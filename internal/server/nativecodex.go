package server

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/xinyao27/jevonian/internal/provider/multiacct"
	"github.com/xinyao27/jevonian/internal/upstream"
)

// nativeCodexPassthrough forwards a Codex / ChatGPT Desktop call that named a
// native OpenAI model to the real backend with the client's own credential.
// src/upstream.ts proxyNativeCodex.
//
// The caller already decoded the request body (including zstd), so the decoded
// bytes are forwarded and the compression headers are dropped: the upstream is
// told the truth about the payload it receives.
//
// It returns true when the request was answered here, in which case the caller
// must stop.
func (s *Server) nativeCodexPassthrough(w http.ResponseWriter, r *http.Request, keyID, model string, body []byte) bool {
	// A caller holding a real Jevonian key is talking to Jevonian: a concrete
	// model it names is routed locally, never forwarded to OpenAI with that key.
	// src/server.ts c.set("jevoKey", true).
	if isJevoKey(keyID) || strings.Contains(r.Header.Get("Authorization"), "sk-jev-") {
		return false
	}
	route, ok := multiacct.ShouldProxyNativeCodex(model, r.Header)
	if !ok {
		// The Ollama Apps split: a native model with a desktop sentinel token
		// cannot reach OpenAI, so answer the authentication error directly.
		if model != "" && !isDesktopRoutedModel(model) {
			token := bearerToken(r.Header.Get("authorization"))
			if multiacct.IsLocalClientKey(token) {
				writeJSONError(w, http.StatusUnauthorized, "authentication_error",
					"OpenAI models require signing in to ChatGPT or adding an OpenAI API key")
				return true
			}
		}
		return false
	}

	target, err := multiacct.NativeCodexTarget(route, r)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "jevonian_error", err.Error())
		return true
	}

	client := s.deps.Client
	if client == nil {
		client = http.DefaultClient
	}
	// redirect: "manual" — a redirect must reach the client, not be followed
	// with the client's credential to a different host.
	noRedirect := *client
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}

	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), reader)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "jevonian_error",
			fmt.Sprintf("Native Codex upstream failed: %v", err))
		return true
	}
	copyNativeHeaders(req.Header, r.Header)

	resp, err := upstream.WithRetry(func() (*http.Response, error) {
		if body != nil {
			req.Body = io.NopCloser(strings.NewReader(string(body)))
			req.ContentLength = int64(len(body))
		}
		return noRedirect.Do(req)
	}, upstream.RetryOptions[*http.Response]{
		Attempts: upstream.ConfiguredRetries() + 1,
		RetryWhen: func(res *http.Response) *upstream.RetryFailure {
			if res != nil && upstream.IsRetryableStatus(res.StatusCode) {
				return &upstream.RetryFailure{Status: res.StatusCode}
			}
			return nil
		},
		Discard: func(res *http.Response) {
			if res != nil && res.Body != nil {
				_ = res.Body.Close()
			}
		},
	})
	if err != nil || resp == nil {
		msg := "unknown error"
		if err != nil {
			msg = err.Error()
		}
		writeJSONError(w, http.StatusBadGateway, "jevonian_error",
			"Native Codex upstream failed: "+msg)
		return true
	}
	defer resp.Body.Close()

	out := w.Header()
	for k, vals := range resp.Header {
		lk := strings.ToLower(k)
		if lk == "content-encoding" || lk == "content-length" || lk == "connection" ||
			lk == "transfer-encoding" || lk == "keep-alive" {
			continue
		}
		for _, v := range vals {
			out.Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
	return true
}

// isJevoKey reports whether the request authenticated with a real Jevonian key
// rather than a desktop sentinel or no key at all.
func isJevoKey(keyID string) bool {
	switch keyID {
	case "", "local", "unauthenticated":
		return false
	}
	return true
}

// copyNativeHeaders forwards the client's headers minus the hop-by-hop and
// framing ones, mirroring proxyNativeCodex in src/account.ts.
func copyNativeHeaders(dst, src http.Header) {
	for k, vals := range src {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "connection" || lk == "content-length" || lk == "content-encoding" {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

// bearerToken strips the scheme from an Authorization header.
func bearerToken(auth string) string {
	token := strings.TrimSpace(auth)
	if len(token) >= 7 && strings.EqualFold(token[:7], "bearer ") {
		token = token[7:]
	}
	return strings.TrimSpace(token)
}

// isDesktopRoutedModel mirrors routing.IsDesktopRoutedModel: `auto` and
// `jevonian/*` stay on Jevonian.
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
