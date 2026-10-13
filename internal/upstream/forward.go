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
	Auth     *oauth.Resolver
	Guard    *guard.Registry
	Quota    *quota.Tracker
	Timeouts Timeouts
	SameHost *int
	Sleep    func(time.Duration)
	Adapters AdapterFunc
}

// Runner drives the attempt loop for one plan.
type Runner struct {
	deps   ForwardDeps
	client *Client
}

// NewRunner sets up the attempt runner.
func NewRunner(deps ForwardDeps) *Runner {
	return &Runner{
		deps: deps,
		client: &Client{
			HTTP:     deps.HTTP,
			Timeouts: deps.Timeouts,
			SameHost: deps.SameHost,
			Sleep:    deps.Sleep,
		},
	}
}

// PlanEntry is one candidate the router considered.
type PlanEntry struct {
	Provider config.Provider
	Model    string
	Effort   string // routing-chosen reasoning effort
	Skip     bool
	Reason   string
}

// AttemptRequest is everything a runner needs to know about the turn.
type AttemptRequest struct {
	ClientKind    ClientKind
	Stream        bool
	Body          wire.Body
	ExtraHeaders  http.Header
	PromptPolicy  config.PromptPolicyConfig
	TokenSaver    config.TokenSaverConfig
	QuotaGuard    config.QuotaGuardConfig
	AllowSameHost bool
	OnRetry       func(RetryAttempt)
}

// Attempt is the telemetry + result of one model / provider try.
type Attempt struct {
	Provider           config.Provider
	AttemptModel       string
	Plan               WirePlan
	Adapter            Adapter
	Stream             bool
	Outcome            Outcome
	Status             int
	Err                error
	Retries            int
	CacheBody          wire.Body
	CacheEvidenceKnown bool
	SavedTokens        int
	SentEffort         string
	Effort             string
}

func (r *Runner) adapterFor(p config.Provider, kind ClientKind, plan WirePlan) (Adapter, error) {
	if r.deps.Adapters != nil {
		if a, ok := r.deps.Adapters(p, kind, plan); ok {
			return a, nil
		}
	}
	return AdapterFor(p, kind, plan)
}

// Try runs one plan entry through guards, egress assembly and upstream POST.
// Returns the completed attempt record; callers read Outcome and Status.
func (r *Runner) Try(ctx context.Context, req AttemptRequest, pe PlanEntry) *Attempt {
	at := &Attempt{
		Provider:     pe.Provider,
		AttemptModel: pe.Model,
		Stream:       req.Stream,
		Effort:       pe.Effort,
	}

	plan, err := PlanUpstreamWire(pe.Provider, req.ClientKind, pe.Model)
	if err != nil {
		at.Outcome = Outcome{Kind: OutcomePlanRefusal}
		at.Status = 400
		at.Err = err
		return at
	}
	at.Plan = plan

	adapter, err := r.adapterFor(pe.Provider, req.ClientKind, plan)
	if err != nil {
		at.Outcome = Outcome{Kind: OutcomePlanRefusal}
		at.Status = 500
		at.Err = err
		return at
	}
	at.Adapter = adapter
	if adapter.AlwaysStreams() {
		at.Stream = true
	}

	r.attempt(ctx, req, at)
	return at
}

func maxOutputFor(p config.Provider, model string) int {
	for _, m := range p.Models {
		if m.ID == model {
			return m.MaxOutput
		}
	}
	return 0
}

func (r *Runner) attempt(ctx context.Context, req AttemptRequest, at *Attempt) {
	provider := at.Provider
	maxOutput := maxOutputFor(provider, at.AttemptModel)

	body, err := at.Adapter.Prepare(PrepInput{
		PromptPolicy: req.PromptPolicy,
		Provider:     provider,
		Model:        at.AttemptModel,
		Effort:       at.Effort,
		ClientKind:   req.ClientKind,
		ClientBody:   req.Body,
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
	if err == nil && result.Response.StatusCode == 401 && provider.Auth == config.AuthOAuth && provider.OAuthSource != config.OAuthStatic {
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
	if err == nil && result.Response.StatusCode == 400 &&
		strings.Contains(result.Text, "thinking") &&
		strings.Contains(result.Text, "cannot be modified") {
		if strippedBody, changed := StripAllThinking(body); changed {
			opts.Body = MarshalBody(strippedBody)
			if req.OnRetry != nil {
				req.OnRetry(RetryAttempt{Failure: RetryFailure{Status: 400}})
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
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		at.Outcome = Outcome{Kind: OutcomeSuccess}
		return
	}
	at.Outcome = Classify(resp.StatusCode, result.Text, nil)
}

func cacheBodyForEvidence(body wire.Body, req AttemptRequest) (wire.Body, bool) {
	if req.TokenSaver.Enabled && containsToolResult(body) {
		return nil, false
	}
	return body, true
}
