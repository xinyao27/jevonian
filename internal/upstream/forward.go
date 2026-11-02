package upstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/guard"
	"github.com/xinyao27/jevonian/internal/oauth"
	cursorprovider "github.com/xinyao27/jevonian/internal/provider/cursor"
	freebuffprovider "github.com/xinyao27/jevonian/internal/provider/freebuff"
	"github.com/xinyao27/jevonian/internal/quota"
	"github.com/xinyao27/jevonian/internal/saver"
	"github.com/xinyao27/jevonian/internal/softstream"
	"github.com/xinyao27/jevonian/internal/wire"
)

// ForwardDeps are the cross-cutting services one turn's attempts share.
type ForwardDeps struct {
	HTTP     *http.Client   // egress client (system proxy / hardened transport)
	Guard    *guard.Guard   // concurrency cap + breaker; nil means no gating
	Quota    *quota.Tracker // spend bookkeeping; nil means unbenched
	Timeouts Timeouts       // layered budgets; zero loads the env defaults
	// SameHost overrides JEVONIAN_SAME_HOST_RETRIES when non-nil.
	SameHost *int
	Sleep    func(time.Duration)
	// Now feeds reset parsing; nil means time.Now.
	Now      func() time.Time
	Auth     *oauth.Resolver
	Adapters map[config.ProviderType]AdapterFunc
}

// PlanEntry is one ranked failover candidate: a provider plus the model it
// serves, with the effort routing chose for it.
type PlanEntry struct {
	Provider config.Provider
	Model    string
	Effort   string
}

// AttemptRequest is everything one attempt needs that does not depend on the
// candidate.
type AttemptRequest struct {
	PromptPolicy config.PromptPolicyConfig
	TokenSaver   config.TokenSaverConfig
	OnBegin      func()
	OnRetry      func(RetryAttempt)
	ClientKind   ClientKind
	ClientBody   wire.Body // decoded client body; never mutated
	Stream       bool      // client asked for SSE
	// MaxOutput resolves a model's output ceiling; nil means unknown.
	MaxOutput func(model string) int
	// ExtraHeaders are added to every outbound request (session affinity).
	ExtraHeaders http.Header
}

// Attempt is one candidate's classified result. On success, Response.Body is
// wrapped so the guard slot is released only when the body finishes.
type Attempt struct {
	Entry    PlanEntry
	Plan     WirePlan
	Adapter  Adapter
	Stream   bool // upstream was asked to stream
	Outcome  Outcome
	Status   int
	Text     string // drained non-2xx body
	Err      error  // transport error
	Response *http.Response
	Retries  int
	Blocked  guard.Block
	// HoldUntil asks Try to open the guard breaker until a host-named deadline
	// (a queue, a waiting room) rather than a fresh failure count.
	HoldUntil time.Time
	// SentEffort is the effort the outgoing body carried, for the ledger.
	SentEffort  string
	SavedTokens int
	// CacheBody is the prepared body used for conservative cache evidence.
	// CacheEvidenceKnown is false for opaque adapters or unsupported shapes.
	CacheBody          wire.Body
	CacheEvidenceKnown bool
}

// Describe returns the human-readable failure for ledgers and soft errors.
func (a Attempt) Describe() string {
	if a.Err != nil {
		return DescribeError(a.Err)
	}
	if a.Blocked != guard.BlockNone {
		return fmt.Sprintf("provider %q is unavailable (%s)", a.Entry.Provider.Name, a.Blocked)
	}
	if a.Text != "" {
		return a.Text
	}
	if a.Status != 0 {
		return fmt.Sprintf("HTTP %d", a.Status)
	}
	return "upstream attempt failed"
}

// Runner executes attempts. One Runner per process; safe for concurrent use.
type Runner struct {
	deps   ForwardDeps
	client *Client

	freebuffMu sync.Mutex
	freebuff   map[string]*freebuffprovider.Manager
}

// NewRunner builds a Runner from shared deps.
func NewRunner(deps ForwardDeps) *Runner {
	timeouts := deps.Timeouts
	if timeouts == (Timeouts{}) {
		timeouts = LoadTimeouts()
	}
	if deps.Auth == nil {
		deps.Auth = &oauth.Resolver{HTTP: deps.HTTP, CursorToken: cursorprovider.Token}
	}
	if deps.Adapters != nil {
		copied := make(map[config.ProviderType]AdapterFunc, len(deps.Adapters))
		for typ, fn := range deps.Adapters {
			copied[typ] = fn
		}
		deps.Adapters = copied
	}
	return &Runner{
		deps:   deps,
		client: &Client{HTTP: deps.HTTP, Timeouts: timeouts, SameHost: deps.SameHost, Sleep: deps.Sleep},
	}
}

// Timeouts exposes the resolved budgets (keepalive/idle settings read them).
func (r *Runner) Timeouts() Timeouts { return r.client.Timeouts }

func (r *Runner) now() time.Time {
	if r.deps.Now != nil {
		return r.deps.Now()
	}
	return time.Now()
}

// Try runs one candidate inside a guard slot: plan wire → adapter → prepare →
// post → first-byte guard → classify. The caller walks the plan; Try never
// re-decides routing.
//
// Guard accounting (the fix for "one failing provider drags down concurrent
// requests"): a saturated or tripped provider is skipped immediately with
// Blocked set — no queueing. Host failures call End(false); success and
// non-host outcomes End(true) — for a streaming success only once the body is
// fully read; a client cancel calls Release.
func (r *Runner) Try(ctx context.Context, req AttemptRequest, entry PlanEntry) Attempt {
	at := Attempt{Entry: entry}
	plan, err := PlanUpstreamWire(entry.Provider, req.ClientKind, entry.Model)
	if err != nil {
		at.Outcome = Outcome{Kind: OutcomeClientError}
		at.Status = 400
		at.Err = err
		return at
	}
	at.Plan = plan
	adapter, err := AdapterFor(entry.Provider, req.ClientKind, plan)
	if fn := r.deps.Adapters[entry.Provider.Type]; fn != nil {
		if custom, ok := fn(entry.Provider, req.ClientKind, plan); ok {
			adapter, err = custom, nil
		}
	}
	if err != nil {
		at.Outcome = Outcome{Kind: OutcomeClientError}
		at.Status = 400
		at.Err = err
		return at
	}
	at.Adapter = adapter
	at.Stream = req.Stream || adapter.AlwaysStreams()

	var slot *guard.Attempt
	if r.deps.Guard != nil {
		if l, ok := adapter.(concurrencyLimiter); ok {
			r.deps.Guard.SetLimit(entry.Provider.Name, l.MaxConcurrent())
		}
		var block guard.Block
		slot, block = r.deps.Guard.Begin(entry.Provider.Name)
		if block != guard.BlockNone {
			at.Blocked = block
			at.Outcome = Outcome{Kind: OutcomeHostFailure}
			return at
		}
	}

	if req.OnBegin != nil {
		req.OnBegin()
	}
	r.attempt(ctx, req, &at)

	switch at.Outcome.Kind {
	case OutcomeSuccess:
		if at.Response != nil && at.Response.Body != nil {
			// Streams end only after the body finishes or the client cancels.
			at.Response.Body = &guardedBody{ReadCloser: at.Response.Body, slot: slot, ctx: ctx}
		} else {
			slot.End(true)
		}
	case OutcomeHostFailure:
		slot.End(false)
	case OutcomeCanceled:
		slot.Release()
	default:
		// Client errors, quota/rate-limit refusals and provider refusals are
		// not verdicts about the host's health. A host-named busy-until is a
		// host verdict, so it holds the breaker instead of End(false)'s count.
		if !at.HoldUntil.IsZero() {
			slot.Hold(at.HoldUntil)
		} else {
			slot.End(true)
		}
	}
	return at
}

func cacheBodyForEvidence(body wire.Body, req AttemptRequest) (wire.Body, bool) {
	if req.TokenSaver.Enabled && containsToolResult(body) {
		return nil, false
	}
	return cloneBody(body), true
}

func (r *Runner) attempt(ctx context.Context, req AttemptRequest, at *Attempt) {
	entry := at.Entry
	provider := entry.Provider
	maxOutput := 0
	if req.MaxOutput != nil {
		maxOutput = req.MaxOutput(entry.Model)
	}
	body, err := at.Adapter.Prepare(PrepInput{
		PromptPolicy: req.PromptPolicy,
		Provider:     provider,
		Model:        entry.Model,
		Effort:       entry.Effort,
		ClientKind:   req.ClientKind,
		ClientBody:   cloneBody(req.ClientBody),
		UpstreamWire: at.Plan.Wire,
		Bridge:       at.Plan.Bridge,
		Stream:       at.Stream,
		ClientStream: req.Stream,
		MaxOutput:    maxOutput,
	})
	if err != nil {
		at.Outcome = Outcome{Kind: OutcomeClientError}
		at.Status = 400
		at.Err = err
		return
	}
	if _, plainOpenAI := at.Adapter.(*openaiAdapter); plainOpenAI {
		at.CacheBody, at.CacheEvidenceKnown = cacheBodyForEvidence(body, req)
	} else if _, plainAnthropic := at.Adapter.(*anthropicAdapter); plainAnthropic {
		at.CacheBody, at.CacheEvidenceKnown = cacheBodyForEvidence(body, req)
	} else if _, plainResponses := at.Adapter.(*responsesAdapter); plainResponses {
		at.CacheBody, at.CacheEvidenceKnown = cacheBodyForEvidence(body, req)
	}
	// Run after every adapter's full wire assembly; some hosts opt out.
	if o, ok := at.Adapter.(tokenSaverOptOut); !ok || !o.SkipsTokenSaver() {
		saved := saver.SaveTokens(ctx, body, req.TokenSaver)
		saver.WarnUnavailable(req.TokenSaver, saved.Stats.Unavailable)
		if saved.Stats.SavedTokens > 0 {
			body = saved.Body
			at.SavedTokens = saved.Stats.SavedTokens
		}
	}
	at.SentEffort = sentEffort(body, at.Plan.Wire)
	if at.CacheEvidenceKnown && at.SentEffort != sentEffort(at.CacheBody, at.Plan.Wire) {
		at.CacheBody, at.CacheEvidenceKnown = nil, false
	}
	auth := oauth.AuthResolution{}
	if provider.Type != config.ProviderTypeChatGPTWeb {
		auth, err = r.deps.Auth.ResolveProviderAuth(ctx, provider, oauth.WireKind(at.Plan.Wire), req.ExtraHeaders.Get("x-jevonian-session"))
		if err != nil {
			at.Outcome = Outcome{Kind: OutcomeProviderRefusal}
			at.Status = 401
			at.Err = err
			return
		}
	}
	// Adapters that own the whole exchange (Connect-RPC, session-bound hosts).
	if own, ok := at.Adapter.(attemptRunner); ok {
		own.runAttempt(r, ctx, req, at, body, auth)
		return
	}
	headers := make(http.Header)
	for k, v := range auth.Headers {
		headers.Set(k, v)
	}
	oauth.WithSessionAffinity(auth.Headers, provider, req.ExtraHeaders.Get("x-jevonian-session"), req.ExtraHeaders)
	for k, v := range auth.Headers {
		headers.Set(k, v)
	}
	headers = at.Adapter.Headers(provider, headers)
	for k, vals := range req.ExtraHeaders {
		for _, v := range vals {
			headers.Set(k, v)
		}
	}
	url := at.Adapter.EndpointURL(provider)
	if url == "" {
		url = UpstreamURLFor(provider, at.Plan.Wire)
	}

	opts := PostOptions{URL: url, Headers: headers, Body: MarshalBody(body), Stream: at.Stream, OnRetry: req.OnRetry}
	result, err := r.client.Post(ctx, opts)
	at.Retries = result.Retries
	isAuthErr := result.Response.StatusCode == 401 || (result.Response.StatusCode == 403 && strings.Contains(strings.ToLower(result.Text), "unauthenticated"))
		if err == nil && isAuthErr && provider.Auth == config.AuthOAuth && provider.OAuthSource != config.OAuthStatic {
		r.deps.Auth.Invalidate(string(provider.OAuthSource), provider.Login)
		if fresh, refreshErr := r.deps.Auth.ResolveProviderAuth(ctx, provider, oauth.WireKind(at.Plan.Wire), req.ExtraHeaders.Get("x-jevonian-session")); refreshErr == nil {
			for k, v := range fresh.Headers {
				opts.Headers.Set(k, v)
			}
			if req.OnRetry != nil {
				req.OnRetry(RetryAttempt{Failure: RetryFailure{Status: 401}})
			}
			result, err = r.client.Post(ctx, opts)
			at.Retries += 1 + result.Retries
		}
	}
	if err != nil {
		at.Err = err
		at.Outcome = Classify(0, "", err)
		if ctx.Err() != nil {
			at.Outcome = Outcome{Kind: OutcomeCanceled}
		}
		return
	}
	resp := result.Response
	if r.deps.Quota != nil && resp != nil {
		// The response's own rate-limit headers record the real window.
		r.deps.Quota.CaptureRateLimitHeaders(provider.Name, resp.Header)
	}
	at.Status = resp.StatusCode
	at.Text = result.Text

	if at.Status >= 200 && at.Status < 300 && at.Stream {
		guarded, gerr := GuardFirstByte(ctx, resp, r.client.Timeouts.FirstByteMS)
		if gerr != nil {
			at.Err = gerr
			at.Outcome = Classify(0, "", gerr)
			if ctx.Err() != nil {
				at.Outcome = Outcome{Kind: OutcomeCanceled}
			}
			return
		}
		resp = guarded
		resp.Body = softstream.IdleGuard(resp.Body, r.client.Timeouts.IdleMS)
	}
	if wrapper, ok := at.Adapter.(responseWrapper); ok && at.Status >= 200 && at.Status < 300 {
		wrapped, werr := wrapper.WrapResponse(resp, at.Stream, entry.Model)
		if werr != nil {
			at.Err = werr
			at.Outcome = Classify(0, "", werr)
			return
		}
		resp = wrapped
	}
	at.Response = resp
	at.Outcome = Classify(at.Status, at.Text, nil)
	// Header exhaustion is a same-request quota failover for provider-side
	// refusals (401/403/429/5xx), even when the body carried no spend token.
	// Do not rewrite a client error (400 Unsupported parameter, …) — that
	// would hide the real failure behind a fake "quota" label and keep
	// failover walking. Do not replace the measured window.
	if at.Status >= 300 && at.Outcome.Signal == quota.SignalNone &&
		(at.Outcome.Kind == OutcomeHostFailure || at.Outcome.Kind == OutcomeRateLimit || at.Outcome.Kind == OutcomeProviderRefusal) &&
		r.deps.Quota != nil &&
		r.deps.Quota.ProviderHealth(provider, quota.HealthOptions{}).Status == quota.StatusExhausted {
		at.Outcome.Kind = OutcomeQuotaRefusal
		return
	}
	r.bench(provider, at)
}

// bench records quota/billing/rate-limit refusals in internal/quota. Host
// failures are deliberately absent: they belong to the guard breaker, and
// marking them as spend would show a flaky host as "exhausted".
func (r *Runner) bench(provider config.Provider, at *Attempt) {
	t := r.deps.Quota
	if t == nil {
		return
	}
	switch at.Outcome.Kind {
	case OutcomeQuotaRefusal:
		label, resets := quota.UsageLimitReset(at.Outcome.Signal, at.Text, r.now())
		at.Outcome.Label = label
		if !resets.IsZero() {
			at.Outcome.Resets = resets.UnixMilli()
		}
		t.MarkSpent(provider.Name, quota.MarkSpentOptions{Label: label, ResetsAt: resets})
	case OutcomeRateLimit:
		// Nothing recorded this refusal; bench briefly so the next turn's routing
		// does not pick the same host straight back up — unless the response's
		// own headers already marked the account exhausted.
		if t.ProviderHealth(provider, quota.HealthOptions{}).Status == quota.StatusExhausted {
			return
		}
		t.MarkSpent(provider.Name, quota.MarkSpentOptions{
			Label:    "rate-limit",
			ResetsAt: r.now().Add(quota.ProviderCooldown),
		})
	}
}

// guardedBody holds the guard slot until the stream finishes.
type guardedBody struct {
	io.ReadCloser
	slot *guard.Attempt
	ctx  context.Context
	once sync.Once
	err  error
}

func (g *guardedBody) Read(p []byte) (int, error) {
	n, err := g.ReadCloser.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		g.err = err
	}
	if errors.Is(err, io.EOF) {
		g.finish()
	}
	return n, err
}

func (g *guardedBody) Close() error {
	err := g.ReadCloser.Close()
	g.finish()
	return err
}

func (g *guardedBody) finish() {
	g.once.Do(func() {
		switch {
		case g.ctx != nil && g.ctx.Err() != nil:
			g.slot.Release()
		case g.err != nil && (IsRetryableError(g.err) || IsTimeout(g.err)):
			g.slot.End(false)
		default:
			g.slot.End(true)
		}
	})
}

func cloneBody(b wire.Body) wire.Body {
	out := make(wire.Body, len(b))
	for k, v := range b {
		out[k] = v
	}
	return out
}

func sentEffort(body wire.Body, w config.UpstreamWire) string {
	switch w {
	case KindAnthropic:
		if oc, ok := body["output_config"].(map[string]any); ok {
			if e, ok := oc["effort"].(string); ok {
				return e
			}
		}
		if th, ok := body["thinking"].(map[string]any); ok {
			if t, _ := th["type"].(string); t == "enabled" || t == "adaptive" {
				return t
			}
		}
	case KindResponses:
		if r, ok := body["reasoning"].(map[string]any); ok {
			if e, ok := r["effort"].(string); ok {
				return e
			}
		}
	default:
		if e, ok := body["reasoning_effort"].(string); ok {
			return e
		}
	}
	return ""
}
