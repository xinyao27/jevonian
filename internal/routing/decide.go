package routing

import (
	"context"
	"fmt"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/quota"
)

func quotaStatus(deps Deps, p config.Provider, model string, now int64, lowPercent float64) QuotaView {
	if deps.Quota == nil {
		return QuotaView{Status: quota.StatusUnknown}
	}
	return deps.Quota.Standing(p, model, now, lowPercent)
}

// candidateExhausted: provider missing, or quota/model window spent.
// src/routing.ts candidateExhausted.
func candidateExhausted(cfg *config.Config, deps Deps, c TierPick, now int64) bool {
	p := providerByName(cfg, c.Provider)
	if p == nil {
		return true
	}
	v := quotaStatus(deps, *p, c.Model, now, cfg.Routing.QuotaGuard.LowPercent)
	return v.Status == quota.StatusExhausted || v.ModelExhausted
}

// failoverPlan is `chosen` first, then the rest of its pool, then every other
// pool, each target once. src/routing.ts failoverPlan.
func failoverPlan(chosen TierPick, offer []TierPick, others [][]TierPick) []TierPick {
	seen := map[string]bool{PlanKey(chosen.Provider, chosen.Model): true}
	plan := []TierPick{chosen}
	add := func(list []TierPick) {
		for _, c := range list {
			k := PlanKey(c.Provider, c.Model)
			if seen[k] {
				continue
			}
			seen[k] = true
			plan = append(plan, c)
		}
	}
	add(offer)
	for _, o := range others {
		add(o)
	}
	return plan
}

// weighedOrder reports the plan for trace/ledger and failover, dropping the
// first entry (the decision's own target). src/routing.ts weighedOrder +
// RouteDecision.order ("excluding the target this decision points at").
func weighedOrder(plan []TierPick, cfg *config.Config, deps Deps, now int64, cache []CacheCandidateView, skipped []RouteSkip) []WeighedCandidate {
	cacheState := map[string]CacheAffinityState{}
	for _, c := range cache {
		cacheState[PlanKey(c.Provider, c.Model)] = c.Cache.State
	}
	skipBy := map[string]*SkipNote{}
	for _, s := range skipped {
		skipBy[PlanKey(s.Provider, s.Model)] = &SkipNote{Reason: s.Reason, Detail: s.Detail}
	}
	out := make([]WeighedCandidate, 0, len(plan))
	for rank, c := range plan {
		w := WeighedCandidate{Provider: c.Provider, Model: c.Model, Canonical: c.Canonical, Rank: rank}
		if p := providerByName(cfg, c.Provider); p != nil && deps.Quota != nil {
			w.Quota = string(quotaStatus(deps, *p, c.Model, now, cfg.Routing.QuotaGuard.LowPercent).Status)
		}
		if s, ok := cacheState[PlanKey(c.Provider, c.Model)]; ok {
			w.CacheState = string(s)
		}
		w.Skipped = skipBy[PlanKey(c.Provider, c.Model)]
		out = append(out, w)
	}
	// TS keeps the chosen target at rank 0 in the trace, and nextFromPlan
	// skips it through `exclude` (the caller seeds exclude with the tried
	// target). Keep the same shape: the full ranked plan.
	return out
}

// decidePinned: a concrete model id — no brain, no phase claim.
// src/routing.ts decideRoute `if (!virtual)` branch.
func decidePinned(deps Deps, input Input, cfg *config.Config, requestedRaw, requestedModel, requestID, session string, now int64, resetOrder func([]TierPick) []TierPick, standCache map[string]quotaStanding) (*Decision, error) {
	guard := cfg.Routing.QuotaGuard
	matches := []config.Provider{}
	for _, p := range cfg.Providers {
		if config.ProviderHasModel(p, requestedModel) {
			matches = append(matches, p)
		}
	}
	ordered := matches
	if guard.Enabled && guard.ResetAware {
		ordered = orderProvidersByReset(matches, requestedModel, cfg, deps, orderOptions{now: now, cache: standCache})
	}
	carriesTools := TurnCarriesTools(input.Body, input.Kind)
	toolSkips := []RouteSkip{}
	// A pinned model still must land on a provider that can carry the turn:
	// when tools are present, a provider with no native tool channel is not a
	// viable target while a capable one exists.
	if carriesTools {
		filtered := toolCapableProviders(ordered)
		if len(filtered) != len(ordered) {
			toolSkips = append(toolSkips, toolSkipNotes(providerPicks(ordered, requestedModel), providerPicks(filtered, requestedModel))...)
		}
		ordered = filtered
	}
	if input.Store != nil && firstHeader(input.Headers, RequestHeaderAffinity) != string(AffinityOff) {
		if previous, ok := input.Store.Get(session, now); ok {
			picks := make([]TierPick, len(ordered))
			byName := map[string]config.Provider{}
			for i, p := range ordered {
				picks[i] = TierPick{Provider: p.Name, Model: requestedModel}
				byName[p.Name] = p
			}
			ttl := input.CacheTTL
			if ttl == 0 {
				ttl = deps.CacheTTL
			}
			picks = orderReusableCache(deps, &previous, picks, now, ttl.Milliseconds())
			for i, pick := range picks {
				ordered[i] = byName[pick.Provider]
			}
		}
	}
	var byWire *config.Provider
	for i := range ordered {
		if CanServeClient(ordered[i], input.Kind) {
			byWire = &ordered[i]
			break
		}
	}
	if byWire == nil && len(ordered) > 0 {
		byWire = &ordered[0]
	}
	exact := byWire
	if guard.Enabled && len(ordered) > 1 {
		for i := range ordered {
			c := ordered[i]
			if !CanServeClient(c, input.Kind) {
				continue
			}
			v := quotaStatus(deps, c, requestedModel, now, guard.LowPercent)
			if v.Status != quota.StatusLow && v.Status != quota.StatusExhausted && !v.ModelExhausted {
				exact = &ordered[i]
				break
			}
		}
	}
	if exact != nil {
		// `ordered` already dropped tool-incapable providers for a tool turn,
		// so the wire list derived from it is tool-capable too.
		wire := []TierPick{}
		for _, c := range ordered {
			if CanServeClient(c, input.Kind) {
				wire = append(wire, TierPick{Provider: c.Name, Model: requestedModel})
			}
		}
		plan := failoverPlan(TierPick{Provider: exact.Name, Model: requestedModel}, wire, nil)
		return &Decision{
			Model: requestedModel, Provider: exact.Name,
			Phase:          PhaseOfModel(cfg, deps, requestedModel),
			RequestedModel: requestedRaw, Reason: ReasonPinnedModel,
			Session: session, RequestID: requestID,
			Skipped: dedupeToolSkips(toolSkips),
			Order:   weighedOrder(plan, cfg, deps, now, nil, nil),
		}, nil
	}

	variants := []TierPick{}
	for _, v := range CanonicalVariants(cfg, requestedModel, input.Kind, deps.Identity) {
		variants = append(variants, TierPick{Provider: v.Provider, Model: v.Model})
	}
	if carriesTools {
		kept := toolCapablePicks(cfg, variants)
		toolSkips = append(toolSkips, toolSkipNotes(variants, kept)...)
		variants = kept
	}
	variants = resetOrder(variants)
	if input.Store != nil && firstHeader(input.Headers, RequestHeaderAffinity) != string(AffinityOff) {
		if previous, ok := input.Store.Get(session, now); ok {
			ttl := input.CacheTTL
			if ttl == 0 {
				ttl = deps.CacheTTL
			}
			variants = orderReusableCache(deps, &previous, variants, now, ttl.Milliseconds())
		}
	}
	if len(variants) > 0 {
		var chosen *TierPick
		if guard.Enabled {
			for i := range variants {
				p := providerByName(cfg, variants[i].Provider)
				if p == nil {
					continue
				}
				v := quotaStatus(deps, *p, variants[i].Model, now, guard.LowPercent)
				if v.Status != quota.StatusLow && v.Status != quota.StatusExhausted && !v.ModelExhausted {
					chosen = &variants[i]
					break
				}
			}
		}
		if chosen == nil {
			chosen = &variants[0]
		}
		plan := failoverPlan(*chosen, variants, nil)
		return &Decision{
			Model: chosen.Model, Provider: chosen.Provider,
			Phase:          PhaseOfModel(cfg, deps, chosen.Model),
			RequestedModel: requestedRaw, Canonical: requestedModel,
			Reason: ReasonCanonicalModel, Session: session, RequestID: requestID,
			Skipped: dedupeToolSkips(toolSkips),
			Order:   weighedOrder(plan, cfg, deps, now, nil, nil),
		}, nil
	}

	fallback := providerByName(cfg, cfg.DefaultProvider)
	if fallback == nil && len(cfg.Providers) > 0 {
		fallback = &cfg.Providers[0]
	}
	if fallback == nil {
		return nil, &RouteError{Message: fmt.Sprintf("No provider configured for model %q", requestedRaw)}
	}
	return &Decision{
		Model: requestedModel, Provider: fallback.Name,
		Phase:          PhaseOfModel(cfg, deps, requestedModel),
		RequestedModel: requestedRaw, Reason: ReasonPinnedModel,
		Session: session, RequestID: requestID,
	}, nil
}

// normalizeRoutingID accepts a header/model value only when it names a
// configured or derived routing. src/routing.ts normalizeRoutingId.
func normalizeRoutingID(value string, cfg *config.Config, routings []config.RoutingEntry) string {
	if value == "" {
		return ""
	}
	for _, e := range cfg.Routing.Routings {
		if e.ID == value {
			return value
		}
	}
	if routingIDRe.MatchString(value) && value != "auto" {
		for _, e := range routings {
			if e.ID == value {
				return value
			}
		}
	}
	return ""
}

func lightFirst(routings []config.RoutingEntry) []config.RoutingEntry {
	out := []config.RoutingEntry{}
	for _, e := range routings {
		if e.ID == "utility" || e.ID == "chat" {
			out = append(out, e)
		}
	}
	for _, e := range routings {
		if e.ID != "utility" && e.ID != "chat" {
			out = append(out, e)
		}
	}
	return out
}

type turnCtx struct {
	deps        Deps
	input       Input
	cfg         *config.Config
	now         int64
	cacheTTLMs  int64
	routings    []config.RoutingEntry
	previous    *SessionState
	signals     PhaseSignals
	affinity    CacheAffinityMode
	keepApplied bool
	keepReason  CacheKeepReason
	resetOrder  func([]TierPick) []TierPick
	// toolSkipped and toolSkippedSeen collect the candidates withheld because
	// the turn carries tools and the provider has no native tool channel.
	toolSkipped     []RouteSkip
	toolSkippedSeen map[string]bool
	// toolFilter / toolFilterReady cache whether any configured candidate has
	// a native tool channel, so the check runs at most once per turn.
	toolFilter      bool
	toolFilterReady bool
}

// turnCarriesTools reports whether this turn sends native tool definitions or
// hands back tool results. src/routing.ts hasTools / hasToolResults.
func (t *turnCtx) turnCarriesTools() bool {
	return t.signals.HasTools || t.signals.HasToolResults
}

// toolFilteringActive reports whether tool-incapable candidates must be
// withheld for this turn.
//
// Filtering is global, not per pool: when the turn carries tools and at least
// one configured candidate has a native tool channel, the incapable ones (the
// chatgpt-web provider) are withheld everywhere. When nothing can serve tools,
// filtering is skipped so the turn still reaches the only candidate and its
// clear provider refusal, instead of a misleading "no models" error.
func (t *turnCtx) toolFilteringActive() bool {
	if !t.turnCarriesTools() {
		return false
	}
	if t.toolFilterReady {
		return t.toolFilter
	}
	t.toolFilterReady = true
	for _, e := range t.routings {
		for _, c := range RoutingCandidates(t.cfg, t.deps, e, t.input.Kind) {
			if p := providerByName(t.cfg, c.Provider); p != nil && ProviderServesTools(*p) {
				t.toolFilter = true
				return true
			}
		}
	}
	return false
}

// dropToolIncapable removes candidates that cannot accept a tool-carrying turn,
// recording each withheld pick once. Without this, routing can failover onto the
// chatgpt-web provider, which rejects a body with `tools` and returns the 400 to
// the client. When a pool would be emptied entirely, it is returned unchanged so
// the pool still exists and the turn reaches its only candidate.
func (t *turnCtx) dropToolIncapable(picks []TierPick) []TierPick {
	if !t.toolFilteringActive() {
		return picks
	}
	kept := make([]TierPick, 0, len(picks))
	withheld := make([]TierPick, 0, len(picks))
	for _, c := range picks {
		p := providerByName(t.cfg, c.Provider)
		if p != nil && !ProviderServesTools(*p) {
			withheld = append(withheld, c)
			continue
		}
		kept = append(kept, c)
	}
	if len(kept) == 0 {
		return picks
	}
	for _, c := range withheld {
		t.noteToolSkip(c)
	}
	return kept
}

// noteToolSkip records one candidate withheld for lacking a tool channel.
func (t *turnCtx) noteToolSkip(c TierPick) {
	if t.toolSkippedSeen == nil {
		t.toolSkippedSeen = map[string]bool{}
	}
	key := PlanKey(c.Provider, c.Model)
	if t.toolSkippedSeen[key] {
		return
	}
	t.toolSkippedSeen[key] = true
	t.toolSkipped = append(t.toolSkipped, RouteSkip{
		Model:    c.Model,
		Provider: c.Provider,
		Reason:   "tools",
		Detail:   "provider has no native tool-calling channel",
	})
}

// mergeToolSkips attaches the tool-filter notes to a decision, appending the
// tool-skip suffix when the turn had a candidate withheld.
func (t *turnCtx) mergeToolSkips(d *Decision) {
	if len(t.toolSkipped) == 0 {
		return
	}
	d.Reason = AppendReason(d.Reason, SuffixToolSkip)
	d.Skipped = append(d.Skipped, t.toolSkipped...)
}

func (t *turnCtx) keepOrder(picks []TierPick) []TierPick {
	previous := t.previous
	if t.affinity == AffinityAuto {
		picks = orderReusableCache(t.deps, previous, picks, t.now, t.cacheTTLMs)
		if previous != nil && t.deps.CacheEvidence != nil {
			activeProvider, activeModel := previous.Provider, previous.Model
			if previous.Cache != nil {
				activeProvider, activeModel = previous.Cache.Provider, previous.Cache.Model
			}
			a := candidateCacheAffinity(t.deps, previous, TierPick{Provider: activeProvider, Model: activeModel}, t.now, int64(CompactionEstimate(t.input.Body)), t.cacheTTLMs)
			if a.PrefixMatch == "changed" || a.PrefixMatch == "unknown" || a.State == CacheUnknown {
				copy := *previous
				copy.Cache = nil
				previous = &copy
			}
		}
	}
	verdict := cacheAffinityKeep(previous, t.affinity, t.signals.WithinTurn, picks, t.now, t.cacheTTLMs)
	if verdict.Keep {
		t.keepApplied = true
	}
	// The first pool that can take the turn names why it was or was not kept.
	if t.keepReason == "" {
		t.keepReason = verdict.Reason
	}
	return applyCacheKeep(picks, t.previous, verdict)
}

// candidatesFor: reset-aware order, then cache keep on top.
// src/routing.ts candidatesFor.
func (t *turnCtx) candidatesFor(id string) []TierPick {
	for _, e := range t.routings {
		if e.ID == id {
			picks := RoutingCandidates(t.cfg, t.deps, e, t.input.Kind)
			picks = t.dropToolIncapable(picks)
			return t.keepOrder(t.resetOrder(picks))
		}
	}
	return nil
}

func (t *turnCtx) effortsOf(model string) []string {
	var stated ModelCapabilities
	if t.deps.Capabilities != nil {
		stated = t.deps.Capabilities(model)
	}
	var override *config.ModelCapacityConfig
	if c, ok := t.cfg.Routing.Capacities[model]; ok {
		override = &c
	}
	return EffectiveCapabilities(model, stated, override).Efforts
}

func (t *turnCtx) tierEffort(id string) string {
	for _, e := range t.routings {
		if e.ID == id {
			return e.Effort
		}
	}
	return ""
}

func decideVirtual(ctx context.Context, deps Deps, input Input, cfg *config.Config, requestedRaw, requestedModel, requestID, session string, now int64, resetOrder func([]TierPick) []TierPick, _ map[string]quotaStanding) (*Decision, error) {
	cacheTTL := input.CacheTTL
	if cacheTTL == 0 {
		cacheTTL = deps.CacheTTL
	}
	t := &turnCtx{
		deps: deps, input: input, cfg: cfg, now: now,
		cacheTTLMs: cacheTTL.Milliseconds(),
		routings:   EffectiveRoutings(cfg, deps),
		signals:    ClassifyPhase(input.Body, input.Kind),
		affinity:   AffinityAuto,
		resetOrder: resetOrder,
	}
	if input.Store != nil {
		if prev, ok := input.Store.Get(session, now); ok {
			t.previous = &prev
		}
	}
	if m := firstHeader(input.Headers, RequestHeaderAffinity); IsCacheAffinityMode(m) {
		t.affinity = CacheAffinityMode(m)
	}
	explicitPhase := normalizeRoutingID(firstHeader(input.Headers, RequestHeaderPhase, RequestHeaderTier), cfg, t.routings)
	if explicitPhase == "" && requestedModel != "auto" {
		explicitPhase = normalizeRoutingID(requestedModel, cfg, t.routings)
	}
	turns := 1
	if t.previous != nil {
		turns = t.previous.Turns + 1
	}
	if explicitPhase != "" {
		return t.decideExplicit(explicitPhase, requestedRaw, requestID, session, turns)
	}
	return t.decideBrain(ctx, requestedRaw, requestID, session, turns)
}

func (t *turnCtx) commit(session, phase string, picked TierPick, turns int) {
	if t.input.Store == nil {
		return
	}
	state := SessionState{Phase: phase, Model: picked.Model, Provider: picked.Provider, Turns: turns, UpdatedAt: t.now}
	if t.previous != nil {
		previous := cloneSessionState(*t.previous)
		if previous.Provider == picked.Provider && previous.Model == picked.Model {
			state.Cache = previous.Cache
		}
		state.Caches = previous.Caches
		if state.Caches != nil {
			delete(state.Caches, PlanKey(picked.Provider, picked.Model))
		}
	}
	t.input.Store.Set(session, state)
}

// decideExplicit: jevonian/<id> or the phase header — no brain.
// src/routing.ts decideRoute `if (explicitPhase)` branch.
func (t *turnCtx) decideExplicit(phase, requestedRaw, requestID, session string, turns int) (*Decision, error) {
	cfg, deps := t.cfg, t.deps
	guard := cfg.Routing.QuotaGuard
	reason := ReasonExplicit(phase)
	tier := t.candidatesFor(phase)
	healthy := tier
	if guard.Enabled {
		healthy = []TierPick{}
		for _, c := range tier {
			if !candidateExhausted(cfg, deps, c, t.now) {
				healthy = append(healthy, c)
			}
		}
	}
	pool := healthy
	if len(pool) == 0 {
		pool = tier
	}
	if guard.Enabled && len(healthy) == 0 {
		// Aggregated routing: a spent tier must not pin the client to that
		// subscription — widen to any healthy model, light routings first.
		fallback := []TierPick{}
		seen := map[string]bool{}
		for _, e := range lightFirst(t.routings) {
			for _, c := range t.candidatesFor(e.ID) {
				k := PlanKey(c.Provider, c.Model)
				if seen[k] {
					continue
				}
				seen[k] = true
				if !candidateExhausted(cfg, deps, c, t.now) {
					fallback = append(fallback, c)
				}
			}
		}
		if len(fallback) > 0 {
			pool = fallback
			// Only a spent tier is a quota fallback; an empty tier widened
			// for a different reason. src/routing.ts.
			if len(tier) > 0 {
				reason = AppendReason(reason, SuffixQuotaFallback)
			} else {
				reason = AppendReason(reason, SuffixNoCandidate)
			}
		}
	} else if guard.Enabled && len(healthy) > 0 && len(healthy) < len(tier) {
		reason = AppendReason(reason, SuffixQuotaSkip)
	}
	if len(pool) == 0 {
		return nil, &RouteError{Message: "No models available for routing. Configure routing.routings or add models to a provider."}
	}
	picked := pool[0]
	if t.keepApplied && t.keepReason != "" {
		reason = withCacheKeep(reason, t.keepReason)
	}
	tierEffort := t.tierEffort(phase)
	wanted := tierEffort
	if wanted == "" {
		wanted = headerEffort(t.input.Headers)
	}
	if wanted == "" {
		wanted = brainEffort(cfg.Routing.DefaultEffort)
	}
	effort := ClampEffort(wanted, t.effortsOf(picked.Model))
	note := ""
	switch {
	case wanted != "" && effort != "" && wanted != effort:
		note = fmt.Sprintf("clamped %q to %q", wanted, effort)
	case tierEffort != "" && effort != "":
		note = fmt.Sprintf("tier set %q", tierEffort)
	}
	if note != "" {
		reason = AppendReason(reason, SuffixEffortClamped)
	}
	t.commit(session, phase, picked, turns)

	others := [][]TierPick{}
	for _, e := range lightFirst(t.routings) {
		others = append(others, t.candidatesFor(e.ID))
	}
	d := &Decision{
		Model: picked.Model, Provider: picked.Provider, Phase: phase,
		RequestedModel: requestedRaw, Canonical: picked.Canonical,
		Virtual: true, Routed: true, Reason: reason,
		Effort: effort, EffortNote: note, CacheKeep: t.keepReason,
		Session: session, RequestID: requestID,
		Order: weighedOrder(failoverPlan(picked, pool, others), cfg, deps, t.now, nil, nil),
	}
	t.mergeToolSkips(d)
	return d, nil
}

func brainEffort(v string) string {
	if IsReasoningEffort(v) {
		return v
	}
	return ""
}

func (t *turnCtx) sleep(d time.Duration) {
	if t.deps.Sleep != nil {
		t.deps.Sleep(d)
		return
	}
	time.Sleep(d)
}
