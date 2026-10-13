package upstream

import (
	"testing"

	"github.com/xinyao27/jevonian/internal/wire"
)

func TestStripHistoricalThinking(t *testing.T) {
	body := wire.Body{
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": "step 1",
			},
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "plan 1", "signature": "sig1"},
					map[string]any{"type": "text", "text": "answer 1"},
				},
			},
			map[string]any{
				"role": "user",
				"content": "step 2",
			},
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "plan 2", "signature": "sig2"},
					map[string]any{"type": "tool_use", "id": "t1", "name": "shell"},
				},
			},
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
				},
			},
		},
	}

	sanitized := sanitizeAnthropicBody(body, false)
	msgs := wire.AsSlice(sanitized["messages"])
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages, got %d", len(msgs))
	}

	// Message 1 (historical assistant) should have thinking stripped
	m1 := wire.AsRecord(msgs[1])
	blocks1 := wire.AsSlice(m1["content"])
	if len(blocks1) != 1 || wire.AsRecord(blocks1[0])["type"] != "text" {
		t.Fatalf("expected message 1 thinking stripped, got: %v", blocks1)
	}

	// Message 3 (latest assistant) should have thinking preserved
	m3 := wire.AsRecord(msgs[3])
	blocks3 := wire.AsSlice(m3["content"])
	if len(blocks3) != 2 || wire.AsRecord(blocks3[0])["type"] != "thinking" {
		t.Fatalf("expected message 3 thinking preserved, got: %v", blocks3)
	}
}

func TestStripAllThinking(t *testing.T) {
	body := wire.Body{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "plan", "signature": "sig"},
					map[string]any{"type": "text", "text": "hello"},
				},
			},
		},
	}

	stripped, changed := StripAllThinking(body)
	if !changed {
		t.Fatalf("expected changed to be true")
	}
	m := wire.AsRecord(wire.AsSlice(stripped["messages"])[0])
	blocks := wire.AsSlice(m["content"])
	if len(blocks) != 1 || wire.AsRecord(blocks[0])["type"] != "text" {
		t.Fatalf("expected thinking stripped, got: %v", blocks)
	}
}
