package routing

import (
	"fmt"
	"regexp"
	"sort"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/quota"
)

// experimentalRe matches catalog ids a vendor marks as pre-release.
// src/routing.ts isExperimental.
var experimentalRe = regexp.MustCompile(`(?i)(exp|experimental|preview|beta)`)

// TierPick is one (provider, model) candidate.
// src/routing.ts TierPick.
type TierPick struct {
	Model     string
	Provider  string
	Canonical string
}

// CapableCandidate pairs a candidate with what it can actually do.
// src/routing.ts CapableCandidate.
type CapableCandidate struct {
	TierPick
	Capabilities ModelCapabilities
}

// CacheCandidateView is a candidate plus its measured cache evidence.
// src/routing.ts CacheCandidateView.
type CacheCandidateView struct {
	Model     string        `json:"model"`
	Provider  string        `json:"provider"`
	Canonical string        `json:"canonical,omitempty"`
	Cache     CacheAffinity `json:"cache"`
	// Difference from the previous model's effective input cost.
	SwitchPenaltyUSD *float64 `json:"switchPenaltyUsd"`
}

// TierEntryCandidates resolves one model id to the providers that serve it:
// exact-declaring providers in config order (client-wire-capable first), then
// canonical/identity variants so a spent exact match cannot hide healthier
// resellers. src/routing.ts tierEntryCandidates.
func TierEntryCandidates(cfg *config.Config, deps Deps, model string, kind RequestKind) []TierPick {
	picks := []TierPick{}
	seen := map[string]bool{}
	add := func(provider, resolved, canonical string) {
		id := provider + "/" + resolved
		if seen[id] {
			return
		}
		seen[id] = true
		picks = append(picks, TierPick{Provider: provider, Model: resolved, Canonical: canonical})
	}

	preferred := []config.Provider{}
	for _, p := range cfg.Providers {
		if config.ProviderHasModel(p, model) && (kind == "" || CanServeClient(p, kind)) {
			preferred = append(preferred, p)
		}
	}
	exact := preferred
	if len(exact) == 0 {
		for _, p := range cfg.Providers {
			if config.ProviderHasModel(p, model) {
				exact = append(exact, p)
			}
		}
	}
	for _, p := range exact {
		add(p.Name, model, "")
	}

	// Exact spelling is not the whole catalog: absorb canonical/identity
	// variants so a spent exact match cannot hide healthier resellers.
	// src/routing.ts the canonicalVariants absorb in tierEntryCandidates.
	for _, v := range CanonicalVariants(cfg, model, kind, deps.Identity) {
		add(v.Provider, v.Model, model)
	}
	return picks
}

// ApplyProviderPreference applies a routing's named providers for one model:
// an allow-list, not just a hint. Absent list (nil) means every provider in
// config order; an empty list withholds the model.
// src/routing.ts applyProviderPreference.
func ApplyProviderPreference(picks []TierPick, preferred []string, hasList bool) []TierPick {
	if !hasList {
		return picks
	}
	if len(preferred) == 0 {
		return nil
	}
	remaining := append([]TierPick{}, picks...)
	kept := []TierPick{}
	for _, pick := range remaining {
		for _, name := range preferred {
			if pick.Provider == name {
				kept = append(kept, pick)
				break
			}
		}
	}
	ordered := []TierPick{}
	for _, name := range preferred {
		for i, pick := range kept {
			if pick.Provider == name {
				ordered = append(ordered, pick)
				kept = append(kept[:i], kept[i+1:]...)
				break
			}
		}
	}
	return ordered
}

// RoutingCandidates expands a routing's declared models to providers and
// filters by that routing's per-model allow-lists.
// src/routing.ts routingCandidates.
func RoutingCandidates(cfg *config.Config, deps Deps, entry config.RoutingEntry, kind RequestKind) []TierPick {
	out := []TierPick{}
	for _, model := range entry.Models {
		preferred, hasList := entry.Providers[model]
		out = append(out, ApplyProviderPreference(
			TierEntryCandidates(cfg, deps, model, kind), preferred, hasList,
		)...)
	}
	return out
}

// TierCandidates is the flat-model form of RoutingCandidates for callers that
// already hold a model list, not a RoutingEntry. src/routing.ts tierCandidates.
func TierCandidates(cfg *config.Config, deps Deps, tier []string, kind RequestKind) []TierPick {
	out := []TierPick{}
	for _, model := range tier {
		out = append(out, TierEntryCandidates(cfg, deps, model, kind)...)
	}
	return out
}

// FirstFromTier is the first candidate a model list resolves to.
// src/routing.ts firstFromTier.
func FirstFromTier(cfg *config.Config, deps Deps, tier []string, kind RequestKind) *TierPick {
	picks := TierCandidates(cfg, deps, tier, kind)
	if len(picks) == 0 {
		return nil
	}
	return &picks[0]
}

// ResolveCandidate resolves the model a brain named against the candidates
// code offered: an unrecognised answer (or "none_of_the_above") takes the
// safest listed option rather than failing the turn.
// src/routing.ts resolveCandidate.
func ResolveCandidate(model string, candidates []TierPick) *TierPick {
	if len(candidates) == 0 {
		return nil
	}
	if model == "" || model == "none_of_the_above" {
		return &candidates[0]
	}
	for i := range candidates {
		if candidates[i].Model == model {
			return &candidates[i]
		}
	}
	for i := range candidates {
		if candidates[i].Canonical == model {
			return &candidates[i]
		}
	}
	return &candidates[0]
}

// ---- deriveRoutings: auto-fill empty model lists by price tier ----

func isExperimental(model string) bool {
	return experimentalRe.MatchString(model)
}

// DeriveRoutings fills each routing's empty model list from the available
// models: "plan" gets the most expensive priced model, every other routing the
// cheapest; unpriced models only fill expensive slots and only after every
// priced one. Declared models are kept and mark their price used.
// src/routing.ts deriveRoutings.
//
// It reads only each routing's own model list, so it is safe to persist. Routing a
// request uses EffectiveRoutings, which also applies the time schedule.
func DeriveRoutings(cfg *config.Config, deps Deps) []config.RoutingEntry {
	return deriveRoutings(cfg, deps, false)
}

// EffectiveRoutings is DeriveRoutings for the current moment: while a schedule
// window is active, each routing that lists models for it uses them.
func EffectiveRoutings(cfg *config.Config, deps Deps) []config.RoutingEntry {
	return deriveRoutings(cfg, deps, true)
}

func deriveRoutings(cfg *config.Config, deps Deps, scheduled bool) []config.RoutingEntry {
	declared := make([]config.RoutingEntry, len(cfg.Routing.Routings))
	for i, entry := range cfg.Routing.Routings {
		declared[i] = entry
		declared[i].Models = append([]string{}, entry.Models...)
		if entry.Providers != nil {
			providers := map[string][]string{}
			for model, list := range entry.Providers {
				providers[model] = append([]string{}, list...)
			}
			declared[i].Providers = providers
		}
	}
	if scheduled {
		declared = ApplySchedule(declared, cfg.Routing.Schedule, deps.clock())
	}

	seenAvail := map[string]bool{}
	available := []string{}
	for _, p := range cfg.Providers {
		for _, m := range p.Models {
			if m.ID != "" && !seenAvail[m.ID] {
				seenAvail[m.ID] = true
				available = append(available, m.ID)
			}
		}
	}

	type pricedModel struct {
		model        string
		output       float64
		experimental bool
	}
	priced := []pricedModel{}
	unpriced := []pricedModel{}
	for _, model := range available {
		if deps.Prices != nil {
			if price := deps.Prices(model, ""); price != nil {
				priced = append(priced, pricedModel{model, price.Output, isExperimental(model)})
				continue
			}
		}
		unpriced = append(unpriced, pricedModel{model, 0, isExperimental(model)})
	}
	sort.SliceStable(priced, func(i, j int) bool { return priced[i].output > priced[j].output })

	// A model the catalog has no price for is still a real candidate, but an
	// unpriced model has no cost signal: it forms a second tier behind every
	// priced model — and only for the `expensive` direction. A cheap pick is
	// a cost claim an unknown price cannot back.
	// src/routing.ts the unpriced tier comment.
	pick := func(exclude map[string]bool, direction string) string {
		var tiers [][]pricedModel
		if direction == "expensive" {
			tiers = [][]pricedModel{priced, unpriced}
		} else {
			tiers = [][]pricedModel{priced}
		}
		for _, tier := range tiers {
			ordered := tier
			if direction == "cheap" {
				ordered = append([]pricedModel{}, tier...)
				for i, j := 0, len(ordered)-1; i < j; i, j = i+1, j-1 {
					ordered[i], ordered[j] = ordered[j], ordered[i]
				}
			}
			for _, c := range ordered {
				if !c.experimental && !exclude[c.model] {
					return c.model
				}
			}
			for _, c := range ordered {
				if !exclude[c.model] {
					return c.model
				}
			}
		}
		return ""
	}

	used := map[string]bool{}
	fill := func(entry *config.RoutingEntry, direction string) {
		if len(entry.Models) > 0 {
			for _, m := range entry.Models {
				used[m] = true
			}
			return
		}
		if candidate := pick(used, direction); candidate != "" {
			entry.Models = []string{candidate}
			entry.Providers = nil
			used[candidate] = true
		}
	}

	for i := range declared {
		if declared[i].ID == "plan" {
			fill(&declared[i], "expensive")
		} else {
			fill(&declared[i], "cheap")
		}
	}
	// A custom/chat routing with nothing left still needs a fallback so
	// explicit aliases work. src/routing.ts the reuse fallback.
	for i := range declared {
		if len(declared[i].Models) > 0 {
			continue
		}
		fallback := ""
		for _, c := range declared {
			if len(c.Models) > 0 {
				fallback = c.Models[0]
				break
			}
		}
		if fallback == "" && len(available) > 0 {
			fallback = available[0]
		}
		if fallback != "" {
			declared[i].Models = []string{fallback}
			declared[i].Providers = nil
		}
	}
	return declared
}

// DeriveTiers is the deprecated four-builtin view after auto-fill.
// src/routing.ts deriveTiers.
func DeriveTiers(cfg *config.Config, deps Deps) config.RoutingTiers {
	routings := DeriveRoutings(cfg, deps)
	tiers := config.RoutingTiers{
		Plan: []string{}, Execute: []string{}, Utility: []string{}, Chat: []string{},
	}
	for _, entry := range routings {
		switch entry.ID {
		case "plan":
			tiers.Plan = append([]string{}, entry.Models...)
		case "execute":
			tiers.Execute = append([]string{}, entry.Models...)
		case "utility":
			tiers.Utility = append([]string{}, entry.Models...)
		case "chat":
			tiers.Chat = append([]string{}, entry.Models...)
		}
	}
	return tiers
}

// RoutingByID returns the derived routing with id.
// src/routing.ts routingById.
func RoutingByID(cfg *config.Config, deps Deps, id string) *config.RoutingEntry {
	for _, entry := range EffectiveRoutings(cfg, deps) {
		if entry.ID == id {
			e := entry
			return &e
		}
	}
	return nil
}

// PhaseOfModel is the routing a model is declared under. Reporting only —
// routing never branches on it. src/routing.ts phaseOfModel.
func PhaseOfModel(cfg *config.Config, deps Deps, model string) string {
	for _, entry := range EffectiveRoutings(cfg, deps) {
		for _, m := range entry.Models {
			if m == model {
				return entry.ID
			}
		}
	}
	return "execute"
}

// ---- quota standing + reset-aware ordering ----

// quotaStanding is a candidate's allowance as reset-aware ordering reads it.
// src/routing.ts QuotaStanding.
type quotaStanding struct {
	used   float64
	renews []int64 // epoch ms, longest window first; 0 when not stated
	spent  bool
	low    bool
}

type orderOptions struct {
	now   int64
	cache map[string]quotaStanding
}

// standingOf resolves one provider/model's standing once per turn.
// src/routing.ts standingOf.
func standingOf(deps Deps, provider config.Provider, model string, now int64, lowPercent float64, cache map[string]quotaStanding) quotaStanding {
	key := provider.Name + "/" + model
	if cache != nil {
		if s, ok := cache[key]; ok {
			return s
		}
	}
	var view QuotaView
	if deps.Quota != nil {
		view = deps.Quota.Standing(provider, model, now, lowPercent)
	} else {
		view = QuotaView{Status: quota.StatusUnknown}
	}
	used := view.UsedPercent
	spent := view.Status == quota.StatusExhausted || view.ModelExhausted
	// A provider whose breaker is open, or whose in-flight slots are full, is
	// treated like a spent one for ordering. src/routing.ts standingOf.
	if deps.Guard != nil && deps.Guard.Spent(provider.Name, now) {
		spent = true
	}
	s := quotaStanding{
		used:   used,
		renews: view.Renews,
		spent:  spent,
		low:    view.Status == quota.StatusLow,
	}
	if cache != nil {
		cache[key] = s
	}
	return s
}

// earlierRenewal compares two renewal lists, longest window leading, to the
// hour. src/routing.ts earlierRenewal.
func earlierRenewal(left, right []int64) int {
	n := len(left)
	if len(right) > n {
		n = len(right)
	}
	for i := 0; i < n; i++ {
		var a, b int64
		if i < len(left) {
			a = left[i] / 3_600_000
		}
		if i < len(right) {
			b = right[i] / 3_600_000
		}
		if a == b {
			continue
		}
		// A window that does not say when it renews waits behind one that does.
		if a == 0 || b == 0 {
			if b == 0 {
				return -1
			}
			return 1
		}
		if a < b {
			return -1
		}
		return 1
	}
	return 0
}

// OrderByQuotaReset orders candidates so the allowance that renews soonest is
// used first; room before low, low before spent; ties keep configured order
// (cache warmth). src/routing.ts orderByQuotaReset.
func OrderByQuotaReset(picks []TierPick, cfg *config.Config, deps Deps, opts orderOptions) []TierPick {
	if len(picks) < 2 {
		return picks
	}
	now := opts.now
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	lowPercent := cfg.Routing.QuotaGuard.LowPercent
	byName := map[string]config.Provider{}
	for _, p := range cfg.Providers {
		byName[p.Name] = p
	}
	local := map[string]quotaStanding{}
	cache := opts.cache
	if cache == nil {
		cache = local
	}
	of := func(pick TierPick) quotaStanding {
		provider, ok := byName[pick.Provider]
		if !ok {
			return quotaStanding{}
		}
		return standingOf(deps, provider, pick.Model, now, lowPercent, cache)
	}
	fine := []TierPick{}
	low := []TierPick{}
	spent := []TierPick{}
	for _, pick := range picks {
		s := of(pick)
		switch {
		case s.spent:
			spent = append(spent, pick)
		case s.low:
			low = append(low, pick)
		default:
			fine = append(fine, pick)
		}
	}
	sort.SliceStable(fine, func(i, j int) bool {
		return earlierRenewal(of(fine[i]).renews, of(fine[j]).renews) < 0
	})
	byUsed := func(list []TierPick) func(i, j int) bool {
		return func(i, j int) bool { return of(list[i]).used < of(list[j]).used }
	}
	sort.SliceStable(low, byUsed(low))
	sort.SliceStable(spent, byUsed(spent))
	out := append(append(append([]TierPick{}, fine...), low...), spent...)
	return out
}

// orderProvidersByReset is OrderByQuotaReset for the providers serving one
// model, as the pinned path holds them. src/routing.ts orderProvidersByReset.
func orderProvidersByReset(providers []config.Provider, model string, cfg *config.Config, deps Deps, opts orderOptions) []config.Provider {
	if len(providers) < 2 {
		return providers
	}
	byName := map[string]config.Provider{}
	picks := make([]TierPick, 0, len(providers))
	for _, p := range providers {
		byName[p.Name] = p
		picks = append(picks, TierPick{Provider: p.Name, Model: model})
	}
	ordered := OrderByQuotaReset(picks, cfg, deps, opts)
	out := make([]config.Provider, 0, len(ordered))
	for _, pick := range ordered {
		if p, ok := byName[pick.Provider]; ok {
			out = append(out, p)
		}
	}
	return out
}

// ---- capability partition ----

// CapableCandidates attaches effective capabilities to each pick.
// src/routing.ts capableCandidates.
func CapableCandidates(cfg *config.Config, deps Deps, candidates []TierPick) []CapableCandidate {
	out := make([]CapableCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		var stated ModelCapabilities
		if deps.Capabilities != nil {
			stated = deps.Capabilities(candidate.Model)
		}
		var override *config.ModelCapacityConfig
		if cfg.Routing.Capacities != nil {
			if cap, ok := cfg.Routing.Capacities[candidate.Model]; ok {
				c := cap
				override = &c
			}
		}
		out = append(out, CapableCandidate{
			TierPick:     candidate,
			Capabilities: EffectiveCapabilities(candidate.Model, stated, override),
		})
	}
	return out
}

// PartitionByCapability splits candidates into the ones the brain may choose
// from and the ones code withholds, keeping the reason. A model whose
// capabilities are unknown is never withheld.
// src/routing.ts partitionByCapability.
func PartitionByCapability(candidates []CapableCandidate, tokens int, minEffort string, requiredEffort bool) (usable []CapableCandidate, skipped []RouteSkip) {
	for _, candidate := range candidates {
		caps := candidate.Capabilities
		if !FitsContext(caps.ContextWindow, tokens) {
			skipped = append(skipped, RouteSkip{
				Model:    candidate.Model,
				Provider: candidate.Provider,
				Reason:   "context",
				Detail:   fmt.Sprintf("~%d tokens exceeds the %d window", tokens, caps.ContextWindow),
			})
			continue
		}
		if requiredEffort && minEffort != "" && len(caps.Efforts) > 0 {
			deepest := deepestEffort(caps.Efforts)
			if EffortRank(deepest) < EffortRank(minEffort) {
				skipped = append(skipped, RouteSkip{
					Model:    candidate.Model,
					Provider: candidate.Provider,
					Reason:   "effort",
					Detail:   fmt.Sprintf("supports up to %q, needs %q", deepest, minEffort),
				})
				continue
			}
		}
		usable = append(usable, candidate)
	}
	return usable, skipped
}

// deepestEffort is the deepest level in a set, regardless of listed order.
// src/routing.ts deepestEffort.
func deepestEffort(efforts []string) string {
	best := ""
	for _, e := range efforts {
		if best == "" || EffortRank(e) > EffortRank(best) {
			best = e
		}
	}
	return best
}

// ---- cache affinity (measured) ----

// CacheAffinityMode is how a conversation's affinity is decided.
// src/routing.ts CacheAffinityMode.
type CacheAffinityMode string

const (
	AffinityAuto    CacheAffinityMode = "auto"
	AffinitySession CacheAffinityMode = "session"
	AffinityTurn    CacheAffinityMode = "turn"
	AffinityOff     CacheAffinityMode = "off"
)

// IsCacheAffinityMode reports whether value names a mode.
// src/routing.ts isCacheAffinityMode.
func IsCacheAffinityMode(value string) bool {
	switch CacheAffinityMode(value) {
	case AffinityAuto, AffinitySession, AffinityTurn, AffinityOff:
		return true
	}
	return false
}

// CacheKeep is the keep/move verdict. src/routing.ts CacheKeep.
type CacheKeep struct {
	Keep      bool
	Reason    CacheKeepReason
	CacheRead int
	At        int64
}

// cacheAffinityKeep decides whether the conversation stays with whoever
// answered it last — a measurement, not a guess, which is why code decides it
// instead of the brain. src/routing.ts cacheAffinityKeep.
func cacheAffinityKeep(previous *SessionState, mode CacheAffinityMode, withinTurn bool, candidates []TierPick, now int64, cacheTTLMs int64) CacheKeep {
	if mode == AffinityOff {
		return CacheKeep{Reason: KeepOff}
	}
	if previous == nil || previous.Cache == nil {
		return CacheKeep{Reason: KeepFirst}
	}
	observation := previous.Cache
	keep := CacheKeep{
		Reason:    KeepFirst,
		CacheRead: observation.CacheReadTokens,
		At:        observation.At,
	}
	// The observation belongs to whoever actually measured it — the serving
	// provider, not the provider the session record last pointed at.
	// src/routing.ts warmTarget.
	warmProvider, warmModel := observation.Provider, observation.Model
	found := false
	for _, candidate := range candidates {
		if candidate.Provider == warmProvider && candidate.Model == warmModel {
			found = true
			break
		}
	}
	if !found {
		keep.Reason = KeepGone
		return keep
	}
	if mode == AffinitySession {
		keep.Keep = true
		keep.Reason = KeepSession
		return keep
	}
	if withinTurn {
		keep.Keep = true
		keep.Reason = KeepTurn
		return keep
	}
	if mode == AffinityTurn {
		keep.Reason = KeepNewTurn
		return keep
	}
	if observation.CacheReadTokens < CacheWorthTokens {
		keep.Reason = KeepNoCache
		return keep
	}
	ttl := cacheTTLMs
	if ttl <= 0 {
		ttl = defaultCacheTTLMs
	}
	if now-observation.At >= ttl {
		keep.Reason = KeepCold
		return keep
	}
	keep.Keep = true
	keep.Reason = KeepCache
	return keep
}

// applyCacheKeep puts whoever answered last first when the verdict says to —
// a preference, not a restriction. src/routing.ts applyCacheKeep.
func applyCacheKeep(picks []TierPick, previous *SessionState, keep CacheKeep) []TierPick {
	if !keep.Keep || previous == nil || len(picks) < 2 {
		return picks
	}
	// Keep the target the cache observation actually belongs to — the serving
	// provider recorded it, so the warm prefix lives there even when the
	// session record has since moved. src/routing.ts applyCacheKeep.
	warmProvider, warmModel := previous.Provider, previous.Model
	if previous.Cache != nil {
		warmProvider, warmModel = previous.Cache.Provider, previous.Cache.Model
	}
	at := -1
	for i, candidate := range picks {
		if candidate.Provider == warmProvider && candidate.Model == warmModel {
			at = i
			break
		}
	}
	if at <= 0 {
		return picks
	}
	picked := picks[at]
	out := []TierPick{picked}
	out = append(out, picks[:at]...)
	out = append(out, picks[at+1:]...)
	return out
}

// cacheAffinity measures one candidate's cache warmth against the stored
// observation. src/routing.ts cacheAffinity.
func cacheAffinity(previous *SessionState, candidate TierPick, now, estimatedTokens, cacheTTLMs int64) CacheAffinity {
	ttl := cacheTTLMs
	if ttl <= 0 {
		ttl = defaultCacheTTLMs
	}
	if previous == nil || previous.Cache == nil || !previous.Cache.Success {
		return CacheAffinity{
			State:                  CacheUnknown,
			PrefixMatch:            "unknown",
			ExpectedUncachedTokens: int(estimatedTokens),
			EffectiveInputCostUSD:  nil,
		}
	}
	observation := previous.Cache
	sameTarget := observation.Provider == candidate.Provider && observation.Model == candidate.Model
	age := now - observation.At
	if age < 0 {
		age = 0
	}
	total := observation.UncachedInputTokens + observation.CacheReadTokens + observation.CacheWriteTokens
	hitRatio := 0.0
	if total > 0 {
		hitRatio = float64(observation.CacheReadTokens) / float64(total)
	}
	// Session identity is not proof that the on-wire prefix is unchanged.
	prefixMatch := "unknown"
	recency := 1 - float64(age)/float64(ttl)
	if recency < 0 {
		recency = 0
	}
	if recency > 1 {
		recency = 1
	}
	confidence := 0.0
	if sameTarget {
		confidence = recency * 0.5
	}
	expectedRead := 0
	if sameTarget {
		v := float64(min64(estimatedTokens, int64(observation.CacheReadTokens))) * recency
		expectedRead = int(v + 0.5)
	}
	expectedUncached := estimatedTokens - int64(expectedRead)
	if expectedUncached < 0 {
		expectedUncached = 0
	}
	var state CacheAffinityState
	switch {
	case !sameTarget:
		state = CacheUnknown
	case age >= ttl:
		state = CacheStale
	case expectedRead > 0:
		state = CacheHot
	case observation.CacheWriteTokens > 0:
		state = CacheWarm
	default:
		state = CacheWarm
	}
	return CacheAffinity{
		State:                  state,
		PrefixMatch:            prefixMatch,
		ObservedHitRatio:       hitRatio,
		ExpectedReadTokens:     expectedRead,
		ExpectedUncachedTokens: int(expectedUncached),
		EffectiveInputCostUSD:  nil,
		Confidence:             confidence,
	}
}

// cacheCostAffinity attaches an effective input cost when pricing knows the
// candidate. src/routing.ts cacheCostAffinity.
func cacheCostAffinity(deps Deps, candidate TierPick, affinity CacheAffinity, at time.Time) CacheAffinity {
	if deps.Prices == nil {
		return affinity
	}
	price := deps.Prices(candidate.Model, candidate.Provider)
	if price == nil {
		return affinity
	}
	rates := price
	if price.PeakRule == "deepseek" && IsDeepSeekPeak(at) && price.Peak != nil {
		rates = price.Peak
	}
	// Without a cache-read rate, reads bill as full input: the cost math is
	// only meaningful when the table names the rate. src/routing.ts.
	if affinity.ExpectedReadTokens > 0 && !rates.HasCacheRd {
		return affinity
	}
	usd := (float64(affinity.ExpectedUncachedTokens)*rates.Input +
		float64(affinity.ExpectedReadTokens)*rates.CacheRead) / 1_000_000
	affinity.EffectiveInputCostUSD = &usd
	affinity.CostKnown = true
	return affinity
}

// candidateCacheAffinity uses evidence from this target, never another provider.
func candidateCacheAffinity(deps Deps, previous *SessionState, candidate TierPick, now, tokens, ttl int64) CacheAffinity {
	if deps.CacheEvidence == nil {
		return cacheAffinity(previous, candidate, now, tokens, ttl)
	}
	var observation *CacheObservation
	if previous != nil {
		if c, ok := previous.Caches[PlanKey(candidate.Provider, candidate.Model)]; ok {
			observation = &c
		} else if previous.Cache != nil && previous.Cache.Provider == candidate.Provider && previous.Cache.Model == candidate.Model {
			observation = previous.Cache
		}
	}
	state := &SessionState{Cache: observation}
	// Cache affinity is target-local. Do not use a different target's legacy
	// Cache field as a fallback when history exists.
	if observation != nil && (observation.Provider != candidate.Provider || observation.Model != candidate.Model) {
		state.Cache = nil
	}
	match := "unknown"
	if deps.CacheEvidence != nil && observation != nil {
		scope, prefix := deps.CacheEvidence(candidate.Provider, candidate.Model)
		if scope == "" || scope != observation.Scope {
			state.Cache = nil
		} else {
			match = CompareCachePrefix(observation.Prefix, prefix)
			if match == "changed" || match == "unknown" {
				state.Cache = nil
			}
		}
	}
	affinity := cacheAffinity(state, candidate, now, tokens, ttl)
	affinity.PrefixMatch = match
	return affinity
}

// orderReusableCache preserves configured order except for targets with
// successful cache reads and matching source-prefix evidence. Unknown entries
// do not receive a new preference. Health filtering still applies afterwards.
func orderReusableCache(deps Deps, previous *SessionState, picks []TierPick, now, ttl int64) []TierPick {
	if deps.CacheEvidence == nil || previous == nil || len(picks) < 2 {
		return picks
	}
	out := append([]TierPick(nil), picks...)
	scores := map[string]int{}
	for _, pick := range picks {
		a := candidateCacheAffinity(deps, previous, pick, now, int64(^uint(0)>>1), ttl)
		// "extends" proves the live conversation still contains the cached
		// prefix and grew past it. A bare "same" does not justify moving the
		// turn back to a target the session already left.
		if a.PrefixMatch == "extends" && a.State == CacheHot && a.ExpectedReadTokens >= CacheWorthTokens {
			scores[PlanKey(pick.Provider, pick.Model)] = a.ExpectedReadTokens
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return scores[PlanKey(out[i].Provider, out[i].Model)] > scores[PlanKey(out[j].Provider, out[j].Model)]
	})
	return out
}

// cacheCandidates measures every candidate against the stored observation.
// src/routing.ts cacheCandidates.
func cacheCandidates(deps Deps, candidates []TierPick, previous *SessionState, now, estimatedTokens, cacheTTLMs int64) []CacheCandidateView {
	out := make([]CacheCandidateView, 0, len(candidates))
	at := time.UnixMilli(now).UTC()
	for _, candidate := range candidates {
		base := candidateCacheAffinity(deps, previous, candidate, now, estimatedTokens, cacheTTLMs)
		out = append(out, CacheCandidateView{
			Model:     candidate.Model,
			Provider:  candidate.Provider,
			Canonical: candidate.Canonical,
			Cache:     cacheCostAffinity(deps, candidate, base, at),
		})
	}
	return out
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
