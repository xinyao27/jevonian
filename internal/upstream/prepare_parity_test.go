package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/oauth"
	"github.com/xinyao27/jevonian/internal/provider/chatgptweb"
	"github.com/xinyao27/jevonian/internal/wire"
)

// capture runs one attempt against a fake upstream and returns what it saw.
func capture(t *testing.T, p config.Provider, req AttemptRequest, model string, reply string, ctype string) (body map[string]any, hdr http.Header, path string, at Attempt) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, hdr = r.URL.Path, r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", ctype)
		io.WriteString(w, reply)
	}))
	t.Cleanup(srv.Close)
	p.BaseURL = srv.URL + p.BaseURL
	r := NewRunner(ForwardDeps{HTTP: srv.Client(), Auth: &oauth.Resolver{HTTP: srv.Client()}, Sleep: func(time.Duration) {}})
	at = r.Try(context.Background(), req, PlanEntry{Provider: p, Model: model})
	if at.Response != nil {
		_, _ = io.Copy(io.Discard, at.Response.Body)
		at.Response.Body.Close()
	}
	return
}

func TestPreviewCacheBodyUsesPreparedBodyWithoutMutatingInput(t *testing.T) {
	provider := config.Provider{Name: "p", Type: config.ProviderTypeOpenAI, BaseURL: "https://example.test", Auth: config.AuthAPIKey}
	body := wire.Body{
		"model": "client-model",
		"messages": []any{
			wire.Body{"role": "system", "content": "You operate in Cursor."},
			wire.Body{"role": "user", "content": "hello"},
		},
	}
	before, _ := json.Marshal(body)
	prepared, wireKind, known := PreviewCacheBody(provider, "upstream-model", KindOpenAI, body, config.PromptPolicyConfig{Builtins: true}, config.TokenSaverConfig{}, true)
	if !known || wireKind != config.WireOpenAI {
		t.Fatalf("known=%v wire=%q", known, wireKind)
	}
	if prepared["model"] != "upstream-model" || prepared["stream"] != true {
		t.Fatalf("prepared body missed adapter mutations: %#v", prepared)
	}
	message := wire.AsRecord(wire.AsSlice(prepared["messages"])[0])
	if message["role"] != "system" || message["content"] != "You work inside the user's code editor." {
		t.Fatalf("prepared messages missed conversion or policy rewrite: %#v", prepared["messages"])
	}
	after, _ := json.Marshal(body)
	if string(before) != string(after) {
		t.Fatalf("preview mutated client body: before=%s after=%s", before, after)
	}
}

func TestPreviewCacheBodyRejectsOpaqueAndSaverCases(t *testing.T) {
	body := wire.Body{"messages": []any{wire.Body{"role": "user", "content": "hello"}}}
	for _, provider := range []config.Provider{
		{Name: "devin", Type: config.ProviderTypeDevin},
		{Name: "cursor", Type: config.ProviderTypeCursor},
		{Name: "gemini", Type: config.ProviderTypeGemini},
		{Name: "freebuff", Type: config.ProviderTypeOpenAI, OAuthSource: config.OAuthFreebuff},
		{Name: "workbuddy", Type: config.ProviderTypeOpenAI, OAuthSource: config.OAuthWorkbuddyAI},
	} {
		if _, _, known := PreviewCacheBody(provider, "m", KindOpenAI, body, config.PromptPolicyConfig{}, config.TokenSaverConfig{}, false); known {
			t.Errorf("opaque provider %q claimed known cache evidence", provider.Name)
		}
	}
	toolBody := wire.Body{"messages": []any{
		wire.Body{"role": "user", "content": "hello"},
		wire.Body{"role": "tool", "content": "tool output"},
	}}
	provider := config.Provider{Name: "p", Type: config.ProviderTypeOpenAI, BaseURL: "https://example.test"}
	if _, _, known := PreviewCacheBody(provider, "m", KindOpenAI, toolBody, config.PromptPolicyConfig{}, config.TokenSaverConfig{Enabled: true}, false); known {
		t.Fatal("enabled token saver with tool results claimed known evidence")
	}
	if _, _, known := PreviewCacheBody(provider, "m", KindOpenAI, body, config.PromptPolicyConfig{}, config.TokenSaverConfig{Enabled: true}, false); !known {
		t.Fatal("enabled token saver without tool results should retain evidence")
	}
	responseProvider := config.Provider{Name: "responses", Type: config.ProviderTypeResponses, BaseURL: "https://example.test"}
	responsesBody := wire.Body{"input": "hello"}
	if _, _, known := PreviewCacheBody(responseProvider, "m", KindResponses, responsesBody, config.PromptPolicyConfig{}, config.TokenSaverConfig{}, false); known {
		t.Fatal("native Responses input should remain unknown")
	}
}

func TestClaudeSubscriptionNativeBodyAndIdentity(t *testing.T) {
	dir := t.TempDir()
	cred := filepath.Join(dir, "c.json")
	exp := time.Now().Add(time.Hour).UnixMilli()
	if err := os.WriteFile(cred, []byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt","expiresAt":%d}}`, exp)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JEVONIAN_CLAUDE_CREDENTIALS", cred)
	p := config.Provider{Name: "claude-subscription", Type: "anthropic", BaseURL: "/v1", Auth: "oauth", OAuthSource: "claude-code", Billing: "subscription"}
	reply := `{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`

	t.Run("string system gets identity first, native fields preserved", func(t *testing.T) {
		body, hdr, path, at := capture(t, p, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"model": "x", "max_tokens": 100, "system": "be nice", "metadata": map[string]any{"user_id": "u"}, "top_k": 5,
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}}, "claude-sonnet-4-5", reply, "application/json")
		if at.Outcome.Kind != OutcomeSuccess {
			t.Fatalf("%+v %v", at.Outcome, at.Err)
		}
		if path != "/v1/messages" || hdr.Get("Authorization") != "Bearer at" ||
			hdr.Get("Anthropic-Beta") != "oauth-2025-04-20" || hdr.Get("Anthropic-Version") != "2023-06-01" ||
			hdr.Get("User-Agent") != "claude-cli/2.1.280 (external, cli)" {
			t.Fatalf("path=%s hdr=%v", path, hdr)
		}
		sys := body["system"].([]any)
		first, second := sys[0].(map[string]any), sys[1].(map[string]any)
		if first["text"] != oauth.ClaudeCodeSystemPrompt || first["cache_control"] != nil ||
			second["text"] != "be nice" || second["cache_control"] == nil {
			t.Fatalf("system %v", sys)
		}
		if body["model"] != "claude-sonnet-4-5" || body["top_k"] != float64(5) || body["metadata"] == nil {
			t.Fatalf("native fields dropped: %v", body)
		}
	})
	t.Run("array system is prefixed, empty string gets cached identity", func(t *testing.T) {
		body, _, _, _ := capture(t, p, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"max_tokens": 10, "system": []any{map[string]any{"type": "text", "text": "S"}},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}}, "claude-sonnet-4-5", reply, "application/json")
		sys := body["system"].([]any)
		if len(sys) != 2 || sys[0].(map[string]any)["text"] != oauth.ClaudeCodeSystemPrompt || sys[1].(map[string]any)["text"] != "S" {
			t.Fatalf("system %v", sys)
		}
		body, _, _, _ = capture(t, p, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"max_tokens": 10, "messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}}, "claude-sonnet-4-5", reply, "application/json")
		sys = body["system"].([]any)
		if len(sys) != 1 || sys[0].(map[string]any)["cache_control"] == nil {
			t.Fatalf("system %v", sys)
		}
	})
	t.Run("legacy model drops adaptive-only fields", func(t *testing.T) {
		body, _, _, _ := capture(t, p, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"max_tokens": 10, "output_config": map[string]any{"effort": "high"}, "context_management": map[string]any{"x": 1},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}}, "claude-sonnet-4-5", reply, "application/json")
		if body["output_config"] != nil || body["context_management"] != nil {
			t.Fatalf("legacy model kept adaptive fields: %v", body)
		}
	})
	t.Run("adaptive model also drops context_management but keeps output_config", func(t *testing.T) {
		// Claude Code sends context_management for Sonnet and Opus. The OAuth wire has no
		// beta header for it, so Anthropic answers 400 "Extra inputs are not permitted".
		body, hdr, _, at := capture(t, p, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"max_tokens": 10, "output_config": map[string]any{"effort": "high"},
			"context_management": map[string]any{"edits": []any{map[string]any{"type": "clear_thinking_20251015"}}},
			"messages":           []any{map[string]any{"role": "user", "content": "hi"}},
		}}, "claude-sonnet-5", reply, "application/json")
		if at.Outcome.Kind != OutcomeSuccess {
			t.Fatalf("%+v %v", at.Outcome, at.Err)
		}
		if body["context_management"] != nil {
			t.Fatalf("context_management reached Anthropic without its beta header: %v", body)
		}
		if body["output_config"] == nil {
			t.Fatalf("output_config is valid for adaptive models and must stay: %v", body)
		}
		if hdr.Get("Anthropic-Beta") != "oauth-2025-04-20" {
			t.Fatalf("beta header = %q", hdr.Get("Anthropic-Beta"))
		}
	})
	t.Run("API-key Anthropic provider gets no identity", func(t *testing.T) {
		k := p
		k.Auth, k.OAuthSource, k.APIKey = "api-key", "", "sk-ant"
		body, hdr, _, _ := capture(t, k, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"max_tokens": 10, "messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}}, "claude-sonnet-4-5", reply, "application/json")
		if body["system"] != nil || hdr.Get("X-Api-Key") != "sk-ant" {
			t.Fatalf("body=%v hdr=%v", body, hdr)
		}
	})
	t.Run("trailing assistant prefill dropped on 4.6+", func(t *testing.T) {
		body, _, _, _ := capture(t, p, AttemptRequest{ClientKind: KindAnthropic, ClientBody: wire.Body{
			"max_tokens": 10, "messages": []any{
				map[string]any{"role": "user", "content": "hi"},
				map[string]any{"role": "assistant", "content": "partial"},
			},
		}}, "claude-sonnet-4-6", reply, "application/json")
		if n := len(body["messages"].([]any)); n != 1 {
			t.Fatalf("messages %v", body["messages"])
		}
	})
}

func TestInjectStreamUsage(t *testing.T) {
	chatSSE := "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: [DONE]\n\n"
	p := config.Provider{Name: "p", Type: "openai", BaseURL: "/v1", Auth: "api-key", APIKey: "k", InjectStreamUsage: true}
	stream := AttemptRequest{ClientKind: KindOpenAI, Stream: true, ClientBody: wire.Body{"stream": true, "messages": []any{map[string]any{"role": "user", "content": "x"}}}}

	body, _, _, _ := capture(t, p, stream, "m", chatSSE, "text/event-stream")
	if so, _ := body["stream_options"].(map[string]any); so["include_usage"] != true {
		t.Fatalf("stream_options %v", body["stream_options"])
	}
	// client-set stream_options wins
	own := AttemptRequest{ClientKind: KindOpenAI, Stream: true, ClientBody: wire.Body{"stream": true, "stream_options": map[string]any{"include_usage": false}, "messages": []any{map[string]any{"role": "user", "content": "x"}}}}
	body, _, _, _ = capture(t, p, own, "m", chatSSE, "text/event-stream")
	if so, _ := body["stream_options"].(map[string]any); so["include_usage"] != false {
		t.Fatalf("client stream_options overwritten: %v", body["stream_options"])
	}
	// injectStreamUsage=false
	off := p
	off.InjectStreamUsage = false
	body, _, _, _ = capture(t, off, stream, "m", chatSSE, "text/event-stream")
	if body["stream_options"] != nil {
		t.Fatalf("injected despite injectStreamUsage=false: %v", body)
	}
	// non-stream client
	plain := AttemptRequest{ClientKind: KindOpenAI, ClientBody: wire.Body{"messages": []any{map[string]any{"role": "user", "content": "x"}}}}
	body, _, _, _ = capture(t, p, plain, "m", `{"choices":[{"message":{"content":"a"}}]}`, "application/json")
	if body["stream_options"] != nil {
		t.Fatalf("injected on non-stream: %v", body)
	}
	// type both is not injected (TS: provider.type === "openai" only)
	both := p
	both.Type = "both"
	body, _, _, _ = capture(t, both, stream, "m", chatSSE, "text/event-stream")
	if body["stream_options"] != nil {
		t.Fatalf("injected on type both: %v", body)
	}
}

func TestResponsesOAuthSetsStoreFalse(t *testing.T) {
	dir := t.TempDir()
	auth := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(auth, []byte(`{"tokens":{"access_token":"cx","refresh_token":"r","account_id":"acct-1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JEVONIAN_CODEX_AUTH", auth)
	p := config.Provider{Name: "chatgpt-subscription", Type: "responses", BaseURL: "/backend-api/codex", Auth: "oauth", OAuthSource: "codex", Billing: "subscription"}
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"
	body, hdr, path, at := capture(t, p, AttemptRequest{ClientKind: KindResponses, ClientBody: wire.Body{"input": "hi"}}, "gpt-5", sse, "text/event-stream")
	if at.Outcome.Kind != OutcomeSuccess {
		t.Fatalf("%+v %v", at.Outcome, at.Err)
	}
	if path != "/backend-api/codex/responses" || body["store"] != false || body["stream"] != true || body["model"] != "gpt-5" {
		t.Fatalf("path=%s body=%v", path, body)
	}
	if hdr.Get("Authorization") != "Bearer cx" || hdr.Get("Chatgpt-Account-Id") != "acct-1" ||
		hdr.Get("Originator") != "codex_cli_rs" || hdr.Get("Openai-Beta") != "responses=experimental" {
		t.Fatalf("hdr %v", hdr)
	}
}

func TestResponsesPassthroughOmitsSamplingControls(t *testing.T) {
	p := config.Provider{Name: "chatgpt", Type: "responses", BaseURL: "/v1", Auth: "api-key", APIKey: "k"}
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"
	client := wire.Body{
		"input":       "hi",
		"temperature": 0.7,
		"top_p":       0.9,
	}
	body, _, _, at := capture(t, p, AttemptRequest{ClientKind: KindResponses, ClientBody: client}, "gpt-5", sse, "text/event-stream")
	if at.Outcome.Kind != OutcomeSuccess {
		t.Fatalf("%+v %v", at.Outcome, at.Err)
	}
	if _, present := body["temperature"]; present {
		t.Fatalf("Responses passthrough must omit temperature: %v", body)
	}
	if _, present := body["top_p"]; present {
		t.Fatalf("Responses passthrough must omit top_p: %v", body)
	}
	if _, present := client["temperature"]; !present {
		t.Fatal("Prepare must not mutate the client body")
	}
}

func TestChatGPTWebStructuredErrorsPreserveFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind chatgptweb.Kind
		want OutcomeKind
	}{
		{"auth", chatgptweb.KindAuth, OutcomeProviderRefusal},
		{"model", chatgptweb.KindModel, OutcomeClientError},
		{"rate limit", chatgptweb.KindRateLimit, OutcomeRateLimit},
		{"browser", chatgptweb.KindBrowser, OutcomeHostFailure},
		{"timeout", chatgptweb.KindTimeout, OutcomeHostFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := config.Provider{Name: "chatgpt-web", Type: config.ProviderTypeChatGPTWeb, BaseURL: "http://127.0.0.1:9222", Auth: config.AuthAPIKey, Billing: config.BillingSubscription, NoKey: true}
			mock := &mockChatGPTWebDriver{result: chatgptweb.ChatResult{Status: 400, Error: &chatgptweb.Error{Status: 400, Kind: tc.kind, Message: "provider failure"}}}
			chatgptweb.SetDefaultDriverForTest(mock)
			t.Cleanup(func() { chatgptweb.SetDefaultDriverForTest(nil) })
			runner := NewRunner(ForwardDeps{HTTP: http.DefaultClient, Auth: &oauth.Resolver{HTTP: http.DefaultClient}})
			at := runner.Try(context.Background(), AttemptRequest{ClientKind: KindOpenAI, ClientBody: wire.Body{"messages": []any{map[string]any{"role": "user", "content": "hi"}}}}, PlanEntry{Provider: p, Model: "gpt-5"})
			if at.Outcome.Kind != tc.want {
				t.Fatalf("outcome=%v want=%v err=%v", at.Outcome.Kind, tc.want, at.Err)
			}
		})
	}
}

func TestChatGPTWebTranslatesAndRoutesCorrectly(t *testing.T) {
	p := config.Provider{Name: "chatgpt-web", Type: config.ProviderTypeChatGPTWeb, BaseURL: "http://127.0.0.1:9222", Auth: config.AuthAPIKey, Billing: config.BillingSubscription, NoKey: true}
	req := AttemptRequest{
		ClientKind: KindAnthropic,
		ClientBody: wire.Body{"messages": []any{map[string]any{"role": "user", "content": "hi"}}},
	}

	plan, err := PlanUpstreamWire(p, KindAnthropic, "auto")
	if err != nil || plan.Wire != KindOpenAI || plan.Bridge != "to-openai" {
		t.Fatalf("plan: %+v err: %v", plan, err)
	}
	planResp, err := PlanUpstreamWire(p, KindResponses, "auto")
	if err != nil || planResp.Wire != KindOpenAI || planResp.Bridge != "to-openai" {
		t.Fatalf("planResp: %+v err: %v", planResp, err)
	}

	adapter, err := AdapterFor(p, KindAnthropic, plan)
	if err != nil {
		t.Fatalf("AdapterFor err: %v", err)
	}
	prep, err := adapter.Prepare(PrepInput{
		PromptPolicy: config.PromptPolicyConfig{},
		Provider:     p,
		Model:        "auto",
		ClientKind:   KindAnthropic,
		ClientBody:   req.ClientBody,
		UpstreamWire: plan.Wire,
		Bridge:       plan.Bridge,
		Stream:       false,
	})
	if err != nil {
		t.Fatalf("Prepare err: %v", err)
	}
	if prep["model"] != "auto" {
		t.Fatalf("expected model=auto, got %v", prep["model"])
	}

	// Test chatgptWebChat with mock driver
	mockDriver := &mockChatGPTWebDriver{
		models: []chatgptweb.Model{{ID: "auto", Title: "ChatGPT Auto"}},
		result: chatgptweb.ChatResult{
			Status: http.StatusOK,
			Completion: wire.Body{
				"choices": []any{
					map[string]any{
						"message": map[string]any{"role": "assistant", "content": "mocked response"},
					},
				},
			},
		},
	}
	chatgptweb.SetDefaultDriverForTest(mockDriver)
	defer chatgptweb.SetDefaultDriverForTest(nil)

	runner := NewRunner(ForwardDeps{HTTP: http.DefaultClient, Auth: &oauth.Resolver{HTTP: http.DefaultClient}})
	at := runner.Try(context.Background(), req, PlanEntry{Provider: p, Model: "auto"})
	if at.Outcome.Kind != OutcomeSuccess {
		t.Fatalf("Try outcome: %+v err: %v text: %s", at.Outcome, at.Err, at.Text)
	}
	if at.Status != 200 {
		t.Fatalf("expected status 200, got %d", at.Status)
	}
	if !mockDriver.called || mockDriver.request.Model != "auto" || mockDriver.prompt == "" {
		t.Fatalf("browser driver not called with model and prompt: called=%v req=%+v prompt=%q", mockDriver.called, mockDriver.request, mockDriver.prompt)
	}
}

type mockChatGPTWebDriver struct {
	models  []chatgptweb.Model
	result  chatgptweb.ChatResult
	called  bool
	request chatgptweb.ChatRequest
	prompt  string
}

func (m *mockChatGPTWebDriver) Models(ctx context.Context, cdpEndpoint string) ([]chatgptweb.Model, error) {
	return m.models, nil
}

func (m *mockChatGPTWebDriver) Chat(ctx context.Context, cdpEndpoint string, req chatgptweb.ChatRequest, prompt string) (chatgptweb.ChatResult, error) {
	m.called, m.request, m.prompt = true, req, prompt
	return m.result, nil
}
