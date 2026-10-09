package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xinyao27/jevonian/internal/brain"
	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/keys"
	"github.com/xinyao27/jevonian/internal/modelsync"
	"github.com/xinyao27/jevonian/internal/oauth"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/provider/freebuff"
	"github.com/xinyao27/jevonian/internal/provider/multiacct"
	"github.com/xinyao27/jevonian/internal/provider/workbuddy"
	"github.com/xinyao27/jevonian/internal/quota"
	"github.com/xinyao27/jevonian/internal/routing"
	"github.com/xinyao27/jevonian/internal/tunnel"
)

// LogRecord preserves all TS ledger fields, including tries and skipped.
type LogRecord map[string]any

// LogSource returns oldest-first append order (not timestamp order).
type LogSource interface{ Records() ([]LogRecord, error) }

// LogSubscriber is optional. Its callbacks must not block ledger producers.
type LogSubscriber interface{ Subscribe(func(LogRecord)) func() }

// LogFilter has the same semantics as the dashboard's request-only filters.
// Values inside one group are OR-ed; groups are AND-ed. Session is an exact,
// case-sensitive match on the record's session id.
type LogFilter struct {
	Phases    []string
	Models    []string
	Providers []string
	Status    []string
	Query     string
	Session   string
}
type LogQuery struct {
	Filter LogFilter
	Before *int64 // Exclusive zero-based append offset, never a SQLite rowid.
	Limit  int
}
type LogPage struct {
	Logs       []LogRecord
	Total      int64
	NextBefore *int64
}

// LogQuerier avoids materializing history for list and detail endpoints.
type LogQuerier interface {
	QueryLogs(context.Context, LogQuery) (LogPage, error)
	LogDetail(context.Context, string) (LogRecord, []LogRecord, error)
}
type LogRange struct {
	Start, End   time.Time
	RequestsOnly bool
}

// LogRanger streams a timestamp range in append order without materializing
// history. Callbacks only aggregate data; they must not write to the network.
type LogRanger interface {
	ScanLogRange(context.Context, LogRange, func(LogRecord) error) error
	FirstLog(context.Context) (LogRecord, error)
}
type LogBucket struct {
	Requests, Errors   int64
	CostUSD, LatencyMS float64
	// CacheReadTokens and PromptTokens sum the bucket's input accounting, so the
	// caller can report the window's cache coverage without a second query.
	CacheReadTokens, PromptTokens int64
	// UncachedInputTokens is the cache-miss half of the denominator. It applies
	// each row's usage convention: prompt_tokens alone for exclusive-input rows,
	// prompt_tokens minus cache_read_tokens for inclusive rows.
	UncachedInputTokens int64
}
type LogSeriesQuerier interface {
	QueryLogSeries(context.Context, LogFilter, time.Time, time.Time, int) ([]LogBucket, error)
}
type LogFacetValue struct {
	Value string `json:"value"`
	Count int64  `json:"count"`
}
type LogFacets struct {
	Total  int64                      `json:"total"`
	Groups map[string][]LogFacetValue `json:"groups"`
}
type LogFacetQuerier interface {
	QueryLogFacets(context.Context, LogFilter, *time.Time) (LogFacets, error)
}
type LogBatch struct {
	Logs   []LogRecord
	Cursor int64
	Reset  bool
}

// LogTail cursors are opaque storage positions, independent of public append
// offsets. ReadAfter returns at most limit rows, including nonmatching rows.
type LogTail interface {
	TailCursor(context.Context) (int64, error)
	ReadAfter(context.Context, int64, int) (LogBatch, error)
}

type KeyPatch struct {
	Name     *string
	LimitUSD *float64
	HasLimit bool
}
type KeyStore interface {
	ListWithUsage() ([]keys.Summary, error)
	Create(keys.CreateOptions) (keys.CreateResult, error)
	Update(string, KeyPatch) (keys.Summary, bool, error)
	Revoke(string) (bool, error)
	HasKeys() bool
}
type CredentialStore interface {
	Get(string) string
	Set(string, string) error
	Remove(string) error
}
type QuotaSource interface {
	ProviderHealth(config.Provider, quota.HealthOptions) quota.Health
	HeaderWindows(string) []quota.Window
	ModelHealth(config.Provider, string) quota.ModelHealth
}
type TunnelManager interface {
	Update(config.TunnelConfig, int)
	Status() tunnel.State
	Start(context.Context) tunnel.State
	Stop() tunnel.State
}
type BrainClient interface {
	Ask(context.Context, brain.Input) brain.Outcome
}

// Deps are the minimal runtime seams. Config returns immutable snapshots;
// Reload receives a fresh snapshot only after a successful disk write.
// Mount New with http.StripPrefix("/api", handler) on loopback only.
type Deps struct {
	Config      func() *config.Config
	Reload      func(*config.Config)
	ConfigPath  string
	Ledger      LogSource
	Keys        KeyStore
	Credentials CredentialStore
	Quota       QuotaSource
	// Quotas supplies vendor live probes; refresh=true must block until complete.
	Quotas      func(context.Context, *config.Config, bool) ([]map[string]any, error)
	ResetQuota  func(context.Context, *config.Config, string) error
	Tunnel      TunnelManager
	Brain       BrainClient
	OAuth       *oauth.Resolver
	Workbuddy   *workbuddy.Client
	Freebuff    *freebuff.Client
	HTTP        *http.Client
	Prices      routing.PriceSource
	PricingInfo func() map[string]any
	Presets     []map[string]any
	LoadBody    func(string) any
	Now         func() time.Time
	// Optional operational handlers, owned by their respective integration modules.
	Extensions map[string]http.Handler
}

type Handler struct {
	deps Deps
	mux  *http.ServeMux
	mu   sync.Mutex
}

func New(deps Deps) *Handler {
	if deps.ConfigPath == "" {
		deps.ConfigPath = paths.ConfigPath()
	}
	if deps.Credentials == nil {
		deps.Credentials = multiacct.DefaultStore()
	}
	if deps.HTTP == nil {
		deps.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if deps.OAuth == nil {
		deps.OAuth = &oauth.Resolver{HTTP: deps.HTTP, Credentials: deps.Credentials}
	}
	if deps.Freebuff == nil {
		deps.Freebuff = &freebuff.Client{HTTP: deps.HTTP}
	}
	if deps.Workbuddy == nil {
		deps.Workbuddy = &workbuddy.Client{HTTP: deps.HTTP}
	}
	if deps.Brain == nil {
		deps.Brain = &brain.Client{HTTP: deps.HTTP, Credentials: deps.Credentials.Get}
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Presets == nil {
		deps.Presets = DefaultPresets()
	}
	h := &Handler{deps: deps, mux: http.NewServeMux()}
	h.routes()
	return h
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		failure(w, 403, "Admin API is only available on loopback.")
		return
	}
	if h.deps.Config == nil || h.deps.Config() == nil {
		failure(w, 503, "Configuration is unavailable.")
		return
	}
	h.mux.ServeHTTP(w, r)
}
func send(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, status int, message string) {
	send(w, status, map[string]any{"error": message})
}
func body(r *http.Request) map[string]any {
	var v map[string]any
	// TS treats invalid JSON and non-object payloads as {}.
	if json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&v) != nil || v == nil {
		return map[string]any{}
	}
	return v
}
func object(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
func text(v any) string { s, _ := v.(string); return s }
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
func stringsOf(v any) []string {
	out := []string{}
	if s, ok := v.(string); ok {
		for _, s := range strings.Split(s, ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	for _, x := range slice(v) {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func slice(v any) []any { a, _ := v.([]any); return a }
func toMap(v any) map[string]any {
	data, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}
func (h *Handler) current() *config.Config { return h.deps.Config() }
func (h *Handler) readConfig() (map[string]any, error) {
	data, err := os.ReadFile(h.deps.ConfigPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		return config.JSONValue(h.current())
	}
	cfg, err := config.ParseBytes(data)
	if err != nil {
		return nil, err
	}
	return config.JSONValue(&cfg)
}
func (h *Handler) persist(value map[string]any) (*config.Config, error) {
	if h.deps.Reload == nil {
		return nil, errors.New("Config reload is unavailable.")
	}
	cfg, err := config.ParseConfig(value)
	if err != nil {
		return nil, err
	}
	if err := config.Save(h.deps.ConfigPath, &cfg); err != nil {
		return nil, err
	}
	h.deps.Reload(&cfg)
	return &cfg, nil
}
func (h *Handler) mutate(w http.ResponseWriter, r *http.Request, fn func(map[string]any, map[string]any) (any, int, error)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	value, err := h.readConfig()
	if err != nil {
		failure(w, 500, err.Error())
		return
	}
	payload, status, err := fn(value, body(r))
	if err != nil {
		failure(w, status, err.Error())
		return
	}
	send(w, status, payload)
}
func (h *Handler) routes() {
	h.mux.HandleFunc("GET /state", h.state)
	h.mux.HandleFunc("GET /tiers", func(w http.ResponseWriter, r *http.Request) { send(w, 200, h.routingPayload(h.current())) })
	h.mux.HandleFunc("PUT /routing", h.saveRouting)
	h.mux.HandleFunc("GET /brains", func(w http.ResponseWriter, r *http.Request) { send(w, 200, h.brainsPayload(h.current())) })
	h.mux.HandleFunc("POST /brains", h.brains)
	h.mux.HandleFunc("PUT /brains/{index}", h.brains)
	h.mux.HandleFunc("DELETE /brains/{index}", h.brains)
	h.mux.HandleFunc("POST /brains/{index}/move", h.brains)
	h.mux.HandleFunc("POST /brain/test", h.testBrain)
	h.mux.HandleFunc("PUT /token-saver", h.saveSection)
	h.mux.HandleFunc("GET /keys", h.keyAPI)
	h.mux.HandleFunc("POST /keys", h.keyAPI)
	h.mux.HandleFunc("PUT /keys/{id}", h.keyAPI)
	h.mux.HandleFunc("DELETE /keys/{id}", h.keyAPI)
	h.mux.HandleFunc("GET /logs", h.logs)
	h.mux.HandleFunc("GET /logs/series", h.logSeries)
	h.mux.HandleFunc("GET /logs/facets", h.logFacets)
	h.mux.HandleFunc("GET /logs/stream", h.logStream)
	h.mux.HandleFunc("GET /logs/{id}", h.logDetail)
	h.mux.HandleFunc("GET /stats", h.stats)
	h.mux.HandleFunc("GET /activity", h.activity)
	h.mux.HandleFunc("POST /providers", h.providers)
	h.mux.HandleFunc("DELETE /providers/{name}", h.providers)
	h.mux.HandleFunc("POST /providers/discover", h.discoverAPI)
	h.mux.HandleFunc("POST /oauth/workbuddy-ai/signin", h.signIn)
	h.mux.HandleFunc("GET /models", h.models)
	h.mux.HandleFunc("GET /quota", h.quotaAPI)
	h.mux.HandleFunc("POST /quota/reset", h.quotaResetAPI)
	h.mux.HandleFunc("GET /lan", h.lanAPI)
	h.mux.HandleFunc("PUT /lan", h.lanAPI)
	h.mux.HandleFunc("GET /tunnel", h.tunnelAPI)
	h.mux.HandleFunc("PUT /tunnel", h.tunnelAPI)
	h.mux.HandleFunc("PUT /model-sync", h.saveSection)
	// Never pretend operational dependencies exist. Integration may supply each route.
	for _, pattern := range []string{"GET /update", "GET /update/check", "POST /update/check", "POST /update/install", "GET /clients", "POST /clients/{id}", "DELETE /clients/{id}", "GET /pricing", "GET /catalog", "GET /catalog/refresh", "POST /catalog/refresh", "GET /model-sync", "POST /model-sync/run"} {
		if handler := h.deps.Extensions[pattern]; handler != nil {
			h.mux.Handle(pattern, handler)
		} else {
			p := pattern
			h.mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
				failure(w, 503, fmt.Sprintf("%s is unavailable: its runtime dependency has not been integrated.", p))
			})
		}
	}
	h.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { failure(w, 404, "Not found") })
}
func (h *Handler) routingPayload(c *config.Config) map[string]any {
	entries := deriveRoutings(c, h.deps.Prices)
	out := map[string]any{"tiers": tiers(entries), "routings": entries}
	// With a schedule, also say which window applies now and which models each
	// routing uses at this moment, so the dashboard can show both.
	// One timestamp for both, so a window change between the calls cannot name one
	// window and return another window's models.
	now := h.deps.Now()
	if status := routing.Status(c.Routing.Schedule, now); status != nil {
		out["schedule"] = status
		effective := map[string][]string{}
		for _, entry := range routing.EffectiveRoutings(c, routing.Deps{Prices: h.deps.Prices, Now: func() int64 { return now.UnixMilli() }}) {
			effective[entry.ID] = entry.Models
		}
		out["effective"] = effective
	}
	return out
}
func (h *Handler) brainSource(b config.BrainConfig) string {
	if h.deps.Credentials.Get(brain.CredentialName(b.Channel)) != "" {
		return "credentials"
	}
	env := b.APIKeyEnv
	channel := brain.FindChannel(b.Channel)
	if env == "" && channel != nil {
		env = channel.APIKeyEnv
	}
	if env != "" && os.Getenv(env) != "" {
		return "env:" + env
	}
	return "none"
}
func channels() []map[string]any {
	out := []map[string]any{}
	for _, c := range brain.Channels {
		if c.ID == "vercel" {
			continue
		}
		m := map[string]any{"id": c.ID, "label": c.Label, "baseUrl": c.BaseURL, "model": c.Model, "apiKeyEnv": c.APIKeyEnv, "hint": c.Hint}
		if c.KeysURL != "" {
			m["keysUrl"] = c.KeysURL
		}
		if c.RequiresBaseURL {
			m["requiresBaseUrl"] = true
		}
		if c.RequiresAccountID {
			m["requiresAccountId"] = true
		}
		if len(c.Models) > 0 {
			m["models"] = c.Models
		}
		out = append(out, m)
	}
	return out
}
func (h *Handler) brainsPayload(c *config.Config) map[string]any {
	out := []any{}
	for _, b := range c.Routing.Brains {
		m := toMap(b)
		m["keySource"] = h.brainSource(b)
		out = append(out, m)
	}
	return map[string]any{"brains": out, "brainChannels": channels()}
}
func (h *Handler) providerSource(p config.Provider) string {
	if p.Auth == config.AuthOAuth && p.OAuthSource != "" && p.OAuthSource != config.OAuthStatic {
		if h.deps.OAuth.HasCredential(string(p.OAuthSource), p.Login) {
			return "oauth:" + string(p.OAuthSource)
		}
		return "none"
	}
	if p.APIKey != "" {
		return "inline"
	}
	if h.deps.Credentials.Get(p.Name) != "" {
		if p.Auth == config.AuthOAuth {
			return "oauth:static"
		}
		return "credentials"
	}
	if p.APIKeyEnv != "" && os.Getenv(p.APIKeyEnv) != "" {
		return "env:" + p.APIKeyEnv
	}
	return "none"
}
func (h *Handler) state(w http.ResponseWriter, r *http.Request) {
	c := h.current()
	value, _ := config.JSONValue(c)
	providers := []any{}
	for _, p := range c.Providers {
		m := toMap(p)
		delete(m, "apiKey")
		delete(m, "headers")
		delete(m, "injectStreamUsage")
		ids := []string{}
		for _, e := range p.Models {
			ids = append(ids, e.ID)
		}
		m["models"] = ids
		m["keySource"] = h.providerSource(p)
		providers = append(providers, m)
	}
	value["providers"] = providers
	object(value["routing"])["brains"] = h.brainsPayload(c)["brains"]
	lan := object(value["lan"])
	lan["port"] = tunnel.LanPort(c)
	lan["bindHost"] = tunnel.LanBindHost(c.Lan)
	lan["urls"] = tunnel.LanBaseURLs(c, tunnel.LanIPv4Addresses(nil))
	delete(value, "modelAliases")
	delete(value, "promptPolicy")
	ks := []keys.Summary{}
	if h.deps.Keys != nil {
		var err error
		ks, err = h.deps.Keys.ListWithUsage()
		if err != nil {
			failure(w, 500, err.Error())
			return
		}
	}
	price := map[string]any{"source": "bundled-fallback", "models": 0}
	if h.deps.PricingInfo != nil {
		// TS labels any loaded models.dev snapshot "models.dev"; the Go status carries the
		// snapshot's source URL, so fold it to the same two labels the dashboard prints.
		info := h.deps.PricingInfo()
		source := "models.dev"
		if s, _ := info["source"].(string); s == "" || s == "bundled-fallback" {
			source = "bundled-fallback"
		}
		price = map[string]any{"source": source, "models": info["models"]}
		if price["models"] == nil {
			price["models"] = 0
		}
	}
	out := h.routingPayload(c)
	out["config"] = value
	out["pricing"] = price
	out["keys"] = ks
	out["brainChannels"] = channels()
	presets := h.deps.Presets
	if presets == nil {
		presets = []map[string]any{}
	}
	out["presets"] = presets
	out["modelSyncDefaultSources"] = []string{"codex", "claude-code", "antigravity", "devin", "cursor", "workbuddy-ai"}
	send(w, 200, out)
}
func tiers(entries []config.RoutingEntry) config.RoutingTiers {
	t := config.RoutingTiers{Plan: []string{}, Execute: []string{}, Utility: []string{}, Chat: []string{}}
	for _, e := range entries {
		switch e.ID {
		case "plan":
			t.Plan = e.Models
		case "execute":
			t.Execute = e.Models
		case "utility":
			t.Utility = e.Models
		case "chat":
			t.Chat = e.Models
		}
	}
	return t
}
func deriveRoutings(c *config.Config, prices routing.PriceSource) []config.RoutingEntry {
	value, _ := config.JSONValue(c)
	copy, _ := config.ParseConfig(value)
	entries := copy.Routing.Routings
	available := []string{}
	seen := map[string]bool{}
	for _, p := range c.Providers {
		for _, m := range p.Models {
			if !seen[m.ID] {
				seen[m.ID] = true
				available = append(available, m.ID)
			}
		}
	}
	used := map[string]bool{}
	for i := range entries {
		e := &entries[i]
		if len(e.Models) > 0 {
			for _, m := range e.Models {
				used[m] = true
			}
			continue
		}
		pick := ""
		best := 0.0
		bestSet := false
		stable := false
		for _, m := range available {
			if used[m] {
				continue
			}
			var price *routing.Price
			if prices != nil {
				price = prices(m, "")
			}
			if e.ID != "plan" && price == nil {
				continue
			}
			isStable := !experimental(m)
			score := 0.0
			if price != nil {
				score = price.Output
			}
			if pick == "" || isStable && !stable || isStable == stable && ((e.ID == "plan" && ((price != nil && !bestSet) || (price != nil && bestSet && score > best))) || (e.ID != "plan" && score < best)) {
				pick = m
				best = score
				bestSet = price != nil
				stable = isStable
			}
		}
		if pick != "" {
			e.Models = []string{pick}
			e.Providers = nil
			used[pick] = true
		}
	}
	for i := range entries {
		if len(entries[i].Models) > 0 {
			continue
		}
		fallback := ""
		for _, e := range entries {
			if len(e.Models) > 0 {
				fallback = e.Models[0]
				break
			}
		}
		if fallback == "" && len(available) > 0 {
			fallback = available[0]
		}
		if fallback != "" {
			entries[i].Models = []string{fallback}
			entries[i].Providers = nil
		}
	}
	return entries
}
func experimental(s string) bool {
	s = strings.ToLower(s)
	for _, v := range []string{"exp", "experimental", "preview", "beta"} {
		if strings.Contains(s, v) {
			return true
		}
	}
	return false
}
func (h *Handler) saveRouting(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, func(value, b map[string]any) (any, int, error) {
		rc := object(value["routing"])
		if entries, ok := b["routings"].([]any); ok {
			seen := map[string]bool{}
			for _, e := range entries {
				seen[text(object(e)["id"])] = true
			}
			for _, id := range config.BuiltinRoutingIDs {
				if !seen[id] {
					return nil, 400, fmt.Errorf("Cannot remove builtin routing %q", id)
				}
			}
			rc["routings"] = entries
		} else {
			ts := object(b["tiers"])
			for _, raw := range slice(rc["routings"]) {
				e := object(raw)
				if x, ok := ts[text(e["id"])]; ok {
					// config.ParseConfig only reads []any; a []string would parse as empty.
					models := []any{}
					for _, m := range stringsOf(x) {
						models = append(models, m)
					}
					e["models"] = models
				}
			}
		}
		if x, ok := b["mode"]; ok {
			if x == "off" {
				rc["mode"] = "off"
			} else {
				rc["mode"] = "auto"
			}
		}
		// null (or an empty object) removes the schedule; config.ParseConfig validates the rest.
		if x, ok := b["schedule"]; ok {
			rc["schedule"] = x
		}
		for _, k := range []string{"baselineModel", "defaultEffort"} {
			if s, ok := b[k].(string); ok {
				rc[k] = s
			}
		}
		for _, k := range []string{"brainPicksEffort"} {
			if x, ok := b[k].(bool); ok {
				rc[k] = x
			}
		}
		if n, ok := b["sessionTtlMinutes"].(float64); ok && n > 0 {
			rc["sessionTtlMinutes"] = n
		}
		q := object(rc["quotaGuard"])
		for k, v := range object(b["quotaGuard"]) {
			if k == "lowPercent" {
				if n, ok := v.(float64); ok && n >= 0 && n <= 100 {
					q[k] = n
				}
			} else if k == "enabled" || k == "resetAware" {
				if _, ok := v.(bool); ok {
					q[k] = v
				}
			}
		}
		if caps := object(b["capacities"]); len(caps) > 0 {
			rc["capacities"] = caps
		}
		if bb := object(b["brain"]); len(bb) > 0 {
			bs := slice(rc["brains"])
			current := toMap(config.DefaultBrain)
			if len(bs) > 0 {
				current = object(bs[0])
			}
			merged, err := h.mergeBrain(current, bb)
			if err != nil {
				return nil, 500, err
			}
			if len(bs) > 0 {
				bs[0] = merged
			} else {
				bs = append(bs, merged)
			}
			rc["brains"] = bs
		}
		cfg, err := h.persist(value)
		if err != nil {
			return nil, 400, err
		}
		out := h.routingPayload(cfg)
		out["routing"] = cfg.Routing
		return out, 200, nil
	})
}
func (h *Handler) mergeBrain(current, b map[string]any) (map[string]any, error) {
	next := map[string]any{}
	channel := text(current["channel"])
	if s := text(b["channel"]); s != "" {
		channel = s
	}
	next["channel"] = channel
	preset := brain.FindChannel(channel)
	for _, k := range []string{"baseUrl", "accountId", "apiKeyEnv", "model"} {
		s, ok := b[k].(string)
		if !ok {
			s = text(current[k])
			if s == "" && preset != nil {
				if k == "baseUrl" {
					s = preset.BaseURL
				}
				if k == "model" {
					s = preset.Model
				}
			}
		}
		if k == "accountId" {
			s = strings.TrimSpace(s)
		}
		if s != "" {
			next[k] = s
		}
	}
	next["timeoutMs"] = current["timeoutMs"]
	if n, ok := b["timeoutMs"].(float64); ok && n > 0 {
		next["timeoutMs"] = n
	}
	next["minConfidence"] = current["minConfidence"]
	if n, ok := b["minConfidence"].(float64); ok {
		next["minConfidence"] = n
	}
	if b["fullPrompt"] == true {
		next["fullPrompt"] = true
	}
	if key := strings.TrimSpace(text(b["apiKey"])); key != "" {
		if err := h.deps.Credentials.Set(brain.CredentialName(channel), key); err != nil {
			return nil, err
		}
	}
	return next, nil
}
func (h *Handler) brains(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, func(value, b map[string]any) (any, int, error) {
		rc := object(value["routing"])
		bs := slice(rc["brains"])
		status := 200
		if r.Method == "POST" && r.PathValue("index") == "" {
			merged, err := h.mergeBrain(toMap(config.DefaultBrain), b)
			if err != nil {
				return nil, 500, err
			}
			bs = append(bs, merged)
			status = 201
		} else {
			index, err := strconv.Atoi(r.PathValue("index"))
			if (err != nil || index < 0 || index >= len(bs)) && strings.HasSuffix(r.URL.Path, "/move") {
				// TS answers 400 "cannot move that brain" for an unknown index here.
				return nil, 400, errors.New("cannot move that brain")
			}
			if err != nil || index < 0 || index >= len(bs) {
				return nil, 404, fmt.Errorf("brain %s not found", r.PathValue("index"))
			}
			switch {
			case strings.HasSuffix(r.URL.Path, "/move"):
				target := index + 1
				if b["direction"] == "up" {
					target = index - 1
				}
				if target < 0 || target >= len(bs) {
					return nil, 400, errors.New("cannot move that brain")
				}
				bs[index], bs[target] = bs[target], bs[index]
			case r.Method == "DELETE":
				channel := text(object(bs[index])["channel"])
				bs = append(bs[:index], bs[index+1:]...)
				shared := false
				for _, x := range bs {
					shared = shared || text(object(x)["channel"]) == channel
				}
				if !shared {
					if err := h.deps.Credentials.Remove(brain.CredentialName(channel)); err != nil {
						return nil, 500, err
					}
				}
			default:
				merged, err := h.mergeBrain(object(bs[index]), b)
				if err != nil {
					return nil, 500, err
				}
				bs[index] = merged
			}
		}
		rc["brains"] = bs
		cfg, err := h.persist(value)
		if err != nil {
			return nil, 500, err
		}
		return h.brainsPayload(cfg), status, nil
	})
}
func (h *Handler) saveSection(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, func(value, b map[string]any) (any, int, error) {
		section := "tokenSaver"
		if r.URL.Path == "/model-sync" {
			section = "modelSync"
		}
		v := object(value[section])
		for k, x := range b {
			if k == "enabled" {
				if _, ok := x.(bool); ok {
					v[k] = x
				}
			}
			if section == "tokenSaver" && k == "command" {
				if _, ok := x.(string); ok {
					v[k] = x
				}
			}
			if (section == "tokenSaver" && k == "timeoutMs") || (section == "modelSync" && k == "intervalMinutes") {
				if _, ok := x.(float64); ok {
					v[k] = x
				}
			}
		}
		cfg, err := h.persist(value)
		if err != nil {
			return nil, 500, err
		}
		if section == "tokenSaver" {
			return map[string]any{section: cfg.TokenSaver}, 200, nil
		}
		return modelSyncPayload(cfg, (&modelsync.Deps{}).LoadState), 200, nil
	})
}
