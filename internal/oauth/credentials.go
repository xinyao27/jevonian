package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/xinyao27/jevonian/internal/oauth/httpx"
	"github.com/xinyao27/jevonian/internal/provider/freebuff"
	"github.com/xinyao27/jevonian/internal/provider/workbuddy"
)

// This file ports the stored-credential readers of src/oauth.ts: where each
// agent's sign-in lives, how a refreshed token is written back, and the env
// overrides that pin a second account's file.
//
// The persistent shape is shared across readers: Data is the credential file's
// JSON (or TOML → map) document and Save persists a rewrite after refresh.

const (
	claudeClientID          = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	codexClientID           = "app_EMoamEEZ73f0CkXaXp7hrann"
	antigravityClientID     = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
	antigravityClientSecret = "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"
	antigravityKeychain     = "gemini"
	antigravityKeychainUser = "antigravity"
	devinDefaultServerURL   = "https://server.codeium.com"

	claudeRefreshURL      = "https://console.anthropic.com/v1/oauth/token"
	codexRefreshURL       = "https://auth.openai.com/oauth/token"
	antigravityRefreshURL = "https://oauth2.googleapis.com/token"
)

// ClaudeCodeSystemPrompt is the identity Claude Code expects for OAuth chats.
const ClaudeCodeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."

// storedCredential is one read credential document and how to write it back.
type storedCredential struct {
	data map[string]any
	// save persists the post-refresh document; nil → not writable.
	save func(ctx context.Context, next map[string]any) error
	// label names where the credential came from, for logs.
	label string
}

func writeJSONFile(path string, next any, pretty bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var data []byte
	var err error
	if pretty {
		data, err = json.MarshalIndent(next, "", "  ")
	} else {
		data, err = json.Marshal(next)
	}
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func readJSONFile(path string) (map[string]any, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, false
	}
	return raw, true
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

// ClaudeCredentialsPath is where Claude Code keeps its sign-in:
// JEVONIAN_CLAUDE_CREDENTIALS wins, then login.credentialsPath, then
// $CLAUDE_CONFIG_DIR / login.home / ~/.claude → .credentials.json.
func ClaudeCredentialsPath(login *Login) string {
	if v := os.Getenv("JEVONIAN_CLAUDE_CREDENTIALS"); v != "" {
		return v
	}
	if login != nil && login.CredentialsPath != "" {
		return login.CredentialsPath
	}
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" && login != nil {
		base = login.Home
	}
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".claude")
	}
	return filepath.Join(base, ".credentials.json")
}

func (r *Resolver) readClaudeCredential(ctx context.Context, login *Login) *storedCredential {
	path := ClaudeCredentialsPath(login)
	explicit := os.Getenv("JEVONIAN_CLAUDE_CREDENTIALS") != "" ||
		(login != nil && login.CredentialsPath != "")
	if data, ok := readJSONFile(path); ok {
		return &storedCredential{
			data: data,
			save: func(_ context.Context, next map[string]any) error {
				return writeJSONFile(path, next, false)
			},
			label: path,
		}
	}
	// A login that names its own file or directory does not fall back to the
	// keychain: that would serve the wrong account's token under the right
	// account's name.
	if explicit || (login != nil && login.Home != "") {
		return nil
	}
	if !isDarwin() {
		return nil
	}
	service := "Claude Code-credentials"
	account := ""
	if login != nil {
		if login.KeychainService != "" {
			service = login.KeychainService
		}
		account = login.KeychainAccount
	}
	value, err := r.keychain().Find(ctx, service, account)
	if err != nil || value == "" {
		return nil
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(value), &data); err != nil {
		return nil
	}
	return &storedCredential{
		data: data,
		save: func(ctx context.Context, next map[string]any) error {
			encoded, err := json.Marshal(next)
			if err != nil {
				return err
			}
			return r.keychain().Add(ctx, service, account, string(encoded))
		},
		label: "keychain:" + service,
	}
}

// resolveClaude reads the Claude Code sign-in and refreshes it when near expiry.
func (r *Resolver) resolveClaude(ctx context.Context, login *Login) (Token, error) {
	credential := r.readClaudeCredential(ctx, login)
	if credential == nil {
		return Token{}, errors.New("Claude Code credentials not found. Sign in with `claude` first, or point JEVONIAN_CLAUDE_CREDENTIALS at a credentials file.")
	}
	oauth := asRecord(credential.data["claudeAiOauth"])
	accessToken := stringField(oauth["accessToken"])
	refreshToken := stringField(oauth["refreshToken"])
	expiresAt := numberField(oauth["expiresAt"])
	if expiresAt == 0 {
		expiresAt = jwtExpiryMS(accessToken)
	}
	now := r.now().UnixMilli()
	if accessToken != "" && (expiresAt == 0 || expiresAt-now > refreshSkewMS) {
		return Token{Token: accessToken, ExpiresAt: expiresAt}, nil
	}
	if refreshToken == "" {
		return Token{}, errors.New("Claude Code token is expired and has no refresh token. Run `claude` to sign in again.")
	}
	refreshed, err := r.refreshClaude(ctx, refreshToken)
	if err != nil {
		return Token{}, errors.New("Claude OAuth refresh failed. Run `claude` to sign in again.")
	}
	next := cloneRecord(credential.data)
	nextOAuth := cloneRecord(oauth)
	nextOAuth["accessToken"] = refreshed.accessToken
	nextOAuth["refreshToken"] = refreshed.refreshToken
	nextOAuth["expiresAt"] = refreshed.expiresAt
	next["claudeAiOauth"] = nextOAuth
	if credential.save != nil {
		// in-memory still carries the refreshed token when the write fails
		_ = credential.save(ctx, next)
	}
	return Token{Token: refreshed.accessToken, ExpiresAt: refreshed.expiresAt}, nil
}

type refreshedClaude struct {
	accessToken  string
	refreshToken string
	expiresAt    int64
}

func (r *Resolver) refreshClaude(ctx context.Context, refreshToken string) (*refreshedClaude, error) {
	body, _ := json.Marshal(map[string]any{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     claudeClientID,
	})
	status, data, err := r.postJSON(ctx, claudeRefreshURL, body)
	if err != nil || status < 200 || status >= 300 {
		return nil, errRefreshed
	}
	var j map[string]any
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, errRefreshed
	}
	access := stringField(j["access_token"])
	if access == "" {
		return nil, errRefreshed
	}
	expiresIn := numberField(j["expires_in"])
	if expiresIn == 0 {
		expiresIn = 3600
	}
	rt := stringField(j["refresh_token"])
	if rt == "" {
		rt = refreshToken
	}
	return &refreshedClaude{
		accessToken:  access,
		refreshToken: rt,
		expiresAt:    r.now().UnixMilli() + expiresIn*1000,
	}, nil
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

// CodexAuthPath is where Codex keeps auth.json: JEVONIAN_CODEX_AUTH wins, then
// login.credentialsPath, then $CODEX_HOME / login.home / ~/.codex.
func CodexAuthPath(login *Login) string { return codexAuthPath(login) }

func codexAuthPath(login *Login) string {
	if v := os.Getenv("JEVONIAN_CODEX_AUTH"); v != "" {
		return v
	}
	if login != nil && login.CredentialsPath != "" {
		return login.CredentialsPath
	}
	base := os.Getenv("CODEX_HOME")
	if base == "" && login != nil {
		base = login.Home
	}
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".codex")
	}
	return filepath.Join(base, "auth.json")
}

func readCodexFile(path string) *storedCredential {
	data, ok := readJSONFile(path)
	if !ok {
		return nil
	}
	return &storedCredential{
		data: data,
		save: func(_ context.Context, next map[string]any) error {
			return writeJSONFile(path, next, true)
		},
		label: path,
	}
}

// resolveCodex reads ~/.codex/auth.json (or the env/login override) and
// refreshes the ChatGPT session when its access token is near expiry.
func (r *Resolver) resolveCodex(ctx context.Context, login *Login) (Token, error) {
	credential := readCodexFile(codexAuthPath(login))
	if credential == nil {
		return Token{}, errors.New("Codex credentials not found. Sign in with `codex` first, or set JEVONIAN_CODEX_AUTH.")
	}
	tokens := asRecord(credential.data["tokens"])
	accessToken := stringField(tokens["access_token"])
	refreshToken := stringField(tokens["refresh_token"])
	accountID := stringField(tokens["account_id"])
	expiresAt := jwtExpiryMS(accessToken)
	now := r.now().UnixMilli()
	if accessToken != "" && (expiresAt == 0 || expiresAt-now > refreshSkewMS) {
		return Token{Token: accessToken, AccountID: accountID, ExpiresAt: expiresAt}, nil
	}
	if refreshToken == "" {
		return Token{}, errors.New("Codex token is expired and has no refresh token. Run `codex` to sign in again.")
	}
	refreshed, err := r.refreshCodex(ctx, refreshToken)
	if err != nil {
		return Token{}, errors.New("Codex OAuth refresh failed. Run `codex` to sign in again.")
	}
	next := cloneRecord(credential.data)
	nextTokens := cloneRecord(tokens)
	nextTokens["access_token"] = refreshed.accessToken
	nextTokens["refresh_token"] = refreshed.refreshToken
	if accountID != "" {
		nextTokens["account_id"] = accountID
	}
	if refreshed.idToken != "" {
		nextTokens["id_token"] = refreshed.idToken
	}
	next["tokens"] = nextTokens
	next["last_refresh"] = r.now().UTC().Format(time.RFC3339Nano)
	if credential.save != nil {
		_ = credential.save(ctx, next)
	}
	return Token{
		Token:     refreshed.accessToken,
		AccountID: accountID,
		ExpiresAt: refreshed.expiresAt,
	}, nil
}

type refreshedCodex struct {
	accessToken  string
	refreshToken string
	idToken      string
	expiresAt    int64
}

func (r *Resolver) refreshCodex(ctx context.Context, refreshToken string) (*refreshedCodex, error) {
	body, _ := json.Marshal(map[string]any{
		"client_id":     codexClientID,
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"scope":         "openid profile email",
	})
	status, data, err := r.postJSON(ctx, codexRefreshURL, body)
	if err != nil || status < 200 || status >= 300 {
		return nil, errRefreshed
	}
	var j map[string]any
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, errRefreshed
	}
	access := stringField(j["access_token"])
	if access == "" {
		return nil, errRefreshed
	}
	out := &refreshedCodex{accessToken: access}
	if rt := stringField(j["refresh_token"]); rt != "" {
		out.refreshToken = rt
	} else {
		out.refreshToken = refreshToken
	}
	out.idToken = stringField(j["id_token"])
	out.expiresAt = jwtExpiryMS(access)
	return out, nil
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

func (r *Resolver) readAntigravityCredential(ctx context.Context, login *Login) *storedCredential {
	override := loginCredentialsPath(login)
	if override == "" {
		override = os.Getenv("JEVONIAN_ANTIGRAVITY_TOKEN")
	}
	if strings.TrimSpace(override) != "" {
		path := strings.TrimSpace(override)
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		data := parseKeyringPayload(string(raw))
		if data == nil {
			return nil
		}
		return &storedCredential{
			data: data,
			save: func(_ context.Context, next map[string]any) error {
				return writeJSONFile(path, next, true)
			},
			label: path,
		}
	}
	if !isDarwin() {
		return nil
	}
	service := antigravityKeychain
	account := antigravityKeychainUser
	if login != nil {
		if login.KeychainService != "" {
			service = login.KeychainService
		}
		if login.KeychainAccount != "" {
			account = login.KeychainAccount
		}
	}
	value, err := r.keychain().Find(ctx, service, account)
	if err != nil || value == "" {
		return nil
	}
	data := parseKeyringPayload(value)
	if data == nil {
		return nil
	}
	return &storedCredential{
		data: data,
		save: func(ctx context.Context, next map[string]any) error {
			encoded, err := json.Marshal(next)
			if err != nil {
				return err
			}
			return r.keychain().Add(ctx, service, account,
				"go-keyring-base64:"+base64.StdEncoding.EncodeToString(encoded))
		},
		label: "keychain:" + service + "/" + account,
	}
}

// parseKeyringPayload unwraps a go-keyring base64 wrapper and parses the JSON.
func parseKeyringPayload(value string) map[string]any {
	trimmed := strings.TrimSpace(value)
	payload := trimmed
	if strings.HasPrefix(trimmed, "go-keyring-base64:") {
		decoded, err := base64.StdEncoding.DecodeString(trimmed[len("go-keyring-base64:"):])
		if err != nil {
			return nil
		}
		payload = string(decoded)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(payload), &data); err != nil {
		return nil
	}
	return data
}

type antigravityTokens struct {
	accessToken  string
	refreshToken string
	expiresAt    int64
}

func antigravityTokensFrom(data map[string]any) (antigravityTokens, bool) {
	token := asRecord(data["token"])
	access := stringField(token["access_token"])
	if access == "" {
		return antigravityTokens{}, false
	}
	out := antigravityTokens{
		accessToken:  access,
		refreshToken: stringField(token["refresh_token"]),
	}
	if expiry := stringField(token["expiry"]); expiry != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, expiry); err == nil {
			out.expiresAt = parsed.UnixMilli()
		}
	}
	return out, true
}

func (r *Resolver) resolveAntigravity(ctx context.Context, login *Login) (Token, error) {
	credential := r.readAntigravityCredential(ctx, login)
	if credential == nil {
		return Token{}, errors.New("Antigravity credentials not found. Sign in with the Antigravity IDE or `agy` CLI, or set JEVONIAN_ANTIGRAVITY_TOKEN.")
	}
	tokens, ok := antigravityTokensFrom(credential.data)
	if !ok {
		return Token{}, errors.New("Antigravity credential has an unexpected shape.")
	}
	now := r.now().UnixMilli()
	if tokens.expiresAt == 0 || tokens.expiresAt-now > refreshSkewMS {
		return Token{Token: tokens.accessToken, ExpiresAt: tokens.expiresAt}, nil
	}
	if tokens.refreshToken == "" {
		return Token{}, errors.New("Antigravity token is expired and has no refresh token. Run `agy` to sign in again.")
	}
	refreshed, err := r.refreshAntigravity(ctx, tokens.refreshToken)
	if err != nil {
		return Token{}, errors.New("Antigravity token refresh failed. Run `agy` to sign in again.")
	}
	token := asRecord(credential.data["token"])
	nextToken := cloneRecord(token)
	nextToken["access_token"] = refreshed.accessToken
	nextToken["expiry"] = time.UnixMilli(refreshed.expiresAt).UTC().Format(time.RFC3339Nano)
	next := cloneRecord(credential.data)
	next["token"] = nextToken
	if credential.save != nil {
		_ = credential.save(ctx, next)
	}
	return Token{Token: refreshed.accessToken, ExpiresAt: refreshed.expiresAt}, nil
}

func (r *Resolver) refreshAntigravity(ctx context.Context, refreshToken string) (*refreshedClaude, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {antigravityClientID},
		"client_secret": {antigravityClientSecret},
		"refresh_token": {refreshToken},
	}.Encode()
	status, data, err := r.postForm(ctx, antigravityRefreshURL, form)
	if err != nil || status < 200 || status >= 300 {
		return nil, errRefreshed
	}
	var j map[string]any
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, errRefreshed
	}
	access := stringField(j["access_token"])
	if access == "" {
		return nil, errRefreshed
	}
	expiresIn := numberField(j["expires_in"])
	if expiresIn == 0 {
		expiresIn = 3600
	}
	return &refreshedClaude{
		accessToken: access,
		expiresAt:   r.now().UnixMilli() + expiresIn*1000,
	}, nil
}

// ResolveAntigravityProject is the project id Antigravity calls run under:
// JEVONIAN_ANTIGRAVITY_PROJECT wins, then the CLI's own cache, then the shared
// default.
func ResolveAntigravityProject() string {
	if v := strings.TrimSpace(os.Getenv("JEVONIAN_ANTIGRAVITY_PROJECT")); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".gemini", "antigravity-cli", "cache", "default_project_id.txt")
	if data, err := os.ReadFile(path); err == nil {
		if v := strings.TrimSpace(string(data)); v != "" {
			return v
		}
	}
	return "default-cli-project"
}

// ---------------------------------------------------------------------------
// Devin
// ---------------------------------------------------------------------------

// DevinCredentialsPath is where `devin auth login` keeps its session token.
// JEVONIAN_DEVIN_CREDENTIALS wins; otherwise %APPDATA%\devin on Windows and
// $XDG_DATA_HOME/devin (default ~/.local/share/devin) elsewhere.
func DevinCredentialsPath(login *Login) string { return devinCredentialsPath(login) }

func devinCredentialsPath(login *Login) string {
	if v := strings.TrimSpace(os.Getenv("JEVONIAN_DEVIN_CREDENTIALS")); v != "" {
		return v
	}
	if login != nil && login.CredentialsPath != "" {
		return login.CredentialsPath
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		if login != nil && login.Home != "" {
			return filepath.Join(login.Home, "credentials.toml")
		}
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "devin", "credentials.toml")
	}
	if login != nil && login.Home != "" {
		return filepath.Join(login.Home, "credentials.toml")
	}
	base := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if base == "" {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "devin", "credentials.toml")
}

// unescapeTomlBasic resolves the escapes a TOML basic string can carry.
func unescapeTomlBasic(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+1 < len(value) {
			c := value[i+1]
			switch c {
			case 'n':
				out.WriteByte('\n')
			case 'r':
				out.WriteByte('\r')
			case 't':
				out.WriteByte('\t')
			case '"', '\\':
				out.WriteByte(c)
			default:
				out.WriteByte(c)
			}
			i++
			continue
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

// ParseFlatTOML parses the flat `key = "value"` lines of Devin's
// credentials.toml. Tables, arrays, and multi-line strings are not used by
// that file and are ignored.
func ParseFlatTOML(text string) map[string]string {
	result := map[string]string{}
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}
		// key = "basic"   |   key = 'literal'   (comment may follow)
		if key, val, ok := parseTomlLine(line, '"'); ok {
			result[key] = unescapeTomlBasic(val)
			continue
		}
		if key, val, ok := parseTomlLine(line, '\''); ok {
			result[key] = val
		}
	}
	return result
}

func parseTomlLine(line string, quote byte) (key, value string, ok bool) {
	eq := strings.Index(line, "=")
	if eq < 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:eq])
	if key == "" || !isTomlKey(key) {
		return "", "", false
	}
	rest := strings.TrimSpace(line[eq+1:])
	if rest == "" || rest[0] != quote {
		return "", "", false
	}
	var sb strings.Builder
	for i := 1; i < len(rest); i++ {
		c := rest[i]
		if c == quote {
			// Only a trailing comment or whitespace may follow the close quote.
			tail := strings.TrimSpace(rest[i+1:])
			if tail != "" && !strings.HasPrefix(tail, "#") {
				return "", "", false
			}
			return key, sb.String(), true
		}
		if quote == '"' && c == '\\' && i+1 < len(rest) {
			sb.WriteByte(c)
			sb.WriteByte(rest[i+1])
			i++
			continue
		}
		sb.WriteByte(c)
	}
	return "", "", false
}

func isTomlKey(key string) bool {
	for i := 0; i < len(key); i++ {
		c := key[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '_' || c == '.' || c == '-' {
			continue
		}
		return false
	}
	return true
}

func readDevinFile(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return ParseFlatTOML(string(data))
}

// Devin session tokens do not expire and there is no refresh flow: when the
// server rejects one, the user signs in again with `devin auth login` and the
// next resolve re-reads the file.
func (r *Resolver) resolveDevin(login *Login) (Token, error) {
	data := readDevinFile(devinCredentialsPath(login))
	if data == nil {
		return Token{}, errors.New("Devin credentials not found. Sign in with `devin auth login`, or set JEVONIAN_DEVIN_CREDENTIALS.")
	}
	token := strings.TrimSpace(data["windsurf_api_key"])
	if token == "" {
		return Token{}, errors.New("Devin credential has an unexpected shape (no windsurf_api_key). Run `devin auth login` again.")
	}
	return Token{Token: token}, nil
}

// DevinServerURL is the API server from credentials.toml (`api_server_url`),
// or the public default.
func DevinServerURL(login *Login) string {
	if v := strings.TrimSpace(readDevinFile(devinCredentialsPath(login))["api_server_url"]); v != "" {
		return strings.TrimRight(v, "/")
	}
	return devinDefaultServerURL
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

// CursorAuthPath is where cursor-agent keeps its sign-in away from the macOS
// keychain.
func CursorAuthPath(login *Login) string { return cursorAuthPath(login) }

func cursorAuthPath(login *Login) string {
	if v := strings.TrimSpace(os.Getenv("JEVONIAN_CURSOR_AUTH")); v != "" {
		return v
	}
	if login != nil && login.CredentialsPath != "" {
		return login.CredentialsPath
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		dir := ""
		if login != nil {
			dir = login.Home
		}
		if dir == "" {
			appData := os.Getenv("APPDATA")
			if appData == "" {
				appData = filepath.Join(home, "AppData", "Roaming")
			}
			dir = filepath.Join(appData, "Cursor")
		}
		return filepath.Join(dir, "auth.json")
	case "darwin":
		dir := ""
		if login != nil {
			dir = login.Home
		}
		if dir == "" {
			dir = filepath.Join(home, ".cursor")
		}
		return filepath.Join(dir, "auth.json")
	default:
		dir := ""
		if login != nil {
			dir = login.Home
		}
		if dir == "" {
			base := os.Getenv("XDG_CONFIG_HOME")
			if base == "" {
				base = filepath.Join(home, ".config")
			}
			dir = filepath.Join(base, "cursor")
		}
		return filepath.Join(dir, "auth.json")
	}
}

// Cursor keeps its sign-in in cursor-agent's own store: the macOS keychain when
// it is there, otherwise the CLI's auth.json. A status read is what renews a
// token about to run out, so the only thing to do here is report whether there
// is something to read at all.
func hasCursorCredential(login *Login) bool {
	if v := strings.TrimSpace(os.Getenv("JEVONIAN_CURSOR_AUTH")); v != "" && fileExists(v) {
		return true
	}
	if fileExists(cursorAuthPath(login)) {
		return true
	}
	return isDarwin()
}

func (r *Resolver) resolveCursor(ctx context.Context, login *Login) (Token, error) {
	if r.CursorToken == nil {
		return Token{}, errors.New("cursor sign-in reading is not wired in this build")
	}
	token, err := r.CursorToken(ctx, login)
	if err != nil {
		return Token{}, err
	}
	return Token{Token: token, ExpiresAt: jwtExpiryMS(token)}, nil
}

// ---------------------------------------------------------------------------
// WorkBuddy AI (delegated to internal/provider/workbuddy)
// ---------------------------------------------------------------------------

func (r *Resolver) workbuddy() *workbuddy.Client {
	if r != nil && r.Workbuddy != nil {
		return r.Workbuddy
	}
	return &workbuddy.Client{HTTP: r.http()}
}

func (r *Resolver) resolveWorkbuddy(ctx context.Context, login *Login, endpoint string) (Token, error) {
	creds, err := r.workbuddy().Resolve(ctx, login, endpoint)
	if err != nil {
		return Token{}, err
	}
	return Token{
		Token:     creds.AccessToken,
		AccountID: creds.UID,
		Domain:    creds.Domain,
		ExpiresAt: creds.ExpiresAt,
	}, nil
}

// resolveFreebuff reads the Freebuff sign-in. The token does not expire on a
// schedule Jevonian can see; a rejected one surfaces as a 401 and the user
// signs in again.
func (r *Resolver) resolveFreebuff(login *Login) (Token, error) {
	token, err := freebuff.ReadToken(login)
	if err != nil {
		return Token{}, err
	}
	return Token{Token: token}, nil
}

func (r *Resolver) workbuddyHasCredential(login *Login) bool {
	return workbuddy.HasCredential(login)
}

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------

var errRefreshed = errors.New("refresh rejected")

// postJSON posts a JSON body through the resolver's client (with the shared
// transient-retry policy).
func (r *Resolver) postJSON(ctx context.Context, target string, body []byte) (int, []byte, error) {
	return httpx.ReadAll(ctx, r.http(), httpx.Request{
		Method:  http.MethodPost,
		URL:     target,
		Headers: map[string]string{"content-type": "application/json"},
		Body:    body,
	})
}

// postForm posts an application/x-www-form-urlencoded body.
func (r *Resolver) postForm(ctx context.Context, target, form string) (int, []byte, error) {
	return httpx.ReadAll(ctx, r.http(), httpx.Request{
		Method:  http.MethodPost,
		URL:     target,
		Headers: map[string]string{"content-type": "application/x-www-form-urlencoded"},
		Body:    []byte(form),
	})
}

// jwtExpiryMS is the JWT's exp in Unix milliseconds, or 0 when it does not say.
func jwtExpiryMS(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) < 2 || parts[1] == "" {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var j struct {
		Exp *float64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &j); err != nil || j.Exp == nil {
		return 0
	}
	return int64(*j.Exp * 1000)
}

func asRecord(value any) map[string]any {
	if m, ok := value.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}

func cloneRecord(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func stringField(value any) string {
	s, _ := value.(string)
	return s
}

func numberField(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case json.Number:
		n, _ := v.Float64()
		return int64(n)
	case string:
		n, _ := strconv.ParseFloat(v, 64)
		return int64(n)
	}
	return 0
}

// ---------------------------------------------------------------------------
// Grok CLI
// ---------------------------------------------------------------------------

// GrokAuthPath is where Grok CLI keeps auth.json: JEVONIAN_GROK_AUTH wins, then
// login.credentialsPath, then $GROK_HOME / login.home / ~/.grok -> auth.json.
func GrokAuthPath(login *Login) string { return grokAuthPath(login) }

func grokAuthPath(login *Login) string {
	if v := os.Getenv("JEVONIAN_GROK_AUTH"); v != "" {
		return v
	}
	if login != nil && login.CredentialsPath != "" {
		return login.CredentialsPath
	}
	base := os.Getenv("GROK_HOME")
	if base == "" && login != nil {
		base = login.Home
	}
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".grok")
	}
	return filepath.Join(base, "auth.json")
}

func (r *Resolver) resolveGrok(_ context.Context, login *Login) (Token, error) {
	path := grokAuthPath(login)
	data, ok := readJSONFile(path)
	if !ok {
		return Token{}, errors.New("Grok CLI credentials not found. Run `grok` to sign in first, or set JEVONIAN_GROK_AUTH.")
	}
	// ~/.grok/auth.json contains entries keyed by issuer/client URI or flat keys.
	for _, val := range data {
		rec := asRecord(val)
		if rec == nil {
			continue
		}
		tok := stringField(rec["key"])
		if tok == "" {
			tok = stringField(rec["access_token"])
		}
		if tok != "" {
			teamID := stringField(rec["team_id"])
			expiresAt := jwtExpiryMS(tok)
			if expStr := stringField(rec["expires_at"]); expStr != "" && expiresAt == 0 {
				if t, err := time.Parse(time.RFC3339Nano, expStr); err == nil {
					expiresAt = t.UnixMilli()
				}
			}
			return Token{Token: tok, AccountID: teamID, ExpiresAt: expiresAt}, nil
		}
	}
	if tok := stringField(data["key"]); tok != "" {
		return Token{Token: tok, ExpiresAt: jwtExpiryMS(tok)}, nil
	}
	return Token{}, errors.New("Grok credentials file had no usable token. Run `grok` to sign in again.")
}

