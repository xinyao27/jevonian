package openai

import (
	crand "crypto/rand"
	"encoding/json"

	"github.com/xinyao27/jevonian/internal/wire"
)

// maxImagesToKeep caps how many images survive normalize: a long agent
// session accumulates screenshots, and multimodal gateways (Alibaba
// DashScope) time out downloading them.
const maxImagesToKeep = 2

// NormalizeMessages sanitizes chat messages for a strict OpenAI-compatible
// wire. It translates Anthropic-style blocks (tool_use / tool_result)
// embedded inside `content` arrays into standard OpenAI `tool_calls` and
// `role: "tool"` messages, combines plain text array items into single
// strings, converts Anthropic image blocks into `image_url` parts, prunes old
// images down to the most recent two, and strips empty `tool_calls` arrays
// that strict backends reject. Port of normalizeOpenAIMessages in
// src/wire.ts.
func NormalizeMessages(messages []any) []wire.Body {
	out := []wire.Body{}

	// Count total multimodal image items across the conversation history.
	totalImages := 0
	for _, raw := range messages {
		msg := wire.AsRecord(raw)
		for _, item := range wire.AsSlice(msg["content"]) {
			rec := wire.AsRecord(item)
			if rec["type"] == "image_url" ||
				(rec["type"] == "image" && rec["source"] != nil) {
				totalImages++
			}
		}
	}
	pruneThreshold := totalImages - maxImagesToKeep
	currentImage := 0

	for _, raw := range messages {
		source, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		msg := cloneMap(source)
		role := msg["role"]
		content, isList := msg["content"].([]any)
		if !isList {
			out = append(out, msg)
			continue
		}

		var textParts []string
		var imageParts []any
		var toolCalls []any
		var toolResults []wire.Body

		for _, item := range content {
			switch v := item.(type) {
			case nil:
				continue
			case string:
				textParts = append(textParts, v)
				continue
			}
			rec, ok := item.(map[string]any)
			if !ok {
				textParts = append(textParts, wire.MarshalJSON(item))
				continue
			}
			switch rec["type"] {
			case "text":
				if t, ok := rec["text"].(string); ok {
					textParts = append(textParts, t)
				}
			case "reasoning", "thought":
				if t, ok := rec["text"].(string); ok {
					textParts = append(textParts, t)
				} else if r, ok := rec["reasoning"].(string); ok {
					textParts = append(textParts, r)
				} else if th, ok := rec["thought"].(string); ok {
					textParts = append(textParts, th)
				}
			case "image_url":
				currentImage++
				if totalImages > maxImagesToKeep && currentImage <= pruneThreshold {
					textParts = append(textParts, "[Previous screenshot omitted to prevent multimodal timeout]")
				} else {
					imageParts = append(imageParts, rec)
				}
			case "image":
				source := wire.AsRecord(rec["source"])
				if source == nil {
					continue
				}
				currentImage++
				if totalImages > maxImagesToKeep && currentImage <= pruneThreshold {
					textParts = append(textParts, "[Previous screenshot omitted to prevent multimodal timeout]")
					continue
				}
				if source["type"] == "base64" {
					if data, ok := source["data"].(string); ok {
						mediaType, _ := source["media_type"].(string)
						if mediaType == "" {
							mediaType = "image/png"
						}
						imageParts = append(imageParts, wire.Body{
							"type":      "image_url",
							"image_url": wire.Body{"url": "data:" + mediaType + ";base64," + data},
						})
						continue
					}
				}
				if source["type"] == "url" {
					if u, ok := source["url"].(string); ok {
						imageParts = append(imageParts, wire.Body{
							"type":      "image_url",
							"image_url": wire.Body{"url": u},
						})
						continue
					}
				}
				imageParts = append(imageParts, rec)
			case "input_audio":
				imageParts = append(imageParts, rec)
			case "tool_use":
				args := "{}"
				switch input := rec["input"].(type) {
				case string:
					args = input
				case nil:
				default:
					args = wire.MarshalJSON(input)
				}
				id, _ := rec["id"].(string)
				if id == "" {
					id = "call_" + randomAlpha(8)
				}
				name, _ := rec["name"].(string)
				toolCalls = append(toolCalls, wire.Body{
					"id":   id,
					"type": "function",
					"function": wire.Body{
						"name":      name,
						"arguments": args,
					},
				})
			case "tool_result":
				var contentStr string
				switch c := rec["content"].(type) {
				case string:
					contentStr = c
				case []any:
					var parts []string
					for _, part := range c {
						switch p := part.(type) {
						case string:
							parts = append(parts, p)
						default:
							rec2 := wire.AsRecord(p)
							if t, ok := rec2["text"].(string); ok {
								parts = append(parts, t)
							} else {
								parts = append(parts, wire.MarshalJSON(p))
							}
						}
					}
					contentStr = joinLines(parts)
				case nil:
				default:
					contentStr = wire.MarshalJSON(c)
				}
				toolCallID := wire.FirstNonEmpty(rec["tool_use_id"], rec["id"])
				toolResults = append(toolResults, wire.Body{
					"role":         "tool",
					"tool_call_id": toolCallID,
					"content":      contentStr,
				})
			default:
				if t, ok := rec["text"].(string); ok {
					textParts = append(textParts, t)
				} else {
					textParts = append(textParts, wire.MarshalJSON(rec))
				}
			}
		}

		switch role {
		case "assistant":
			var existing []any
			if calls, ok := msg["tool_calls"].([]any); ok {
				existing = calls
			}
			combined := append(existing, toolCalls...)
			assistant := cloneMap(msg)
			assistant["role"] = "assistant"
			switch {
			case len(textParts) > 0:
				assistant["content"] = joinLines(textParts)
			case len(imageParts) > 0:
				assistant["content"] = imageParts
			case len(combined) > 0:
				assistant["content"] = nil
			default:
				assistant["content"] = ""
			}
			if len(combined) > 0 {
				assistant["tool_calls"] = combined
			} else {
				delete(assistant, "tool_calls")
			}
			out = append(out, assistant)
		case "user":
			// Tool results go out before the user text/image. A `tool`
			// message must directly follow the assistant turn carrying the
			// matching `tool_calls`; strict backends (Qwen, DeepSeek) reject
			// the sequence when a plain `user` message is interposed.
			out = append(out, toolResults...)
			if len(textParts) > 0 || len(imageParts) > 0 {
				entry := cloneMap(msg)
				entry["role"] = "user"
				if len(imageParts) > 0 {
					var parts []any
					for _, t := range textParts {
						parts = append(parts, wire.Body{"type": "text", "text": t})
					}
					parts = append(parts, imageParts...)
					entry["content"] = parts
				} else {
					entry["content"] = joinLines(textParts)
				}
				out = append(out, entry)
			}
		default:
			entry := cloneMap(msg)
			switch {
			case len(textParts) > 0:
				entry["content"] = joinLines(textParts)
			case len(imageParts) > 0:
				entry["content"] = imageParts
			default:
				entry["content"] = ""
			}
			out = append(out, entry)
		}
	}

	// Strict OpenAI backends reject messages with empty `tool_calls: []`
	// ("Empty tool_calls is not supported in message."). Strip any empty or
	// null tool_calls across all messages before egress.
	for _, item := range out {
		if calls, present := item["tool_calls"]; present {
			list, ok := calls.([]any)
			if !ok || len(list) == 0 {
				delete(item, "tool_calls")
			}
		}
	}
	return out
}

func joinLines(parts []string) string {
	result := ""
	for i, part := range parts {
		if i > 0 {
			result += "\n"
		}
		result += part
	}
	return result
}

func cloneMap(m map[string]any) map[string]any {
	next := make(map[string]any, len(m))
	for k, v := range m {
		next[k] = v
	}
	return next
}

const alphaChars = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomAlpha(n int) string {
	var b [8]byte
	_, _ = randRead(b[:])
	out := make([]byte, n)
	for i := range out {
		out[i] = alphaChars[int(b[i%8])%len(alphaChars)]
	}
	return string(out)
}

// randRead is crypto/rand.Read behind a var so the only nondeterminism in
// this file stays visible.
var randRead = crand.Read

// sanitizeChunk strips empty id/name from streamed tool_call deltas: some
// providers (Qwen, vLLM) send continuation chunks with `id: ""` and clients
// like OpenCode overwrite the real id with it. Returns the (possibly
// rewritten) data payload.
func sanitizeChunk(data string) string {
	if data == "[DONE]" {
		return data
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		return data
	}
	choices, ok := parsed["choices"].([]any)
	if !ok {
		return data
	}
	changed := false
	for _, rawChoice := range choices {
		choice, ok := rawChoice.(map[string]any)
		if !ok {
			continue
		}
		delta, ok := choice["delta"].(map[string]any)
		if !ok {
			continue
		}
		toolCalls, ok := delta["tool_calls"].([]any)
		if !ok {
			continue
		}
		for _, rawTC := range toolCalls {
			tc, ok := rawTC.(map[string]any)
			if !ok {
				continue
			}
			if _, isNumber := tc["index"].(float64); !isNumber {
				tc["index"] = float64(0)
				changed = true
			}
			if id, ok := tc["id"].(string); ok && trimSpace(id) == "" {
				delete(tc, "id")
				changed = true
			}
			if fn, ok := tc["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok && trimSpace(name) == "" {
					delete(fn, "name")
					changed = true
				}
			}
		}
	}
	if !changed {
		return data
	}
	out, err := json.Marshal(parsed)
	if err != nil {
		return data
	}
	return string(out)
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

// SanitizeStreamTranslator rewrites outbound Chat Completions SSE so empty
// `id`/`name` on streamed tool_call deltas never reach the client — the port
// of sanitizeOpenAIChatStream in src/wire.ts. Unlike the protocol bridges it
// preserves the original frame layout (passes non-data lines through).
type SanitizeStreamTranslator struct {
	buf []byte
}

// NewSanitizeStream builds the sanitizer translator.
func NewSanitizeStream() *SanitizeStreamTranslator {
	return &SanitizeStreamTranslator{}
}

// Write ingests raw upstream bytes and returns sanitized SSE bytes.
func (s *SanitizeStreamTranslator) Write(p []byte) []byte {
	s.buf = append(s.buf, p...)
	var out []byte
	for {
		index := indexOfDoubleNewline(s.buf)
		if index < 0 {
			break
		}
		block := string(s.buf[:index])
		s.buf = s.buf[index+2:]
		out = append(out, s.rewriteBlock(block)...)
		out = append(out, '\n', '\n')
	}
	return out
}

// Flush returns the sanitized tail of the buffer.
func (s *SanitizeStreamTranslator) Flush() []byte {
	if len(s.buf) == 0 {
		return nil
	}
	block := string(s.buf)
	s.buf = nil
	return s.rewriteBlock(block)
}

func (s *SanitizeStreamTranslator) rewriteBlock(block string) []byte {
	var out []byte
	lines := splitLines(block)
	for i, line := range lines {
		if i > 0 {
			out = append(out, '\n')
		}
		if len(line) > 5 && line[:5] == "data:" {
			raw := trimSpace(line[5:])
			if raw == "" {
				out = append(out, line...)
			} else {
				out = append(out, "data: "+sanitizeChunk(raw)...)
			}
		} else {
			out = append(out, line...)
		}
	}
	return out
}

func indexOfDoubleNewline(b []byte) int {
	for i := 0; i+1 < len(b); i++ {
		if b[i] == '\n' && b[i+1] == '\n' {
			return i
		}
	}
	return -1
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
		}
	}
	lines = append(lines, s[start:])
	return lines
}

// SanitizeResponse strips empty id/name from a non-streaming chat
// completion's tool_calls — the port of sanitizeOpenAIChatResponse.
func SanitizeResponse(body wire.Body) wire.Body {
	choices, ok := body["choices"].([]any)
	if !ok {
		return body
	}
	for _, rawChoice := range choices {
		choice, ok := rawChoice.(map[string]any)
		if !ok {
			continue
		}
		msg, ok := choice["message"].(map[string]any)
		if !ok {
			continue
		}
		toolCalls, ok := msg["tool_calls"].([]any)
		if !ok {
			continue
		}
		for _, rawTC := range toolCalls {
			tc, ok := rawTC.(map[string]any)
			if !ok {
				continue
			}
			if id, ok := tc["id"].(string); ok && trimSpace(id) == "" {
				delete(tc, "id")
			}
			if fn, ok := tc["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok && trimSpace(name) == "" {
					delete(fn, "name")
				}
			}
		}
	}
	return body
}
