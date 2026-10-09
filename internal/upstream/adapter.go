package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/oauth"
	"github.com/xinyao27/jevonian/internal/wire"
	anthropicwire "github.com/xinyao27/jevonian/internal/wire/anthropic"
	openaiwire "github.com/xinyao27/jevonian/internal/wire/openai"
	responseswire "github.com/xinyao27/jevonian/internal/wire/responses"
)

// ClientKind is the client's wire (which shape the HTTP response must take).
// Equal to config.UpstreamWire; named for call sites that speak "who asked".
type ClientKind = config.UpstreamWire

const (
	KindOpenAI    = config.WireOpenAI
	KindAnthropic = config.WireAnthropic
	KindResponses = config.WireResponses
)

// WirePlan is the chosen upstream wire + whether the body must be bridged.
// src/wire.ts planUpstreamWire.
type WirePlan struct {
	Wire   config.UpstreamWire
	Bridge string // "", "to-openai", "to-anthropic"
}

// PlanUpstreamWire decides the wire to hit and whether the body is translated.
// Preference: honor the model's declared wires; prefer the client's own wire
// when the model lists it; otherwise bridge onto one the model speaks.
// src/wire.ts planUpstreamWire.
func PlanUpstreamWire(provider config.Provider, client ClientKind, model string) (WirePlan, error) {
	switch provider.Type {
	case config.ProviderTypeGemini:
		// Gemini speaks its own envelope built from a Chat Completions body.
		bridge := ""
		if client == KindResponses {
			bridge = "to-openai"
		}
		return WirePlan{Wire: KindOpenAI, Bridge: bridge}, nil
	case config.ProviderTypeChatGPTWeb:
		bridge := ""
		if client != KindOpenAI {
			bridge = "to-openai"
		}
		return WirePlan{Wire: KindOpenAI, Bridge: bridge}, nil
	case config.ProviderTypeDevin, config.ProviderTypeCursor:
		// Connect-RPC envelopes encode a Chat Completions body.
		if client == KindOpenAI {
			return WirePlan{Wire: KindOpenAI}, nil
		}
		return WirePlan{Wire: KindOpenAI, Bridge: "to-openai"}, nil
	case config.ProviderTypeResponses:
		if client != KindOpenAI && client != KindResponses {
			return WirePlan{}, fmt.Errorf("provider %q speaks responses, not %s", provider.Name, client)
		}
		return WirePlan{Wire: KindResponses}, nil
	}
	if !providerServesClient(provider, client) {
		return WirePlan{}, fmt.Errorf("provider %q speaks the %s protocol, not %s", provider.Name, provider.Type, client)
	}
	wires := WiresOf(provider, model)
	has := func(w config.UpstreamWire) bool {
		for _, x := range wires {
			if x == w {
				return true
			}
		}
		return false
	}
	switch client {
	case KindResponses:
		if has(KindResponses) {
			return WirePlan{Wire: KindResponses}, nil
		}
		if has(KindOpenAI) {
			return WirePlan{Wire: KindOpenAI, Bridge: "to-openai"}, nil
		}
		if has(KindAnthropic) {
			return WirePlan{Wire: KindAnthropic, Bridge: "to-anthropic"}, nil
		}
		return WirePlan{}, fmt.Errorf("model %q on %q cannot serve Responses clients", model, provider.Name)
	case KindAnthropic:
		if has(KindAnthropic) {
			return WirePlan{Wire: KindAnthropic}, nil
		}
		if has(KindOpenAI) {
			return WirePlan{Wire: KindOpenAI, Bridge: "to-openai"}, nil
		}
		return WirePlan{}, fmt.Errorf("model %q on %q cannot serve Anthropic clients", model, provider.Name)
	default:
		if has(KindOpenAI) {
			return WirePlan{Wire: KindOpenAI}, nil
		}
		if has(KindAnthropic) {
			return WirePlan{Wire: KindAnthropic, Bridge: "to-anthropic"}, nil
		}
		return WirePlan{}, fmt.Errorf("model %q on %q cannot serve OpenAI clients", model, provider.Name)
	}
}

func providerServesClient(p config.Provider, client ClientKind) bool {
	if ProviderSpeaks(p, client) {
		return true
	}
	if p.Type == config.ProviderTypeDevin || p.Type == config.ProviderTypeCursor || p.Type == config.ProviderTypeChatGPTWeb {
		return true
	}
	if client == KindAnthropic && p.Type == config.ProviderTypeOpenAI {
		return true
	}
	if client == KindOpenAI && p.Type == config.ProviderTypeAnthropic {
		return true
	}
	if client == KindResponses &&
		(p.Type == config.ProviderTypeOpenAI || p.Type == config.ProviderTypeBoth ||
			p.Type == config.ProviderTypeGemini || p.Type == config.ProviderTypeAnthropic) {
		return true
	}
	return false
}

// ProviderSpeaks is true when the host accepts wire natively.
// src/wire.ts providerSpeaks.
func ProviderSpeaks(p config.Provider, w config.UpstreamWire) bool {
	if p.Type == config.ProviderTypeBoth {
		return w == KindOpenAI || w == KindAnthropic
	}
	switch p.Type {
	case config.ProviderTypeGemini, config.ProviderTypeDevin, config.ProviderTypeCursor, config.ProviderTypeChatGPTWeb:
		return w == KindOpenAI
	}
	if w == KindOpenAI {
		return p.Type == config.ProviderTypeOpenAI || p.Type == config.ProviderTypeResponses
	}
	return config.ProviderType(w) == p.Type
}

// WiresOf lists the model's declared wires, or inferred ones when the entry
// omits `wire`. src/wire.ts wiresOf.
func WiresOf(p config.Provider, modelID string) []config.UpstreamWire {
	for _, e := range p.Models {
		if e.ID == modelID && len(e.Wire) > 0 {
			return e.Wire
		}
	}
	return inferModelWires(p, modelID)
}

func inferModelWires(p config.Provider, modelID string) []config.UpstreamWire {
	switch p.Type {
	case config.ProviderTypeAnthropic:
		return []config.UpstreamWire{KindAnthropic}
	case config.ProviderTypeResponses:
		return []config.UpstreamWire{KindResponses}
	case config.ProviderTypeGemini, config.ProviderTypeDevin, config.ProviderTypeCursor,
		config.ProviderTypeChatGPTWeb, config.ProviderTypeOpenAI:
		return []config.UpstreamWire{KindOpenAI}
	case config.ProviderTypeBoth:
		if anthropicwire.NeedsWire(modelID) {
			return []config.UpstreamWire{KindAnthropic}
		}
		wires := []config.UpstreamWire{KindOpenAI}
		if IsNativeResponsesHost(p.BaseURL) {
			wires = append(wires, KindResponses)
		}
		if !MessagesRejectsNonClaude(p) {
			wires = append(wires, KindAnthropic)
		}
		return wires
	}
	return []config.UpstreamWire{KindOpenAI}
}

// Native host tables. src/wire.ts NATIVE_*_HOSTS.
var (
	nativeDualWireHosts     = []string{"openrouter.ai", "api.deepseek.com"}
	nativeResponsesHosts    = []string{"opencode.ai"}
	messagesClaudeOnlyHosts = []string{"opencode.ai", "commandcode.ai"}
	splitAnthropicPathHosts = []string{"api.deepseek.com"}
)

func hostOf(baseURL string) string {
	u := strings.TrimPrefix(baseURL, "http://")
	u = strings.TrimPrefix(u, "https://")
	if i := strings.IndexAny(u, "/:"); i >= 0 {
		u = u[:i]
	}
	return strings.ToLower(u)
}

func hostMatches(baseURL string, suffixes []string) bool {
	host := hostOf(baseURL)
	for _, s := range suffixes {
		if host == s || strings.HasSuffix(host, "."+s) {
			return true
		}
	}
	return false
}

// IsNativeDualWireHost is true for hosts that speak Chat + Messages on one key.
func IsNativeDualWireHost(baseURL string) bool { return hostMatches(baseURL, nativeDualWireHosts) }

// IsNativeResponsesHost is true for hosts that accept /responses natively.
func IsNativeResponsesHost(baseURL string) bool {
	return hostMatches(baseURL, nativeResponsesHosts)
}

// MessagesRejectsNonClaude is true for hosts that reject non-Claude ids on /messages.
func MessagesRejectsNonClaude(p config.Provider) bool {
	return hostMatches(p.BaseURL, messagesClaudeOnlyHosts)
}

// UpstreamURLFor resolves the endpoint one provider wire POSTs to.
// src/wire.ts upstreamUrlFor.
func UpstreamURLFor(p config.Provider, w config.UpstreamWire) string {
	base := strings.TrimRight(p.BaseURL, "/")
	if w == KindAnthropic && hostMatches(p.BaseURL, splitAnthropicPathHosts) {
		root := base
		root = strings.TrimSuffix(root, "/v1/messages")
		root = strings.TrimSuffix(root, "/anthropic")
		root = strings.TrimSuffix(root, "/v1")
		return root + "/anthropic/v1/messages"
	}
	path := "/chat/completions"
	switch p.Type {
	case config.ProviderTypeAnthropic:
		path = "/messages"
	case config.ProviderTypeResponses:
		path = "/responses"
	case config.ProviderTypeBoth:
		if w == KindAnthropic {
			path = "/messages"
		} else if w == KindResponses {
			path = "/responses"
		}
	default:
		if w == KindAnthropic {
			path = "/messages"
		} else if w == KindResponses {
			path = "/responses"
		}
	}
	return base + path
}

// PrepInput is what one attempt needs to build its body.
type PrepInput struct {
	PromptPolicy config.PromptPolicyConfig
	Provider     config.Provider
	Model        string
	Effort       string // routing-chosen thinking level
	ClientKind   ClientKind
	ClientBody   wire.Body
	UpstreamWire config.UpstreamWire
	Bridge       string
	Stream       bool
	// ClientStream is whether the client asked for SSE; Stream is what the
	// upstream is asked for (always-stream hosts differ).
	ClientStream bool
	MaxOutput    int
}

// PreviewCacheBody prepares evidence for transparent static adapters only.
// It has no auth, network, environment, or token-saver side effects. A false
// result means the prepared body is not safe to use as cache evidence.
func PreviewCacheBody(provider config.Provider, model string, clientKind ClientKind, clientBody wire.Body, policy config.PromptPolicyConfig, tokenSaver config.TokenSaverConfig, stream bool) (wire.Body, config.UpstreamWire, bool) {
	if provider.Auth == config.AuthOAuth || provider.OAuthSource != "" ||
		(provider.Type != config.ProviderTypeOpenAI && provider.Type != config.ProviderTypeAnthropic && provider.Type != config.ProviderTypeResponses && provider.Type != config.ProviderTypeBoth) {
		return nil, "", false
	}
	plan, err := PlanUpstreamWire(provider, clientKind, model)
	if err != nil || (plan.Wire != KindOpenAI && plan.Wire != KindAnthropic && plan.Wire != KindResponses) {
		return nil, "", false
	}
	adapter, err := AdapterFor(provider, clientKind, plan)
	if err != nil {
		return nil, "", false
	}
	switch adapter.(type) {
	case *openaiAdapter, *anthropicAdapter, *responsesAdapter:
	default:
		return nil, "", false
	}
	if tokenSaver.Enabled && containsToolResult(clientBody) {
		return nil, "", false
	}
	clonedBody, ok := cloneAdapterBody(clientBody)
	if !ok {
		return nil, "", false
	}
	prepared, err := adapter.Prepare(PrepInput{
		PromptPolicy: policy, Provider: provider, Model: model, ClientKind: clientKind,
		ClientBody: clonedBody, UpstreamWire: plan.Wire, Bridge: plan.Bridge,
		Stream: stream || adapter.AlwaysStreams(), ClientStream: stream,
	})
	if err != nil {
		return nil, "", false
	}
	if _, ok := prepared["messages"].([]any); !ok {
		return nil, "", false
	}
	return prepared, plan.Wire, true
}

func cloneAdapterBody(body wire.Body) (wire.Body, bool) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, false
	}
	var clone wire.Body
	if err := json.Unmarshal(encoded, &clone); err != nil || clone == nil {
		return nil, false
	}
	return clone, true
}

func containsToolResult(body wire.Body) bool {
	for _, raw := range wire.AsSlice(body["messages"]) {
		message := wire.AsRecord(raw)
		if message["role"] == "tool" {
			return true
		}
		for _, block := range wire.AsSlice(message["content"]) {
			if wire.AsRecord(block)["type"] == "tool_result" {
				return true
			}
		}
	}
	for _, raw := range wire.AsSlice(body["input"]) {
		if wire.AsRecord(raw)["type"] == "function_call_output" {
			return true
		}
	}
	return false
}

// Adapter is one provider's egress: build the wire body, send it, read its
// usage. The attempt loop stays protocol-blind: AdapterFor is the one place
// that maps a provider to its adapter (tests and embedders add their own via
// ForwardDeps.Adapters), and provider quirks are optional interfaces below,
// never provider-type checks in the loop.
type Adapter interface {
	// Wire is the upstream protocol the provider answers on.
	Wire() config.UpstreamWire
	// AlwaysStreams reports whether the provider only streams (responses,
	// devin, cursor, workbuddy). A non-stream client gets the stream folded.
	AlwaysStreams() bool
	// Prepare assembles the upstream body for one attempt.
	Prepare(in PrepInput) (wire.Body, error)
	// UsageFrom reads a non-streaming reply's token accounting.
	UsageFrom(body []byte) wire.Usage
	// EndpointURL overrides the default UpstreamURLFor when non-empty.
	EndpointURL(provider config.Provider) string
	// Headers contributes provider-specific request headers.
	Headers(provider config.Provider, base http.Header) http.Header
}

// Optional adapter capabilities. The attempt loop asks the adapter, so a new
// provider adds a method here instead of a branch in Try/attempt.

// attemptRunner owns the whole upstream exchange (Connect-RPC, session-bound
// hosts). The runner still owns guards, classification and benching.
type attemptRunner interface {
	runAttempt(r *Runner, ctx context.Context, req AttemptRequest, at *Attempt, body wire.Body, auth oauth.AuthResolution)
}

// concurrencyLimiter caps parallel turns per account (a second session would
// supersede the first).
type concurrencyLimiter interface{ MaxConcurrent() int }

// tokenSaverOptOut skips tool-result compression for hosts outside parity.
type tokenSaverOptOut interface{ SkipsTokenSaver() bool }

// AdapterFunc selects an adapter for one runner. No mutable process registry is
// shared across independent servers or tests.
type AdapterFunc func(provider config.Provider, clientKind ClientKind, plan WirePlan) (Adapter, bool)

// AdapterFor picks the built-in egress for a provider. It is the only place
// that maps provider identity to behavior.
func AdapterFor(provider config.Provider, clientKind ClientKind, plan WirePlan) (Adapter, error) {
	switch provider.Type {
	case config.ProviderTypeChatGPTWeb:
		return &chatGPTWebAdapter{rpcAdapter: rpcAdapter{chat: chatgptWebChat}}, nil
	case config.ProviderTypeDevin:
		return &rpcAdapter{chat: devinChat}, nil
	case config.ProviderTypeCursor:
		return &rpcAdapter{chat: cursorChat}, nil
	}
	if provider.Type == config.ProviderTypeGemini {
		return &geminiAdapter{}, nil
	}
	if provider.OAuthSource == config.OAuthFreebuff {
		return &freebuffAdapter{}, nil
	}
	if provider.OAuthSource == config.OAuthWorkbuddyAI {
		return &workbuddyAdapter{}, nil
	}
	switch plan.Wire {
	case KindAnthropic:
		return &anthropicAdapter{}, nil
	case KindResponses:
		return &responsesAdapter{}, nil
	default:
		return &openaiAdapter{}, nil
	}
}

// openaiAdapter is the plain Chat Completions egress.
type openaiAdapter struct{}

func (a *openaiAdapter) Wire() config.UpstreamWire { return KindOpenAI }
func (a *openaiAdapter) AlwaysStreams() bool       { return false }

func (a *openaiAdapter) Prepare(in PrepInput) (wire.Body, error) {
	body := in.ClientBody
	switch in.ClientKind {
	case KindAnthropic:
		body = anthropicwire.ToChatRequest(body, in.Model)
	case KindResponses:
		body = responseswire.ToChatRequest(in.ClientBody, in.Model)
	}
	body["model"] = in.Model
	if in.Stream {
		body["stream"] = true
	}
	if in.Effort != "" {
		body = withEffort(body, in.Effort)
	}
	body = fitThinkingBudget(body)
	// src/prepare.ts: ask streaming Chat Completions hosts to report usage.
	if in.ClientKind == KindOpenAI && (in.Provider.Type == config.ProviderTypeOpenAI || in.Provider.Type == config.ProviderTypeChatGPTWeb) &&
		in.ClientStream && in.Provider.InjectStreamUsage {
		if _, set := body["stream_options"]; !set {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	return wire.RewritePromptBodies(body, in.PromptPolicy), nil
}

func (a *openaiAdapter) UsageFrom(body []byte) wire.Usage {
	u := openaiwire.CompletionUsage(body)
	return wire.Usage{Input: u.PromptTokens, Output: u.CompletionTokens, CacheRead: u.CacheRead}
}
func (a *openaiAdapter) EndpointURL(p config.Provider) string { return "" }
func (a *openaiAdapter) Headers(p config.Provider, base http.Header) http.Header {
	return base
}

type chatGPTWebAdapter struct{ rpcAdapter }

func (*chatGPTWebAdapter) MaxConcurrent() int    { return 1 }
func (*chatGPTWebAdapter) SkipsTokenSaver() bool { return true }

// anthropicAdapter is the Anthropic Messages egress.
type anthropicAdapter struct{}

func (a *anthropicAdapter) Wire() config.UpstreamWire { return KindAnthropic }
func (a *anthropicAdapter) AlwaysStreams() bool       { return false }

func (a *anthropicAdapter) Prepare(in PrepInput) (wire.Body, error) {
	var body wire.Body
	clientEffort := anthropicwire.ClientEffortOf(in.ClientBody, anthropicwire.WireKind(in.ClientKind))
	if in.ClientKind == KindAnthropic && in.Bridge == "" {
		// Native Messages client on a Messages host: keep the client's own body
		// (metadata, top_k, ...) and only set the router's model and effort.
		native := make(wire.Body, len(in.ClientBody)+1)
		for k, v := range in.ClientBody {
			native[k] = v
		}
		native["model"] = in.Model
		if in.Stream {
			native["stream"] = true
		}
		withEffort := anthropicwire.WithEffort(native, in.Effort, anthropicwire.WireAnthropic, clientEffort)
		body = anthropicwire.FitThinkingMaxTokens(withEffort, anthropicwire.MaxTokensOptions{
			ClientSetMax: true,
			MaxOutput:    in.MaxOutput,
		})
	} else {
		var chat wire.Body
		switch in.ClientKind {
		case KindAnthropic:
			chat = anthropicwire.ToChatRequest(in.ClientBody, in.Model)
		case KindResponses:
			chat = responseswire.ToChatRequest(in.ClientBody, in.Model)
		default:
			chat = in.ClientBody
		}
		body = anthropicwire.BridgedAnthropicBody(chat, anthropicwire.BridgedBodyOptions{
			Model:        in.Model,
			Stream:       in.Stream,
			Effort:       in.Effort,
			ClientEffort: clientEffort,
			MaxOutput:    in.MaxOutput,
		})
	}
	// src/prepare.ts payloadFor: the Claude Code identity belongs to the OAuth
	// Messages wire only; Claude 4.6+ then rejects a trailing assistant turn.
	if in.Provider.Auth == config.AuthOAuth {
		body = applyClaudeCodeSystem(body)
	}
	return wire.RewritePromptBodies(anthropicwire.NormalizePrefill(body), in.PromptPolicy), nil
}

// applyClaudeCodeSystem mirrors applyClaudeCodeSystem in src/prepare.ts: put the
// Claude Code identity first in `system`, and drop adaptive-only fields a legacy
// model rejects.
func applyClaudeCodeSystem(in wire.Body) wire.Body {
	next := make(wire.Body, len(in)+1)
	for k, v := range in {
		next[k] = v
	}
	prompt := func(cache bool) wire.Body {
		b := wire.Body{"type": "text", "text": oauth.ClaudeCodeSystemPrompt}
		if cache {
			b["cache_control"] = wire.Body{"type": "ephemeral"}
		}
		return b
	}
	switch system := next["system"].(type) {
	case string:
		if system != "" {
			next["system"] = []any{prompt(false), wire.Body{"type": "text", "text": system, "cache_control": wire.Body{"type": "ephemeral"}}}
		} else {
			next["system"] = []any{prompt(true)}
		}
	case []any:
		next["system"] = append([]any{prompt(false)}, system...)
	default:
		next["system"] = []any{prompt(true)}
	}
	// Anthropic accepts context_management only together with its beta header. This
	// wire sends just oauth-2025-04-20, so a field a client set (Claude Code sends one
	// for Sonnet and Opus) fails with 400 "context_management: Extra inputs are not
	// permitted". Drop it for every model, not only the legacy ones below.
	delete(next, "context_management")
	if !anthropicwire.ThinkingSupportFor(next["model"]).Adaptive {
		delete(next, "output_config")
		if wire.AsRecord(next["thinking"])["type"] == "adaptive" {
			delete(next, "thinking")
		}
		if msgs, ok := next["messages"].([]any); ok {
			out := make([]any, len(msgs))
			for i, m := range msgs {
				if rec, ok := m.(map[string]any); ok && rec["role"] == "system" {
					c := make(wire.Body, len(rec))
					for k, v := range rec {
						c[k] = v
					}
					c["role"] = "user"
					out[i] = c
					continue
				}
				out[i] = m
			}
			next["messages"] = out
		}
	}
	return next
}

func (a *anthropicAdapter) UsageFrom(body []byte) wire.Usage {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	return anthropicwire.Usage(raw["usage"])
}
func (a *anthropicAdapter) EndpointURL(p config.Provider) string { return "" }
func (a *anthropicAdapter) Headers(p config.Provider, base http.Header) http.Header {
	base.Set("anthropic-version", "2023-06-01")
	return base
}

// responsesAdapter is the native Responses egress (always SSE-shaped upstream).
type responsesAdapter struct{}

func (a *responsesAdapter) Wire() config.UpstreamWire { return KindResponses }
func (a *responsesAdapter) AlwaysStreams() bool       { return true }

func (a *responsesAdapter) Prepare(in PrepInput) (wire.Body, error) {
	if in.ClientKind == KindResponses {
		// Clone and drop sampling controls. A Responses client (Codex) may send
		// temperature/top_p; reasoning models reject them with HTTP 400.
		body := make(wire.Body, len(in.ClientBody)+2)
		for k, v := range in.ClientBody {
			if k == "temperature" || k == "top_p" {
				continue
			}
			body[k] = v
		}
		body["model"] = in.Model
		body["stream"] = true
		if in.Provider.Auth == config.AuthOAuth {
			body["store"] = false
		}
		return wire.RewritePromptBodies(responseswire.EnsureCallIDs(body), in.PromptPolicy), nil
	}
	return wire.RewritePromptBodies(responseswire.EnsureCallIDs(responseswire.ChatToResponses(in.ClientBody, in.Model)), in.PromptPolicy), nil
}

func (a *responsesAdapter) UsageFrom(body []byte) wire.Usage {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	return responseswire.Usage(raw["usage"])
}
func (a *responsesAdapter) EndpointURL(p config.Provider) string { return "" }
func (a *responsesAdapter) Headers(p config.Provider, base http.Header) http.Header {
	return base
}

// withEffort writes the reasoning effort onto a chat-shaped body, honoring a
// client's explicit instruction.
func withEffort(body wire.Body, effort string) wire.Body {
	if effort == "" {
		return body
	}
	if _, ok := body["reasoning_effort"]; ok {
		return body
	}
	out := make(wire.Body, len(body)+1)
	for k, v := range body {
		out[k] = v
	}
	out["reasoning_effort"] = effort
	return out
}

// fitThinkingBudget ensures thinking_budget is strictly lower than max_completion_tokens
// or max_tokens. On DashScope/Qwen, reasoning models default thinking_budget to 32768,
// which errors with HTTP 400 "max_completion_tokens [X] must be greater than thinking_budget [32768]"
// whenever a client restricts max_completion_tokens <= 32768.
func fitThinkingBudget(body wire.Body) wire.Body {
	var maxTokens int
	if v, ok := body["max_completion_tokens"]; ok {
		maxTokens = bodyToInt(v)
	} else if v, ok := body["max_tokens"]; ok {
		maxTokens = bodyToInt(v)
	}
	if maxTokens <= 0 {
		return body
	}

	budget := 0
	if v, ok := body["thinking_budget"]; ok {
		budget = bodyToInt(v)
	}

	if (budget > 0 && budget >= maxTokens) || maxTokens <= 32768 {
		headroom := maxTokens / 5
		if headroom < 512 {
			headroom = 512
		}
		if headroom >= maxTokens {
			headroom = maxTokens / 2
		}
		newBudget := maxTokens - headroom
		if newBudget <= 0 {
			newBudget = maxTokens - 1
		}
		if budget > 0 && budget < newBudget {
			newBudget = budget
		}

		out := make(wire.Body, len(body)+1)
		for k, v := range body {
			out[k] = v
		}
		out["thinking_budget"] = newBudget
		if th, ok := out["thinking"].(map[string]any); ok {
			if b, ok := th["budget_tokens"]; ok {
				tb := bodyToInt(b)
				if tb >= maxTokens {
					thCopy := make(map[string]any, len(th))
					for k, v := range th {
						thCopy[k] = v
					}
					thCopy["budget_tokens"] = newBudget
					out["thinking"] = thCopy
				}
			}
		}
		return out
	}

	return body
}

func bodyToInt(v any) int {
	switch val := v.(type) {
	case int:
		return val
	case int64:
		return int(val)
	case float64:
		return int(val)
	case json.Number:
		if i, err := val.Int64(); err == nil {
			return int(i)
		}
	}
	return 0
}

// MarshalBody serializes a prepared body once per attempt.
func MarshalBody(b wire.Body) []byte {
	buf, err := json.Marshal(b)
	if err != nil {
		return nil
	}
	return buf
}
