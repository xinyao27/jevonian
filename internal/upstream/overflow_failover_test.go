package upstream

import (
	"testing"

	"github.com/xinyao27/jevonian/internal/wire"
)

func TestContextOverflowClassification(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "xAI input_too_large error message",
			body: `{"code":"invalid-argument","error":"Failed to start sampling: input_too_large The prompt is too long for this model's context window (391725 tokens > 256000 tokens)"}`,
			want: true,
		},
		{
			name: "Standard context length exceeded",
			body: `{"error":{"message":"context_length_exceeded: maximum context length is 128000 tokens"}}`,
			want: true,
		},
		{
			name: "Prompt is too long",
			body: `{"error":"prompt is too long"}`,
			want: true,
		},
		{
			name: "Unrelated client error",
			body: `{"error":"invalid_api_key"}`,
			want: false,
		},
	}

	re := reContextOverflow()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := re.MatchString(tc.body)
			if got != tc.want {
				t.Fatalf("reContextOverflow() match = %v, want %v for body: %s", got, tc.want, tc.body)
			}
		})
	}
}

func TestContextOverflowIsFailoverable(t *testing.T) {
	o := Outcome{
		Kind: OutcomeContextOverflow,
	}
	if !o.Failoverable() {
		t.Fatalf("expected OutcomeContextOverflow to be Failoverable(), got false")
	}
}

func TestGrokBuildStripsReasoningEffort(t *testing.T) {
	body := wire.Body{
		"model":            "grok-build-0.1",
		"reasoning_effort": "low",
		"thinking_budget":  2048,
	}
	cleaned := withEffort(body, "low")
	if _, ok := cleaned["reasoning_effort"]; ok {
		t.Fatalf("expected reasoning_effort to be removed for grok-build-0.1")
	}
	if _, ok := cleaned["thinking_budget"]; ok {
		t.Fatalf("expected thinking_budget to be removed for grok-build-0.1")
	}

	noneBody := wire.Body{
		"model":            "other-model",
		"reasoning_effort": "low",
	}
	cleanedNone := withEffort(noneBody, "none")
	if _, ok := cleanedNone["reasoning_effort"]; ok {
		t.Fatalf("expected reasoning_effort to be removed when effort is 'none'")
	}
}
