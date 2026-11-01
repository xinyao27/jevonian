package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/guard"
	"github.com/xinyao27/jevonian/internal/ledger"
	"github.com/xinyao27/jevonian/internal/quota"
	"github.com/xinyao27/jevonian/internal/routing"
	"github.com/xinyao27/jevonian/internal/server/admin/trace"
	"github.com/xinyao27/jevonian/internal/softstream"
	"github.com/xinyao27/jevonian/internal/upstream"
	"github.com/xinyao27/jevonian/internal/wire"
	anthropicwire "github.com/xinyao27/jevonian/internal/wire/anthropic"
	openaiwire "github.com/xinyao27/jevonian/internal/wire/openai"
	responseswire "github.com/xinyao27/jevonian/internal/wire/responses"
)

const (
	cacheAdapterVersion   = "adapter-v1"
	cacheConverterVersion = "wire-v1"

	// KindOpenAI etc. alias upstream's client-wire constants.
	KindOpenAI    = upstream.KindOpenAI
	KindAnthropic = upstream.KindAnthropic
	KindResponses = upstream.KindResponses
)

// PlanEntry is one ranked failover candidate handed to the attempt loop.
type PlanEntry = upstream.PlanEntry

// AttemptRequest is everything one attempt needs that does not depend on the
// candidate.
type AttemptRequest = upstream.AttemptRequest

// Attempt is one candidate's classified result.
type Attempt = upstream.Attempt

// Runner executes upstream attempts for this server.
type Runner = upstream.Runner

// ForwardDeps wires the runner's shared services.
type ForwardDeps = upstream.ForwardDeps

// NewRunner builds the shared Runner.
func NewRunner(d upstream.ForwardDeps) *upstream.Runner { return upstream.NewRunner(d) }

// turn is one routed request's state.
type turn struct {
	srv         *Server
	cfg         *config.Config
	kind        upstream.ClientKind
	path        string
	requestID   string
	keyID       string
	keyName     string
	started     time.Time
	stream      bool
	decision    *routing.Decision
	body        wire.Body
	cacheBody   wire.Body
	cacheScope  string
	cacheKnown  bool
	cacheWire   config.UpstreamWire
	headers     map[string]string
	retries     int
	failovers   int
	savedTokens int
	trace       *trace.Store
	recorded    bool
	tried       map[string]bool
	// overflowRetries counts compact-and-retry rounds after a provider's hard
	// context rejection; at most one per turn.
	overflowRetries int
	// exclusiveInput is set by deliver from the answering adapter: its usage
	// input already excludes cache reads.
	exclusiveInput bool
	hasUsage       bool
	// capture is the request payload queued by captureRequest so record can
	// re-save it with the response merged in. nil when capture never ran.
	capture map[string]any
	// respCapture tees a streaming turn's client-wire bytes; respData holds the
	// final client-wire JSON of a non-stream turn. Exactly one is set on a
	// successful turn.
	respCapture *streamCapture
	respData    []byte
}

// handleChat is the routing-driven inference flow for every /v1 inference path.
func (s *Server) handleChat(w http.ResponseWriter, r *http.Request, keyID, keyName string, kind upstream.ClientKind) {
	started := time.Now()
	cfg := s.Config()
	if cfg == nil {
		writeJSONError(w, http.StatusInternalServerError, "jevonian_error", "server config is not loaded")
		return
	}
	raw, err := readRequestBody(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "Failed to read body")
		return
	}
	var body wire.Body
	if err := json.Unmarshal(raw, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "Invalid JSON body")
		return
	}
	if body == nil {
		body = wire.Body{}
	}
	// ChatGPT Desktop dual catalog: a native OpenAI model keeps using the real
	// backend with the client's own credential. Only `jevonian/*` (and bare
	// `auto`) stay on Jevonian. src/upstream.ts proxyNativeCodex call site.
	if kind == upstream.KindResponses || kind == upstream.KindOpenAI {
		model, _ := body["model"].(string)
		if s.nativeCodexPassthrough(w, r, keyID, model, raw) {
			return
		}
	}
	// Claude Desktop can only ask for the Claude ids it knows; translate a
	// gateway stand-in back to the Jevonian model before routing.
	if kind == upstream.KindAnthropic {
		if requested, _ := body["model"].(string); requested != "" {
			desktop := routing.DesktopModels(cfg)
			pinned := func(id string) bool {
				for _, p := range cfg.Providers {
					for _, e := range p.Models {
						if e.ID == id {
							return true
						}
					}
				}
				return false
			}
			if stand := resolveClaudeGatewayModel(requested, desktop, cfg.Routing.Mode == "auto",
				pinned, isClaudeGatewayRequest(r.Header)); stand != "" {
				body["model"] = stand
			}
		}
	}
	t := &turn{
		srv:       s,
		cfg:       cfg,
		kind:      kind,
		path:      r.URL.Path,
		requestID: uuid.NewString(),
		keyID:     keyID,
		keyName:   keyName,
		started:   started,
		stream:    wire.Bool(body["stream"]),
		body:      body,
		headers:   requestHeaders(r),
		tried:     map[string]bool{},
	}
	t.serve(w, r)
}

// serve routes once, then walks the failover plan.
func (t *turn) serve(w http.ResponseWriter, r *http.Request) {
	decision, err := t.initialDecision(r.Context())
	if err != nil {
		status := 400
		msg := err.Error()
		var re *routing.RouteError
		if asRouteError(err, &re) {
			status = re.Status
			msg = re.Message
		}
		t.record(status, wire.Usage{}, nil, false, msg)
		writeJSONError(w, status, "jevonian_error", msg)
		return
	}
	t.decision = decision
	t.trace = trace.New(nil)
	t.trace.BeginRoute(trace.Init{RequestID: t.requestID, Session: decision.Session, Path: t.path, Stream: t.stream, StartedAt: t.started.UnixMilli()})

	// A conservative token estimate can be a false positive. Try to compact
	// proactively, but if Jev is unavailable or there are no stale tool results,
	// let the provider make the final call. src/upstream.ts (contextOverflow).
	if decision.ContextOverflow && !t.remoteCompaction() {
		t.compactAndReroute(r.Context(), false)
	}
	t.tried[routing.PlanKey(t.decision.Provider, t.decision.Model)] = true
	t.run(w, r)
}

// run walks the decision's candidate plan until one provider answers.
func (t *turn) run(w http.ResponseWriter, r *http.Request) {
	for {
		cand := t.currentCandidate()
		if cand == nil {
			t.writeUnavailable(w, upstream.Attempt{
				Outcome: upstream.Outcome{Kind: upstream.OutcomeHostFailure},
				Err:     fmt.Errorf("provider %q is not configured", t.decision.Provider),
			})
			return
		}
		// Codex remote compaction only a native Responses host can answer; a
		// bridged Chat Completions reply has no compaction item.
		if t.remoteCompaction() && cand.Provider.Type != config.ProviderTypeResponses {
			msg := fmt.Sprintf("Remote compaction requires ChatGPT's Responses API; %q cannot serve it.", cand.Provider.Name)
			t.record(http.StatusBadRequest, wire.Usage{}, nil, true, msg)
			t.writeError(w, http.StatusBadRequest, msg)
			return
		}
		t.captureRequest()
		attempt := t.runner().Try(r.Context(), t.attemptRequest(), *cand)
		t.retries += attempt.Retries
		t.savedTokens = attempt.SavedTokens
		if attempt.Blocked != guard.BlockNone {
			if !t.failover() {
				t.writeUnavailable(w, attempt)
				return
			}
			continue
		}
		if attempt.Outcome.Kind != upstream.OutcomeSuccess {
			t.endAttempt(attempt)
		}
		switch attempt.Outcome.Kind {
		case upstream.OutcomeSuccess:
			t.cacheBody, t.cacheKnown, t.cacheWire = attempt.CacheBody, attempt.CacheEvidenceKnown, attempt.Plan.Wire
			t.cacheScope = ""
			if attempt.CacheEvidenceKnown {
				t.cacheScope = t.cacheScopeFor(cand.Provider, cand.Model, attempt.Plan.Wire)
			}
			// A folded 200 can still hide a `response.failed` quota verdict;
			// deliver reports it so the turn moves to the next provider.
			if t.deliver(w, r, attempt) && t.failover() {
				continue
			}
			return
		case upstream.OutcomeCanceled:
			t.record(499, wire.Usage{}, nil, false, "client canceled")
			return
		case upstream.OutcomeContextOverflow:
			// The provider's own window is smaller than the estimate said. Shrink
			// once and re-route; any other outcome is the client's answer.
			if t.overflowRetries == 0 && !t.remoteCompaction() {
				t.overflowRetries++
				if t.compactAndReroute(r.Context(), true) {
					continue
				}
			}
			// When compaction is unavailable or insufficient, fail over to the next
			// candidate in the plan (e.g. models with larger context windows).
			if t.failover() {
				continue
			}
			t.writeRefusal(w, attempt)
			return
		case upstream.OutcomeClientError:
			t.writeRefusal(w, attempt)
			return
		default:
			if !t.failover() {
				t.writeRefusal(w, attempt)
				return
			}
		}
	}
}

// captureRequest dumps the request body and routing decision for the log
// detail view (src/upstream.ts saveBody kind "request"). Runs per attempt, so a
// failover overwrites the capture with the provider that finally answered.
func (t *turn) captureRequest() {
	d := t.decision
	if d == nil {
		return
	}
	// A failover overwrites the capture: drop the previous attempt's answer too.
	t.respCapture = nil
	t.respData = nil
	decision := map[string]any{
		"provider":       d.Provider,
		"model":          d.Model,
		"requestedModel": d.RequestedModel,
		"phase":          d.Phase,
		"reason":         d.Reason,
		"cache":          d.Cache,
		"brain":          string(d.Brain),
	}
	if d.SwitchPenaltyUSD != nil {
		decision["switchPenaltyUsd"] = *d.SwitchPenaltyUSD
	}
	if d.BrainChannel != "" {
		decision["brainChannel"] = d.BrainChannel
	}
	if d.Canonical != "" {
		decision["canonical"] = d.Canonical
	}
	t.capture = map[string]any{
		"kind":     "request",
		"at":       time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"path":     strings.TrimPrefix(t.path, "/v1"),
		"decision": decision,
		"body":     t.body,
	}
	SaveBody(t.requestID, t.capture)
}

// saveResponseCapture re-saves the request capture with the model's answer
// merged in as a top-level `response`. It runs once per turn from record, after
// the stream has ended, so the tee buffer is settled. A turn whose request was
// never captured writes nothing.
func (t *turn) saveResponseCapture(status int, errText string) {
	if t.capture == nil || !captureEnabled() {
		return
	}
	wireKind := string(t.kind)
	var response map[string]any
	switch {
	case t.respCapture != nil:
		data, truncated := t.respCapture.snapshot()
		response = normalizeResponse(t.kind, true, data)
		if truncated {
			response["truncated"] = true
		}
	case t.respData != nil:
		response = normalizeResponse(t.kind, false, t.respData)
	case errText != "":
		response = map[string]any{"wire": wireKind, "text": ""}
	default:
		return
	}
	response["wire"] = wireKind
	response["status"] = status
	response["stream"] = t.stream
	if errText != "" {
		response["error"] = t.redactText(errText)
	}
	t.capture["response"] = response
	SaveBody(t.requestID, t.capture)
}

// redactText scrubs the answering provider's credential from text before it is
// stored in a capture the dashboard shows.
func (t *turn) redactText(text string) string {
	if t.decision == nil {
		return text
	}
	for i := range t.cfg.Providers {
		if t.cfg.Providers[i].Name == t.decision.Provider {
			return softstream.RedactSecrets(text, config.ResolveAPIKey(t.cfg.Providers[i]))
		}
	}
	return text
}

func (t *turn) decide(ctx context.Context) (*routing.Decision, error) {
	return t.decideBody(ctx, t.body)
}

func (t *turn) decideBody(ctx context.Context, body wire.Body) (*routing.Decision, error) {
	input := routing.Input{
		Config:    t.cfg,
		Body:      body,
		Headers:   t.headers,
		Store:     t.srv.deps.Store,
		Kind:      routing.RequestKind(t.kind),
		RequestID: t.requestID,
		KeyID:     t.keyID,
		KeyName:   t.keyName,
	}
	deps := t.routingDeps(body)
	return routing.Decide(ctx, deps, input)
}

// cacheScopeKind invalidates source evidence when outgoing prompt policy changes.
func (t *turn) cacheScopeKind() string {
	policy, _ := json.Marshal(struct {
		Prompt     config.PromptPolicyConfig
		TokenSaver config.TokenSaverConfig
	}{t.cfg.PromptPolicy, t.cfg.TokenSaver})
	return string(t.kind) + "\x00" + t.keyID + "\x00" + string(policy)
}

func (t *turn) cacheScopeFor(provider config.Provider, model string, wireKind config.UpstreamWire) string {
	return routing.CacheScope(provider, fmt.Sprintf("%s\x00%s\x00%s\x00%s", t.cacheScopeKind(), wireKind, cacheAdapterVersion, cacheConverterVersion), config.ResolveAPIKey(provider))
}

func (t *turn) routingDeps(bodies ...wire.Body) routing.Deps {
	deps := t.srv.deps.Routing
	if deps.Quota == nil && t.srv.deps.Quota != nil {
		deps.Quota = routing.QuotaSourceFunc(t.srv.quotaStanding)
	}
	if deps.Guard == nil && t.srv.deps.Guard != nil {
		deps.Guard = t.srv.deps.Guard
	}
	if deps.RecordBrainCall == nil {
		deps.RecordBrainCall = BrainRecorder(t.srv.deps.Ledger, deps.Prices)
	}
	evidenceBody := t.body
	if len(bodies) > 0 {
		evidenceBody = bodies[0]
	}
	deps.CacheEvidence = func(provider, model string) (string, routing.CachePrefix) {
		for i := range t.cfg.Providers {
			p := t.cfg.Providers[i]
			if p.Name != provider {
				continue
			}
			prepared, wireKind, known := upstream.PreviewCacheBody(p, model, t.kind, evidenceBody, t.cfg.PromptPolicy, t.cfg.TokenSaver, t.stream)
			if !known || prepared == nil {
				return "", routing.CachePrefix{}
			}
			if p.Type == config.ProviderTypeResponses {
				return "", routing.CachePrefix{}
			}
			return t.cacheScopeFor(p, model, wireKind), routing.BuildCachePrefix(prepared)
		}
		return "", routing.CachePrefix{}
	}
	return deps
}

func (s *Server) quotaStanding(provider config.Provider, model string, now int64, lowPercent float64) routing.QuotaView {
	health, exhausted, renews := s.deps.Quota.Standing(provider, model, now, lowPercent)
	return routing.QuotaView{
		Status:         health.Status,
		UsedPercent:    health.UsedPercent,
		Renews:         renews,
		ModelExhausted: exhausted,
	}
}

func (t *turn) runner() *upstream.Runner { return t.srv.runner }

func (t *turn) currentCandidate() *upstream.PlanEntry {
	d := t.decision
	if d == nil {
		return nil
	}
	for i := range t.cfg.Providers {
		if t.cfg.Providers[i].Name == d.Provider {
			return &upstream.PlanEntry{
				Provider: t.cfg.Providers[i],
				Model:    d.Model,
				Effort:   d.Effort,
			}
		}
	}
	return nil
}

func (t *turn) attemptRequest() upstream.AttemptRequest {
	return upstream.AttemptRequest{
		PromptPolicy: t.cfg.PromptPolicy,
		TokenSaver:   t.cfg.TokenSaver,
		OnBegin:      t.beginAttempt,
		OnRetry:      t.retryAttempt,
		ClientKind:   t.kind,
		ClientBody:   t.body,
		Stream:       t.stream,
		MaxOutput:    t.maxOutput,
		ExtraHeaders: t.sessionAffinity(),
	}
}

func (t *turn) sessionAffinity() http.Header {
	h := http.Header{}
	if t.decision != nil && t.decision.Session != "" {
		h.Set("x-jevonian-session", t.decision.Session)
	}
	return h
}

func (t *turn) failover() bool {
	if t.kind == upstream.KindResponses && responseswire.IsRemoteCompactionV2(t.body) {
		return false
	}
	next := t.decision.NextFromPlan(t.tried)
	if next == nil {
		return false
	}
	t.tried[routing.PlanKey(next.Provider, next.Model)] = true
	next.Reason = routing.WithQuotaFailover(next.Reason)
	t.decision = next
	t.failovers++
	if t.srv.deps.Store != nil && next.Session != "" {
		t.srv.deps.Store.Retarget(next.Session, next.Provider, next.Model, time.Now().UnixMilli())
	}
	return true
}

// deliver writes a successful attempt back in the client's wire, bridging when
// the plan called for it. Returns false when a folded upstream refusal was
// marked spent and the turn should fail over instead of answering.
func (t *turn) deliver(w http.ResponseWriter, r *http.Request, attempt upstream.Attempt) bool {
	d := t.decision
	// The convention follows the translator that produced the usage, not the
	// provider: a streaming Chat upstream bridged to an Anthropic client is
	// re-split to exclusive input, while a folded non-stream reply keeps the
	// upstream's inclusive OpenAI count.
	t.exclusiveInput = upstream.LedgerExclusive(attempt.Plan, t.kind, t.stream)
	headers := t.decisionHeaders(attempt.Retries)
	upstreamWire := attempt.Plan.Wire
	bridge := attempt.Plan.Bridge
	usage := wire.Usage{}

	// fold renders the upstream JSON body as the client wire's bytes.
	fold := func(body []byte) ([]byte, wire.Usage) {
		var resp wire.Body
		_ = json.Unmarshal(body, &resp)
		switch {
		case upstreamWire == upstream.KindAnthropic && bridge == "to-anthropic":
			u := anthropicwire.Usage(resp["usage"])
			chat := anthropicwire.ToChat(resp, d.Model)
			return finishJSON(chat, t.kind, d.Model, u, t), u
		case upstreamWire == upstream.KindOpenAI && bridge == "to-openai":
			u := openaiwire.CompletionUsage(body)
			usage2 := wire.Usage{Input: u.PromptTokens, Output: u.CompletionTokens, CacheRead: u.CacheRead}
			return finishJSON(resp, t.kind, d.Model, usage2, t), usage2
		case upstreamWire == upstream.KindResponses:
			u := responseswire.Usage(resp["usage"])
			if t.kind == upstream.KindResponses {
				return finishJSON(resp, t.kind, d.Model, u, t), u
			}
			result := responseswire.ChatResultFromResponse(resp)
			chat := responseswire.ChatCompletionFrom(result, d.Model, "chatcmpl-"+d.Session, t.started.Unix())
			return finishJSON(chat, t.kind, d.Model, u, t), result.Usage
		default:
			u := attempt.Adapter.UsageFrom(body)
			out, _ := json.Marshal(resp)
			return out, u
		}
	}

	if t.stream {
		tracker := &wire.StreamTracker{}
		var streamBody io.ReadCloser = attempt.Response.Body
		var usageFn func() wire.Usage
		streamBody, usageFn = t.bridgeStream(streamBody, attempt, tracker)
		// Tee the client-wire bytes so the body capture can show the answer.
		// This seam sees the exact SSE the client renders, after bridging but
		// before soft wrapping, and runs synchronously inside WriteStream's copy
		// loop, so the buffer is settled before record() reads it. Skip the tee
		// entirely when capture is off.
		if captureEnabled() {
			capture := &streamCapture{}
			t.respCapture = capture
			streamBody = &teeReadCloser{source: streamBody, capture: capture}
		}
		var softErr atomic.Pointer[string]
		var canceled atomic.Bool
		WriteStream(w, r, streamBody, StreamOptions{
			Kind:        t.kind,
			Model:       d.Model,
			ContentType: streamContentType(attempt.Response, t.kind),
			Headers:     headers,
			Redact:      t.redactor(attempt),
			OnFirstChunk: func() {
				if t.trace != nil {
					t.trace.FirstToken(t.requestID)
				}
			},
			OnSoft:         func(reason string) { softErr.Store(&reason) },
			OnClientCancel: func() { canceled.Store(true) },
		})
		usage = usageFn()
		t.hasUsage = usage != (wire.Usage{})
		if canceled.Load() || r.Context().Err() != nil {
			st, u, errText := tracker.CancelOutcome()
			t.record(st, u, t.costOf(u), true, errText)
			return false
		}
		if reason := softErr.Load(); reason != nil {
			t.record(http.StatusBadGateway, usage, nil, true, *reason)
			return false
		}
		t.record(200, usage, t.costOf(usage), true, "")
		return false
	}

	raw, err := io.ReadAll(attempt.Response.Body)
	_ = attempt.Response.Body.Close()
	if err != nil {
		t.record(http.StatusBadGateway, wire.Usage{}, nil, true, err.Error())
		writeJSONError(w, http.StatusBadGateway, "jevonian_error", "Failed to read upstream body")
		return false
	}
	// A streaming-only upstream (responses) always answers SSE; fold it.
	if attempt.Stream && !t.stream {
		var failure string
		raw, usage, failure = foldStreamToJSON(raw, attempt, d, t.kind)
		t.hasUsage = usage != (wire.Usage{})
		if failure != "" {
			// The folded stream carries a `response.failed` rather than an HTTP
			// error, so the refusal hides inside a 200. A quota verdict still
			// fails the provider over; anything else is the client's answer as a
			// 502 (src/upstream.ts).
			if t.srv.deps.Quota != nil &&
				quota.MessageSpendSignal(failure) != quota.SignalNone {
				t.srv.deps.Quota.MarkSpent(attempt.Entry.Provider.Name, quota.MarkSpentOptions{Label: "limit"})
				return true
			}
			t.record(http.StatusBadGateway, wire.Usage{}, nil, true, failure)
			writeJSONError(w, http.StatusBadGateway, "jevonian_error", failure)
			return false
		}
		if (upstreamWire == upstream.KindOpenAI && bridge == "to-openai") ||
			(upstreamWire == upstream.KindResponses && t.kind == upstream.KindOpenAI) {
			var chat wire.Body
			_ = json.Unmarshal(raw, &chat)
			raw = finishJSON(chat, t.kind, d.Model, usage, t)
		}
	} else {
		raw, usage = fold(raw)
		t.hasUsage = usage != (wire.Usage{})
	}
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(200)
	t.respData = raw
	_, _ = w.Write(raw)
	t.record(200, usage, t.costOf(usage), true, "")
	return false
}

// bridgeStream translates the upstream SSE body into the client wire when the
// plan bridged, else passes it through with usage tracking.
func mergeUsage(previous, next wire.Usage) wire.Usage {
	if next.Input != 0 {
		previous.Input = next.Input
	}
	if next.Output != 0 {
		previous.Output = next.Output
	}
	if next.CacheRead != 0 {
		previous.CacheRead = next.CacheRead
	}
	if next.CacheWrite != 0 {
		previous.CacheWrite = next.CacheWrite
	}
	return previous
}

func (t *turn) bridgeStream(body io.ReadCloser, attempt upstream.Attempt, tracker *wire.StreamTracker) (io.ReadCloser, func() wire.Usage) {
	d := t.decision
	bridge := attempt.Plan.Bridge
	clientKind := t.kind
	upstreamWire := attempt.Plan.Wire

	usage := wire.Usage{}
	var usageMu sync.Mutex
	setUsage := func(u wire.Usage) {
		usageMu.Lock()
		if u.Input != 0 || u.Output != 0 || u.CacheRead != 0 || u.CacheWrite != 0 {
			usage = mergeUsage(usage, u)
		}
		usageMu.Unlock()
		tracker.Feed(wire.StreamEvent{Kind: wire.StreamUsage, Usage: u})
	}
	getUsage := func() wire.Usage { usageMu.Lock(); defer usageMu.Unlock(); return usage }
	onEvent := func(e wire.StreamEvent) { tracker.Feed(e) }

	switch {
	case upstreamWire == upstream.KindAnthropic && bridge == "to-anthropic" &&
		(clientKind == upstream.KindOpenAI || clientKind == upstream.KindResponses):
		toChat := anthropicwire.NewToChatStream(d.Model, func(u wire.Usage, _ string) {
			setUsage(u)
		}, onEvent)
		if clientKind == upstream.KindResponses {
			toResponses := responseswire.NewFromChatStream(d.Model, func(res responseswire.ChatBridgeResult) {
				tracker.Feed(wire.StreamEvent{Kind: wire.StreamFinish})
			})
			return chainTranslators(body, toChat, toResponses), getUsage
		}
		return wire.TranslateReader(body, toChat), getUsage
	case upstreamWire == upstream.KindResponses && bridge == "" && clientKind == upstream.KindResponses:
		repair := responseswire.NewPassthroughRepairStream(func(resp wire.Body) {
			u := responseswire.Usage(resp["usage"])
			setUsage(u)
			tracker.Feed(wire.StreamEvent{Kind: wire.StreamUsage, Usage: u})
			tracker.Feed(wire.StreamEvent{Kind: wire.StreamFinish})
		})
		return wire.TranslateReader(body, repair), getUsage
	case upstreamWire == upstream.KindResponses && clientKind == upstream.KindOpenAI:
		// A Responses host answering an OpenAI client: fold the Responses SSE
		// back into Chat Completions chunks. src/upstream.ts `translated`.
		toChat := responseswire.NewToChatStream(d.Model, func(res responseswire.ChatBridgeResult) {
			setUsage(res.Usage)
			tracker.Feed(wire.StreamEvent{Kind: wire.StreamUsage, Usage: res.Usage})
			tracker.Feed(wire.StreamEvent{Kind: wire.StreamFinish})
		})
		return wire.TranslateReader(body, toChat), getUsage
	case upstreamWire == upstream.KindOpenAI && bridge == "to-openai" && clientKind == upstream.KindResponses:
		toResponses := responseswire.NewFromChatStream(d.Model, func(res responseswire.ChatBridgeResult) {
			setUsage(res.Usage)
			tracker.Feed(wire.StreamEvent{Kind: wire.StreamUsage, Usage: res.Usage})
			tracker.Feed(wire.StreamEvent{Kind: wire.StreamFinish})
		})
		return wire.TranslateReader(body, toResponses), getUsage
	case upstreamWire == upstream.KindOpenAI && bridge == "to-openai" && clientKind == upstream.KindAnthropic:
		toAnthropic := anthropicwire.NewChatToStream(d.Model, anthropicwire.ChatToStreamOptions{
			Usage: func() *wire.Usage {
				u := getUsage()
				if u == (wire.Usage{}) {
					return nil
				}
				return &u
			},
			OnFinish: func(u wire.Usage) {
				setUsage(u)
				tracker.Feed(wire.StreamEvent{Kind: wire.StreamUsage, Usage: u})
				tracker.Feed(wire.StreamEvent{Kind: wire.StreamFinish})
			},
		})
		return wire.TranslateReader(body, toAnthropic), getUsage
	default:
		// Same-wire passthrough: still observe the stream for usage/cancel.
		passthrough := wire.TranslateReader(body, &usageTracker{
			kind:    upstreamWire,
			tracker: tracker,
			onUsage: func(u wire.Usage) { setUsage(u) },
		})
		return passthrough, getUsage
	}
}

// trackerTee adapts a StreamTracker to TeeTranslator.
type trackerTee struct{ t *wire.StreamTracker }

func (tt trackerTee) Ingest(e wire.Body) { tt.t.Feed(eventFromBody(e)) }
func (tt trackerTee) Flush()             {}

// usageTracker is a Translator that forwards upstream frames unchanged while
// feeding a StreamTracker — the passthrough path's usage hook.
type usageTracker struct {
	kind    config.UpstreamWire
	tracker *wire.StreamTracker
	onUsage func(wire.Usage)
	usage   wire.Usage
}

func (u *usageTracker) Handle(event wire.Body, sink wire.EventSink) {
	e := eventFromBody(event)
	u.tracker.Feed(e)
	if e.Usage != (wire.Usage{}) {
		u.usage = mergeUsage(u.usage, e.Usage)
		if u.onUsage != nil {
			u.onUsage(u.usage)
		}
	}
	if u.kind == config.WireAnthropic || u.kind == config.WireResponses {
		sink.EmitEvent(event)
	} else {
		sink.EmitData(event)
	}
}

func (u *usageTracker) Finish(sink wire.EventSink) {
	if u.kind == config.WireOpenAI {
		sink.Emit(wire.SSEDone)
	}
}

// chainTranslators pipes the upstream body through two translators.
func chainTranslators(body io.ReadCloser, first, second wire.Translator) io.ReadCloser {
	return wire.TranslateReader(wire.TranslateReader(body, first), second)
}

// foldStreamToJSON reads a streamed upstream body and folds it into the client
// wire's non-stream JSON. clientKind is the requesting client's wire, which
// decides the folded shape when the upstream is Responses. It reports the
// upstream failure message (if any) so the turn can still fail over on a quota
// verdict inside the folded 200.
func foldStreamToJSON(raw []byte, attempt upstream.Attempt, d *routing.Decision, clientKind upstream.ClientKind) ([]byte, wire.Usage, string) {
	events := wire.SplitSseEvents(string(raw)).Events
	if attempt.Plan.Wire == upstream.KindResponses {
		failure := responseswire.ErrorMessage(events)
		completed := lastCompletedResponse(events)
		if completed == nil || failure != "" {
			msg := failure
			if msg == "" {
				msg = "upstream stream ended before completion"
			}
			payload := errorBody("jevonian_error", msg)
			out, _ := json.Marshal(payload)
			return out, wire.Usage{}, msg
		}
		repaired := responseswire.RepairOutput(*completed, events)
		completed = &repaired
		u := responseswire.Usage((*completed)["usage"])
		if clientKind == upstream.KindOpenAI {
			// Responses upstream serving an OpenAI client: fold to chat.
			// src/upstream.ts `translated`.
			result := responseswire.ChatResultFromResponse(*completed)
			chat := responseswire.ChatCompletionFrom(result, d.Model, "chatcmpl-"+d.Session, time.Now().Unix())
			out, _ := json.Marshal(chat)
			return out, result.Usage, ""
		}
		out, _ := json.Marshal(*completed)
		return out, u, ""
	}
	// OpenAI chat SSE → folded chat completion (a workbuddy-like always-stream
	// host answering a non-stream client).
	u := lastChatUsage(events)
	out := openaiwire.FoldChatBytes(raw, d.Model)
	buf, _ := json.Marshal(out)
	return buf, u, ""
}

func lastCompletedResponse(events []wire.Body) *wire.Body {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i]["type"] == "response.completed" {
			if resp, ok := events[i]["response"].(map[string]any); ok {
				b := wire.Body(resp)
				return &b
			}
		}
	}
	return nil
}

func lastChatUsage(events []wire.Body) wire.Usage {
	for i := len(events) - 1; i >= 0; i-- {
		if u, ok := events[i]["usage"].(map[string]any); ok {
			return wire.Usage{
				Input:     int(wire.Number(u["prompt_tokens"])),
				Output:    int(wire.Number(u["completion_tokens"])),
				CacheRead: int(wire.Number(nested(u, "prompt_tokens_details", "cached_tokens"))),
			}
		}
	}
	return wire.Usage{}
}

func nested(m map[string]any, keys ...string) any {
	cur := m
	for i, k := range keys {
		if i == len(keys)-1 {
			return cur[k]
		}
		next, ok := cur[k].(map[string]any)
		if !ok {
			return nil
		}
		cur = next
	}
	return nil
}

func t0() int64 { return time.Now().Unix() }

// finishJSON renders a folded non-stream body in the client wire.
func finishJSON(body wire.Body, kind upstream.ClientKind, model string, u wire.Usage, t *turn) []byte {
	switch kind {
	case upstream.KindAnthropic:
		out := anthropicwire.ChatToMessage(body, model)
		raw, _ := json.Marshal(out)
		return raw
	case upstream.KindResponses:
		out := chatJSONToResponse(body, t)
		raw, _ := json.Marshal(out)
		return raw
	default:
		body["model"] = model
		raw, _ := json.Marshal(body)
		return raw
	}
}

// chatJSONToResponse builds a Responses `response` object from a chat
// completion (src/upstream.ts chatJsonToResponse).
func chatJSONToResponse(chat wire.Body, t *turn) wire.Body {
	var content string
	var toolCalls []any
	if choices, ok := chat["choices"].([]any); ok && len(choices) > 0 {
		if ch, ok := choices[0].(map[string]any); ok {
			if msg, ok := ch["message"].(map[string]any); ok {
				content, _ = msg["content"].(string)
				toolCalls, _ = msg["tool_calls"].([]any)
			}
		}
	}
	var output []any
	if content != "" {
		output = append(output, map[string]any{
			"type": "message", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": content}},
		})
	}
	for _, raw := range toolCalls {
		call, _ := raw.(map[string]any)
		fn, _ := call["function"].(map[string]any)
		callID, _ := call["id"].(string)
		if callID == "" {
			callID = "call_" + uuid.NewString()[:16]
		}
		output = append(output, map[string]any{
			"type": "function_call", "call_id": callID,
			"name":      wire.AsString(fn["name"]),
			"arguments": wire.AsString(fn["arguments"]),
		})
	}
	u := wire.Usage{}
	if usage, ok := chat["usage"].(map[string]any); ok {
		u = wire.Usage{
			Input:     int(wire.Number(usage["prompt_tokens"])),
			Output:    int(wire.Number(usage["completion_tokens"])),
			CacheRead: int(wire.Number(nested(usage, "prompt_tokens_details", "cached_tokens"))),
		}
	}
	return wire.Body{
		"id":         "resp_" + t.requestID[:16],
		"object":     "response",
		"created_at": t.started.Unix(),
		"status":     "completed",
		"model":      t.decision.Model,
		"output":     output,
		"usage": map[string]any{
			"input_tokens":         u.Input,
			"output_tokens":        u.Output,
			"total_tokens":         u.Input + u.Output,
			"input_tokens_details": map[string]any{"cached_tokens": u.CacheRead},
		},
	}
}

// eventFromBody decodes an SSE event body for the StreamTracker.
func eventFromBody(e wire.Body) wire.StreamEvent {
	ev := wire.StreamEvent{}
	if typ, _ := e["type"].(string); typ != "" {
		switch typ {
		case "message_stop", "response.completed":
			ev.Kind = wire.StreamFinish
		case "response.failed", "error":
			ev.Kind = wire.StreamError
			if resp, ok := e["response"].(map[string]any); ok {
				if er, ok := resp["error"].(map[string]any); ok {
					ev.Message = wire.AsString(er["message"])
				}
			}
			if ev.Message == "" {
				ev.Message = wire.AsString(e["message"])
			}
		default:
			ev.Kind = wire.StreamContent
		}
	}
	if u := e["usage"]; u != nil {
		if raw, ok := u.(map[string]any); ok {
			ev.Usage = wire.Usage{
				Input:      int(wire.Number(raw["input_tokens"])),
				Output:     int(wire.Number(raw["output_tokens"])),
				CacheRead:  int(wire.Number(raw["cache_read_input_tokens"])),
				CacheWrite: int(wire.Number(raw["cache_creation_input_tokens"])),
			}
			if _, hasInput := raw["input_tokens"]; !hasInput {
				ev.Usage.Input = int(wire.Number(raw["prompt_tokens"]))
			}
			if _, hasOutput := raw["output_tokens"]; !hasOutput {
				ev.Usage.Output = int(wire.Number(raw["completion_tokens"]))
			}
			if ev.Usage.CacheRead == 0 {
				ev.Usage.CacheRead = int(wire.Number(nested(raw, "prompt_tokens_details", "cached_tokens")))
			}
			if ev.Kind == 0 && ev.Usage != (wire.Usage{}) {
				ev.Kind = wire.StreamUsage
			}
		}
	}
	if ev.Kind == 0 && ev.Usage == (wire.Usage{}) {
		ev.Kind = wire.StreamContent
	}
	return ev
}

// streamContentType preserves the upstream content type when it is SSE.
func streamContentType(resp *http.Response, kind upstream.ClientKind) string {
	if resp != nil {
		if ct := resp.Header.Get("content-type"); strings.Contains(ct, "event-stream") {
			return ct
		}
	}
	return "text/event-stream"
}

func (t *turn) redactor(attempt upstream.Attempt) func(string) string {
	return func(text string) string {
		return softstream.RedactSecrets(text, attempt.Entry.Provider.APIKey)
	}
}

func (t *turn) costOf(u wire.Usage) *float64 {
	if t.srv.deps.Routing.Prices == nil || t.decision == nil {
		return nil
	}
	price := t.srv.deps.Routing.Prices(t.decision.Model, t.decision.Provider)
	if price == nil {
		return nil
	}
	ru := routing.Usage{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}
	usd, known := routing.CostOf(price, ru, t.now())
	if !known {
		return nil
	}
	return &usd
}

func (t *turn) now() time.Time {
	if t.srv.deps.Now != nil {
		return t.srv.deps.Now()
	}
	return time.Now()
}

// uncachedInput subtracts cache reads unless the delivering adapter's usage
// already reports exclusive input.
func uncachedInput(t *turn, u wire.Usage) int {
	if t.exclusiveInput {
		return u.Input
	}
	if u.Input-u.CacheRead < 0 {
		return 0
	}
	return u.Input - u.CacheRead
}

// record appends the ledger row and feeds the session cache observation.
func (t *turn) record(status int, usage wire.Usage, costUSD *float64, pricingKnown bool, errText string) {
	if t.recorded {
		return
	}
	t.recorded = true
	t.saveResponseCapture(status, errText)
	s := t.srv
	d := t.decision
	rec := ledger.Record{
		ID:               t.requestID,
		RequestID:        t.requestID,
		TS:               t.now(),
		Path:             strings.TrimPrefix(t.path, "/v1"),
		KeyID:            t.keyID,
		KeyName:          t.keyName,
		Stream:           t.stream,
		Status:           status,
		LatencyMs:        int(time.Since(t.started).Milliseconds()),
		PromptTokens:     usage.Input,
		CompletionTokens: usage.Output,
		CacheReadTokens:  usage.CacheRead,
		CacheWriteTokens: usage.CacheWrite,
		CostUSD:          costUSD,
		PricingKnown:     pricingKnown,
		Error:            wire.TruncateRunes(errText, 300),
	}
	// Persist the usage convention so readers divide by the right denominator.
	// Only meaningful when the turn actually reported usage.
	if t.hasUsage {
		exclusive := t.exclusiveInput
		rec.ExclusiveInput = &exclusive
	}
	if d != nil {
		rec.Session = d.Session
		rec.Provider = d.Provider
		rec.Model = d.Model
		rec.RequestedModel = d.RequestedModel
		rec.Phase = d.Phase
		routed := d.Routed
		rec.Routed = &routed
		rec.Reason = d.Reason
		rec.Brain = string(d.Brain)
		if d.HasConfidence {
			rec.Confidence = &d.Confidence
		}
		rec.Canonical = d.Canonical
		rec.Effort = d.Effort
		rec.EffortNote = d.EffortNote
		rec.SwitchPenaltyUSD = d.SwitchPenaltyUSD
		rec.BrainChannel = d.BrainChannel
		rec.CacheKeep = string(d.CacheKeep)
		if d.Cache != nil {
			rec.Cache, _ = json.Marshal(d.Cache)
		}
		if len(d.Skipped) > 0 {
			rec.Skipped, _ = json.Marshal(d.Skipped)
		}
		for _, p := range t.cfg.Providers {
			if p.Name == d.Provider && p.Billing == config.BillingSubscription {
				rec.Billing = "subscription"
				break
			}
		}
	}
	if t.savedTokens > 0 {
		v := t.savedTokens
		rec.SavedTokens = &v
	}
	if t.trace != nil {
		if finished, ok := t.trace.FinishRoute(t.requestID, status, errText); ok {
			if len(finished.Tries) > 1 {
				rec.Tries, _ = json.Marshal(finished.Tries)
			}
			if finished.TTFTMs != nil {
				v := int(*finished.TTFTMs)
				rec.TTFTMs = &v
			}
		}
	}
	if t.retries > 0 {
		v := t.retries
		rec.Retries = &v
	}
	if t.failovers > 0 {
		v := t.failovers
		rec.Failovers = &v
	}
	if s.deps.Ledger != nil {
		_ = s.deps.Ledger.Append(rec)
	}
	if s.deps.Store != nil && status >= 200 && status < 300 && d != nil && d.Session != "" {
		var providerConfig *config.Provider
		for i := range t.cfg.Providers {
			if t.cfg.Providers[i].Name == d.Provider {
				providerConfig = &t.cfg.Providers[i]
				break
			}
		}
		if providerConfig != nil {
			prefix := routing.CachePrefix{}
			scope := ""
			if t.cacheKnown && t.cacheBody != nil && providerConfig.Type != config.ProviderTypeResponses && t.cacheWire != config.WireResponses {
				prefix = routing.BuildCachePrefix(t.cacheBody)
				scope = t.cacheScope
			}
			s.deps.Store.ObserveCache(d.Session, routing.CacheObservation{
				Provider:            d.Provider,
				Model:               d.Model,
				At:                  time.Now().UnixMilli(),
				UncachedInputTokens: uncachedInput(t, usage),
				InputTokens:         usage.Input,
				CacheReadTokens:     usage.CacheRead,
				CacheWriteTokens:    usage.CacheWrite,
				Success:             true,
				UsageKnown:          t.hasUsage,
				Prefix:              prefix,
				Scope:               scope,
			})
		}
	}
}

// writeRefusal surfaces a non-failoverable refusal or the plan's exhausted
// last one. A streaming client gets a soft assistant completion rather than a
// bare JSON error.
func (t *turn) writeRefusal(w http.ResponseWriter, attempt upstream.Attempt) {
	status := attempt.Status
	if status == 0 {
		status = http.StatusBadGateway
	}
	reason := attempt.Describe()
	t.record(status, wire.Usage{}, nil, true, reason)
	if t.stream {
		model := ""
		if t.decision != nil {
			model = t.decision.Model
		}
		WriteSoftError(w, t.kind, model, reason, t.decisionHeaders(attempt.Retries))
		return
	}
	ct := "application/json"
	if attempt.Response != nil {
		if got := attempt.Response.Header.Get("content-type"); got != "" {
			ct = got
		}
	}
	for k, v := range t.decisionHeaders(attempt.Retries) {
		w.Header().Set(k, v)
	}
	w.Header().Set("content-type", ct)
	w.WriteHeader(status)
	if attempt.Text != "" {
		_, _ = w.Write([]byte(attempt.Text))
	} else {
		_ = json.NewEncoder(w).Encode(errorBody("jevonian_error", reason))
	}
}

func (t *turn) writeUnavailable(w http.ResponseWriter, attempt upstream.Attempt) {
	msg := attempt.Describe()
	t.record(http.StatusBadGateway, wire.Usage{}, nil, true, msg)
	t.writeError(w, http.StatusBadGateway, msg)
}

func (t *turn) writeError(w http.ResponseWriter, status int, msg string) {
	if t.stream {
		model := ""
		if t.decision != nil {
			model = t.decision.Model
		}
		WriteSoftError(w, t.kind, model, msg, nil)
		return
	}
	writeJSONError(w, status, "jevonian_error", msg)
}

func (t *turn) decisionHeaders(retries int) map[string]string {
	d := t.decision
	if d == nil {
		return nil
	}
	h := map[string]string{
		"x-jevonian-model":      d.Model,
		"x-jevonian-provider":   d.Provider,
		"x-jevonian-phase":      d.Phase,
		"x-jevonian-session":    d.Session,
		"x-jevonian-reason":     d.Reason,
		"x-jevonian-request-id": d.RequestID,
	}
	if retries > 0 {
		h["x-jevonian-retries"] = strconv.Itoa(retries)
	}
	if d.Cache != nil && d.Cache.State != "" {
		h["x-jevonian-cache-state"] = string(d.Cache.State)
	}
	if d.CacheKeep != "" {
		h["x-jevonian-cache-keep"] = string(d.CacheKeep)
	}
	if d.Brain != "" {
		h["x-jevonian-brain"] = string(d.Brain)
	}
	if d.BrainChannel != "" {
		h["x-jevonian-brain-channel"] = d.BrainChannel
	}
	if d.Canonical != "" {
		h["x-jevonian-canonical"] = d.Canonical
	}
	if d.Effort != "" {
		h["x-jevonian-effort"] = d.Effort
	}
	if d.EffortNote != "" {
		h["x-jevonian-effort-note"] = d.EffortNote
	}
	if len(d.Skipped) > 0 {
		parts := make([]string, 0, len(d.Skipped))
		for _, sk := range d.Skipped {
			parts = append(parts, sk.Provider+"/"+sk.Model+"="+sk.Reason+"("+sk.Detail+")")
		}
		h["x-jevonian-skipped"] = strings.Join(parts, "; ")
	}
	if t.failovers > 0 {
		h["x-jevonian-quota-failovers"] = strconv.Itoa(t.failovers)
	}
	return h
}

// requestHeaders flattens the incoming headers for routing.
func requestHeaders(r *http.Request) map[string]string {
	out := map[string]string{}
	for k, vals := range r.Header {
		if len(vals) > 0 {
			out[strings.ToLower(k)] = vals[0]
		}
	}
	return out
}

func asRouteError(err error, re **routing.RouteError) bool {
	var target *routing.RouteError
	if err == nil {
		return false
	}
	if as, ok := err.(*routing.RouteError); ok {
		target = as
	} else {
		return false
	}
	*re = target
	return true
}
