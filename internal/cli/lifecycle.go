package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/xinyao27/jevonian/internal/clients"
	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/oauth/sentinel"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/routing"
	"github.com/xinyao27/jevonian/internal/service"
	"github.com/xinyao27/jevonian/internal/tunnel"
)

func probeHost(host string) string {
	switch strings.TrimSpace(host) {
	case "0.0.0.0", "::", "*", "":
		return "127.0.0.1"
	}
	return host
}
func waitPort(cfg config.Config, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(probeHost(cfg.Listen.Host), fmt.Sprint(cfg.Listen.Port)), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}
func openDashboard(url string, a arguments, out io.Writer) {
	if a.has("no-open") || os.Getenv("JEVONIAN_NO_OPEN") != "" {
		return
	}
	// Under `pnpm dev` (JEVONIAN_WEB_DEV) `tsx watch` restarts the process on
	// every edit; reuse the tab instead of stacking a new one each restart.
	// src/cli.ts openBrowser + src/browser.ts openBrowserOnce.
	if os.Getenv("JEVONIAN_WEB_DEV") != "" {
		if alreadyOpened(paths.BrowserStatePath()) {
			fmt.Fprintf(out, "dashboard already open at %s — reusing the tab\n", url)
			return
		}
	}
	if launchBrowser(url) {
		if os.Getenv("JEVONIAN_WEB_DEV") != "" {
			writeBrowserState(paths.BrowserStatePath())
		}
	}
}

// alreadyOpened reports whether this dev session already launched the
// dashboard, so a watcher restart reuses the tab. src/browser.ts
// shouldSkipBrowserOpen.
func alreadyOpened(statePath string) bool {
	data, err := os.ReadFile(statePath)
	if err != nil {
		return false
	}
	var record struct {
		OpenedAt *float64 `json:"openedAt"`
	}
	if err := json.Unmarshal(data, &record); err != nil {
		return false
	}
	return record.OpenedAt != nil
}

// writeBrowserState records the launch; a parse failure later simply opens a
// fresh tab. src/browser.ts writeState.
func writeBrowserState(statePath string) {
	payload := map[string]any{
		"pid":      os.Getpid(),
		"openedAt": time.Now().UnixMilli(),
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(statePath), 0o755)
	_ = os.WriteFile(statePath, append(data, '\n'), 0o600)
}

// launchBrowser opens url with the platform's default handler.
func launchBrowser(url string) bool {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if cmd.Start() == nil {
		go cmd.Wait()
		return true
	}
	return false
}
func (c commandContext) start(a arguments, restart bool) error {
	m := service.Manager{}
	if err := m.AssertLive(); err != nil {
		return err
	}
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	var s service.Status
	action := "restarted"
	restarted := false
	if restart && m.Status().PlistInstalled {
		s, err = m.RestartOntoCurrent()
		restarted = true
	} else {
		var result service.Result
		result, err = m.Ensure()
		s = result.Status
		action = result.Action
	}
	if err != nil {
		return err
	}
	if !waitPort(cfg, 15*time.Second) {
		return fmt.Errorf("LaunchAgent %s, but http://%s:%d/ did not answer within 15s. Check %s or run --foreground", action, probeHost(cfg.Listen.Host), cfg.Listen.Port, s.LogPath)
	}
	url := "http://" + net.JoinHostPort(probeHost(cfg.Listen.Host), fmt.Sprint(cfg.Listen.Port)) + "/"
	if restarted {
		fmt.Fprintln(c.out, "Jevonian service restarted.")
		return c.status()
	}
	switch action {
	case "installed":
		fmt.Fprintln(c.out, "Jevonian is now running in the background.")
	case "updated":
		fmt.Fprintln(c.out, "Jevonian service updated and restarted.")
	case "started":
		fmt.Fprintln(c.out, "Jevonian service started.")
	default:
		fmt.Fprintln(c.out, "Jevonian is already running in the background.")
	}
	fmt.Fprintf(c.out, "dashboard: %s\n", url)
	if s.PID > 0 {
		fmt.Fprintf(c.out, "pid:       %d\n", s.PID)
	}
	fmt.Fprintf(c.out, "log:       %s\nstop:      jevonian stop\nstatus:    jevonian status\nforeground: jevonian --foreground\n", s.LogPath)
	openDashboard(url, a, c.out)
	return nil
}

// printLanState reports a persisted LAN change (TS `lan: enabled on host:port`).
func (c commandContext) printLanState(cfg config.Config) {
	if cfg.Lan.Enabled {
		fmt.Fprintf(c.out, "lan: enabled on %s:%d\n", tunnel.LanBindHost(cfg.Lan), tunnel.LanPort(&cfg))
	} else {
		fmt.Fprintln(c.out, "lan: disabled")
	}
}
func (c commandContext) stop(a arguments) error {
	_, err := (service.Manager{}).Stop(a.has("uninstall"))
	if err != nil {
		return err
	}
	if a.has("uninstall") {
		fmt.Fprintln(c.out, "stopped and uninstalled the LaunchAgent")
	} else {
		fmt.Fprintln(c.out, "stopped")
	}
	if a.has("uninstall") {
		fmt.Fprintln(c.out, "start again: jevonian start")
		return nil
	}
	fmt.Fprintln(c.out, "start again: jevonian start  (or bare `jevonian` / `jevonian serve`)")
	return c.status()
}
func (c commandContext) status() error {
	m := service.Manager{}
	s := m.Status()
	fmt.Fprintf(c.out, "label:   %s\nplist:   %s", s.Label, s.PlistPath)
	if !s.PlistInstalled {
		fmt.Fprint(c.out, " (missing)")
	}
	loaded := "no"
	if s.Loaded {
		loaded = "yes"
	}
	fmt.Fprintf(c.out, "\nloaded:  %s\n", loaded)
	if s.PID > 0 {
		fmt.Fprintf(c.out, "pid:     %d\n", s.PID)
	}
	fmt.Fprintf(c.out, "log:     %s\n", s.LogPath)
	if entry := m.InspectEntry(); entry.Path != "" {
		fmt.Fprintf(c.out, "binary:  %s\n", entry.Path)
		if entry.Missing {
			fmt.Fprintln(c.out, "warning: LaunchAgent ProgramArguments path is missing — run `jevonian restart` to repoint onto this install")
		}
	} else if s.PlistInstalled && entry.Err != nil {
		fmt.Fprintf(c.out, "warning: cannot read LaunchAgent ProgramArguments: %v\n", entry.Err)
	}
	if s.Loaded && s.PID == 0 {
		fmt.Fprintln(c.out, "warning: LaunchAgent is loaded but has no pid — check the log or run `jevonian restart`")
	}
	if s.Detail != "loaded" && s.Detail != "" {
		fmt.Fprintf(c.out, "detail:  %s\n", s.Detail)
	}
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.Lan.Enabled {
		fmt.Fprintf(c.out, "lan:     %s:%d — %s\n", tunnel.LanBindHost(cfg.Lan), tunnel.LanPort(&cfg), strings.Join(tunnel.LanBaseURLs(&cfg, tunnel.LanIPv4Addresses(nil)), ", "))
	} else {
		fmt.Fprintln(c.out, "lan:     off")
	}
	if tail := service.ReadLogTail(12); tail != "" {
		fmt.Fprintln(c.out, "\nrecent log:\n"+tail)
	}
	return nil
}
func (c commandContext) launch(args []string) int {
	fail := func(err error) int { fmt.Fprintln(c.errOut, err); return 1 }
	if len(args) == 0 {
		return fail(fmt.Errorf("Usage: jevonian launch <claude|grok> [--model M] [--] [args...]"))
	}
	targetClient := strings.ToLower(args[0])
	if targetClient == "claude" || targetClient == "claude-code" {
		return c.launchClaude(args[1:])
	}
	if targetClient == "grok" || targetClient == "grok-cli" {
		return c.launchGrok(args[1:])
	}
	return fail(fmt.Errorf("Usage: jevonian launch <claude|grok> [--model M] [--] [args...]"))
}

func (c commandContext) launchClaude(args []string) int {
	fail := func(err error) int { fmt.Fprintln(c.errOut, err); return 1 }
	a, err := parseArgs(args)
	if err != nil {
		return fail(err)
	}
	if _, err := os.Stat(paths.ConfigPath()); err != nil {
		return fail(fmt.Errorf("No config at %s. Run `jevonian init` or `jevonian serve` first", paths.ConfigPath()))
	}
	cfg, _, err := config.Load()
	if err != nil {
		return fail(err)
	}
	models := routing.ClaudeCodeModels(&cfg)
	if len(models) == 0 {
		return fail(fmt.Errorf("configure at least one routed model before launching Claude Code"))
	}
	extra := append(a.positionals, a.passthrough...)
	spec, err := sentinel.PrepareLaunch(cfg.Listen.Port, models, a.flags["model"], extra, os.Environ(), nil)
	if err != nil {
		return fail(err)
	}
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Env = spec.Env
	cmd.Stdin = c.in
	cmd.Stdout = rawWriter(c.out)
	cmd.Stderr = rawWriter(c.errOut)
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code := exit.ExitCode()
			if code < 0 {
				return 1
			}
			return code
		}
		return fail(err)
	}
	return 0
}

func (c commandContext) launchGrok(args []string) int {
	fail := func(err error) int { fmt.Fprintln(c.errOut, err); return 1 }
	a, err := parseArgs(args)
	if err != nil {
		return fail(err)
	}
	if _, err := os.Stat(paths.ConfigPath()); err != nil {
		return fail(fmt.Errorf("No config at %s. Run `jevonian init` or `jevonian serve` first", paths.ConfigPath()))
	}
	cfg, _, err := config.Load()
	if err != nil {
		return fail(err)
	}
	mgr := clients.New(clients.Options{})
	grokBin := mgr.FindGrokPath()
	if grokBin == "" {
		return fail(fmt.Errorf("grok binary not found. Install Grok CLI, then re-run `jevonian launch grok`."))
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%d/v1", cfg.Listen.Port)
	model := a.flags["model"]
	if model == "" {
		if cfg.Routing.BaselineModel != "" {
			model = cfg.Routing.BaselineModel
		} else {
			model = "jevonian/auto"
		}
	}

	argv := []string{"-u", baseURL, "-m", model}
	argv = append(argv, a.positionals...)
	argv = append(argv, a.passthrough...)

	env := os.Environ()
	env = append(env,
		fmt.Sprintf("GROK_MODELS_BASE_URL=%s", baseURL),
		fmt.Sprintf("GROK_XAI_API_BASE_URL=%s", baseURL),
	)

	cmd := exec.Command(grokBin, argv...)
	cmd.Env = env
	cmd.Stdin = c.in
	cmd.Stdout = rawWriter(c.out)
	cmd.Stderr = rawWriter(c.errOut)
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code := exit.ExitCode()
			if code < 0 {
				return 1
			}
			return code
		}
		return fail(err)
	}
	return 0
}
