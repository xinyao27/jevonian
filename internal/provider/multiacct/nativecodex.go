package multiacct

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// isDesktopRoutedModel mirrors routing.IsDesktopRoutedModel. Duplicated (three
// lines) rather than imported: routing → upstream is expected to import the
// oauth seam, which imports this package, so importing routing here would cycle.
func isDesktopRoutedModel(model string) bool {
	id := strings.TrimSpace(model)
	if id == "" {
		return false
	}
	if id == "auto" || strings.HasPrefix(id, "jevonian/") {
		return true
	}
	switch id {
	case "plan", "execute", "agent", "subagent", "utility", "chat":
		return true
	}
	return false
}

// This file ports src/account.ts — the bits that decide whether a
// Codex/ChatGPT desktop client asked for a native model that must bypass
// Jevonian's router and reach the real OpenAI/ChatGPT backend with the
// client's own credentials (the Ollama Apps split). Account/session *probe*
// forwarding lives in internal/server (probes.go); this file owns the
// account-aware inference decision.

// NativeCodexRoute is which upstream a native Codex model should keep using.
type NativeCodexRoute string

const (
	RouteChatGPT NativeCodexRoute = "chatgpt"
	RouteOpenAI  NativeCodexRoute = "openai"
)

// localClientKeys mirrors server.LocalClientKeys without importing the server:
// the sentinel values are a shared contract between the sentinel writer
// (internal/oauth/sentinel) and this router.
var localClientKeys = map[string]bool{
	"jevonian-local":     true,
	"ollama-local-codex": true,
	"ollama":             true,
}

// IsLocalClientKey reports whether token is one of the desktop sentinel values.
func IsLocalClientKey(token string) bool { return localClientKeys[token] }

// ShouldProxyNativeCodex reports whether a Codex/ChatGPT Desktop inference call
// named a native model that should keep using OpenAI / the ChatGPT
// subscription — the Ollama Apps split.
//
//	jevonian/* models       → "" (stay on Jevonian)
//	chatgpt-account-id      → "chatgpt" (ChatGPT backend, account session)
//	any other bearer token  → "openai" (api.openai.com with the client's key)
//	the loopback sentinel   → "" (sentinel-only sessions cannot call OpenAI)
func ShouldProxyNativeCodex(model string, headers http.Header) (NativeCodexRoute, bool) {
	if isDesktopRoutedModel(model) {
		return "", false
	}
	if account := strings.TrimSpace(headers.Get("chatgpt-account-id")); account != "" {
		return RouteChatGPT, true
	}
	auth := headers.Get("Authorization")
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if auth == token {
		token = strings.TrimSpace(strings.TrimPrefix(token, "bearer "))
	}
	if token == "" {
		return "", false
	}
	if IsLocalClientKey(token) || strings.HasPrefix(token, "sk-jev-") {
		return "", false
	}
	return RouteOpenAI, true
}

// NativeCodexTarget builds the upstream URL for a native Codex model request.
// route "chatgpt" strips the leading /v1 (the ChatGPT backend re-adds its own),
// route "openai" keeps the path. Mirrors proxyNativeCodex in src/account.ts.
func NativeCodexTarget(route NativeCodexRoute, r *http.Request) (*url.URL, error) {
	chatgptBase := strings.TrimSpace(os.Getenv("JEVONIAN_CHATGPT_CODEX_UPSTREAM"))
	if chatgptBase == "" {
		chatgptBase = "https://chatgpt.com/backend-api/codex"
	}
	openaiBase := strings.TrimSpace(os.Getenv("JEVONIAN_OPENAI_UPSTREAM"))
	if openaiBase == "" {
		openaiBase = "https://api.openai.com/v1"
	}
	path := r.URL.Path
	if route == RouteChatGPT {
		path = strings.TrimPrefix(path, "/v1")
		if path == "" || !strings.HasPrefix(path, "/") {
			path = "/responses"
		}
	}
	base := chatgptBase
	if route == RouteOpenAI {
		base = openaiBase
	}
	// new URL(path + search, base + "/") — an absolute path replaces the
	// base's own path, matching the TS semantics exactly.
	parsed, err := url.Parse(strings.TrimRight(base, "/") + "/")
	if err != nil {
		return nil, fmt.Errorf("native codex upstream: %w", err)
	}
	return parsed.ResolveReference(&url.URL{Path: path, RawQuery: r.URL.RawQuery}), nil
}
