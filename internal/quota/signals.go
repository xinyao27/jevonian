package quota

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SpendSignal says why an upstream refused in a way that means "do not keep
// hitting this provider". src/quota.ts ProviderSpendSignal.
type SpendSignal string

const (
	SignalNone    SpendSignal = ""
	SignalBilling SpendSignal = "billing"
	SignalQuota   SpendSignal = "quota"
)

// Structured exhaustion markers upstreams actually emit. Free-text copy is
// ignored on purpose: providers rename messages constantly but keep stable
// type/code fields. src/quota.ts QUOTA_TOKENS / BILLING_TOKENS.
var quotaTokens = map[string]bool{
	"usage_limit_reached": true,
	"gousagelimiterror":   true,
	"rate_limited":        true,
	"quota_exceeded":      true,
	"weekly_usage_limit":  true,
}

var billingTokens = map[string]bool{
	"insufficient_credits":       true,
	"insufficient_balance":       true,
	"payment_required":           true,
	"billing_not_active":         true,
	"budget_exhausted":           true,
	"credit_exhausted":           true,
	"spending_limit_reached":     true,
	"used_all_available_credits": true,
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func normalizeToken(v string) string {
	return strings.Trim(nonAlnum.ReplaceAllString(strings.ToLower(strings.TrimSpace(v)), "_"), "_")
}

// errorTokens pulls type/code tokens from OpenAI / Anthropic / gateway error
// envelopes, walking nested `error` objects up to depth 4.
func errorTokens(body string) []string {
	var root any
	if err := json.Unmarshal([]byte(body), &root); err != nil {
		return nil
	}
	var tokens []string
	add := func(v any) {
		if s, ok := v.(string); ok && s != "" {
			tokens = append(tokens, normalizeToken(s))
		}
	}
	var walk func(v any, depth int)
	walk = func(v any, depth int) {
		if depth > 4 || v == nil {
			return
		}
		switch t := v.(type) {
		case []any:
			for _, e := range t {
				walk(e, depth+1)
			}
		case map[string]any:
			add(t["type"])
			add(t["code"])
			add(t["error_type"])
			walk(t["error"], depth+1)
		}
	}
	walk(root, 0)
	return tokens
}

// ProviderSpendSignal classifies a failed response as a billing or quota
// verdict. Evidence, strongest first: HTTP 402, then structured type/code
// tokens on a 429/403. src/quota.ts providerSpendSignal.
func ProviderSpendSignal(status int, body string) SpendSignal {
	if status == 402 {
		return SignalBilling
	}
	if status != 429 && status != 403 {
		return SignalNone
	}
	tokens := errorTokens(body)
	for _, t := range tokens {
		if billingTokens[t] {
			return SignalBilling
		}
	}
	for _, t := range tokens {
		if quotaTokens[t] {
			return SignalQuota
		}
	}
	return SignalNone
}

var freeTextSpend = []struct {
	re     *regexp.Regexp
	signal SpendSignal
}{
	{regexp.MustCompile(`(?i)usage limit (has been )?reached|usage_limit_reached`), SignalQuota},
	{regexp.MustCompile(`(?i)weekly usage limit|weekly_usage_limit`), SignalQuota},
	{regexp.MustCompile(`(?i)quota (has been )?exhausted|quota_exceeded|out of quota`), SignalQuota},
	{regexp.MustCompile(`(?i)rate limit( has been)? reached|too many requests`), SignalQuota},
	{regexp.MustCompile(`(?i)insufficient (credits?|balance|funds?|quota)`), SignalBilling},
	{regexp.MustCompile(`(?i)payment required|billing not active|budget exhausted`), SignalBilling},
	{regexp.MustCompile(`(?i)(used all available credits|monthly spending limit|purchase more credits|raise your spending limit|spending_limit)`), SignalBilling},
	{regexp.MustCompile(`(?i)(permission-denied|permission_denied).*?(credits?|spending limit|balance)`), SignalBilling},
}

// MessageSpendSignal recovers the same verdict from an already-unwrapped error
// message (a Responses `response.failed`, a provider trailer). Patterns stay
// narrow so "context length limit" is not mistaken for quota.
// src/quota.ts messageSpendSignal.
func MessageSpendSignal(message string) SpendSignal {
	for _, p := range freeTextSpend {
		if p.re.MatchString(message) {
			return p.signal
		}
	}
	n := normalizeToken(message)
	if billingTokens[n] {
		return SignalBilling
	}
	if quotaTokens[n] {
		return SignalQuota
	}
	return SignalNone
}

// IsProviderRefusal is true when a failed status is a verdict about the
// provider rather than the request, so another provider is worth trying.
// src/quota.ts isProviderRefusal.
func IsProviderRefusal(status int) bool {
	switch status {
	case 401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529:
		return true
	}
	return false
}

// IsRateLimitRefusal is true for a rate/spend refusal that carried no spend
// signal; the provider is benched briefly. src/quota.ts isRateLimitRefusal.
func IsRateLimitRefusal(status int) bool {
	return status == 402 || status == 403 || status == 429
}

var (
	reUnixReset   = regexp.MustCompile(`"resets_at"\s*:\s*(\d{9,12})`)
	reISOReset    = regexp.MustCompile(`(?i)resets?\s+at\s+(\d{4}-\d{2}-\d{2}T[^\s".]+)`)
	reSecondsLeft = regexp.MustCompile(`(?i)"resets_in_seconds"\s*:\s*(\d+)`)
	reHrMin       = regexp.MustCompile(`(?i)resets?\s+in\s+(\d+)\s*hr(?:\s+(\d+)\s*min)?`)
	reHM          = regexp.MustCompile(`(?i)resets?\s+in\s+(\d+)\s*h(?:\s*(\d+)\s*m)?`)
	reWeek        = regexp.MustCompile(`(?i)week`)
)

// UsageLimitReset reads the window label and reset time a spend refusal body
// states. Zero time when the body names none. src/quota.ts captureUsageLimit.
func UsageLimitReset(signal SpendSignal, body string, now time.Time) (string, time.Time) {
	label := "limit"
	if signal == SignalBilling {
		label = "balance"
	} else if reWeek.MatchString(body) {
		label = "week"
	}
	if m := reUnixReset.FindStringSubmatch(body); m != nil {
		if secs, err := strconv.ParseInt(m[1], 10, 64); err == nil && secs > 1_000_000_000 {
			return label, time.Unix(secs, 0).UTC()
		}
	}
	if m := reISOReset.FindStringSubmatch(body); m != nil {
		if t, ok := parseISO(m[1]); ok {
			return label, t
		}
	}
	if m := reSecondsLeft.FindStringSubmatch(body); m != nil {
		if secs, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			return label, now.Add(time.Duration(secs) * time.Second).UTC()
		}
	}
	m := reHrMin.FindStringSubmatch(body)
	if m == nil {
		m = reHM.FindStringSubmatch(body)
	}
	if m != nil {
		hours, _ := strconv.Atoi(m[1])
		minutes := 0
		if len(m) > 2 && m[2] != "" {
			minutes, _ = strconv.Atoi(m[2])
		}
		return label, now.Add(time.Duration(hours*60+minutes) * time.Minute).UTC()
	}
	return label, time.Time{}
}

func parseISO(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// CaptureUsageLimit benches a provider when a failed response carries a spend
// signal, using the reset the body states. Returns true when a limit was
// recorded so the caller can immediately re-route. Host failures never reach
// here — they belong to internal/guard. src/quota.ts captureUsageLimit.
func (t *Tracker) CaptureUsageLimit(provider string, status int, body string) bool {
	signal := ProviderSpendSignal(status, body)
	if signal == SignalNone {
		return false
	}
	label, resets := UsageLimitReset(signal, body, t.now())
	t.MarkSpent(provider, MarkSpentOptions{Label: label, ResetsAt: resets})
	return true
}
