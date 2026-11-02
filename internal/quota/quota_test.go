package quota

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
)

func TestProviderSpendSignal(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   SpendSignal
	}{
		{402, `{"error":"payment"}`, SignalBilling},
		{429, `{"error":{"type":"usage_limit_reached"}}`, SignalQuota},
		{429, `{"type":"error","error":{"type":"GoUsageLimitError"}}`, SignalQuota},
		{403, `{"code":"insufficient_balance"}`, SignalBilling},
		{429, `{"error":{"type":"rate_limit"}}`, SignalNone}, // unclassified
		{500, `{"error":{"type":"usage_limit_reached"}}`, SignalNone},
		{400, "", SignalNone},
	}
	for i, c := range cases {
		if got := ProviderSpendSignal(c.status, c.body); got != c.want {
			t.Fatalf("case %d: status=%d got %q want %q", i, c.status, got, c.want)
		}
	}
}

func TestMessageSpendSignal(t *testing.T) {
	if got := MessageSpendSignal("usage limit has been reached"); got != SignalQuota {
		t.Fatalf("got %q", got)
	}
	if got := MessageSpendSignal("context length limit"); got != SignalNone {
		t.Fatalf("context limit must not read as quota: %q", got)
	}
	if got := MessageSpendSignal("insufficient balance"); got != SignalBilling {
		t.Fatalf("got %q", got)
	}
	if got := MessageSpendSignal("Your team has either used all available credits or reached its monthly spending limit"); got != SignalBilling {
		t.Fatalf("xAI spending limit must read as billing: %q", got)
	}
}

func TestIsProviderRefusal(t *testing.T) {
	for _, s := range []int{401, 402, 403, 404, 408, 429, 500, 503, 529} {
		if !IsProviderRefusal(s) {
			t.Fatalf("%d should be a provider refusal", s)
		}
	}
	for _, s := range []int{200, 400, 413, 422} {
		if IsProviderRefusal(s) {
			t.Fatalf("%d is a client error, not a refusal", s)
		}
	}
}

func TestUsageLimitReset(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	label, reset := UsageLimitReset(SignalQuota, `{"resets_at":1789929256}`, now)
	if label != "limit" || reset.IsZero() {
		t.Fatalf("unix reset: label=%s reset=%v", label, reset)
	}
	if reset.Unix() != 1789929256 {
		t.Fatalf("reset = %d", reset.Unix())
	}
	_, reset = UsageLimitReset(SignalQuota, "resets in 3hr 15min", now)
	if reset.Sub(now) != 3*time.Hour+15*time.Minute {
		t.Fatalf("hr/min reset = %v", reset.Sub(now))
	}
	_, reset = UsageLimitReset(SignalQuota, `{"resets_in_seconds":120}`, now)
	if reset.Sub(now) != 120*time.Second {
		t.Fatalf("seconds reset = %v", reset.Sub(now))
	}
	label, reset = UsageLimitReset(SignalBilling, "insufficient balance", now)
	if label != "balance" {
		t.Fatalf("billing label = %s", label)
	}
	label, _ = UsageLimitReset(SignalQuota, "weekly usage limit", now)
	if label != "week" {
		t.Fatalf("weekly label = %s", label)
	}
}

func TestCaptureUsageLimitMarksSpent(t *testing.T) {
	tracker := New(nil)
	tracker.SetClock(func() time.Time { return time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC) })
	ok := tracker.CaptureUsageLimit("p1", 429, `{"error":{"type":"usage_limit_reached"},"resets_in_seconds":600}`)
	if !ok {
		t.Fatal("expected capture")
	}
	p := config.Provider{Name: "p1"}
	h := tracker.ProviderHealth(p, HealthOptions{})
	if h.Status != StatusExhausted {
		t.Fatalf("status = %s", h.Status)
	}
}

func TestHeaderSnapshotRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "quota.json")
	tracker := New(nil)
	tracker.SetStatePath(path)
	tracker.SetClock(func() time.Time { return time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC) })
	tracker.MarkProviderSpent("p1", MarkSpentOptions{
		Label:    "limit",
		ResetsAt: time.Date(2026, 1, 2, 6, 0, 0, 0, time.UTC),
	})
	fresh := New(nil)
	fresh.SetStatePath(path)
	fresh.SetClock(func() time.Time { return time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC) })
	h := fresh.ProviderHealth(config.Provider{Name: "p1"}, HealthOptions{})
	if h.Status != StatusExhausted {
		t.Fatalf("reloaded status = %s", h.Status)
	}
	if h.ResetsAt == "" {
		t.Fatal("resetsAt lost across reload")
	}
}

func TestClearRejection(t *testing.T) {
	tracker := New(nil)
	tracker.MarkProviderSpent("p1", MarkSpentOptions{Label: "limit"})
	if tracker.ProviderHealth(config.Provider{Name: "p1"}, HealthOptions{}).Status != StatusExhausted {
		t.Fatal("expected exhausted")
	}
	tracker.ClearRejection("p1")
	if tracker.ProviderHealth(config.Provider{Name: "p1"}, HealthOptions{}).Status == StatusExhausted {
		t.Fatal("rejection not cleared")
	}
}

func TestModelScopedSpentDoesNotExhaustAccount(t *testing.T) {
	tracker := New(nil)
	tracker.MarkProviderSpent("p1", MarkSpentOptions{Label: "limit", Model: "m1"})
	p := config.Provider{Name: "p1"}
	if tracker.ProviderHealth(p, HealthOptions{}).Status == StatusExhausted {
		t.Fatal("model-scoped refusal must not exhaust the account")
	}
	if !tracker.ProviderModelExhausted(p, "m1", HealthOptions{}) {
		t.Fatal("m1 should be exhausted")
	}
	if tracker.ProviderModelExhausted(p, "m2", HealthOptions{}) {
		t.Fatal("m2 should not be exhausted")
	}
}

func TestModelHealthDiagnosesCooldownExpiryAndIsolation(t *testing.T) {
	now := time.Date(2026, 10, 6, 1, 0, 0, 0, time.UTC)
	tracker := New(nil)
	tracker.SetClock(func() time.Time { return now })
	provider := config.Provider{Name: "devin"}
	reset := now.Add(45 * time.Second)
	tracker.MarkSpent("devin", MarkSpentOptions{Model: "swe-2-max", Label: "Reached free model rate limit", ResetsAt: reset})
	if got := tracker.ProviderHealth(provider, HealthOptions{}).Status; got != StatusUnknown {
		t.Fatalf("account status = %s; model refusal must not exhaust account", got)
	}
	health := tracker.ModelHealth(provider, "swe-2-max")
	if health.Status != StatusExhausted || health.Reason != "Reached free model rate limit" || !health.ResetsAt.Equal(reset) {
		t.Fatalf("model health = %+v", health)
	}
	if tracker.ModelHealth(provider, "swe-2").Status != StatusOK {
		t.Fatal("sibling model should remain healthy")
	}
	now = reset
	if health := tracker.ModelHealth(provider, "swe-2-max"); health.Status != StatusOK {
		t.Fatalf("expired model health = %+v", health)
	}
}

func TestAnthropicWindowsFromHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.62")
	h.Set("anthropic-ratelimit-unified-5h-reset", "1789930000")
	h.Set("anthropic-ratelimit-unified-5h-status", "allowed")
	windows := anthropicWindowsFromHeaders(h)
	if len(windows) != 1 {
		t.Fatalf("windows = %+v", windows)
	}
	if windows[0].UsedPercent != 62 {
		t.Fatalf("fraction scaling: %v", windows[0].UsedPercent)
	}
	if windows[0].ResetsAt == "" || windows[0].Status != "allowed" {
		t.Fatalf("missing fields: %+v", windows[0])
	}
}

func TestAccountWindowsLongestFirst(t *testing.T) {
	tracker := New(nil)
	tracker.MarkProviderSpent("p1", MarkSpentOptions{
		Label:    "week",
		ResetsAt: time.Now().Add(24 * time.Hour),
	})
	now := time.Now().UnixMilli()
	ws := tracker.AccountWindows(config.Provider{Name: "p1"}, now)
	if len(ws) == 0 {
		t.Fatal("expected account window from rejection snapshot")
	}
	if ws[0].ResetsAt == 0 {
		t.Fatalf("reset missing: %+v", ws[0])
	}
}

func TestStandingExposesRenews(t *testing.T) {
	tracker := New(nil)
	tracker.MarkProviderSpent("p1", MarkSpentOptions{
		Label:    "5h",
		ResetsAt: time.Now().Add(2 * time.Hour),
	})
	health, modelExhausted, renews := tracker.Standing(config.Provider{Name: "p1"}, "m", time.Now().UnixMilli(), 10)
	if health.Status != StatusExhausted {
		t.Fatalf("status = %s", health.Status)
	}
	if !modelExhausted {
		t.Fatal("account exhaustion implies model exhaustion")
	}
	if len(renews) == 0 || renews[0] == 0 {
		t.Fatalf("renews = %v", renews)
	}
}

// src/quota.ts captureQuotaHeaders: identical windows inside the TTL are not
// rewritten (so the live cache stays warm), but a stale snapshot is refreshed
// even when its window fields are unchanged.
func TestCaptureRateLimitHeadersSkipsIdenticalFreshSnapshot(t *testing.T) {
	now := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	tracker := New(nil)
	tracker.SetClock(func() time.Time { return now })
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.1")

	tracker.CaptureRateLimitHeaders("p", h)
	first := tracker.revision("p")
	fetched := tracker.HeaderWindows("p")
	if len(fetched) != 1 {
		t.Fatalf("windows = %+v", fetched)
	}

	now = now.Add(30 * time.Second)
	tracker.CaptureRateLimitHeaders("p", h)
	if tracker.revision("p") != first {
		t.Fatal("identical fresh snapshot must not invalidate caches")
	}

	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.2")
	tracker.CaptureRateLimitHeaders("p", h)
	if tracker.revision("p") == first {
		t.Fatal("changed window must be recorded")
	}

	second := tracker.revision("p")
	now = now.Add(2 * HeaderSnapshotTTL)
	tracker.CaptureRateLimitHeaders("p", h)
	if tracker.revision("p") == second {
		t.Fatal("stale snapshot must be rewritten even when the windows are unchanged")
	}
	entry, _ := tracker.headerEntry("p")
	if entry.FetchedAt != now.Format(isoMillis) {
		t.Fatalf("fetchedAt = %s want %s", entry.FetchedAt, now.Format(isoMillis))
	}
}

// Codex window ids and ISO timestamps are shared with the TS quota.json.
func TestHeaderWindowIdsAndTimestampShape(t *testing.T) {
	h := http.Header{}
	h.Set("x-codex-primary-used-percent", "12.5")
	h.Set("x-codex-primary-window-minutes", "300")
	h.Set("x-codex-primary-reset-at", "1700000000")
	ws := codexWindowsFromHeaders(h)
	if len(ws) != 1 || ws[0].ID != "codex-primary" || ws[0].Label != "5h" {
		t.Fatalf("windows = %+v", ws)
	}
	if ws[0].ResetsAt != "2023-11-14T22:13:20.000Z" {
		t.Fatalf("resetsAt = %q, want JS toISOString shape", ws[0].ResetsAt)
	}
}

// Claude's utilization is already 0-100 on the live endpoint: 1 means 1%.
func TestPercentPointsKeepsOnePercentAtOnePercent(t *testing.T) {
	if got := clampPercent(1); got != 1 {
		t.Fatalf("clampPercent(1) = %v", got)
	}
	if got := fractionPercent(1); got != 100 {
		t.Fatalf("fractionPercent(1) = %v (header fractions <= 1 scale up)", got)
	}
}

// A stale snapshot is disclosed in the health note so routing can distrust it
// (src/quota.test.ts "flags a stale snapshot in quota health").
func TestProviderHealthFlagsStaleSnapshot(t *testing.T) {
	now := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	tracker := New(nil)
	tracker.SetClock(func() time.Time { return now })
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0")
	tracker.CaptureRateLimitHeaders("p", h)
	now = now.Add(3 * time.Hour)
	health := tracker.ProviderHealth(config.Provider{Name: "p"}, HealthOptions{})
	if health.Status != StatusOK || health.Note != "stale snapshot (measured 3h ago)" {
		t.Fatalf("health = %+v", health)
	}
}
