// Package oauth resolves local sign-ins (Claude Code, Codex, Antigravity,
// Devin, Cursor, WorkBuddy AI) into usable tokens, with refresh and write-back.
//
// Port of src/oauth.ts. The source registry and wire pairing rules are shared
// by config validation, the CLI `add` command, the admin API, and the resolver
// itself.
package oauth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/xinyao27/jevonian/internal/provider/freebuff"
	"github.com/xinyao27/jevonian/internal/provider/multiacct"
	"github.com/xinyao27/jevonian/internal/provider/workbuddy"
)

// Source names a local sign-in the router can read.
type Source = string

// Sources is every local sign-in the router can read; the one list every
// parser shares. Mirrors OAUTH_SOURCES in src/oauth.ts.
var Sources = []Source{
	"claude-code",
	"codex",
	"antigravity",
	"devin",
	"cursor",
	"workbuddy-ai",
	"freebuff",
	"static",
	"grok",
}

// IsSource reports whether value names a known source.
func IsSource(value string) bool {
	for _, s := range Sources {
		if value == s {
			return true
		}
	}
	return false
}

// ParseSource parses an oauthSource field, or "" when the value is not a
// source we know.
func ParseSource(value any) Source {
	if s, ok := value.(string); ok && IsSource(s) {
		return s
	}
	return ""
}

// RequiredType is which wire a credential only speaks on. A Devin or Cursor
// sign-in yields a token for its own Connect-RPC wire; carried to any other
// wire it just 401s, so the pairing is enforced where a provider is added.
var RequiredType = map[Source]string{
	"devin":  "devin",
	"cursor": "cursor",
}

func capitalize(value string) string {
	if value == "" {
		return value
	}
	return strings.ToUpper(value[:1]) + value[1:]
}

// WireType returns the resolved wire type, or an error when
// type/oauthSource disagree. Returns the resolved type on success so a caller
// can adopt the forced wire when it was not asked for explicitly.
func WireType(source Source, typ string, explicitType bool) (string, error) {
	required, ok := RequiredType[source]
	if !ok || required == "" {
		return typ, nil
	}
	if explicitType && typ != required {
		return "", fmt.Errorf("%s credentials require --type %s.", capitalize(required), required)
	}
	return required, nil
}

// WireMismatch is the inverse check: a wire that only a specific credential can
// drive must be configured with that credential (or a static token for it).
// Returns the message to show, or "".
func WireMismatch(typ, auth string, source Source) string {
	for s, wire := range RequiredType {
		if typ != wire {
			continue
		}
		if auth != "oauth" {
			return fmt.Sprintf("%s wire requires --auth oauth --oauth-source %s (or static).",
				capitalize(wire), s)
		}
		if source != s && source != "static" {
			return fmt.Sprintf("%s wire requires --oauth-source %s (or static).",
				capitalize(wire), s)
		}
	}
	return ""
}

// Token is a resolved credential.
type Token struct {
	Token string
	// AccountID is the provider account id (Codex `account_id`, WorkBuddy uid).
	AccountID string
	// Domain is WorkBuddy AI's X-Domain (and similar vendor account hosts).
	Domain string
	// ExpiresAt is Unix milliseconds; zero when the credential does not expire.
	ExpiresAt int64
}

func (t Token) fresh(now time.Time) bool {
	return t.ExpiresAt == 0 || t.ExpiresAt-now.UnixMilli() > refreshSkewMS
}

// ErrNoStaticToken is returned when a static-auth provider has no stored key.
var ErrNoStaticToken = errors.New("no OAuth token stored for this provider")

// Resolver resolves tokens; every collaborator that can touch the network or
// the OS is injectable for tests.
type Resolver struct {
	// HTTP drives token refreshes and remote credential reads.
	HTTP *http.Client
	// Credentials is the per-provider API-key store read by ResolveProviderAuth
	// (api-key and static auth). nil → the default credentials.json.
	Credentials KeyReader
	// Keychain reads a macOS keychain generic-password item.
	// nil → the built-in `security` CLI on darwin, unsupported elsewhere.
	Keychain Keychain
	// CursorToken reads the cursor-agent sign-in (keychain/auth.json + renew).
	// nil → ErrUnsupported.
	CursorToken func(ctx context.Context, login *Login) (string, error)
	// Workbuddy reads the WorkBuddy AI session (sign-in file + refresh).
	// nil → a workbuddy.Client sharing HTTP.
	Workbuddy *workbuddy.Client
	// Now is the clock.
	Now func() time.Time
	// Logger receives one line per resolve/refresh failure path worth noting.
	Logger func(string)

	mu      sync.Mutex
	cache   map[string]Token
	pending map[string]*pendingCall
}

type pendingCall struct {
	done chan struct{}
	tok  Token
	err  error
}

// KeyReader is the per-provider stored key (credentials.json). Satisfied by
// *multiacct.Store.
type KeyReader interface {
	Get(provider string) string
}

// Keychain is the macOS keychain surface.
type Keychain interface {
	// Find returns the password for service (and account when non-empty), or ""
	// when absent.
	Find(ctx context.Context, service, account string) (string, error)
	// Add upserts a generic password.
	Add(ctx context.Context, service, account, value string) error
}

// Login names an alternate local sign-in (config.ProviderLogin).
type Login = multiacct.Login

func loginKey(source Source, login *Login) string { return multiacct.Key(source, login) }

const refreshSkewMS int64 = 120_000

func (r *Resolver) now() time.Time {
	if r != nil && r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Resolver) http() *http.Client {
	if r != nil && r.HTTP != nil {
		return r.HTTP
	}
	return http.DefaultClient
}

var getenv = os.Getenv

func (r *Resolver) keychain() Keychain {
	if r != nil && r.Keychain != nil {
		return r.Keychain
	}
	return SecurityKeychain{}
}

// Resolve returns a token for source, refreshing and writing back when the
// stored credential is near expiry. Concurrent callers for the same login share
// one resolve.
// The "static" source returns StaticToken (the provider's stored key) as-is.
func (r *Resolver) Resolve(ctx context.Context, opts ResolveOptions) (Token, error) {
	if opts.Source == "static" {
		if opts.StaticToken != "" {
			return Token{Token: opts.StaticToken}, nil
		}
		return Token{}, ErrNoStaticToken
	}

	key := loginKey(opts.Source, opts.Login)
	r.mu.Lock()
	r.initLocked()
	if cached, ok := r.cache[key]; ok && cached.fresh(r.now()) {
		r.mu.Unlock()
		return cached, nil
	}
	if call, ok := r.pending[key]; ok {
		r.mu.Unlock()
		select {
		case <-call.done:
			return call.tok, call.err
		case <-ctx.Done():
			return Token{}, ctx.Err()
		}
	}
	call := &pendingCall{done: make(chan struct{})}
	r.pending[key] = call
	r.mu.Unlock()

	tok, err := r.resolveSource(ctx, opts)

	r.mu.Lock()
	delete(r.pending, key)
	if err == nil {
		if r.cache == nil {
			r.cache = map[string]Token{}
		}
		r.cache[key] = tok
	}
	r.mu.Unlock()
	call.tok, call.err = tok, err
	close(call.done)
	return tok, err
}

func (r *Resolver) initLocked() {
	if r.cache == nil {
		r.cache = map[string]Token{}
	}
	if r.pending == nil {
		r.pending = map[string]*pendingCall{}
	}
}

func (r *Resolver) resolveSource(ctx context.Context, opts ResolveOptions) (Token, error) {
	login := opts.Login
	switch opts.Source {
	case "claude-code":
		return r.resolveClaude(ctx, login)
	case "codex":
		return r.resolveCodex(ctx, login)
	case "antigravity":
		return r.resolveAntigravity(ctx, login)
	case "devin":
		return r.resolveDevin(login)
	case "cursor":
		return r.resolveCursor(ctx, login)
	case "workbuddy-ai":
		return r.resolveWorkbuddy(ctx, login, opts.Endpoint)
	case "freebuff":
		return r.resolveFreebuff(login)
	case "grok":
		return r.resolveGrok(ctx, login)
	default:
		return Token{}, fmt.Errorf("unknown OAuth source %q", opts.Source)
	}
}

// ResolveOptions are one resolve call's inputs.
type ResolveOptions struct {
	Source      Source
	StaticToken string
	Login       *Login
	// Endpoint overrides a source's service base (WorkBuddy AI; tests).
	Endpoint string
}

// Invalidate drops a cached token so the next resolve re-reads the sign-in.
// Passing a login limits it to that account; omitting it clears every login of
// the source, which is what a caller who does not know which one failed wants.
func (r *Resolver) Invalidate(source Source, login *Login) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cache == nil {
		return
	}
	if login != nil {
		delete(r.cache, loginKey(source, login))
		return
	}
	delete(r.cache, source)
	prefix := source + "\x00"
	for key := range r.cache {
		if strings.HasPrefix(key, prefix) {
			delete(r.cache, key)
		}
	}
}

// HasCredential reports whether the local credential for a source exists and
// holds a token. Used for status display only; it never hits the network.
func (r *Resolver) HasCredential(source Source, login *Login) bool {
	switch source {
	case "static":
		return false
	case "codex":
		return readCodexFile(codexAuthPath(login)) != nil
	case "devin":
		return readDevinFile(devinCredentialsPath(login))["windsurf_api_key"] != ""
	case "cursor":
		return hasCursorCredential(login)
	case "workbuddy-ai":
		return r.workbuddyHasCredential(login)
	case "freebuff":
		return freebuff.HasCredential(login)
	case "antigravity":
		override := loginCredentialsPath(login)
		if override == "" {
			override = os.Getenv("JEVONIAN_ANTIGRAVITY_TOKEN")
		}
		if strings.TrimSpace(override) != "" && fileExists(strings.TrimSpace(override)) {
			return true
		}
		// Keychain-backed, and a named service cannot be checked without reading
		// it; the best an existence check can say on macOS is "maybe".
		return isDarwin()
	case "claude-code":
		if env := os.Getenv("JEVONIAN_CLAUDE_CREDENTIALS"); env != "" {
			return fileExists(env)
		}
		if fileExists(ClaudeCredentialsPath(login)) {
			return true
		}
		// Otherwise the sign-in may be in the keychain, where an existence check
		// cannot reach it.
		return isDarwin()
	}
	return false
}

func loginCredentialsPath(login *Login) string {
	if login == nil {
		return ""
	}
	return login.CredentialsPath
}

// CredentialLabel names a source for status display.
func CredentialLabel(source Source) string {
	switch source {
	case "claude-code":
		return "Claude Code credentials"
	case "codex":
		return "Codex credentials"
	case "antigravity":
		return "Antigravity credentials"
	case "devin":
		return "Devin credentials"
	case "cursor":
		return "Cursor credentials"
	case "workbuddy-ai":
		return "WorkBuddy AI credentials"
	case "freebuff":
		return "Freebuff credentials"
	default:
		return "stored token"
	}
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

// isDarwin reports the host platform. Not injectable: GOOS is fixed at build
// time, and tests exercise non-darwin paths by asserting the env/file branches.
func isDarwin() bool { return runtime.GOOS == "darwin" }
