package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/oauth"
	"github.com/xinyao27/jevonian/internal/wire"
	anthropicwire "github.com/xinyao27/jevonian/internal/wire/anthropic"
	openaiwire "github.com/xinyao27/jevonian/internal/wire/openai"
	responseswire "github.com/xinyao27/jevonian/internal/wire/responses"
)

// ClientKind is the client's wire (which shape the HTTP response must take).
// Equal to config.UpstreamWire; named for call sites that speak "who asked".
type ClientKind = config.UpstreamWire

const (
	KindOpenAI    = config.WireOpenAI
	KindAnthropic = config.WireAnthropic
	KindResponses = config.WireResponses
)

// WirePlan is the chosen upstream wire + whether the body must be bridged.
// src/wire.ts planUpstreamWire.
type WirePlan struct {
	Wire   config.UpstreamWire
	Bridge string
}

// PlanUpstreamWire picks the upstream protocol and bridge.
// src/wire.ts planUpstreamWire.
func PlanUpstreamWire(p config.Provider, clientKind ClientKind, modelID string) (WirePlan, error) {
	wires := WiresFor(p, modelID)
	if len(wires) == 0 {
		return WirePlan{}, fmt.Errorf("no wires available for provider %q and model %q", p.Name, modelID)
	}
	upstreamWire := wires[0]

	plan := WirePlan{Wire: upstreamWire}
	if clientKind == KindOpenAI && upstreamWire == KindResponses {
		plan.Bridge = "openai-to-responses"
	} else if clientKind == KindResponses && upstreamWire == KindOpenAI {
		plan.Bridge = "responses-to-openai"
	}
	return plan, nil
}

// ProviderOffers reports whether a provider lists a model. An empty list means
// wild-card match (the provider takes whatever the client names).
func ProviderOffers(p config.Provider, modelID string) bool {
	if len(p.Models) == 0 {
		return true
	}
	for _, m := range p.Models {
		if m.ID == modelID {
			return true
		}
	}
	return false
}

// ModelWire picks the upstream wire protocol for one model.
// Models listed with an explicit `wire` take precedence over provider-wide rules.
func ModelWire(p config.Provider, modelID string) config.UpstreamWire {
	for _, m := range p.Models {
		if m.ID == modelID && len(m.Wire) > 0 {
			return m.Wire[0]
		}
	}
	wires := WiresFor(p, modelID)
	if len(wires) > 0 {
		return wires[0]
	}
	return KindOpenAI
}

// WireForProvider returns the first wire protocol the provider supports.
// src/wire.ts wireForProvider.
func WireForProvider(p config.Provider) config.UpstreamWire {
	wires := WiresFor(p, "")
	if len(wires) > 0 {
		return wires[0]
	}
	return KindOpenAI
}

// WiresFor lists supported wires, model-specific overrides first.
// src/wire.ts wiresFor.
func WiresFor(p config.Provider, modelID string) []config.UpstreamWire {
	if p.OAuthSource == config.OAuthWorkbuddyAI {
		return []config.UpstreamWire{KindAnthropic, KindOpenAI}
	}
	for _, e := range p.Models {
		if e.ID == modelID && len(e.Wire) > 0 {
			return e.Wire
		}
	}
	return inferModelWires(p, modelID)
}

func inferModelWires(p config.Provider, modelID string) []config.UpstreamWire {
	switch p.Type {
	case config.ProviderTypeAnthropic:
		return []config.UpstreamWire{KindAnthropic}
	case config.ProviderTypeResponses:
		return []config.UpstreamWire{KindResponses}
	case config.ProviderTypeGemini, config.ProviderTypeDevin, config.ProviderTypeCursor,
		config.ProviderTypeChatGPTWeb, config.ProviderTypeOpenAI:
		return []config.UpstreamWire{KindOpenAI}
	case config.ProviderTypeBoth:
		if anthropicwire.NeedsWire(modelID) {
			return []config.UpstreamWire{KindAnthropic}
		}
		wires := []config.UpstreamWire{KindOpenAI}
		if IsNativeResponsesHost(p.BaseURL) {
			wires = append(wires, KindResponses)
		}
		if !MessagesRejectsNonClaude(p) {
			wires = append(wires, KindAnthropic)
		}
		return wires
	}
	return []config.UpstreamWire{KindOpenAI}
}

// Native host tables. src/wire.ts NATIVE_*_HOSTS.
var (
	nativeDualWireHosts     = []string{"openrouter.ai", "api.deepseek.com"}
	nativeResponsesHosts    = []string{"opencode.ai"}
	messagesClaudeOnlyHosts = []string{"opencode.ai", "commandcode.ai"}
	splitAnthropicPathHosts = []string{"api.deepseek.com"}
)

func hostOf(baseURL string) string {
	u := strings.TrimPrefix(baseURL, "http://")
	u = strings.TrimPrefix(u, "https://")
	if i := strings.IndexAny(u, "/:"); i >= 0 {
		u = u[:i]
	}
	return strings.ToLower(u)
}

func hostMatches(baseURL string, suffixes []string) bool {
	host := hostOf(baseURL)
	for _, s := range suffixes {
		if host == s || strings.HasSuffix(host, "."+s) {
			return true
		}
	}
	return false
}

// IsNativeDualWireHost is true for hosts that speak Chat + Messages on one key.
func IsNativeDualWireHost(baseURL string) bool { return hostMatches(baseURL, nativeDualWireHosts) }

// IsNativeResponsesHost is true for hosts that accept /responses natively.
func IsNativeResponsesHost(baseURL string) bool {
	return hostMatches(baseURL, nativeResponsesHosts)
}

// MessagesRejectsNonClaude is true for hosts that reject non-Claude ids on /messages.
func MessagesRejectsNonClaude(p config.Provider) bool {
	return hostMatches(p.BaseURL, messagesClaudeOnlyHosts)
}

// UpstreamURLFor resolves the endpoint one provider wire POSTs to.
// src/wire.ts upstreamUrlFor.
func UpstreamURLFor(p config.Provider, w config.UpstreamWire) string {
	base := strings.TrimRight(p.BaseURL, "/")
	if w == KindAnthropic && hostMatches(p.BaseURL, splitAnthropicPathHosts) {
		root := base
		root = strings.TrimSuffix(root, "/v1/messages")
		root = strings.TrimSuffix(root, "/anthropic")
		root = strings.TrimSuffix(root, "/v1")
		return root + "/anthropic/v1/messages"
	}
	path := "/chat/completions"
	switch p.Type {
	case config.ProviderTypeAnthropic:
		path = "/messages"
	case config.ProviderTypeResponses:
		path = "/responses"
	case config.ProviderTypeBoth:
		if w == KindAnthropic {
			path = "/messages"
		} else if w == KindResponses {
			path = "/responses"
		}
	default:
		if w == KindAnthropic {
			path = "/messages"
		} else if w == KindResponses {
			path = "/responses"
		}
	}
	return base + path
}

// PrepInput is what one attempt needs to build its body.
type PrepInput struct {
	PromptPolicy config.PromptPolicyConfig
	Provider     config.Provider
	Model        string
	Effort       string // routing-chosen thinking level
	ClientKind   ClientKind
	ClientBody   wire.Body
	UpstreamWire config.UpstreamWire
	Bridge       string
	Stream       bool
	// ClientStream is whether the client asked for SSE; Stream is what the
	// upstream is asked for (always-stream hosts differ).
	ClientStream bool
	MaxOutput    int
}

// PreviewCacheBody prepares evidence for transparent static adapters only.
// It has no auth, network, environment, or token-saver side effects. A false
// result means the prepared body is not safe to use as cache evidence.
func PreviewCacheBody(provider config.Provider, model string, clientKind ClientKind, clientBody wire.Body, policy config.PromptPolicyConfig, tokenSaver config.TokenSaverConfig, stream bool) (wire.Body, config.UpstreamWire, bool) {
	if provider.Auth == config.AuthOAuth || provider.OAuthSource != "" ||
		(provider.Type != config.ProviderTypeOpenAI && provider.Type != config.ProviderTypeAnthropic && provider.Type != config.ProviderTypeResponses && provider.Type != config.ProviderTypeBoth) {
		return nil, "", false
	}
	plan, err := PlanUpstreamWire(provider, clientKind, model)
	if err != nil || (plan.Wire != KindOpenAI && plan.Wire != KindAnthropic && plan.Wire != KindResponses) {
		return nil, "", false
	}
	adapter, err := AdapterFor(provider, clientKind, plan)
	if err != nil {
		return nil, "", false
	}
	switch adapter.(type) {
	case *openaiAdapter, *anthropicAdapter, *responsesAdapter:
	default:
		return nil, "", false
	}
	if tokenSaver.Enabled && containsToolResult(clientBody) {
		return nil, "", false
	}
	clonedBody, ok := cloneAdapterBody(clientBody)
	if !ok {
		return nil, "", false
	}
	prepared, err := adapter.Prepare(PrepInput{
		PromptPolicy: policy, Provider: provider, Model: model, ClientKind: clientKind,
		ClientBody: clonedBody, UpstreamWire: plan.Wire, Bridge: plan.Bridge,
		Stream: stream || adapter.AlwaysStreams(), ClientStream: stream,
	})
	if err != nil {
		return nil, "", false
	}
	if _, ok := prepared["messages"].([]any); !ok {
		return nil, "", false
	}
	return prepared, plan.Wire, true
}

func cloneAdapterBody(body wire.Body) (wire.Body, bool) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, false
	}
	var clone wire.Body
	if err := json.Unmarshal(encoded, &clone); err != nil || clone == nil {
		return nil, false
	}
	return clone, true
}

func containsToolResult(body wire.Body) bool {
	for _, raw := range wire.AsSlice(body["messages"]) {
		message := wire.AsRecord(raw)
		if message["role"] == "tool" {
			return true
		}
		for _, block := range wire.AsSlice(message["content"]) {
			if wire.AsRecord(block)["type"] == "tool_result" {
				return true
			}
		}
	}
	for _, raw := range wire.AsSlice(body["input"]) {
		if wire.AsRecord(raw)["type"] == "function_call_output" {
			return true
		}
	}
	return false
}

// Adapter is one provider's egress: build the wire body, send it, read its
// usage. The attempt loop stays protocol-blind: AdapterFor is the one place
// that maps a provider to its adapter (tests and embedders add their own via
// ForwardDeps.Adapters), and provider quirks are optional interfaces below,
// never provider-type checks in the loop.
type Adapter interface {
	// Wire is the upstream protocol the provider answers on.
	Wire() config.UpstreamWire
	// AlwaysStreams reports whether the provider only streams (responses,
	// devin, cursor, workbuddy). A non-stream client gets the stream folded.
	AlwaysStreams() bool
	// Prepare assembles the upstream body for one attempt.
	Prepare(in PrepInput) (wire.Body, error)
	// UsageFrom reads a non-streaming reply's token accounting.
	UsageFrom(body []byte) wire.Usage
	// EndpointURL overrides the default UpstreamURLFor when non-empty.
	EndpointURL(provider config.Provider) string
	// Headers contributes provider-specific request headers.
	Headers(provider config.Provider, base http.Header) http.Header
}

// Optional adapter capabilities. The attempt loop asks the adapter, so a new
// provider adds a method here instead of a branch in Try/attempt.

// attemptRunner owns the whole upstream exchange (Connect-RPC, session-bound
// hosts). The runner still owns guards, classification and benching.
type attemptRunner interface {
	runAttempt(r *Runner, ctx context.Context, req AttemptRequest, at *Attempt, body wire.Body, auth oauth.AuthResolution)
}

// concurrencyLimiter caps parallel turns per account (a second session would
// supersede the first).
type concurrencyLimiter interface{ MaxConcurrent() int }

// tokenSaverOptOut skips tool-result compression for hosts outside parity.
type tokenSaverOptOut interface{ SkipsTokenSaver() bool }

// AdapterFunc selects an adapter for one runner. No mutable process registry is
// shared across independent servers or tests.
type AdapterFunc func(provider config.Provider, clientKind ClientKind, plan WirePlan) (Adapter, bool)

// AdapterFor picks the built-in egress for a provider. It is the only place
// that maps provider identity to behavior.
func AdapterFor(provider config.Provider, clientKind ClientKind, plan WirePlan) (Adapter, error) {
	switch provider.Type {
	case config.ProviderTypeChatGPTWeb:
		return &chatGPTWebAdapter{rpcAdapter: rpcAdapter{chat: chatgptWebChat}}, nil
	case config.ProviderTypeDevin:
		return &rpcAdapter{chat: devinChat}, nil
	case config.ProviderTypeCursor:
		return &rpcAdapter{chat: cursorChat}, nil
	}
	if provider.Type == config.ProviderTypeGemini {
		return &geminiAdapter{}, nil
	}
	if provider.OAuthSource == config.OAuthFreebuff {
		return &freebuffAdapter{}, nil
	}
	if provider.OAuthSource == config.OAuthWorkbuddyAI {
		return &workbuddyAdapter{}, nil
	}
	switch plan.Wire {
	case KindAnthropic:
		return &anthropicAdapter{}, nil
	case KindResponses:
		return &responsesAdapter{}, nil
	default:
		return &openaiAdapter{}, nil
	}
}

// openaiAdapter is the plain Chat Completions egress.
type openaiAdapter struct{}

func (a *openaiAdapter) Wire() config.UpstreamWire { return KindOpenAI }
func (a *openaiAdapter) AlwaysStreams() bool       { return false }

func (a *openaiAdapter) Prepare(in PrepInput) (wire.Body, error) {
	body := in.ClientBody
	switch in.ClientKind {
	case KindAnthropic:
		body = anthropicwire.ToChatRequest(body, in.Model)
	case KindResponses:
		body = responseswire.ToChatRequest(in.ClientBody, in.Model)
	}
	body["model"] = in.Model
	if in.Stream {
		body["stream"] = true
	}
	if in.Effort != "" {
		body = withEffort(body, in.Effort)
	}
	body = fitThinkingBudget(body)
	// src/prepare.ts: ask streaming Chat Completions hosts to report usage.
	if in.ClientKind == KindOpenAI && (in.Provider.Type == config.ProviderTypeOpenAI || in.Provider.Type == config.ProviderTypeChatGPTWeb) &&
		in.ClientStream && in.Provider.InjectStreamUsage {
		if _, set := body["stream_options"]; !set {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	return wire.RewritePromptBodies(body, in.PromptPolicy), nil
}

func (a *openaiAdapter) UsageFrom(body []byte) wire.Usage {
	u := openaiwire.CompletionUsage(body)
	return wire.Usage{Input: u.PromptTokens, Output: u.CompletionTokens, CacheRead: u.CacheRead}
}
func (a *openaiAdapter) EndpointURL(p config.Provider) string { return "" }
func (a *openaiAdapter) Headers(p config.Provider, base http.Header) http.Header {
	return base
}

type chatGPTWebAdapter struct{ rpcAdapter }

func (*chatGPTWebAdapter) MaxConcurrent() int    { return 1 }
func (*chatGPTWebAdapter) SkipsTokenSaver() bool { return true }

// anthropicAdapter is the Anthropic Messages egress.
type anthropicAdapter struct{}

func (a *anthropicAdapter) Wire() config.UpstreamWire { return KindAnthropic }
func (a *anthropicAdapter) AlwaysStreams() bool       { return false }

func (a *anthropicAdapter) Prepare(in PrepInput) (wire.Body, error) {
	var body wire.Body
	clientEffort := anthropicwire.ClientEffortOf(in.ClientBody, anthropicwire.WireKind(in.ClientKind))
	if in.ClientKind == KindAnthropic && in.Bridge == "" {
		// Native Messages client on a Messages host: keep the client's own body
		// (metadata, top_k, ...) and only set the router's model and effort.
		native := make(wire.Body, len(in.ClientBody)+1)
		for k, v := range in.ClientBody {
			native[k] = v
		}
		native["model"] = in.Model
		if in.Stream {
			native["stream"] = true
		}
		delete(native, "context_management")
		withEffort := anthropicwire.WithEffort(native, in.Effort, anthropicwire.WireAnthropic, clientEffort)
		body = anthropicwire.FitThinkingMaxTokens(withEffort, anthropicwire.MaxTokensOptions{
			ClientSetMax: true,
			MaxOutput:    in.MaxOutput,
		})
	} else {
		var chat wire.Body
		switch in.ClientKind {
		case KindAnthropic:
			chat = anthropicwire.ToChatRequest(in.ClientBody, in.Model)
		case KindResponses:
			chat = responseswire.ToChatRequest(in.ClientBody, in.Model)
		default:
			chat = in.ClientBody
		}
		body = anthropicwire.BridgedAnthropicBody(chat, anthropicwire.BridgedBodyOptions{
			Model:        in.Model,
			Stream:       in.Stream,
			Effort:       in.Effort,
			ClientEffort: clientEffort,
			MaxOutput:    in.MaxOutput,
		})
	}
	// src/prepare.ts payloadFor: the Claude Code identity belongs to the OAuth
	// Messages wire only; Claude 4.6+ then rejects a trailing assistant turn.
	if in.Provider.Auth == config.AuthOAuth {
		body = applyClaudeCodeSystem(body)
	}
	body = sanitizeAnthropicBody(body, in.Provider.Auth == config.AuthOAuth)
	return wire.RewritePromptBodies(anthropicwire.NormalizePrefill(body), in.PromptPolicy), nil
}

func sanitizeAnthropicBody(in wire.Body, isOAuth bool) wire.Body {
	delete(in, "context_management")
	if !isOAuth {
		claudeCodeSignature := "You are Claude Code, Anthropic's official CLI for Claude."
		agentSignature := "You are an interactive coding assistant."

		if sysStr, ok := in["system"].(string); ok {
			if strings.Contains(sysStr, claudeCodeSignature) {
				in["system"] = strings.ReplaceAll(sysStr, claudeCodeSignature, agentSignature)
			}
		} else if sysList, ok := in["system"].([]any); ok {
			outSys := make([]any, len(sysList))
			for i, s := range sysList {
				if rec, ok := s.(map[string]any); ok {
					if txt, ok := rec["text"].(string); ok && strings.Contains(txt, claudeCodeSignature) {
						c := make(wire.Body, len(rec))
						for k, v := range rec {
							c[k] = v
						}
						c["text"] = strings.ReplaceAll(txt, claudeCodeSignature, agentSignature)
						outSys[i] = c
						continue
					}
				}
				outSys[i] = s
			}
			in["system"] = outSys
		}
	}

	if msgs, ok := in["messages"].([]any); ok && len(msgs) > 0 {
		lastAssistantIdx := -1
		for i := len(msgs) - 1; i >= 0; i-- {
			if rec, ok := msgs[i].(map[string]any); ok && rec["role"] == "assistant" {
				lastAssistantIdx = i
				break
			}
		}

		changed := false
		out := make([]any, len(msgs))
		for i, m := range msgs {
			out[i] = m
			rec, ok := m.(map[string]any)
			if !ok {
				continue
			}
			role, _ := rec["role"].(string)
			if role == "system" {
				c := make(wire.Body, len(rec))
				for k, v := range rec {
					c[k] = v
				}
				c["role"] = "user"
				out[i] = c
				changed = true
				continue
			}
			// Prune historical thinking blocks from all assistant messages except the last one.
			// Earlier thinking blocks are unnecessary for subsequent turns, and stale/mismatched
			// signatures from previous models or compacted histories trigger Anthropic 400 errors.
			if role == "assistant" && i < lastAssistantIdx {
				blocks, ok := rec["content"].([]any)
				if !ok || len(blocks) == 0 {
					continue
				}
				var filtered []any
				hadThinking := false
				for _, b := range blocks {
					bRec, ok := b.(map[string]any)
					if ok {
						t, _ := bRec["type"].(string)
						if t == "thinking" || t == "redacted_thinking" {
							hadThinking = true
							continue
						}
					}
					filtered = append(filtered, b)
				}
				if hadThinking {
					if len(filtered) == 0 {
						filtered = []any{map[string]any{"type": "text", "text": "..."}}
					}
					c := make(wire.Body, len(rec))
					for k, v := range rec {
						c[k] = v
					}
					c["content"] = filtered
					out[i] = c
					changed = true
				}
			}
		}
		if changed {
			in["messages"] = out
		}
	}
	return in
}

// StripAllThinking removes all thinking and redacted_thinking content blocks from all assistant turns.
// Used as a last-resort fallback retry when upstream rejects with a thinking block tampering error.
func StripAllThinking(in wire.Body) (wire.Body, bool) {
	msgs, ok := in["messages"].([]any)
	if !ok || len(msgs) == 0 {
		return in, false
	}
	changed := false
	out := make([]any, len(msgs))
	for i, m := range msgs {
		out[i] = m
		rec, ok := m.(map[string]any)
		if !ok || rec["role"] != "assistant" {
			continue
		}
		blocks, ok := rec["content"].([]any)
		if !ok || len(blocks) == 0 {
			continue
		}
		var filtered []any
		hadThinking := false
		for _, b := range blocks {
			bRec, ok := b.(map[string]any)
			if ok {
				t, _ := bRec["type"].(string)
				if t == "thinking" || t == "redacted_thinking" {
					hadThinking = true
					continue
				}
			}
			filtered = append(filtered, b)
		}
		if hadThinking {
			if len(filtered) == 0 {
				filtered = []any{map[string]any{"type": "text", "text": "..."}}
			}
			c := make(wire.Body, len(rec))
			for k, v := range rec {
				c[k] = v
			}
			c["content"] = filtered
			out[i] = c
			changed = true
		}
	}
	if changed {
		next := make(wire.Body, len(in))
		for k, v := range in {
			next[k] = v
		}
		next["messages"] = out
		return next, true
	}
	return in, false
}

// applyClaudeCodeSystem mirrors applyClaudeCodeSystem in src/prepare.ts: put the
// Claude Code identity first in `system`, and drop adaptive-only fields a legacy
// model rejects.
func applyClaudeCodeSystem(in wire.Body) wire.Body {
	next := make(wire.Body, len(in)+1)
	for k, v := range in {
		next[k] = v
	}
	prompt := func(cache bool) wire.Body {
		b := wire.Body{"type": "text", "text": oauth.ClaudeCodeSystemPrompt}
		if cache {
			b["cache_control"] = wire.Body{"type": "ephemeral"}
		}
		return b
	}
	switch system := next["system"].(type) {
	case string:
		if system != "" {
			next["system"] = []any{prompt(false), wire.Body{"type": "text", "text": system, "cache_control": wire.Body{"type": "ephemeral"}}}
		} else {
			next["system"] = []any{prompt(true)}
		}
	case []any:
		next["system"] = append([]any{prompt(false)}, system...)
	default:
		next["system"] = []any{prompt(true)}
	}
	// Anthropic accepts context_management only together with its beta header. This
	// wire sends just oauth-2025-04-20, so a field a client set (Claude Code sends one
	// unconditionally) gets rejected with 400.
	delete(next, "context_management")
	return next
}

func withEffort(body wire.Body, effort string) wire.Body {
	// src/prepare.ts withEffort: only openai-family models accept the reasoning_effort field.
	// Gemini rejects it; Anthropic models accept thinking.budget_tokens instead.
	body["reasoning_effort"] = effort
	return body
}

// fitThinkingBudget enforces `max_completion_tokens >= thinking_budget + 1` for models
// that require it (e.g. o1/o3/deepseek). Port of src/prepare.ts fitThinkingBudget.
func fitThinkingBudget(body wire.Body) wire.Body {
	// If max_tokens is present, make sure max_completion_tokens is not lower
	if maxTokens, ok := body["max_tokens"]; ok {
		if _, hasMaxCompletion := body["max_completion_tokens"]; !hasMaxCompletion {
			body["max_completion_tokens"] = maxTokens
		}
	}
	return body
}

func sentEffort(body wire.Body, wire config.UpstreamWire) string {
	if wire == KindAnthropic {
		return anthropicwire.SentEffort(body)
	}
	if s, ok := body["reasoning_effort"].(string); ok {
		return s
	}
	return ""
}
