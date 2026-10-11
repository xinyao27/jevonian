package clients

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/xinyao27/jevonian/internal/oauth/jsoncedit"
)

func testManager(t *testing.T, platform string) *Manager {
	t.Helper()
	home := t.TempDir()
	return New(Options{Home: home, DataDir: filepath.Join(home, "data"), Platform: platform, Hostname: "fixture-host", LookPath: func(string) (string, error) { return "", errors.New("not installed") }, Running: func(ClientID) bool { return false }, Restart: func(context.Context, ClientID) error { return nil }, Now: func() time.Time { return time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC) }})
}
func put(t *testing.T, path, text string) {
	t.Helper()
	if err := writeText(path, text); err != nil {
		t.Fatal(err)
	}
}
func get(t *testing.T, path string) string {
	t.Helper()
	text, err := readText(path)
	if err != nil {
		t.Fatal(err)
	}
	return text
}
func mustApply(t *testing.T, m *Manager, id ClientID, options ApplyOptions) ApplyResult {
	t.Helper()
	v, err := m.Apply(id, options)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func mustRestore(t *testing.T, m *Manager, id ClientID) {
	t.Helper()
	if _, err := m.Restore(id); err != nil {
		t.Fatal(err)
	}
}
func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}
func assertContains(t *testing.T, text string, needles ...string) {
	t.Helper()
	for _, needle := range needles {
		if !strings.Contains(text, needle) {
			t.Fatalf("missing %q in:\n%s", needle, text)
		}
	}
}

// Fixtures and expectations are ported from src/claude-code.test.ts.
func TestClaudeCodeSurgicalConnectRestore(t *testing.T) {
	m := testManager(t, "linux")
	path := m.ClaudeCodeSettingsPath()
	original := `{
  // my hand-written layout
  "theme": "dark",
  "env": {
    "API_TIMEOUT_MS": "1200000",   /* keep */
    "KEEP_ME": "yes"
  },
  "attribution": { "commit": "" }
}
`
	put(t, path, original)
	applied := mustApply(t, m, Claude, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}, CodeModels: []string{"jevonian/auto", "jevonian/utility"}})
	if applied.Target.Status != Connected || applied.Target.BaseURL != "http://127.0.0.1:8787" {
		t.Fatalf("%+v", applied)
	}
	text := get(t, path)
	assertContains(t, text, "// my hand-written layout", `"API_TIMEOUT_MS": "1200000",   /* keep */`, `"KEEP_ME": "yes"`, `"attribution": { "commit": "" }`)
	env := readObject(path)["env"].(map[string]any)
	for key, value := range ClaudeCodeEnv(8787, []string{"jevonian/auto", "jevonian/utility"}, "") {
		if env[key] != value {
			t.Fatalf("%s = %v want %s", key, env[key], value)
		}
	}
	if env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] != "jevonian/utility" {
		t.Fatal(env)
	}
	// Re-connect must not capture our own token as the user's original.
	mustApply(t, m, Claude, ApplyOptions{Port: 9090, Models: []string{"jevonian/plan"}})
	mustRestore(t, m, Claude)
	if text := get(t, path); text != original {
		t.Fatalf("restore not byte-identical:\n%s", text)
	}
	backups, err := filepath.Glob(path + ".jevonian-backup-*")
	if err != nil || len(backups) < 3 {
		t.Fatalf("backups %v %v", backups, err)
	}
	if exists(m.statePath("claude-code")) {
		t.Fatal("restore state not cleared")
	}
}
func TestClaudeCodeAbsentSettingsRemoved(t *testing.T) {
	m := testManager(t, "linux")
	mkdir(t, m.opts.ClaudeConfigDir)
	mustApply(t, m, Claude, ApplyOptions{Port: 9090, Models: []string{"jevonian/auto"}})
	if !exists(m.ClaudeCodeSettingsPath()) {
		t.Fatal("settings missing")
	}
	mustRestore(t, m, Claude)
	if exists(m.ClaudeCodeSettingsPath()) {
		t.Fatal("settings stub left behind")
	}
}
func TestClaudeCodeRestorePreservesPostConnectUnmanagedChanges(t *testing.T) {
	for _, lostState := range []bool{false, true} {
		t.Run(map[bool]string{false: "saved", true: "lost-state"}[lostState], func(t *testing.T) {
			m := testManager(t, "linux")
			path := m.ClaudeCodeSettingsPath()
			put(t, path, "{\n  // settings I keep by hand\n  \"theme\": \"dark\",\n  \"env\": {\"KEEP_ME\": \"yes\", \"ANTHROPIC_API_KEY\": \"original-key\"}\n}\n")
			mustApply(t, m, Claude, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}})
			if lostState {
				if err := os.Remove(m.statePath("claude-code")); err != nil {
					t.Fatal(err)
				}
			}
			next := jsoncedit.ApplyEdits(get(t, path), []jsoncedit.Edit{{Path: []string{"theme"}, Value: "light"}, {Path: []string{"env", "NEW_USER_KEY"}, Value: "saved-after-connect"}})
			put(t, path, next)
			mustRestore(t, m, Claude)
			text := get(t, path)
			assertContains(t, text, "// settings I keep by hand", `"theme": "light"`, `"KEEP_ME": "yes"`, `"NEW_USER_KEY": "saved-after-connect"`)
			if strings.Contains(text, "ANTHROPIC_AUTH_TOKEN") || strings.Contains(text, "ANTHROPIC_BASE_URL") {
				t.Fatal(text)
			}
			if !lostState && readObject(path)["env"].(map[string]any)["ANTHROPIC_API_KEY"] != "original-key" {
				t.Fatal("prior managed API key not restored")
			}
		})
	}
}
func TestClaudeCodeLostStateRemovesEmptyEnv(t *testing.T) {
	m := testManager(t, "linux")
	path := m.ClaudeCodeSettingsPath()
	put(t, path, "{\n  \"theme\": \"dark\"\n}\n")
	mustApply(t, m, Claude, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}})
	if err := os.Remove(m.statePath("claude-code")); err != nil {
		t.Fatal(err)
	}
	mustRestore(t, m, Claude)
	if _, ok := readObject(path)["env"]; ok {
		t.Fatal("empty env left behind")
	}
}
func TestClaudeCodeRefusesMalformedOrScalarEnv(t *testing.T) {
	for _, original := range []string{`{broken`, `{"env":"not-an-object"}`, `[1,2]`} {
		m := testManager(t, "linux")
		path := m.ClaudeCodeSettingsPath()
		put(t, path, original)
		if _, err := m.Apply(Claude, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}}); err == nil {
			t.Fatalf("accepted %s", original)
		}
		if get(t, path) != original {
			t.Fatal("malformed config overwritten")
		}
		if exists(m.statePath("claude-code")) {
			t.Fatal("captured unusable restore state")
		}
	}
}
func TestModelRoutingEnvAndLaunchTSContract(t *testing.T) {
	route := ResolveClaudeCodeModels([]string{"jevonian/auto", "jevonian/utility"}, "")
	if route.Primary != "jevonian/auto" || route.Fast != "jevonian/utility" {
		t.Fatal(route)
	}
	if ClaudeCodeModelLabel("accounts/fireworks/models/deepseek-v4.1-flash") != "Jevonian Deepseek V4 1 Flash" {
		t.Fatal("label")
	}
	env := ClaudeCodeEnv(8787, []string{"jevonian/auto", "jevonian/utility"}, "")
	checks := map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:8787", "ANTHROPIC_AUTH_TOKEN": "jevonian-local", "ANTHROPIC_API_KEY": "", "ANTHROPIC_DEFAULT_OPUS_MODEL": "jevonian/auto", "ANTHROPIC_DEFAULT_SONNET_MODEL": "jevonian/auto", "ANTHROPIC_DEFAULT_HAIKU_MODEL": "jevonian/utility", "CLAUDE_CODE_SUBAGENT_MODEL": "jevonian/auto", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Jevonian Auto", "ANTHROPIC_CUSTOM_MODEL_OPTION": "jevonian/auto", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "Jevonian Auto"}
	for key, value := range checks {
		if env[key] != value {
			t.Fatalf("%s = %q", key, env[key])
		}
	}
	m := testManager(t, "linux")
	bin := filepath.Join(m.opts.Home, ".local", "bin", "claude")
	put(t, bin, "#!/bin/sh\n")
	spec, err := m.PrepareClaudeCodeLaunch(8787, []string{"jevonian/auto"}, "jevonian/plan", []string{"--resume"}, []string{"PATH=/usr/bin", "ANTHROPIC_API_KEY=sk-leaked"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != bin || !reflect.DeepEqual(spec.Args, []string{"--model", "jevonian/plan", "--resume"}) {
		t.Fatalf("%+v", spec)
	}
	if strings.Contains(strings.Join(spec.Env, "\n"), "sk-leaked") {
		t.Fatal("exported key not cleared")
	}
	assertContains(t, strings.Join(spec.Env, "\n"), "PATH=/usr/bin", "ANTHROPIC_API_KEY=", "ANTHROPIC_AUTH_TOKEN=jevonian-local")
}

// Fixtures are ported from src/client-routing.test.ts, including the real
// model catalog field schema rather than sparse synthetic picker entries.
func TestCodexLoginAndSurgicalTOML(t *testing.T) {
	m := testManager(t, "linux")
	path := m.CodexConfigPath()
	auth := filepath.Join(m.opts.CodexHome, "auth.json")
	original := "# my careful setup\nmodel = \"gpt-5.6-sol\"\nmodel_provider = \"custom\"\napproval_policy = \"on-request\"\n\n[mcp_servers.thing]\ncommand = \"thing\"\n\n# trailing comment\n"
	login := `{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt-secret"}}`
	put(t, path, original)
	put(t, auth, login)
	result := mustApply(t, m, ChatGPT, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}})
	if result.Target.Status != Connected || len(result.Written) != 4 {
		t.Fatalf("%+v", result)
	}
	text := get(t, path)
	assertContains(t, text, "# my careful setup", `approval_policy = "on-request"`, "[mcp_servers.thing]", "# trailing comment", `model = "jevonian/auto"`, `openai_base_url = "http://127.0.0.1:8787/v1"`)
	if strings.Contains(text, "model_provider") || strings.Count(text, "\nmodel = ") != 1 {
		t.Fatal(text)
	}
	if get(t, auth) != login {
		t.Fatal("login overwritten")
	}
	mustApply(t, m, ChatGPT, ApplyOptions{Port: 9090, Models: []string{"jevonian/plan"}})
	mustRestore(t, m, ChatGPT)
	if get(t, path) != original {
		t.Fatal("original TOML not restored")
	}
	if get(t, auth) != login {
		t.Fatal("login touched by Restore")
	}
	if exists(m.CodexCatalogPath()) || exists(m.CodexRoutingCatalogPath()) {
		t.Fatal("catalogs not removed")
	}
}
func TestCodexSentinelCreationAndNewLoginSafety(t *testing.T) {
	for _, newLogin := range []bool{false, true} {
		t.Run(map[bool]string{false: "sentinel", true: "new-login"}[newLogin], func(t *testing.T) {
			m := testManager(t, "linux")
			mustApply(t, m, ChatGPT, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}})
			auth := filepath.Join(m.opts.CodexHome, "auth.json")
			obj := readObject(auth)
			if obj["auth_mode"] != "apikey" || obj["OPENAI_API_KEY"] != ManagedMarker {
				t.Fatal(obj)
			}
			if newLogin {
				put(t, auth, `{"auth_mode":"chatgpt","tokens":{"refresh_token":"new-login"}}`)
			}
			mustRestore(t, m, ChatGPT)
			if newLogin {
				assertContains(t, get(t, auth), "new-login")
			} else if exists(auth) {
				t.Fatal("sentinel left behind")
			}
			if exists(m.CodexConfigPath()) {
				t.Fatal("new config stub left behind")
			}
		})
	}
}
func TestCodexEnsureExclusive(t *testing.T) {
	m := testManager(t, "linux")
	auth := filepath.Join(m.opts.CodexHome, "auth.json")
	for _, login := range []string{"", `{"tokens":{"refresh_token":"r"}}`, `malformed login`} {
		put(t, auth, login)
		created, path, err := m.EnsureCodexSentinel()
		if err != nil || created || path != auth {
			t.Fatalf("%v %q %v", created, path, err)
		}
		if get(t, auth) != login {
			t.Fatal("existing auth changed")
		}
	}
}
func TestCodexRestoreKeepsUnmanagedChanges(t *testing.T) {
	m := testManager(t, "linux")
	path := m.CodexConfigPath()
	put(t, path, "# keep\nmodel = 'gpt-5.6-sol' # prior\nmodel_provider = \"old\"\napproval_policy = \"on-request\"\n\n[section]\nkey = \"v\"\n")
	mustApply(t, m, ChatGPT, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}})
	put(t, path, strings.Replace(get(t, path), `key = "v"`, `key = "changed"`, 1))
	mustRestore(t, m, ChatGPT)
	assertContains(t, get(t, path), "# keep", `model = 'gpt-5.6-sol' # prior`, `model_provider = "old"`, `key = "changed"`)
	if strings.Contains(get(t, path), "openai_base_url") || strings.Contains(get(t, path), "model_catalog_json") {
		t.Fatal(get(t, path))
	}
}
func TestCodexLostStateRestoreManagedKeysOnly(t *testing.T) {
	m := testManager(t, "linux")
	path := m.CodexConfigPath()
	put(t, path, "# keep\nmodel = \"gpt-5.6-sol\"\n")
	mustApply(t, m, ChatGPT, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto"}})
	if err := os.Remove(m.statePath("chatgpt")); err != nil {
		t.Fatal(err)
	}
	mustRestore(t, m, ChatGPT)
	assertContains(t, get(t, path), "# keep", `model = "jevonian/auto"`)
	if strings.Contains(get(t, path), "openai_base_url") || strings.Contains(get(t, path), "model_catalog_json") {
		t.Fatal(get(t, path))
	}
}
func TestCodexCatalogTSContract(t *testing.T) {
	m := testManager(t, "linux")
	put(t, m.CodexModelsCachePath(), `{"models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","visibility":"list","supported_in_api":true,"priority":1,"input_modalities":["text","image"],"base_instructions":"Native system prompt","future_field":{"keep":true}},{"slug":"JEVONIAN/AUTO","priority":2},null,7,{"slug":""}]}`)
	mustApply(t, m, ChatGPT, ApplyOptions{Port: 8787, Models: []string{"jevonian/auto", "JEVONIAN/AUTO"}})
	rows := readObject(m.CodexCatalogPath())["models"].([]any)
	if len(rows) != 2 {
		t.Fatal(rows)
	}
	injected := rows[0].(map[string]any)
	native := rows[1].(map[string]any)
	if injected["slug"] != "jevonian/auto" || native["slug"] != "gpt-5.6-sol" || injected["supported_in_api"] != true || native["supported_in_api"] != false {
		t.Fatal(rows)
	}
	if injected["priority"].(float64) >= native["priority"].(float64) || native["future_field"] == nil {
		t.Fatal(rows)
	}
	fields := []string{"slug", "display_name", "description", "default_reasoning_level", "supported_reasoning_levels", "shell_type", "visibility", "supported_in_api", "priority", "additional_speed_tiers", "service_tiers", "default_service_tier", "availability_nux", "upgrade", "base_instructions", "model_messages", "include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions", "supports_reasoning_summary_parameter", "supports_reasoning_summaries", "default_reasoning_summary", "support_verbosity", "default_verbosity", "apply_patch_tool_type", "web_search_tool_type", "truncation_policy", "supports_parallel_tool_calls", "supports_image_detail_original", "context_window", "max_context_window", "auto_compact_token_limit", "effective_context_window_percent", "experimental_supported_tools", "input_modalities", "supports_search_tool"}
	if len(injected) != len(fields) {
		t.Fatalf("schema has %d fields want %d", len(injected), len(fields))
	}
	for _, key := range fields {
		if _, ok := injected[key]; !ok {
			t.Fatalf("missing parser-required %s", key)
		}
	}
	if injected["display_name"] != "Jevonian Auto" || injected["base_instructions"] != "Native system prompt" || injected["supports_image_detail_original"] != true || !reflect.DeepEqual(injected["input_modalities"], []any{"text", "image"}) {
		t.Fatal(injected)
	}
	levels := injected["supported_reasoning_levels"].([]any)
	if len(levels) != 8 || levels[7].(map[string]any)["effort"] != "ultra" {
		t.Fatal(levels)
	}
	routing := readObject(m.CodexRoutingCatalogPath())["models"].([]any)
	if len(routing) != 2 || routing[0].(map[string]any)["slug"] != "jevonian/auto" {
		t.Fatal(routing)
	}
	var catalog map[string]any
	if json.Unmarshal([]byte(get(t, m.CodexCatalogPath())), &catalog) != nil {
		t.Fatal("not plain JSON")
	}
}

func TestGrokApplyAndRestore(t *testing.T) {
	m := testManager(t, "linux")
	grokCfg := m.GrokConfigPath()
	put(t, grokCfg, "[models]\ndefault = \"grok-4.7\"\ndefault_reasoning_effort = \"high\"\n")

	status := m.GrokStatus(8787)
	if !status.Installed {
		t.Fatal("expected Grok installed when config exists")
	}
	if status.Status == Connected {
		t.Fatal("expected Disconnected initially")
	}

	mustApply(t, m, Grok, ApplyOptions{Port: 8787, Models: []string{"grok-4.5"}})

	content := get(t, grokCfg)
	assertContains(t, content, `xai_api_base_url = "http://127.0.0.1:8787/v1"`, `models_base_url = "http://127.0.0.1:8787/v1"`, `default = "grok-4.5"`, `default_reasoning_effort = "high"`)

	statusAfter := m.GrokStatus(8787)
	if statusAfter.Status != Connected {
		t.Fatalf("expected Connected after apply, got %s", statusAfter.Status)
	}

	mustRestore(t, m, Grok)

	restored := get(t, grokCfg)
	if strings.Contains(restored, "8787") {
		t.Fatalf("expected 8787 removed after restore, got:\n%s", restored)
	}
	assertContains(t, restored, `default = "grok-4.7"`)
}

