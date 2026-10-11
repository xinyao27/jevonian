package upstream

import (
	"testing"

	"github.com/xinyao27/jevonian/internal/wire"
)

func TestThinkingBudgetAndEffortMutualExclusion(t *testing.T) {
	// Case 1: withEffort removes thinking_budget if present
	bodyWithBudget := wire.Body{
		"max_tokens":      4096,
		"thinking_budget": 2048,
	}
	withEff := withEffort(bodyWithBudget, "medium")
	if withEff["reasoning_effort"] != "medium" {
		t.Fatalf("expected reasoning_effort 'medium', got %v", withEff["reasoning_effort"])
	}
	if _, hasBudget := withEff["thinking_budget"]; hasBudget {
		t.Fatalf("expected thinking_budget to be deleted when reasoning_effort is added, but found %v", withEff["thinking_budget"])
	}

	// Case 2: fitThinkingBudget does NOT add thinking_budget when reasoning_effort is present
	bodyWithEffort := wire.Body{
		"max_tokens":       24,
		"reasoning_effort": "medium",
	}
	fitted := fitThinkingBudget(bodyWithEffort)
	if _, hasBudget := fitted["thinking_budget"]; hasBudget {
		t.Fatalf("fitThinkingBudget added thinking_budget while reasoning_effort was present: %v", fitted["thinking_budget"])
	}

	// Case 3: fitThinkingBudget sets thinking_budget when reasoning_effort is absent and max_tokens <= 32768
	bodyWithoutEffort := wire.Body{
		"max_tokens": 4096,
	}
	fittedNoEffort := fitThinkingBudget(bodyWithoutEffort)
	if budget, ok := fittedNoEffort["thinking_budget"].(int); !ok || budget <= 0 || budget >= 4096 {
		t.Fatalf("expected thinking_budget between 0 and 4096, got %v", fittedNoEffort["thinking_budget"])
	}
}
