package upstream

import (
	"strings"

	"github.com/xinyao27/jevonian/internal/quota"
)

// OutcomeKind classifies one upstream attempt's verdict. Provider packages
// (cursor/devin) map their own error kinds onto this so the attempt loop
// drives guard / quota / failover decisions from one enum.
// src/quota.ts providerSpendSignal + src/upstream.ts refusal handling.
type OutcomeKind int

const (
	// OutcomeSuccess is a 2xx with a usable body.
	OutcomeSuccess OutcomeKind = iota
	// OutcomeHostFailure is a transport error, timeout, or retryable 5xx —
	// a verdict about the host. Bench via guard.End(false), then fail over.
	OutcomeHostFailure
	// OutcomeQuotaRefusal is a classified quota/billing refusal — bench via
	// quota (real reset when stated), never the breaker.
	OutcomeQuotaRefusal
	// OutcomeRateLimit is an unclassified 402/403/429 — still a provider
	// refusal; bench briefly via quota.MarkSpent, then fail over.
	OutcomeRateLimit
	// OutcomeProviderRefusal is any other verdict about the provider
	// (401 key rejection, 404 unknown model, 529 overloaded, …) that another
	// provider may still serve. Not benched: only quota verdicts record spend.
	OutcomeProviderRefusal
	// OutcomeContextOverflow is a 400/413/422 whose body says the context
	// window overflowed; the server may compact and re-route.
	OutcomeContextOverflow
	// OutcomeClientError is a verdict about the request (400/413/422 without
	// an overflow marker): pass the error through to the client untouched.
	OutcomeClientError
	// OutcomeCanceled is the client hanging up; free the guard slot without
	// judging the host.
	OutcomeCanceled
)

// Outcome is one attempt's classified result.
type Outcome struct {
	Kind   OutcomeKind
	Signal quota.SpendSignal // billing or quota, when classified
	Label  string            // window label the refusal body stated ("5h", "week")
	Resets int64             // reset the refusal stated, epoch ms; 0 unknown
}

// Failoverable reports whether routing should walk the next candidate.
func (o Outcome) Failoverable() bool {
	switch o.Kind {
	case OutcomeHostFailure, OutcomeQuotaRefusal, OutcomeRateLimit, OutcomeProviderRefusal:
		return true
	}
	return false
}

// contextOverflowRE matches the wording providers use for a too-long request.
// src/upstream.ts isContextOverflowResponse.
var contextOverflowRE = reContextOverflow()

// Classify gives one verdict for a finished attempt — status plus drained body
// for HTTP replies, err for transport failures — so guard, quota and failover
// each act on the same call.
func Classify(status int, body string, err error) Outcome {
	if err != nil {
		if isContextCancel(err) {
			return Outcome{Kind: OutcomeCanceled}
		}
		if IsRetryableError(err) || IsTimeout(err) {
			return Outcome{Kind: OutcomeHostFailure}
		}
		return Outcome{Kind: OutcomeClientError}
	}
	if status >= 200 && status < 300 {
		return Outcome{Kind: OutcomeSuccess}
	}

	if sig := quota.ProviderSpendSignal(status, body); sig != quota.SignalNone {
		return Outcome{Kind: OutcomeQuotaRefusal, Signal: sig}
	}
	if isContextOverflow(status, body) {
		return Outcome{Kind: OutcomeContextOverflow}
	}
	if IsRetryableStatus(status) {
		return Outcome{Kind: OutcomeHostFailure}
	}
	if quota.IsRateLimitRefusal(status) {
		return Outcome{Kind: OutcomeRateLimit}
	}
	if quota.IsProviderRefusal(status) {
		return Outcome{Kind: OutcomeProviderRefusal}
	}
	if status == 400 && (strings.Contains(body, "Unexpected item type in content") || strings.Contains(body, "invalid_parameter_error")) {
		return Outcome{Kind: OutcomeProviderRefusal}
	}
	return Outcome{Kind: OutcomeClientError}
}

func isContextCancel(err error) bool {
	return isContextCancelErr(err)
}

func isContextOverflow(status int, text string) bool {
	if status != 400 && status != 413 && status != 422 {
		return false
	}
	return contextOverflowRE.MatchString(text)
}
