package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/xinyao27/jevonian/internal/catalogsync"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/provider/devin"
	"github.com/xinyao27/jevonian/internal/routing"
)

type modelPrice struct {
	Provider   string      `json:"provider,omitempty"`
	PeakRule   string      `json:"peakRule,omitempty"`
	Input      float64     `json:"input"`
	Output     float64     `json:"output"`
	CacheRead  float64     `json:"cacheRead,omitempty"`
	CacheWrite float64     `json:"cacheWrite,omitempty"`
	Peak       *modelPrice `json:"peak,omitempty"`
}
type providerMeta struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	API  string   `json:"api,omitempty"`
	Env  []string `json:"env"`
	Type string   `json:"type"`
}
type pricingSnapshot struct {
	FetchedAt    string                    `json:"fetchedAt"`
	Source       string                    `json:"source"`
	Models       map[string]modelPrice     `json:"models"`
	Providers    map[string]providerMeta   `json:"providers"`
	Capabilities map[string]map[string]any `json:"capabilities,omitempty"`
	Identities   map[string]map[string]any `json:"identities,omitempty"`
}

var official = map[string]bool{"alibaba": true, "anthropic": true, "deepseek": true, "google": true, "meta": true, "minimax": true, "mistral": true, "moonshotai": true, "openai": true, "qwen": true, "tencent": true, "xai": true, "xiaomi": true, "zai": true}

// Rates from the TS v0.5.4 bundled fallback; snapshots take priority.
var fallbackPrices = map[string]modelPrice{
	"deepseek-v4.1-flash": {Provider: "deepseek", PeakRule: "deepseek", Input: .15, Output: .6, CacheRead: .003, Peak: &modelPrice{Input: .3, Output: 1.2, CacheRead: .006}},
	"deepseek-v4-pro":     {Provider: "deepseek", PeakRule: "deepseek", Input: .66, Output: 1.98, CacheRead: .022, Peak: &modelPrice{Input: 1.32, Output: 3.96, CacheRead: .044}},
	"claude-fable-5-1":    {Provider: "anthropic", Input: 10, Output: 50, CacheRead: .25, CacheWrite: 12.5},
	"claude-opus-5":       {Provider: "anthropic", Input: 5, Output: 25, CacheRead: .5, CacheWrite: 6.25},
	"gpt-5.6-luna":        {Provider: "openai", Input: .2, Output: 1.2, CacheRead: .02, CacheWrite: .25},
	"kimi-k3":             {Provider: "moonshot", Input: 3, Output: 15, CacheRead: .3},
	"kimi-k2.7-code":      {Provider: "moonshot", Input: .95, Output: 4, CacheRead: .19},
	"glm-5.3":             {Provider: "zai", Input: 1.4, Output: 4.4, CacheRead: .26},
	"glm-5.3-flash":       {Provider: "zai", Input: .15, Output: .5, CacheRead: .03},
	"minimax-m3":          {Provider: "minimax", Input: .3, Output: 1.2, CacheRead: .06},
	"qwen3.8-flash":       {Provider: "qwen", Input: .15, Output: .47, CacheRead: .016, CacheWrite: .2},
	"grok-4.5":            {Provider: "xai", Input: 2.0, Output: 6.0, CacheRead: .3},
	"grok-4.5-latest":     {Provider: "xai", Input: 2.0, Output: 6.0, CacheRead: .3},
	"grok-build-latest":   {Provider: "xai", Input: 2.0, Output: 6.0, CacheRead: .3},
	"grok-4.7":            {Provider: "xai", Input: 2.0, Output: 6.0},
	"grok-4.6":            {Provider: "xai", Input: 2.0, Output: 6.0, CacheRead: .5},
	"grok-4.3":            {Provider: "xai", Input: 1.25, Output: 2.5, CacheRead: .2},
	"grok-4.3-latest":     {Provider: "xai", Input: 1.25, Output: 2.5, CacheRead: .2},
	"grok-build-0.1":      {Provider: "xai", Input: 1.0, Output: 2.0, CacheRead: .2},
	"grok-code-fast-1":    {Provider: "xai", Input: 1.0, Output: 2.0, CacheRead: .2},
	"grok-code-fast":      {Provider: "xai", Input: 1.0, Output: 2.0, CacheRead: .2},
	"grok-4.20":           {Provider: "xai", Input: 1.25, Output: 2.5},
	"grok-4.20-0309-reasoning":     {Provider: "xai", Input: 1.25, Output: 2.5},
	"grok-4.20-non-reasoning":     {Provider: "xai", Input: 1.25, Output: 2.5},
	"grok-4.20-0309-non-reasoning": {Provider: "xai", Input: 1.25, Output: 2.5},
	"grok-4.20-multi-agent":       {Provider: "xai", Input: 1.25, Output: 2.5},
	"grok-4.20-multi-agent-0309":  {Provider: "xai", Input: 1.25, Output: 2.5},
}

func pricingPath() string { return filepath.Join(paths.DataDir(), "pricing.json") }

// pricingCache keeps the last parse per path+mtime+size so a single command
// (doctor calls it for the pricing label, the routing deps and report) reads
// the multi-megabyte snapshot once instead of once per use. It holds only the
// price side; capabilities and identities live in catalogsync's cache, so the
// two caches never hold the same decoded data.
var pricingCache struct {
	sync.Mutex
	path string
	mod  time.Time
	size int64
	snap pricingSnapshot
}

// pricingView is the read side of pricing.json: the price half only. Leaving
// out capabilities/identities skips decoding the larger half of the file.
type pricingView struct {
	FetchedAt string                  `json:"fetchedAt"`
	Source    string                  `json:"source"`
	Models    map[string]modelPrice   `json:"models"`
	Providers map[string]providerMeta `json:"providers"`
}

func loadPricing() pricingSnapshot {
	var s pricingSnapshot
	path := pricingPath()
	info, err := os.Stat(path)
	pricingCache.Lock()
	defer pricingCache.Unlock()
	if err == nil {
		if pricingCache.path == path && pricingCache.mod.Equal(info.ModTime()) && pricingCache.size == info.Size() {
			return pricingCache.snap
		}
	}
	if b, readErr := os.ReadFile(path); readErr == nil {
		var v pricingView
		if json.Unmarshal(b, &v) == nil {
			s = pricingSnapshot{FetchedAt: v.FetchedAt, Source: v.Source, Models: v.Models, Providers: v.Providers}
		}
	}
	if s.Models == nil {
		s.Models = map[string]modelPrice{}
		s.Source = "bundled-fallback"
	}
	for id, p := range fallbackPrices {
		if _, ok := s.Models[id]; !ok {
			s.Models[id] = p
		}
	}
	if err == nil {
		pricingCache.path = path
		pricingCache.mod = info.ModTime()
		pricingCache.size = info.Size()
		pricingCache.snap = s
	}
	return s
}

// cliPricingSource is the label TS `pricingInfo().source` prints: "models.dev" once any snapshot
// is loaded (usePriceTable's default), "bundled-fallback" otherwise. The snapshot's own source
// URL stays in pricing.json and in the dashboard status payload.
func cliPricingSource(s pricingSnapshot) string {
	if s.Source == "bundled-fallback" || s.Source == "" {
		return "bundled-fallback"
	}
	return "models.dev"
}
func aliases(model string) []string {
	out := []string{model}
	current := model
	for {
		found := false
		for _, suffix := range []string{"extra-low", "xhigh", "high", "medium", "low", "tiered", "thinking", "reasoning", "preview", "agent", "latest"} {
			if strings.HasSuffix(current, "-"+suffix) {
				current = strings.TrimSuffix(current, "-"+suffix)
				if current != "" {
					out = append(out, current)
					found = true
				}
				break
			}
		}
		if !found {
			break
		}
	}
	return out
}
func priceFor(s pricingSnapshot, model, provider string) *modelPrice {
	if strings.Contains(strings.ToLower(provider), "devin") || strings.HasPrefix(strings.ToLower(model), "devin/") {
		if meta, ok := devin.LookupModelMeta(model); ok && meta.Price != nil {
			p := meta.Price
			read := 0.0
			if p.CacheRead != nil {
				read = *p.CacheRead
			}
			return &modelPrice{Provider: "devin", Input: p.Input, Output: p.Output, CacheRead: read, CacheWrite: p.Input}
		}
	}
	names := aliases(model)
	tail := routing.BareModelID(model)
	if tail != model {
		names = append(names, aliases(tail)...)
	}
	var candidates []modelPrice
	var named *modelPrice
	for _, name := range names {
		if provider != "" {
			if p, ok := s.Models[provider+"/"+name]; ok {
				if official[provider] {
					return &p
				}
				if named == nil {
					copy := p
					named = &copy
				}
				candidates = append(candidates, p)
			}
		}
		if p, ok := s.Models[name]; ok {
			candidates = append(candidates, p)
		}
	}
	if named != nil {
		return named
	}
	for _, p := range candidates {
		if official[p.Provider] {
			return &p
		}
	}
	if len(candidates) > 0 {
		return &candidates[0]
	}
	return nil
}
func routePrice(p *modelPrice) *routing.Price {
	if p == nil {
		return nil
	}
	return &routing.Price{Provider: p.Provider, PeakRule: p.PeakRule, Input: p.Input, Output: p.Output, CacheRead: p.CacheRead, CacheWrite: p.CacheWrite, Peak: routePrice(p.Peak)}
}

// PriceSource resolves one model/provider pair through the persisted snapshot
// plus bundled fallbacks. Shareable as admin.Deps.Prices / routing.Deps.Prices.
func PriceSource() func(model, provider string) *routing.Price {
	return pricingDeps().Prices
}

// PricingInfo returns the dashboard's pricing/catalog status payload.
func PricingInfo() map[string]any {
	s := loadPricing()
	fresh := false
	if at, err := time.Parse(time.RFC3339Nano, s.FetchedAt); err == nil {
		fresh = time.Since(at) < 12*time.Hour
	}
	return map[string]any{
		"present":   s.FetchedAt != "" || len(s.Models) > 0,
		"fresh":     fresh,
		"fetchedAt": s.FetchedAt,
		"source":    s.Source,
		"models":    len(s.Models),
		"path":      pricingPath(),
		"ttlMs":     (12 * time.Hour).Milliseconds(),
	}
}

// RefreshPricing pulls models.dev and persists the snapshot (12h TTL source).
func RefreshPricing() (map[string]any, error) {
	s, err := refreshPricing()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"models":    len(s.Models),
		"fetchedAt": s.FetchedAt,
		"source":    s.Source,
		"cached":    false,
	}, nil
}

// PricingPath is the snapshot location.
func PricingPath() string { return pricingPath() }
func pricingDeps() routing.Deps {
	s := loadPricing()
	return routing.Deps{Prices: func(model, provider string) *routing.Price { return routePrice(priceFor(s, model, provider)) }}
}
func refreshPricing() (pricingSnapshot, error) {
	target := os.Getenv("JEVONIAN_MODELS_DEV_URL")
	if target == "" {
		target = "https://models.dev/api.json"
	}
	resp, err := cliHTTP().Get(target)
	if err != nil {
		return pricingSnapshot{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return pricingSnapshot{}, fmt.Errorf("models.dev HTTP %d", resp.StatusCode)
	}
	var raw map[string]struct {
		Name   string   `json:"name"`
		API    string   `json:"api"`
		Env    []string `json:"env"`
		NPM    string   `json:"npm"`
		Models map[string]struct {
			Name        string `json:"name"`
			Family      string `json:"family"`
			ReleaseDate string `json:"release_date"`
			Cost        struct {
				Input      *float64 `json:"input"`
				Output     *float64 `json:"output"`
				CacheRead  float64  `json:"cache_read"`
				CacheWrite float64  `json:"cache_write"`
			} `json:"cost"`
			Limit struct {
				Context int `json:"context"`
				Output  int `json:"output"`
			} `json:"limit"`
			Reasoning        any  `json:"reasoning"`
			Thinking         bool `json:"thinking"`
			ReasoningOptions []struct {
				Type   string   `json:"type"`
				Values []string `json:"values"`
			} `json:"reasoning_options"`
		} `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&raw); err != nil {
		return pricingSnapshot{}, err
	}
	s := pricingSnapshot{FetchedAt: time.Now().UTC().Format(time.RFC3339Nano), Source: target, Models: map[string]modelPrice{}, Providers: map[string]providerMeta{}, Capabilities: map[string]map[string]any{}, Identities: map[string]map[string]any{}}
	var providers []string
	for id := range raw {
		providers = append(providers, id)
	}
	sort.Strings(providers)
	for _, provider := range providers {
		value := raw[provider]
		typ := "openai"
		if strings.Contains(strings.ToLower(value.NPM), "anthropic") {
			typ = "anthropic"
		}
		s.Providers[provider] = providerMeta{ID: provider, Name: value.Name, API: value.API, Env: value.Env, Type: typ}
		var ids []string
		for id := range value.Models {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			m := value.Models[id]
			bare := routing.BareModelID(id)
			keys := []string{provider + "/" + id, routing.BareModelID(provider) + "/" + bare, bare}
			if m.Cost.Input != nil && m.Cost.Output != nil {
				p := modelPrice{Provider: provider, Input: *m.Cost.Input, Output: *m.Cost.Output, CacheRead: m.Cost.CacheRead, CacheWrite: m.Cost.CacheWrite}
				for _, key := range keys {
					old, ok := s.Models[key]
					if !ok || (key == bare && official[provider] && !official[old.Provider]) {
						s.Models[key] = p
					}
				}
			}
			caps := map[string]any{}
			if m.Limit.Context > 0 {
				caps["contextWindow"] = m.Limit.Context
			}
			if m.Limit.Output > 0 {
				caps["maxOutput"] = m.Limit.Output
			}
			var efforts []string
			for _, option := range m.ReasoningOptions {
				if option.Type == "effort" {
					efforts = option.Values
					break
				}
			}
			if arr, ok := m.Reasoning.([]any); ok {
				for _, v := range arr {
					if str, ok := v.(string); ok {
						efforts = append(efforts, str)
					}
				}
			}
			if len(efforts) == 0 && (m.Thinking || m.Reasoning == true) {
				efforts = []string{"minimal", "low", "medium", "high", "max"}
			}
			if len(efforts) > 0 {
				caps["efforts"] = efforts
			}
			identity := map[string]any{}
			if m.Name != "" {
				identity["name"] = m.Name
			}
			if m.Family != "" {
				identity["family"] = m.Family
			}
			if m.ReleaseDate != "" {
				identity["releaseDate"] = m.ReleaseDate
			}
			for _, key := range keys {
				if len(caps) > 0 {
					if _, ok := s.Capabilities[key]; !ok {
						s.Capabilities[key] = caps
					}
				}
				if len(identity) > 0 {
					if _, ok := s.Identities[key]; !ok || official[provider] {
						s.Identities[key] = identity
					}
				}
			}
		}
	}
	if len(s.Models) == 0 {
		return s, fmt.Errorf("models.dev returned no usable price records; previous snapshot preserved")
	}
	return s, writeJSONAtomic(pricingPath(), s, 0o600)
}
func (c commandContext) catalogDeps() catalogsync.Deps {
	return catalogsync.Deps{HTTP: cliHTTP(), RefreshPricing: RefreshPricing, PricingStatus: PricingInfo}
}

// printCatalogRefresh renders a catalogsync.RefreshResult in the TS `pricing --refresh` shape.
func (c commandContext) printCatalogRefresh(res catalogsync.RefreshResult, verbose bool) {
	verb := func(m map[string]any) string {
		if cached, _ := m["cached"].(bool); cached && verbose {
			return "cached"
		}
		return "saved"
	}
	if msg, _ := res.Pricing["error"].(string); msg != "" {
		fmt.Fprintf(c.out, "pricing: failed (%s)\n", msg)
	} else {
		fmt.Fprintf(c.out, "pricing: %s %v models from %v at %v\n", verb(res.Pricing), res.Pricing["models"], res.Pricing["source"], res.Pricing["fetchedAt"])
	}
	if msg, _ := res.Leaderboard["error"].(string); msg != "" {
		fmt.Fprintf(c.out, "leaderboard: failed (%s)\n", msg)
	} else {
		fmt.Fprintf(c.out, "leaderboard: %s %v models (%v boards) at %v\n", verb(res.Leaderboard), res.Leaderboard["models"], res.Leaderboard["boards"], res.Leaderboard["fetchedAt"])
	}
}

func (c commandContext) pricing(a arguments) error {
	if a.has("refresh") {
		fmt.Fprintln(c.out, "fetching models.dev pricing + benchmarks...")
		c.printCatalogRefresh(c.catalogDeps().Refresh(context.Background(), true), true)
	}
	s := loadPricing()
	fmt.Fprintf(c.out, "pricing source: %s (%d models)\n", cliPricingSource(s), len(s.Models))
	status := catalogsync.Status(time.Now(), PricingInfo())
	board, _ := status["leaderboard"].(map[string]any)
	if present, _ := board["present"].(bool); present {
		boards, _ := board["boards"].([]string)
		fmt.Fprintf(c.out, "leaderboard: fresh=%v models=%v boards=%d fetchedAt=%v\n", board["fresh"], board["models"], len(boards), board["fetchedAt"])
	} else {
		fmt.Fprintln(c.out, "leaderboard: missing (run jevonian refresh)")
	}
	return nil
}
