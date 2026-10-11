package config

// Builtin routing ids that cannot be deleted.
var BuiltinRoutingIDs = []string{"plan", "execute", "utility", "chat"}

var defaultRoutingCopy = map[string]struct{ Label, Description string }{
	"plan":    {"Plan", "planning, coordination, review"},
	"execute": {"Execute", "implementation, debugging, tool loops"},
	"utility": {"Background", "background calls, titles, summaries"},
	"chat":    {"Chit-chat", "casual chat, greetings, small talk"},
}

var providerTypes = map[string]bool{
	"openai": true, "anthropic": true, "responses": true, "both": true,
	"gemini": true, "devin": true, "cursor": true, "chatgpt-web": true,
}

var oauthSources = map[string]bool{
	"claude-code": true, "codex": true, "antigravity": true, "devin": true,
	"cursor": true, "workbuddy-ai": true, "freebuff": true, "static": true,
	"grok": true,
}

var reasoningEfforts = map[string]bool{
	"none": true, "minimal": true, "low": true, "medium": true,
	"high": true, "xhigh": true, "max": true, "ultra": true,
}

var nativeDualWireHosts = []string{"openrouter.ai", "api.deepseek.com"}

const (
	defaultListenHost = "127.0.0.1"
	defaultListenPort = 8787
)

// DefaultQuotaGuard matches src/config.ts DEFAULT_QUOTA_GUARD.
var DefaultQuotaGuard = QuotaGuardConfig{
	Enabled:    true,
	LowPercent: 10,
	ResetAware: true,
}

// DefaultBrain matches src/config.ts DEFAULT_BRAIN.
var DefaultBrain = BrainConfig{
	Channel:       "typesafe",
	TimeoutMs:     5000,
	MinConfidence: 0.6,
}

// DefaultTunnel matches src/config.ts DEFAULT_TUNNEL.
var DefaultTunnel = TunnelConfig{
	Enabled:  false,
	Provider: "cloudflare",
}

// DefaultLan matches src/config.ts DEFAULT_LAN.
var DefaultLan = LanConfig{Enabled: false}

// DefaultModelSync matches src/config.ts DEFAULT_MODEL_SYNC.
var DefaultModelSync = ModelSyncConfig{
	Enabled:         true,
	IntervalMinutes: 12 * 60,
}

const minModelSyncIntervalMinutes = 15

// DefaultPromptPolicy matches src/prompt-policy.ts DEFAULT_PROMPT_POLICY.
var DefaultPromptPolicy = PromptPolicyConfig{
	Builtins: true,
	Rewrites: []PromptRewriteRule{},
}

// DefaultTokenSaver matches src/saver.ts DEFAULT_TOKEN_SAVER.
var DefaultTokenSaver = TokenSaverConfig{
	Enabled:   true,
	Command:   "rtk",
	TimeoutMs: 3000,
}

// DefaultRouting matches src/config.ts DEFAULT_ROUTING.
func DefaultRouting() RoutingConfig {
	routings := defaultRoutings(RoutingTiers{})
	return RoutingConfig{
		Mode:              "auto",
		Routings:          routings,
		Tiers:             tiersFromRoutings(routings),
		SessionTTLMinutes: 720,
		QuotaGuard:        DefaultQuotaGuard,
		Brains:            []BrainConfig{},
		BrainPicksEffort:  true,
	}
}

// DefaultConfig returns parseConfig({}) — empty providers, default listen/routing/etc.
func DefaultConfig() Config {
	return Config{
		Listen:       ListenConfig{Host: defaultListenHost, Port: defaultListenPort},
		Providers:    []Provider{},
		Tunnel:       DefaultTunnel,
		Lan:          DefaultLan,
		Routing:      DefaultRouting(),
		ModelSync:    DefaultModelSync,
		PromptPolicy: DefaultPromptPolicy,
		TokenSaver:   DefaultTokenSaver,
	}
}

func emptyRoutingTiers() RoutingTiers {
	return RoutingTiers{
		Plan:    []string{},
		Execute: []string{},
		Utility: []string{},
		Chat:    []string{},
	}
}

func isBuiltinRoutingID(id string) bool {
	for _, b := range BuiltinRoutingIDs {
		if b == id {
			return true
		}
	}
	return false
}

func defaultRoutings(models RoutingTiers) []RoutingEntry {
	out := make([]RoutingEntry, 0, len(BuiltinRoutingIDs))
	for _, id := range BuiltinRoutingIDs {
		meta := defaultRoutingCopy[id]
		var modelsFor []string
		switch id {
		case "plan":
			modelsFor = append([]string{}, models.Plan...)
		case "execute":
			modelsFor = append([]string{}, models.Execute...)
		case "utility":
			modelsFor = append([]string{}, models.Utility...)
		case "chat":
			modelsFor = append([]string{}, models.Chat...)
		}
		out = append(out, RoutingEntry{
			ID:          id,
			Label:       meta.Label,
			Description: meta.Description,
			Models:      modelsFor,
		})
	}
	return out
}

func tiersFromRoutings(routings []RoutingEntry) RoutingTiers {
	tiers := emptyRoutingTiers()
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
