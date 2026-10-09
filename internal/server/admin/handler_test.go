package admin_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xinyao27/jevonian/internal/clients"
	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/keys"
	"github.com/xinyao27/jevonian/internal/ledger"
	"github.com/xinyao27/jevonian/internal/provider/chatgptweb"
	"github.com/xinyao27/jevonian/internal/provider/multiacct"
	"github.com/xinyao27/jevonian/internal/quota"
	"github.com/xinyao27/jevonian/internal/routing"
	"github.com/xinyao27/jevonian/internal/server/admin"
)

type logs struct {
	mu       sync.Mutex
	rows     []admin.LogRecord
	listener func(admin.LogRecord)
}

func (s *logs) Records() ([]admin.LogRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]admin.LogRecord{}, s.rows...), nil
}
func (s *logs) Subscribe(fn func(admin.LogRecord)) func() {
	s.mu.Lock()
	s.listener = fn
	s.mu.Unlock()
	return func() { s.mu.Lock(); s.listener = nil; s.mu.Unlock() }
}
func (s *logs) append(r admin.LogRecord) {
	s.mu.Lock()
	s.rows = append(s.rows, r)
	fn := s.listener
	s.mu.Unlock()
	if fn != nil {
		fn(r)
	}
}

type harness struct {
	h      *admin.Handler
	path   string
	config *config.Config
	creds  *multiacct.Store
}

func setup(t *testing.T, source admin.LogSource) *harness {
	t.Helper()
	return setupAt(t, source, time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC))
}

// setupAt is setup with a fixed clock, for tests that depend on the time of day.
func setupAt(t *testing.T, source admin.LogSource, now time.Time) *harness {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", filepath.Join(dir, ".codex"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(dir, ".claude"))
	t.Setenv("JEVONIAN_DATA_DIR", dir)
	cfg := config.DefaultConfig()
	x := &harness{path: filepath.Join(dir, "config.json"), config: &cfg, creds: &multiacct.Store{Path: filepath.Join(dir, "credentials.json")}}
	x.h = admin.New(admin.Deps{Config: func() *config.Config { return x.config }, Reload: func(c *config.Config) { x.config = c }, ConfigPath: x.path, Credentials: x.creds, Keys: admin.OpenKeys(dir, keys.Open(dir, nil)), Ledger: source, Prices: func(model, provider string) *routing.Price {
		if model == "baseline" {
			return &routing.Price{Input: 2, Output: 4}
		}
		return nil
	}, Now: func() time.Time { return now }})
	return x
}
func request(t *testing.T, h http.Handler, method, path string, payload any) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(payload)
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	req.RemoteAddr = "127.0.0.1:1234"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s: %s: %v", method, path, rr.Body.String(), err)
	}
	return rr.Code, out
}
func checkStatus(t *testing.T, got, want int, body any) {
	t.Helper()
	if got != want {
		t.Fatalf("status %d want %d: %#v", got, want, body)
	}
}
func TestBrainsCRUDPersistsWithoutMutatingSnapshot(t *testing.T) {
	x := setup(t, nil)
	snapshot := x.config
	code, out := request(t, x.h, "POST", "/brains", map[string]any{"channel": "typesafe", "apiKey": "secret"})
	checkStatus(t, code, 201, out)
	if len(snapshot.Routing.Brains) != 0 {
		t.Fatal("mutated live snapshot")
	}
	if x.config.Routing.Brains[0].MinConfidence != config.DefaultBrain.MinConfidence {
		t.Fatalf("default confidence %#v", x.config.Routing.Brains)
	}
	if strings.Contains(string(mustJSON(out)), "secret") {
		t.Fatal("secret leaked")
	}
	if x.creds.Get("brain:typesafe") != "secret" {
		t.Fatal("credential not stored")
	}
	code, out = request(t, x.h, "POST", "/brains", map[string]any{"channel": "typesafe"})
	checkStatus(t, code, 201, out)
	code, out = request(t, x.h, "POST", "/brains/1/move", map[string]any{"direction": "up"})
	checkStatus(t, code, 200, out)
	if x.config.Routing.Brains[0].Channel != "typesafe" {
		t.Fatal("move failed")
	}
	code, out = request(t, x.h, "PUT", "/brains/1", map[string]any{"channel": "openrouter", "model": "typesafe-custom", "timeoutMs": 6000})
	checkStatus(t, code, 200, out)
	// Deleting one of two brains on a channel retains the shared credential.
	request(t, x.h, "POST", "/brains", map[string]any{"channel": "typesafe"})
	request(t, x.h, "DELETE", "/brains/1", nil)
	if x.creds.Get("brain:typesafe") == "" {
		t.Fatal("removed shared credential")
	}
	request(t, x.h, "DELETE", "/brains/1", nil)
	if x.creds.Get("brain:openrouter") != "" {
		t.Fatal("credential not removed")
	}
	data, err := os.ReadFile(x.path)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := config.ParseBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(persisted.Routing.Brains) != 1 {
		t.Fatal("disk does not reflect delete")
	}
	stat, _ := os.Stat(x.path)
	if stat.Mode().Perm() != 0o600 {
		t.Fatal("config permissions")
	}
	code, out = request(t, x.h, "POST", "/brains/0/move", map[string]any{"direction": "up"})
	checkStatus(t, code, 400, out)
}
func mustJSON(v any) []byte { data, _ := json.Marshal(v); return data }
func TestRoutingValidationExternalEditAndTokenSaver(t *testing.T) {
	x := setup(t, nil)
	request(t, x.h, "POST", "/brains", map[string]any{"channel": "typesafe"})
	data, _ := os.ReadFile(x.path)
	disk, err := config.ParseBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	disk.Listen.Port = 9999
	disk.ModelAliases = map[string][]string{"alias": {"p/model"}}
	if err := config.Save(x.path, &disk); err != nil {
		t.Fatal(err)
	}
	entries := []any{map[string]any{"id": "plan", "label": "Plan", "models": []string{"baseline"}}, map[string]any{"id": "execute", "label": "Execute", "models": []string{"m"}, "providers": map[string]any{"m": []string{}}}, map[string]any{"id": "utility", "label": "Utility", "models": []string{}}, map[string]any{"id": "chat", "label": "Chat", "models": []string{}}, map[string]any{"id": "review", "label": "Review", "models": []string{"m"}}}
	code, out := request(t, x.h, "PUT", "/routing", map[string]any{"routings": entries, "quotaGuard": map[string]any{"enabled": false}, "brainPicksEffort": false})
	checkStatus(t, code, 200, out)
	if x.config.Listen.Port != 9999 || len(x.config.Routing.Brains) != 1 || x.config.ModelAliases["alias"][0] != "p/model" {
		t.Fatal("lost external edits or brains")
	}
	if x.config.Routing.QuotaGuard.Enabled || !x.config.Routing.QuotaGuard.ResetAware {
		t.Fatal("quota guard merge")
	}
	if len(x.config.Routing.Tiers.Plan) != 1 {
		t.Fatal("tiers not mirrored")
	}
	if order, ok := x.config.Routing.Routings[1].Providers["m"]; !ok || len(order) != 0 {
		t.Fatal("explicit empty allow list lost")
	}
	code, out = request(t, x.h, "PUT", "/routing", map[string]any{"routings": entries[1:]})
	checkStatus(t, code, 400, out)
	entries[4] = map[string]any{"id": "auto", "label": "Bad", "models": []string{}}
	code, out = request(t, x.h, "PUT", "/routing", map[string]any{"routings": entries})
	checkStatus(t, code, 400, out)
	code, out = request(t, x.h, "PUT", "/token-saver", map[string]any{"enabled": false, "command": "  /tmp/rtk ", "timeoutMs": 0})
	checkStatus(t, code, 200, out)
	if x.config.TokenSaver.Enabled || x.config.TokenSaver.Command != "/tmp/rtk" || x.config.TokenSaver.TimeoutMs != 3000 {
		t.Fatalf("bad token saver %#v", x.config.TokenSaver)
	}
}
func TestKeysCRUDAndStateRedaction(t *testing.T) {
	x := setup(t, nil)
	code, out := request(t, x.h, "POST", "/keys", map[string]any{"name": "work", "limitUsd": "12.5"})
	checkStatus(t, code, 201, out)
	key := out["key"].(string)
	if !strings.HasPrefix(key, "sk-jev-") {
		t.Fatal("not a real key")
	}
	record := out["record"].(map[string]any)
	id := record["id"].(string)
	code, out = request(t, x.h, "PUT", "/keys/"+id, map[string]any{"name": " office ", "limitUsd": nil})
	checkStatus(t, code, 200, out)
	updated := out["key"].(map[string]any)
	if updated["name"] != "office" || updated["limitUsd"] != nil {
		t.Fatalf("bad patch %#v", updated)
	}
	code, out = request(t, x.h, "GET", "/state", nil)
	checkStatus(t, code, 200, out)
	if strings.Contains(string(mustJSON(out)), key) || strings.Contains(string(mustJSON(out)), "\"hash\"") {
		t.Fatal("secret leaked")
	}
	code, out = request(t, x.h, "DELETE", "/keys/"+id, nil)
	checkStatus(t, code, 200, out)
	if len(out["keys"].([]any)) != 0 {
		t.Fatal("not deleted")
	}
	code, out = request(t, x.h, "DELETE", "/keys/"+id, nil)
	checkStatus(t, code, 404, out)
}
func TestLogsPaginationFiltersDetailSeriesAndReports(t *testing.T) {
	source := &logs{rows: []admin.LogRecord{
		{"id": "older", "ts": "2026-10-05T10:00:00.000Z", "kind": "request", "model": "anthropic/claude-3.5-sonnet-20241022", "provider": "p", "phase": "plan", "session": "s", "status": 200, "latencyMs": 100, "promptTokens": 100, "completionTokens": 20, "cacheReadTokens": 30, "costUsd": 1.0, "keyId": "k", "keyName": "Work"},
		{"id": "brain", "requestId": "older", "ts": "2026-10-05T10:00:00.000Z", "kind": "brain", "model": "jev", "session": "s", "costUsd": 0.1},
		{"id": "newer", "ts": "2026-10-05T11:55:00.000Z", "kind": "request", "model": "claude-3-5-sonnet", "provider": "p", "phase": "execute", "session": "s2", "status": 502, "latencyMs": 300, "promptTokens": 50, "completionTokens": 10, "cacheReadTokens": 0, "costUsd": 2.0, "billing": "subscription", "keyId": "other", "tries": []any{map[string]any{"cause": "retry"}}},
	}}
	x := setup(t, source)
	code, out := request(t, x.h, "GET", "/logs?limit=1", nil)
	checkStatus(t, code, 200, out)
	if out["total"] != float64(2) || out["nextBefore"] != float64(2) {
		t.Fatalf("bad page %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?limit=1&before=2", nil)
	if out["nextBefore"] != nil || out["logs"].([]any)[0].(map[string]any)["id"] != "older" {
		t.Fatal("bad cursor")
	}
	_, out = request(t, x.h, "GET", "/logs?q=retry", nil)
	if out["total"] != float64(1) {
		t.Fatal("tries search")
	}
	// The exact session filter keeps non-brain rows only and composes with the
	// other filters and the pagination cursor.
	_, out = request(t, x.h, "GET", "/logs?session=s", nil)
	if out["total"] != float64(1) || out["logs"].([]any)[0].(map[string]any)["id"] != "older" {
		t.Fatalf("session filter %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?session=s2", nil)
	if out["total"] != float64(1) || out["logs"].([]any)[0].(map[string]any)["id"] != "newer" {
		t.Fatalf("session filter %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?session=S", nil)
	if out["total"] != float64(0) {
		t.Fatal("session filter must be case-sensitive")
	}
	_, out = request(t, x.h, "GET", "/logs?session=s&phase=plan", nil)
	if out["total"] != float64(1) || out["logs"].([]any)[0].(map[string]any)["id"] != "older" {
		t.Fatalf("session + phase %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?session=s&phase=execute", nil)
	if out["total"] != float64(0) {
		t.Fatalf("session + phase mismatch %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?session=s&limit=1", nil)
	if out["total"] != float64(1) || out["nextBefore"] != nil {
		t.Fatalf("session + pagination %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?session=s&limit=1&before=3", nil)
	if out["total"] != float64(1) || out["logs"].([]any)[0].(map[string]any)["id"] != "older" {
		t.Fatalf("session + cursor %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs?session=s&limit=1&before=0", nil)
	if out["total"] != float64(1) || len(out["logs"].([]any)) != 0 {
		t.Fatalf("session + early cursor %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs/older", nil)
	if len(out["brainCalls"].([]any)) != 1 {
		t.Fatal("brain detail missing")
	}
	_, out = request(t, x.h, "GET", "/logs/series?minutes=60&buckets=6", nil)
	buckets := out["buckets"].([]any)
	if buckets[5].(map[string]any)["requests"] != float64(1) {
		t.Fatalf("bad series %#v", out)
	}
	_, out = request(t, x.h, "GET", "/activity?range=today&keyId=k", nil)
	summary := out["summary"].(map[string]any)
	if summary["totalRequests"] != float64(1) || summary["totalTokens"] != float64(150) || len(out["keys"].([]any)) != 2 {
		t.Fatalf("bad filtered report %#v", out)
	}
	_, out = request(t, x.h, "GET", "/activity?range=today", nil)
	if len(out["models"].([]any)) != 1 {
		t.Fatal("canonical groups not merged")
	}
	summary = out["summary"].(map[string]any)
	if summary["apiSpendUsd"] != float64(1) || summary["subscriptionValueUsd"] != float64(2) || summary["errorRequests"] != float64(1) {
		t.Fatalf("bad activity %#v", summary)
	}
	_, out = request(t, x.h, "GET", "/stats", nil)
	if out["requests"] != float64(3) || out["brainRequests"] != float64(1) || out["subscriptionUsd"] != float64(2) {
		t.Fatalf("bad stats %#v", out)
	}
}
func TestLogFacetsExclusionSortCapAndBrain(t *testing.T) {
	rows := []admin.LogRecord{
		{"id": "a", "ts": "2026-10-05T11:30:00.000Z", "kind": "request", "model": "gpt-5", "provider": "openai", "phase": "execute", "status": 200},
		{"id": "b", "ts": "2026-10-05T11:31:00.000Z", "kind": "request", "model": "gpt-5", "provider": "openai", "phase": "execute", "status": 200},
		{"id": "c", "ts": "2026-10-05T11:32:00.000Z", "kind": "request", "model": "gpt-5", "provider": "anthropic", "phase": "plan", "status": 500},
		{"id": "d", "ts": "2026-10-05T11:33:00.000Z", "kind": "request", "model": "claude", "provider": "anthropic", "phase": "plan", "status": 500},
		{"id": "e", "ts": "2026-10-05T11:34:00.000Z", "kind": "request", "model": "claude", "provider": "anthropic", "phase": "", "status": 200},
		// Brain rows must never appear in any facet or in the total.
		{"id": "brain", "requestId": "a", "ts": "2026-10-05T11:30:00.000Z", "kind": "brain", "model": "gpt-5", "provider": "openai", "phase": "execute", "status": 200},
	}
	x := setup(t, &logs{rows: rows})
	code, out := request(t, x.h, "GET", "/logs/facets", nil)
	checkStatus(t, code, 200, out)
	if out["total"] != float64(5) {
		t.Fatalf("total excludes brain: %#v", out)
	}
	groups := out["groups"].(map[string]any)
	status := groups["status"].([]any)
	if len(status) != 2 {
		t.Fatalf("status always lists ok and error: %#v", status)
	}
	if status[0].(map[string]any)["value"] != "ok" || status[0].(map[string]any)["count"] != float64(3) ||
		status[1].(map[string]any)["value"] != "error" || status[1].(map[string]any)["count"] != float64(2) {
		t.Fatalf("status facet %#v", status)
	}
	// phase "-" collects the missing phase; sorted by count desc, then value.
	phase := groups["phase"].([]any)
	wantPhase := []struct {
		value string
		count float64
	}{{"execute", 2}, {"plan", 2}, {"-", 1}}
	if len(phase) != len(wantPhase) {
		t.Fatalf("phase facet %#v", phase)
	}
	for i, w := range wantPhase {
		row := phase[i].(map[string]any)
		if row["value"] != w.value || row["count"] != w.count {
			t.Fatalf("phase[%d] %#v want %#v", i, row, w)
		}
	}
	provider := groups["provider"].([]any)
	if len(provider) != 2 || provider[0].(map[string]any)["value"] != "anthropic" || provider[0].(map[string]any)["count"] != float64(3) {
		t.Fatalf("provider facet %#v", provider)
	}
	model := groups["model"].([]any)
	if len(model) != 2 || model[0].(map[string]any)["value"] != "gpt-5" || model[0].(map[string]any)["count"] != float64(3) || model[1].(map[string]any)["value"] != "claude" {
		t.Fatalf("model facet %#v", model)
	}
	if strings.Contains(string(mustJSON(out)), "brain") {
		t.Fatalf("brain row leaked: %s", mustJSON(out))
	}

	// With status=error the status group ignores its own filter but respects
	// the others; the total still applies every filter.
	_, out = request(t, x.h, "GET", "/logs/facets?status=error", nil)
	checkStatus(t, code, 200, out)
	if out["total"] != float64(2) {
		t.Fatalf("filtered total %#v", out)
	}
	status = out["groups"].(map[string]any)["status"].([]any)
	if status[0].(map[string]any)["value"] != "ok" || status[0].(map[string]any)["count"] != float64(3) ||
		status[1].(map[string]any)["value"] != "error" || status[1].(map[string]any)["count"] != float64(2) {
		t.Fatalf("status exclusion %#v", status)
	}
	// The phase group DOES respect the status=error filter.
	phase = out["groups"].(map[string]any)["phase"].([]any)
	if len(phase) != 1 || phase[0].(map[string]any)["value"] != "plan" || phase[0].(map[string]any)["count"] != float64(2) {
		t.Fatalf("phase respects status %#v", phase)
	}

	// The optional minutes window keeps only recent records.
	_, out = request(t, x.h, "GET", "/logs/facets?minutes=60", nil)
	if out["total"] != float64(5) {
		t.Fatalf("window total %#v", out)
	}
	_, out = request(t, x.h, "GET", "/logs/facets?minutes=1", nil)
	if out["total"] != float64(0) {
		t.Fatalf("empty window total %#v", out)
	}
}

func TestLogFacetModelCap(t *testing.T) {
	rows := []admin.LogRecord{}
	for i := 0; i < 60; i++ {
		rows = append(rows, admin.LogRecord{"id": fmt.Sprintf("r-%d", i), "kind": "request", "model": fmt.Sprintf("model-%02d", i), "status": 200})
	}
	x := setup(t, &logs{rows: rows})
	_, out := request(t, x.h, "GET", "/logs/facets", nil)
	models := out["groups"].(map[string]any)["model"].([]any)
	if len(models) != 50 {
		t.Fatalf("model cap = %d want 50", len(models))
	}
	// Equal counts sort by value asc, so the first 50 lexicographic values win.
	if models[0].(map[string]any)["value"] != "model-00" || models[49].(map[string]any)["value"] != "model-49" {
		t.Fatalf("model cap order %#v %#v", models[0], models[49])
	}
}

func TestProviderDiscoveryAndWirePins(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("keyless discovery sent auth")
		}
		io.WriteString(w, `{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}`)
	}))
	defer upstream.Close()
	x := setup(t, nil)
	code, out := request(t, x.h, "POST", "/providers/discover", map[string]any{"type": "openai", "baseUrl": upstream.URL + "/v1", "noKey": true})
	checkStatus(t, code, 200, out)
	if len(out["models"].([]any)) != 2 {
		t.Fatal("discovery did not dedupe")
	}
	code, out = request(t, x.h, "POST", "/providers", map[string]any{"name": "local", "type": "openai", "baseUrl": upstream.URL + "/v1", "noKey": true, "models": []any{map[string]any{"id": "a", "wire": "anthropic"}, "b"}})
	checkStatus(t, code, 200, out)
	code, out = request(t, x.h, "POST", "/providers", map[string]any{"name": "local", "type": "openai", "baseUrl": upstream.URL + "/v1", "noKey": true, "models": []string{"a"}})
	checkStatus(t, code, 200, out)
	if len(x.config.Providers[0].Models[0].Wire) != 1 || len(x.config.Providers[0].ExcludeModels) != 1 {
		t.Fatal("lost wire or exclusion")
	}
	// Saving a provider must refresh computed tiers without pinning an automatic
	// routing's derived model list into the saved configuration.
	cfg := *x.config
	cfg.Providers = nil
	cfg.DefaultProvider = ""
	cfg.Routing.Routings = []config.RoutingEntry{{ID: "plan", Label: "Plan", Description: "Planning"}, {ID: "execute", Label: "Execute"}, {ID: "utility", Label: "Utility"}, {ID: "chat", Label: "Chat"}}
	x.config = &cfg
	code, out = request(t, x.h, "POST", "/providers", map[string]any{"name": "local", "type": "openai", "baseUrl": upstream.URL + "/v1", "noKey": true, "models": []string{"a", "b"}})
	checkStatus(t, code, 200, out)
	if len(x.config.Routing.Routings[0].Models) != 0 {
		t.Fatalf("provider save pinned automatic route models: %#v", x.config.Routing.Routings[0].Models)
	}
	if len(out["routings"].([]any)) == 0 {
		t.Fatal("provider save did not return derived route previews")
	}
	data, _ := os.ReadFile(x.path)
	reloaded, err := config.ParseBytes(data)
	if err != nil || reloaded.Providers[0].Models[0].ID != "a" {
		t.Fatalf("unreadable model serialization: %s %v", data, err)
	}
	code, out = request(t, x.h, "POST", "/providers", map[string]any{"name": "bad", "baseUrl": "https://example.com", "type": "openai", "auth": "oauth", "oauthSource": "devin"})
	checkStatus(t, code, 400, out)
	code, out = request(t, x.h, "DELETE", "/providers/local", nil)
	checkStatus(t, code, 200, out)
	if x.config.DefaultProvider != "" || len(x.config.Providers) != 0 {
		t.Fatal("defaultProvider not cleared")
	}
}
func TestQuotaAPIIncludesConfiguredModelHealth(t *testing.T) {
	x := setup(t, nil)
	cfg := x.config
	cfg.Providers = []config.Provider{{Name: "devin", Billing: config.BillingSubscription, Models: []config.ModelEntry{{ID: "swe-2-max"}, {ID: "swe-2"}}}}
	tracker := quota.New(nil)
	now := time.Date(2026, 10, 6, 1, 0, 0, 0, time.UTC)
	tracker.SetClock(func() time.Time { return now })
	tracker.MarkSpent("devin", quota.MarkSpentOptions{Model: "swe-2-max", Label: "Reached free model rate limit", ResetsAt: now.Add(45 * time.Second)})
	x.h = admin.New(admin.Deps{Config: func() *config.Config { return cfg }, Quota: tracker, Quotas: func(context.Context, *config.Config, bool) ([]map[string]any, error) { return nil, nil }})
	code, out := request(t, x.h, "GET", "/quota", nil)
	checkStatus(t, code, 200, out)
	row := out["health"].([]any)[0].(map[string]any)
	models := row["modelHealth"].([]any)
	if len(models) != 1 {
		t.Fatalf("model health rows = %#v", models)
	}
	model := models[0].(map[string]any)
	if model["model"] != "swe-2-max" || model["status"] != "exhausted" || model["reason"] != "Reached free model rate limit" || model["resetsAt"] == nil {
		t.Fatalf("model health = %#v", model)
	}
}

func TestLoopbackAndMissingDependencies(t *testing.T) {
	x := setup(t, nil)
	req := httptest.NewRequest("GET", "/state", nil)
	req.RemoteAddr = "192.168.1.2:5432"
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	rr := httptest.NewRecorder()
	x.h.ServeHTTP(rr, req)
	if rr.Code != 403 {
		t.Fatal("nonloopback admin allowed")
	}
	for _, path := range []string{"/logs", "/catalog", "/quota", "/update", "/clients", "/model-sync"} {
		code, out := request(t, x.h, "GET", path, nil)
		checkStatus(t, code, 503, out)
	}
}
func TestPersistenceFailureDoesNotReload(t *testing.T) {
	x := setup(t, nil)
	if err := os.WriteFile(x.path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out := request(t, x.h, "PUT", "/token-saver", map[string]any{"enabled": false})
	checkStatus(t, code, 500, out)
	if !x.config.TokenSaver.Enabled {
		t.Fatal("reloaded despite failed write")
	}
}
func TestSSEReadyFilteredLogAndCancellation(t *testing.T) {
	source := &logs{}
	x := setup(t, source)
	server := httptest.NewServer(x.h)
	defer server.Close()
	response, err := http.Get(server.URL + "/logs/stream?q=retry")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "event: ready\n" {
		t.Fatalf("ready: %q %v", line, err)
	}
	reader.ReadString('\n')
	reader.ReadString('\n')
	source.append(admin.LogRecord{"id": "clean", "model": "m"})
	source.append(admin.LogRecord{"id": "retried", "model": "m", "retries": 1})
	line, err = reader.ReadString('\n')
	if err != nil || line != "event: log\n" {
		t.Fatalf("log: %q %v", line, err)
	}
	line, _ = reader.ReadString('\n')
	if !strings.Contains(line, "retried") || strings.Contains(line, "clean") {
		t.Fatalf("filter failed %s", line)
	}
	response.Body.Close()
}
func TestSSESessionFilterExcludesBrainRows(t *testing.T) {
	source := &logs{}
	x := setup(t, source)
	server := httptest.NewServer(x.h)
	defer server.Close()
	response, err := http.Get(server.URL + "/logs/stream?session=s")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "event: ready\n" {
		t.Fatalf("ready: %q %v", line, err)
	}
	reader.ReadString('\n')
	reader.ReadString('\n')
	source.append(admin.LogRecord{"id": "other", "session": "s2"})
	source.append(admin.LogRecord{"id": "brain", "kind": "brain", "session": "s"})
	source.append(admin.LogRecord{"id": "match", "session": "s"})
	line, err = reader.ReadString('\n')
	if err != nil || line != "event: log\n" {
		t.Fatalf("log: %q %v", line, err)
	}
	line, _ = reader.ReadString('\n')
	if !strings.Contains(line, "match") || strings.Contains(line, "other") || strings.Contains(line, "brain") {
		t.Fatalf("session filter failed %s", line)
	}
}
func TestSSEMultiValueStatusFilter(t *testing.T) {
	source := &logs{}
	x := setup(t, source)
	server := httptest.NewServer(x.h)
	defer server.Close()
	response, err := http.Get(server.URL + "/logs/stream?status=error")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "event: ready\n" {
		t.Fatalf("ready: %q %v", line, err)
	}
	reader.ReadString('\n')
	reader.ReadString('\n')
	source.append(admin.LogRecord{"id": "ok", "status": 200})
	source.append(admin.LogRecord{"id": "bad", "status": 503})
	line, err = reader.ReadString('\n')
	if err != nil || line != "event: log\n" {
		t.Fatalf("log: %q %v", line, err)
	}
	line, _ = reader.ReadString('\n')
	if !strings.Contains(line, "bad") || strings.Contains(line, "\"ok\"") {
		t.Fatalf("multi-value status filter failed %s", line)
	}
}
func TestSQLiteAdapterReadsGoLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.sqlite")
	db, err := ledger.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cost := 0.5
	if err := db.Append(ledger.Record{ID: "r1", Model: "m", Status: 200, CostUSD: &cost, PricingKnown: true}); err != nil {
		t.Fatal(err)
	}
	source, err := admin.OpenSQLiteLogs(path)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	x := setup(t, source)
	code, out := request(t, x.h, "GET", "/logs", nil)
	checkStatus(t, code, 200, out)
	row := out["logs"].([]any)[0].(map[string]any)
	if row["id"] != "r1" || row["costUsd"] != 0.5 || row["pricingKnown"] != true {
		t.Fatalf("bad SQLite wire %#v", row)
	}
}

func TestExtensionRoutesMounted(t *testing.T) {
	dir := t.TempDir()
	cfg := config.DefaultConfig()
	clientMgr := clients.New(clients.Options{
		Home:    dir,
		DataDir: dir,
	})
	exts := admin.BuildExtensions(admin.ExtensionOptions{
		Config:  func() *config.Config { return &cfg },
		Clients: clientMgr,
	})

	h := admin.New(admin.Deps{
		Config:     func() *config.Config { return &cfg },
		Extensions: exts,
	})

	// 1. GET /clients
	code, out := request(t, h, "GET", "/clients", nil)
	checkStatus(t, code, 200, out)
	if out["clients"] == nil {
		t.Fatalf("expected clients array, got %#v", out)
	}

	// 2. GET /catalog
	code, out = request(t, h, "GET", "/catalog", nil)
	checkStatus(t, code, 200, out)
	if out["leaderboard"] == nil || out["pricing"] == nil {
		t.Fatalf("expected catalog status object, got %#v", out)
	}

	// 3. GET /pricing
	code, out = request(t, h, "GET", "/pricing", nil)
	checkStatus(t, code, 200, out)
	if out["prices"] == nil || out["provider"] != "" {
		t.Fatalf("expected {provider, prices}, got %#v", out)
	}
}

func TestChatGPTWebProviderCRUDAndDiscover(t *testing.T) {
	x := setup(t, nil)
	mockDriver := &mockChatGPTWebDriver{
		models: []chatgptweb.Model{
			{ID: "gpt-4o", Title: "GPT-4o"},
			{ID: "o1", Title: "o1"},
		},
	}
	chatgptweb.SetDefaultDriverForTest(mockDriver)
	defer chatgptweb.SetDefaultDriverForTest(nil)

	// POST /providers
	code, out := request(t, x.h, "POST", "/providers", map[string]any{
		"name":    "chatgpt-local",
		"type":    "chatgpt-web",
		"baseUrl": "http://127.0.0.1:9222",
		"billing": "subscription",
	})
	checkStatus(t, code, 200, out)
	cfg := out["config"].(map[string]any)
	provs := cfg["providers"].([]any)
	if len(provs) == 0 || provs[0].(map[string]any)["type"] != "chatgpt-web" || provs[0].(map[string]any)["noKey"] != true {
		t.Fatalf("expected keyless chatgpt-web provider, got %#v", provs)
	}

	// POST /providers/discover
	code, out = request(t, x.h, "POST", "/providers/discover", map[string]any{
		"name":    "chatgpt-local",
		"type":    "chatgpt-web",
		"baseUrl": "http://127.0.0.1:9222",
	})
	checkStatus(t, code, 200, out)
	models := out["models"].([]any)
	if len(models) != 2 || models[0] != "gpt-4o" || models[1] != "o1" {
		t.Fatalf("expected models [gpt-4o, o1], got %#v", models)
	}
}

type mockChatGPTWebDriver struct {
	models []chatgptweb.Model
}

func (m *mockChatGPTWebDriver) Models(ctx context.Context, cdpEndpoint string) ([]chatgptweb.Model, error) {
	return m.models, nil
}

func (m *mockChatGPTWebDriver) Chat(ctx context.Context, cdpEndpoint string, req chatgptweb.ChatRequest, prompt string) (chatgptweb.ChatResult, error) {
	return chatgptweb.ChatResult{}, nil
}
