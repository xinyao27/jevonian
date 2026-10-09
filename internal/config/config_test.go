package config

import (
	"os"
	"path/filepath"
	"testing"
)

const realisticConfig = `{
  // Example Jevonian config (JSONC)
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "defaultProvider": "deepseek",
  "providers": [
    {
      "name": "deepseek",
      "type": "both",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "auth": "api-key",
      "billing": "api",
      "models": [
        "deepseek-v4.1-flash",
        { "id": "deepseek-v4-pro", "wire": "openai" }
      ],
      "injectStreamUsage": true,
      "quota": { "fiveHourUsd": 10, "weeklyUsd": 50 },
    },
    {
      "name": "claude-work",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "auth": "oauth",
      "oauthSource": "claude-code",
      "billing": "subscription",
      "models": ["claude-sonnet-4-5"],
      "login": { "label": "work", "home": "/Users/me/.claude-work" },
    },
  ],
  "routing": {
    "mode": "auto",
    "routings": [
      {
        "id": "plan",
        "label": "Plan",
        "description": "planning",
        "models": ["deepseek-v4-pro"],
        "providers": { "deepseek-v4-pro": ["deepseek"] },
      },
      {
        "id": "execute",
        "label": "Execute",
        "description": "implementation",
        "models": ["deepseek-v4.1-flash", "claude-sonnet-4-5"],
      },
      {
        "id": "utility",
        "label": "Background",
        "description": "background",
        "models": ["deepseek-v4.1-flash"],
      },
      {
        "id": "chat",
        "label": "Chit-chat",
        "description": "small talk",
        "models": ["deepseek-v4.1-flash"],
      },
    ],
    "sessionTtlMinutes": 720,
    "baselineModel": "deepseek-v4-pro",
    "quotaGuard": { "enabled": true, "lowPercent": 15, "resetAware": true },
    "brains": [
      {
        "channel": "typesafe",
        "timeoutMs": 4000,
        "minConfidence": 0.55,
      },
    ],
    "brainPicksEffort": true,
  },
  "promptPolicy": {
    "builtins": true,
    "rewrites": [
      { "match": "You operate in Cursor\\.", "replace": "You work in an editor." },
    ],
  },
  "modelSync": { "enabled": true, "intervalMinutes": 720 },
  "tokenSaver": { "enabled": false, "command": "rtk", "timeoutMs": 2000 },
  "tunnel": { "enabled": false, "provider": "cloudflare" },
  "lan": { "enabled": false },
}`

func TestParseRealisticJSONC(t *testing.T) {
	cfg, err := ParseBytes([]byte(realisticConfig))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Listen.Host != "127.0.0.1" || cfg.Listen.Port != 8787 {
		t.Fatalf("listen = %+v", cfg.Listen)
	}
	if cfg.DefaultProvider != "deepseek" {
		t.Fatalf("defaultProvider = %q", cfg.DefaultProvider)
	}
	if len(cfg.Providers) != 2 {
		t.Fatalf("providers = %d", len(cfg.Providers))
	}

	ds := cfg.Providers[0]
	if ds.Name != "deepseek" || ds.Type != ProviderTypeBoth || ds.Auth != AuthAPIKey {
		t.Fatalf("deepseek provider = %+v", ds)
	}
	if ds.APIKeyEnv != "DEEPSEEK_API_KEY" {
		t.Fatalf("apiKeyEnv = %q", ds.APIKeyEnv)
	}
	if len(ds.Models) != 2 || ds.Models[0].ID != "deepseek-v4.1-flash" {
		t.Fatalf("models = %+v", ds.Models)
	}
	if ds.Models[1].ID != "deepseek-v4-pro" || len(ds.Models[1].Wire) != 1 || ds.Models[1].Wire[0] != WireOpenAI {
		t.Fatalf("pinned model = %+v", ds.Models[1])
	}
	if ds.Quota == nil || ds.Quota.FiveHourUSD == nil || *ds.Quota.FiveHourUSD != 10 {
		t.Fatalf("quota = %+v", ds.Quota)
	}

	claude := cfg.Providers[1]
	if claude.OAuthSource != OAuthClaudeCode || claude.Billing != BillingSubscription {
		t.Fatalf("claude provider = %+v", claude)
	}
	if claude.Login == nil || claude.Login.Label != "work" || claude.Login.Home != "/Users/me/.claude-work" {
		t.Fatalf("login = %+v", claude.Login)
	}

	if cfg.Routing.Mode != "auto" {
		t.Fatalf("routing.mode = %q", cfg.Routing.Mode)
	}
	if len(cfg.Routing.Routings) != 4 {
		t.Fatalf("routings = %d", len(cfg.Routing.Routings))
	}
	plan := cfg.Routing.Routings[0]
	if plan.ID != "plan" || len(plan.Models) != 1 || plan.Models[0] != "deepseek-v4-pro" {
		t.Fatalf("plan = %+v", plan)
	}
	if len(plan.Providers["deepseek-v4-pro"]) != 1 || plan.Providers["deepseek-v4-pro"][0] != "deepseek" {
		t.Fatalf("plan providers = %+v", plan.Providers)
	}
	if len(cfg.Routing.Tiers.Plan) != 1 || cfg.Routing.Tiers.Plan[0] != "deepseek-v4-pro" {
		t.Fatalf("tiers.plan = %+v", cfg.Routing.Tiers.Plan)
	}
	if !cfg.Routing.QuotaGuard.Enabled || cfg.Routing.QuotaGuard.LowPercent != 15 {
		t.Fatalf("quotaGuard = %+v", cfg.Routing.QuotaGuard)
	}
	if len(cfg.Routing.Brains) != 1 || cfg.Routing.Brains[0].TimeoutMs != 4000 {
		t.Fatalf("brains = %+v", cfg.Routing.Brains)
	}
	if cfg.PromptPolicy.Builtins != true || len(cfg.PromptPolicy.Rewrites) != 1 {
		t.Fatalf("promptPolicy = %+v", cfg.PromptPolicy)
	}
	if cfg.TokenSaver.Enabled {
		t.Fatal("tokenSaver should be disabled")
	}
	if cfg.ModelSync.IntervalMinutes != 720 {
		t.Fatalf("modelSync = %+v", cfg.ModelSync)
	}
}

func TestParseConfigEmptyDefaults(t *testing.T) {
	cfg, err := ParseConfig(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen.Port != 8787 {
		t.Fatalf("port = %d", cfg.Listen.Port)
	}
	if len(cfg.Providers) != 0 {
		t.Fatalf("providers = %d", len(cfg.Providers))
	}
	if cfg.Routing.Mode != "auto" || len(cfg.Routing.Routings) != 4 {
		t.Fatalf("routing = %+v", cfg.Routing)
	}
	if !cfg.Routing.QuotaGuard.Enabled || !cfg.Routing.QuotaGuard.ResetAware {
		t.Fatalf("quotaGuard = %+v", cfg.Routing.QuotaGuard)
	}
	if !cfg.PromptPolicy.Builtins {
		t.Fatal("promptPolicy.builtins should default true")
	}
}

func TestParseRejectsUnknownProviderType(t *testing.T) {
	_, err := ParseConfig(map[string]any{
		"providers": []any{
			map[string]any{"name": "p", "type": "grpc", "baseUrl": "https://example.com"},
		},
	})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestParseDropsUnknownOAuthSource(t *testing.T) {
	cfg, err := ParseConfig(map[string]any{
		"providers": []any{
			map[string]any{
				"name": "p", "type": "openai", "baseUrl": "https://example.com/v1",
				"auth": "oauth", "oauthSource": "nope",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Providers[0].OAuthSource != "" {
		t.Fatalf("oauthSource = %q", cfg.Providers[0].OAuthSource)
	}
}

func TestNormalizeDualWireHost(t *testing.T) {
	cfg, err := ParseConfig(map[string]any{
		"providers": []any{
			map[string]any{
				"name": "or", "type": "openai", "baseUrl": "https://openrouter.ai/api/v1",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Providers[0].Type != ProviderTypeBoth {
		t.Fatalf("type = %q, want both", cfg.Providers[0].Type)
	}
}

func TestChatGPTWebDefaultsToNoKey(t *testing.T) {
	cfg, err := ParseConfig(map[string]any{
		"providers": []any{
			map[string]any{
				"name": "chatgpt-local", "type": "chatgpt-web", "baseUrl": "http://127.0.0.1:8080/v1",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Providers[0].NoKey {
		t.Fatalf("expected NoKey=true for chatgpt-web")
	}
}

func TestLoadMissingFileReturnsDefault(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "missing.json")
	t.Setenv("JEVONIAN_CONFIG", cfgPath)
	cfg, path, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if path != cfgPath {
		t.Fatalf("path = %q", path)
	}
	if len(cfg.Providers) != 0 || cfg.Listen.Port != 8787 {
		t.Fatalf("default cfg = %+v", cfg)
	}
}

func TestLoadMissingFileHonoursJevonianPort(t *testing.T) {
	t.Setenv("JEVONIAN_CONFIG", filepath.Join(t.TempDir(), "missing.json"))
	t.Setenv("JEVONIAN_PORT", "8807")
	cfg, _, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen.Port != 8807 {
		t.Fatalf("port = %d, want 8807 from JEVONIAN_PORT", cfg.Listen.Port)
	}
	for _, bad := range []string{"", "oops", "0", "-3"} {
		t.Setenv("JEVONIAN_PORT", bad)
		cfg, _, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Listen.Port != 8787 {
			t.Fatalf("JEVONIAN_PORT=%q: port = %d, want the default 8787", bad, cfg.Listen.Port)
		}
	}
}

func TestLoadReadsJSONCFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfgPath, []byte(realisticConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JEVONIAN_CONFIG", cfgPath)
	cfg, path, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if path != cfgPath {
		t.Fatalf("path = %q", path)
	}
	if len(cfg.Providers) != 2 {
		t.Fatalf("providers = %d", len(cfg.Providers))
	}
}

func TestJevonianPortEnvOverridesListen(t *testing.T) {
	t.Setenv("JEVONIAN_PORT", "9999")
	cfg, err := ParseConfig(map[string]any{
		"listen": map[string]any{"port": float64(8787)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen.Port != 9999 {
		t.Fatalf("port = %d", cfg.Listen.Port)
	}
}

func TestLegacyTiersOnly(t *testing.T) {
	cfg, err := ParseConfig(map[string]any{
		"routing": map[string]any{
			"tiers": map[string]any{
				"plan":    []any{"m1"},
				"execute": []any{"m2"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Routing.Tiers.Plan) != 1 || cfg.Routing.Tiers.Plan[0] != "m1" {
		t.Fatalf("tiers = %+v", cfg.Routing.Tiers)
	}
	if cfg.Routing.Routings[0].Models[0] != "m1" {
		t.Fatalf("routings = %+v", cfg.Routing.Routings)
	}
}
