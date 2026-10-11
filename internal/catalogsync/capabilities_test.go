package catalogsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/provider/cursor"
	"github.com/xinyao27/jevonian/internal/provider/devin"
	"github.com/xinyao27/jevonian/internal/routing"
)

func sandbox(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("JEVONIAN_DATA_DIR", dir)
	devin.ResetModelMeta()
	cursor.ResetCatalog()
	t.Cleanup(func() {
		devin.ResetModelMeta()
		cursor.ResetCatalog()
	})
	return dir
}

func writeSnapshot(t *testing.T, dir string, snap map[string]any) {
	t.Helper()
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pricing.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCapabilitiesReadSnapshotShapes(t *testing.T) {
	dir := sandbox(t)
	writeSnapshot(t, dir, map[string]any{
		"capabilities": map[string]any{
			"openai/gpt-x":  map[string]any{"contextWindow": 128000, "maxOutput": 16000, "efforts": []string{"low", "bogus", "high"}},
			"gpt-x":         map[string]any{"contextWindow": 128000},
			"deepseek-flsh": map[string]any{"contextWindow": 64000},
			"canon-model-1": map[string]any{"contextWindow": 32000},
		},
	})
	caps := Capabilities()

	got := caps("openai/gpt-x")
	if got.ContextWindow != 128000 || got.MaxOutput != 16000 || len(got.Efforts) != 2 || got.Efforts[0] != "low" || got.Efforts[1] != "high" {
		t.Fatalf("qualified key: %+v", got)
	}
	// The bare tail resolves when the exact key is absent.
	if got := caps("someprovider/gpt-x"); got.ContextWindow != 128000 {
		t.Fatalf("bare tail: %+v", got)
	}
	// The canonical id resolves a re-spelled model (dots -> dashes, case folded).
	if got := caps("Canon.Model.1"); got.ContextWindow != 32000 {
		t.Fatalf("canonical: %+v", got)
	}
	// Silence is not evidence of a small window.
	if got := caps("unknown-model"); got.ContextWindow != 0 || got.MaxOutput != 0 || len(got.Efforts) != 0 {
		t.Fatalf("unknown: %+v", got)
	}
}

func TestCapabilitiesMissingOrCorruptSnapshotIsEmpty(t *testing.T) {
	dir := sandbox(t)
	if got := ModelCapabilities("anything"); got.ContextWindow != 0 || got.MaxOutput != 0 || len(got.Efforts) != 0 {
		t.Fatalf("missing snapshot: %+v", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "pricing.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ModelCapabilities("anything"); got.ContextWindow != 0 {
		t.Fatalf("corrupt snapshot: %+v", got)
	}
}

func TestCapabilitiesMergeDevinAndCursorUnderCatalog(t *testing.T) {
	dir := sandbox(t)
	cacheRead := 0.1
	devin.SaveModelMeta([]devin.Model{
		{ID: "devin-only", ContextWindow: 200000, MaxOutput: 8000, Price: &devin.Price{Input: 1, Output: 2, CacheRead: &cacheRead}},
		{ID: "both-model", ContextWindow: 150000, MaxOutput: 9000},
	})
	cursor.SaveCatalog([]cursor.Model{
		{ID: "cursor-only", Name: "Cursor Only", Context: 400000},
		{ID: "both-model", Name: "Both", Context: 500000},
	})
	writeSnapshot(t, dir, map[string]any{
		"capabilities": map[string]any{
			// models.dev states only the output cap: Devin/Cursor windows must survive.
			"both-model": map[string]any{"maxOutput": 4000},
		},
	})
	if got := ModelCapabilities("devin-only"); got.ContextWindow != 200000 || got.MaxOutput != 8000 {
		t.Fatalf("devin-only: %+v", got)
	}
	if got := ModelCapabilities("cursor-only"); got.ContextWindow != 400000 {
		t.Fatalf("cursor-only: %+v", got)
	}
	// {...devin, ...cursor, ...catalog}: cursor beats devin on the window, the
	// catalog beats devin on the output cap it states.
	if got := ModelCapabilities("both-model"); got.ContextWindow != 500000 || got.MaxOutput != 4000 {
		t.Fatalf("both-model: %+v", got)
	}
	// A provider prefix is ignored for both on-disk catalogs.
	if got := ModelCapabilities("some/devin-only"); got.ContextWindow != 200000 {
		t.Fatalf("prefixed devin-only: %+v", got)
	}
}

func TestServingModeAndNormalizeModelName(t *testing.T) {
	for id, want := range map[string]ServingMode{
		"deepseek-v4-flash":           ModeStandard,
		"deepseek-v4-flash:free":      ModeFree,
		"deepseek-v4-flash-free":      ModeFree,
		"kimi-k3:fast":                ModeFast,
		"openrouter/x/model:thinking": ModeThinking,
		"gpt-batch":                   ModeBatch,
		"freedom-model":               ModeStandard,
	} {
		if got := ServingModeOf(id); got != want {
			t.Errorf("ServingModeOf(%q) = %q, want %q", id, got, want)
		}
	}
	for in, want := range map[string]string{
		"DeepSeek V4.1 Flash":                "deepseek v4.1 flash",
		"DeepSeek V4.1 Flash (Fireworks AI)": "deepseek v4.1 flash",
		"OpenAI: GPT-5 Pro":                  "gpt 5 pro",
		"GPT-5 Pro":                          "gpt 5 pro",
	} {
		if got := NormalizeModelName(in); got != want {
			t.Errorf("NormalizeModelName(%q) = %q, want %q", in, got, want)
		}
	}
}

func identityConfig() *config.Config {
	return &config.Config{Providers: []config.Provider{
		{Name: "reseller", Type: config.ProviderTypeOpenAI, BaseURL: "https://api.reseller.example/v1", Models: []config.ModelEntry{{ID: "deepseek-v4.1-flash"}}},
		{Name: "official", Type: config.ProviderTypeOpenAI, BaseURL: "https://api.deepseek/v1", Models: []config.ModelEntry{{ID: "deepseek-flash"}}},
		{Name: "deepseek", Type: config.ProviderTypeOpenAI, BaseURL: "https://gateway.example/v1", Models: []config.ModelEntry{{ID: "deepseek-flash:free"}}},
	}}
}

func TestIdentityWidensAcrossSpellingsAndTagsOfficial(t *testing.T) {
	dir := sandbox(t)
	writeSnapshot(t, dir, map[string]any{
		"identities": map[string]any{
			"deepseek/deepseek-flash":        map[string]any{"name": "DeepSeek V4.1 Flash", "family": "deepseek"},
			"deepseek/deepseek-v4.1-flash":   map[string]any{"name": "DeepSeek V4.1 Flash"},
			"reseller-x/deepseek-v4.1-flash": map[string]any{"name": "DeepSeek: DeepSeek V4.1 Flash (Fireworks AI)"},
			"deepseek-flash":                 map[string]any{"name": "DeepSeek V4.1 Flash"},
			"deepseek-v4.1-flash":            map[string]any{"name": "DeepSeek V4.1 Flash"},
			"deepseek-flash:free":            map[string]any{"name": "DeepSeek V4.1 Flash"},
		},
	})
	idx := NewIdentity()
	key := idx.IdentityKey("deepseek-v4.1-flash")
	if key != "deepseek v4.1 flash@standard" {
		t.Fatalf("key = %q", key)
	}
	if idx.IdentityKey("deepseek-flash") != key {
		t.Fatal("official spelling must share the reseller's identity key")
	}
	// The serving mode keeps promo routes out of the standard pool.
	if free := idx.IdentityKey("deepseek-flash:free"); free == key || free != "deepseek v4.1 flash@free" {
		t.Fatalf("free key = %q", free)
	}
	// An id the catalog does not name has no identity key.
	if idx.IdentityKey("made-up-model") != "" {
		t.Fatal("unknown id must not get an identity key")
	}

	cfg := identityConfig()
	if !idx.IsOfficial(cfg, "official", "deepseek-v4.1-flash") {
		t.Fatal("a *.deepseek host must be official for the deepseek vendor")
	}
	if !idx.IsOfficial(cfg, "deepseek", "deepseek-v4.1-flash") {
		t.Fatal("a provider named after the vendor must be official")
	}
	if idx.IsOfficial(cfg, "reseller", "deepseek-v4.1-flash") {
		t.Fatal("a reseller must not be official")
	}
	if idx.IsOfficial(cfg, "missing", "deepseek-v4.1-flash") || idx.IsOfficial(cfg, "official", "made-up-model") {
		t.Fatal("unknown provider or model must not be official")
	}

	// CanonicalVariants widens deepseek-v4.1-flash onto the official
	// `deepseek-flash` spelling through identity, in config order.
	variants := routing.CanonicalVariants(cfg, "deepseek-v4.1-flash", "", idx)
	var viaIdentity, official []string
	for _, v := range variants {
		if v.ViaIdentity {
			viaIdentity = append(viaIdentity, v.Provider+"/"+v.Model)
		}
		if v.Official {
			official = append(official, v.Provider)
		}
	}
	if len(variants) != 2 || variants[0].Provider != "reseller" || variants[1].Provider != "official" || len(viaIdentity) != 1 || viaIdentity[0] != "official/deepseek-flash" {
		t.Fatalf("variants = %+v", variants)
	}
	if len(official) != 1 || official[0] != "official" {
		t.Fatalf("official variants = %v", official)
	}
	// With no identity index the widening never happens.
	if v := routing.CanonicalVariants(cfg, "deepseek-v4.1-flash", "", nil); len(v) != 1 {
		t.Fatalf("nil index variants = %+v", v)
	}
}

func TestIdentityPrefersOfficialNameAndReloadsOnChange(t *testing.T) {
	dir := sandbox(t)
	writeSnapshot(t, dir, map[string]any{
		"identities": map[string]any{
			"a-reseller/x-model": map[string]any{"name": "Reseller Flavoured X"},
			"anthropic/x-model":  map[string]any{"name": "Real X"},
		},
	})
	id := NewIdentity().(Identity)
	if got := id.Of("x-model"); got.DisplayName != "Reseller Flavoured X" {
		// Bare/canonical maps keep first-named-wins, like TS.
		t.Fatalf("bare display = %+v", got)
	}
	if got := id.Of("anthropic/x-model"); got.DisplayName != "Real X" || got.Label != "real x" {
		t.Fatalf("qualified display = %+v", got)
	}
	// A refreshed snapshot (new size/mtime) is picked up without a restart.
	writeSnapshot(t, dir, map[string]any{
		"identities": map[string]any{"anthropic/x-model": map[string]any{"name": "Real X Renamed Longer"}},
	})
	if got := id.Of("x-model"); got.DisplayName != "Real X Renamed Longer" {
		t.Fatalf("after refresh = %+v", got)
	}
}

func TestXaiGrokCapabilities(t *testing.T) {
	sandbox(t)
	caps := Capabilities()

	// grok-4.5 context window and reasoning efforts
	g45 := caps("grok-4.5")
	if g45.ContextWindow != 500000 {
		t.Fatalf("expected grok-4.5 context window 500000, got %d", g45.ContextWindow)
	}
	if len(g45.Efforts) != 4 || g45.Efforts[0] != "low" || g45.Efforts[3] != "xhigh" {
		t.Fatalf("expected grok-4.5 efforts [low, medium, high, xhigh], got %v", g45.Efforts)
	}

	// grok-4.3 1M context window and efforts including none
	g43 := caps("xai/grok-4.3")
	if g43.ContextWindow != 1000000 {
		t.Fatalf("expected grok-4.3 context window 1000000, got %d", g43.ContextWindow)
	}
	if len(g43.Efforts) != 5 || g43.Efforts[0] != "none" || g43.Efforts[4] != "xhigh" {
		t.Fatalf("expected grok-4.3 efforts [none, low, medium, high, xhigh], got %v", g43.Efforts)
	}

	// grok-build-0.1 256k context
	gb := caps("grok-build-0.1")
	if gb.ContextWindow != 256000 {
		t.Fatalf("expected grok-build-0.1 context window 256000, got %d", gb.ContextWindow)
	}
}

