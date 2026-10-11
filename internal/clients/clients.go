// Package clients connects local ChatGPT/Codex and Claude Desktop/Code clients.
// Disk paths and process hooks are injectable; this package does not import server
// or cli. Mount Handler only on the loopback admin surface.
package clients

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/xinyao27/jevonian/internal/oauth/sentinel"
	"github.com/xinyao27/jevonian/internal/paths"
)

const ManagedMarker = sentinel.Marker

type ClientID string

const (
	ChatGPT ClientID = "chatgpt"
	Claude  ClientID = "claude"
	Grok    ClientID = "grok"
)

type Status string

const (
	Connected    Status = "connected"
	Disconnected Status = "disconnected"
	Unavailable  Status = "unavailable"
)

type Surface struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Status     Status `json:"status"`
	ConfigPath string `json:"configPath,omitempty"`
	BaseURL    string `json:"baseUrl,omitempty"`
	Reason     string `json:"reason,omitempty"`
}
type Target struct {
	ID         ClientID  `json:"id"`
	Label      string    `json:"label"`
	Installed  bool      `json:"installed"`
	Status     Status    `json:"status"`
	ConfigPath string    `json:"configPath,omitempty"`
	BaseURL    string    `json:"baseUrl,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	Logo       string    `json:"logo"`
	Surfaces   []Surface `json:"surfaces,omitempty"`
}
type ApplyOptions struct {
	Port   int
	Models []string
	// nil means use Models; an explicitly empty list remains empty.
	CodeModels []string
	Restart    bool
}
type ApplyResult struct {
	Target    Target   `json:"target"`
	Restarted bool     `json:"restarted"`
	Written   []string `json:"written"`
}

// Options permits tests to avoid all real user paths and process operations.
// Explicit Home also disables ambient client/data path overrides unless supplied.
type Options struct {
	Home, DataDir, CodexHome, ClaudeConfigDir, GrokHome, Platform, Hostname string
	LookPath                                                                func(string) (string, error)
	Running                                                                 func(ClientID) bool
	Restart                                                                 func(context.Context, ClientID) error
	Now                                                                     func() time.Time
}
type Manager struct {
	opts Options
	mu   sync.Mutex
}

func New(opts Options) *Manager {
	explicitHome := opts.Home != ""
	if opts.Home == "" {
		opts.Home, _ = os.UserHomeDir()
	}
	if opts.DataDir == "" {
		if explicitHome {
			opts.DataDir = filepath.Join(opts.Home, ".local", "share", "jevonian")
		} else {
			opts.DataDir = paths.DataDir()
		}
	}
	if opts.CodexHome == "" {
		if !explicitHome {
			opts.CodexHome = os.Getenv("CODEX_HOME")
		}
		if opts.CodexHome == "" {
			opts.CodexHome = filepath.Join(opts.Home, ".codex")
		}
	}
	if opts.ClaudeConfigDir == "" {
		if !explicitHome {
			opts.ClaudeConfigDir = strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
		}
		if opts.ClaudeConfigDir == "" {
			opts.ClaudeConfigDir = filepath.Join(opts.Home, ".claude")
		}
	}
	if opts.GrokHome == "" {
		if !explicitHome {
			opts.GrokHome = os.Getenv("GROK_HOME")
		}
		if opts.GrokHome == "" {
			opts.GrokHome = filepath.Join(opts.Home, ".grok")
		}
	}
	if opts.Platform == "" {
		opts.Platform = runtime.GOOS
		if opts.Platform == "windows" {
			opts.Platform = "win32"
		}
	}
	if opts.Hostname == "" {
		opts.Hostname, _ = os.Hostname()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.LookPath == nil {
		opts.LookPath = exec.LookPath
	}
	return &Manager{opts: opts}
}
func validID(id ClientID) bool             { return id == ChatGPT || id == Claude || id == Grok }
func (m *Manager) StateDir() string        { return filepath.Join(m.opts.DataDir, "clients") }
func (m *Manager) CodexConfigPath() string { return filepath.Join(m.opts.CodexHome, "config.toml") }
func (m *Manager) GrokConfigPath() string  { return filepath.Join(m.opts.GrokHome, "config.toml") }
func (m *Manager) ClaudeCodeSettingsPath() string {
	return filepath.Join(m.opts.ClaudeConfigDir, "settings.json")
}
func CodexBaseURL(port int) string      { return fmt.Sprintf("http://127.0.0.1:%d/v1", port) }
func GrokBaseURL(port int) string       { return fmt.Sprintf("http://127.0.0.1:%d/v1", port) }
func ClaudeCodeBaseURL(port int) string { return sentinel.BaseURL(port) }
func ClaudeCodeEnv(port int, models []string, model string) map[string]string {
	return sentinel.Env(port, models, model)
}
func ClaudeCodeModelLabel(model string) string { return sentinel.ModelLabel(model) }
func ResolveClaudeCodeModels(models []string, override string) sentinel.ModelRouting {
	return sentinel.ResolveModels(models, override)
}
func ClaudeCodeEnvAssignments(port int, models []string, model string) []string {
	return sentinel.EnvAssignments(port, models, model)
}

func (m *Manager) Targets(port int) []Target {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.targets(port)
}
func (m *Manager) targets(port int) []Target {
	return []Target{m.chatGPTStatus(port), m.claudeStatus(port), m.grokStatus(port)}
}
func (m *Manager) Apply(id ClientID, opts ApplyOptions) (ApplyResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !validID(id) {
		return ApplyResult{}, fmt.Errorf("Unknown client.")
	}
	if len(opts.Models) == 0 {
		return ApplyResult{}, fmt.Errorf("Select at least one model before connecting %s.", map[ClientID]string{ChatGPT: "ChatGPT", Claude: "Claude", Grok: "Grok"}[id])
	}
	if id == ChatGPT {
		return m.applyChatGPT(opts)
	}
	if id == Grok {
		return m.applyGrok(opts)
	}
	return m.applyClaude(opts)
}
func (m *Manager) Restore(id ClientID) (Target, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !validID(id) {
		return Target{}, fmt.Errorf("Unknown client.")
	}
	if id == ChatGPT {
		return m.restoreChatGPT()
	}
	if id == Grok {
		return m.restoreGrok()
	}
	return m.restoreClaude()
}
func (m *Manager) ClientConfigExists(id ClientID) bool {
	if id == ChatGPT {
		return exists(m.CodexConfigPath())
	}
	if id == Grok {
		return exists(m.GrokConfigPath())
	}
	return m.desktopInstalled() || exists(m.ClaudeCodeSettingsPath())
}
func (m *Manager) FindClaudeCodePath() string {
	if p, err := m.opts.LookPath("claude"); err == nil && p != "" && exists(p) {
		return p
	}
	name := "claude"
	if m.opts.Platform == "win32" {
		name += ".exe"
	}
	for _, p := range []string{filepath.Join(m.opts.Home, ".local", "bin", name), filepath.Join(m.opts.Home, ".claude", "local", name)} {
		if exists(p) {
			return p
		}
	}
	return ""
}

// PrepareClaudeCodeLaunch does not mutate disk or run the binary. The caller owns
// stdio, process signals and exit-code forwarding, as in src/claude-code.ts.
func (m *Manager) PrepareClaudeCodeLaunch(port int, models []string, model string, args, baseEnv []string) (sentinel.LaunchSpec, error) {
	path := m.FindClaudeCodePath()
	if path == "" {
		return sentinel.LaunchSpec{}, fmt.Errorf("claude binary not found. Install Claude Code, then re-run `jevonian launch claude`.")
	}
	route := ResolveClaudeCodeModels(models, model)
	argv := []string{}
	if strings.TrimSpace(model) != "" || len(models) > 0 {
		argv = append(argv, "--model", route.Primary)
	}
	argv = append(argv, args...)
	env := []string{}
	managed := ClaudeCodeEnv(port, models, model)
	for _, kv := range baseEnv {
		key, _, _ := strings.Cut(kv, "=")
		if _, ok := managed[key]; !ok {
			env = append(env, kv)
		}
	}
	env = append(env, ClaudeCodeEnvAssignments(port, models, model)...)
	return sentinel.LaunchSpec{Path: path, Args: argv, Env: env}, nil
}
func (m *Manager) IsClientRunning(id ClientID) bool {
	if m.opts.Running != nil {
		return m.opts.Running(id)
	}
	if m.opts.Platform != "darwin" {
		return false
	}
	patterns := []string{"Claude.app/Contents/MacOS/Claude"}
	if id == ChatGPT {
		patterns = []string{"ChatGPT.app", "Codex.app"}
	}
	for _, p := range patterns {
		out, _ := exec.Command("pgrep", "-f", p).Output()
		if strings.TrimSpace(string(out)) != "" {
			return true
		}
	}
	return false
}
func (m *Manager) RestartClient(ctx context.Context, id ClientID) error {
	if m.opts.Restart != nil {
		return m.opts.Restart(ctx, id)
	}
	if m.opts.Platform != "darwin" {
		return nil
	}
	app, bundle := "Claude", "com.anthropic.claudefordesktop"
	if id == ChatGPT {
		app, bundle = "ChatGPT", "com.openai.codex"
	}
	if err := exec.CommandContext(ctx, "osascript", "-e", fmt.Sprintf("tell application %q to quit", app)).Run(); err != nil {
		_ = exec.CommandContext(ctx, "osascript", "-e", fmt.Sprintf("tell application id %q to quit", bundle)).Run()
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && m.IsClientRunning(id) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	if err := exec.CommandContext(ctx, "open", "-b", bundle).Run(); err != nil {
		_ = exec.CommandContext(ctx, "open", "-a", app).Run()
	}
	return ctx.Err()
}
