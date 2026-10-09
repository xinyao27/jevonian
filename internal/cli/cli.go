// Package cli implements the native Jevonian command line.
package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/service"
	"github.com/xinyao27/jevonian/internal/update"
)

// Version is overridden by release builds using -ldflags -X.
var Version = "0.7.2"

const helpText = `Jevonian — local AI router

Usage: jevonian [command] [flags]
  serve                       Start the router (default; macOS LaunchAgent)
  start | stop | restart       Control the macOS background service
  status                      Show service, LAN state, and recent logs
  init                        Write example config or add your first provider
  add <preset|custom>          Add/update a provider
  providers (or list)         List providers and credential sources
  remove <name> [--keep-key]   Remove a provider
  keys [list|create|update|remove]  Manage Jevonian API keys
  report                      Show recorded requests, spend, cache, and savings
  doctor [--network]          Diagnose config and optionally probe providers
  models [--refresh|--sync]   Show/discover models; append newly discovered ids
  pricing [--refresh]         Show/fetch models.dev pricing snapshot
  quota [--refresh]           Show quota windows, reset times, and rolling spend
  refresh                     Refresh catalog, pricing, and leaderboard snapshots
  update [--check]            Check for or install a new release
  launch claude [--model M] [--] [args...]  Launch Claude Code without disk edits
  version | help              Print version or this help

Serve flags: --foreground / --fg, --no-open, --lan / --no-lan,
  --lan-host HOST, --lan-port PORT, --tunnel / --no-tunnel
Service flags: stop --uninstall; JEVONIAN_SERVICE_TAKEOVER=1 allows takeover
Add flags: --key K, --env NAME, --models a,b, --base-url URL,
  --type openai|anthropic|responses|both|gemini|devin|cursor,
  --auth api-key|oauth, --oauth-source SOURCE, --billing api|subscription,
  --name NAME, --login-home DIR, --login-file PATH,
  --login-keychain SERVICE[:ACCOUNT], --login-label LABEL
Keys flags: create [NAME] --limit-usd N; update ID --name NAME --limit-usd N
`

type arguments struct {
	positionals []string
	flags       map[string]string
	passthrough []string
}

var booleanFlags = map[string]bool{"yes": true, "keep-key": true, "uninstall": true, "network": true, "refresh": true, "sync": true, "foreground": true, "fg": true, "no-open": true, "lan": true, "no-lan": true, "tunnel": true, "no-tunnel": true, "help": true, "json": true, "check": true, "no-config": true, "start": true, "stop": true, "status": true}

func parseArgs(args []string) (arguments, error) {
	a := arguments{flags: map[string]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			a.passthrough = append(a.passthrough, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "--") {
			a.positionals = append(a.positionals, arg)
			continue
		}
		key, value, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		if key == "" {
			return a, fmt.Errorf("empty flag")
		}
		if !inline && !booleanFlags[key] {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return a, fmt.Errorf("--%s requires a value", key)
			}
			i++
			value = args[i]
		}
		a.flags[key] = value
	}
	return a, nil
}
func (a arguments) has(k string) bool { _, ok := a.flags[k]; return ok }

// commands is the one dispatch table for plain `err`-returning commands; typo
// suggestions read the same keys, so the two cannot drift. serve, launch,
// version and help have special exit/flow handling in run.
var commands = map[string]func(c commandContext, a arguments) error{
	"start":     func(c commandContext, a arguments) error { return c.start(a, false) },
	"restart":   func(c commandContext, a arguments) error { return c.start(a, true) },
	"stop":      commandContext.stop,
	"status":    func(c commandContext, _ arguments) error { return c.status() },
	"providers": func(c commandContext, _ arguments) error { return c.providers() },
	"list":      func(c commandContext, _ arguments) error { return c.providers() },
	"remove":    commandContext.remove,
	"init":      commandContext.init,
	"add":       commandContext.add,
	"keys":      commandContext.keys,
	"report":    func(c commandContext, _ arguments) error { return c.report() },
	"doctor":    commandContext.doctor,
	"models":    commandContext.models,
	"pricing":   commandContext.pricing,
	"quota":     commandContext.quota,
	"update":    commandContext.update,
	"refresh":   commandContext.refresh,
}

// specialCommands are dispatched in run outside the table.
var specialCommands = []string{"serve", "launch", "version", "help"}

// nearestCommand returns the closest command to a typo within an edit distance
// of 2, so "docter" suggests `doctor` while "xyz" offers nothing.
func nearestCommand(typed string) string {
	names := append([]string(nil), specialCommands...)
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names) // deterministic tie-break
	best := ""
	bestDist := 3 // require < 3 to suggest
	for _, c := range names {
		if d := editDistance(typed, c); d < bestDist {
			best, bestDist = c, d
		}
	}
	return best
}

// editDistance is a small Levenshtein over runes.
func editDistance(a, b string) int {
	ar, br := []rune(a), []rune(b)
	prev := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		cur := make([]int, len(br)+1)
		cur[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(br)]
}

func Run(args []string) int { return run(args, os.Stdin, os.Stdout, os.Stderr) }
func run(args []string, in io.Reader, out, errOut io.Writer) int {
	out, errOut, term := newTermEnv(out, errOut)
	command := "serve"
	rest := args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		rest = args[1:]
	}
	if len(args) > 0 {
		switch args[0] {
		case "--version", "-V", "-v":
			command = "version"
			rest = nil
		case "--help", "-h":
			command = "help"
			rest = nil
		}
	}
	if command == "help" {
		fmt.Fprint(out, renderHelp(term.out, out))
		return 0
	}
	if command == "version" {
		fmt.Fprintln(out, renderVersion(term.out, out))
		return 0
	}
	a, err := parseArgs(rest)
	if err != nil {
		fmt.Fprintln(errOut, err)
		return 1
	}
	if a.has("help") {
		fmt.Fprint(out, renderHelp(term.out, out))
		return 0
	}
	c := commandContext{in: in, out: out, errOut: errOut, term: term}
	// Heal a broken LaunchAgent after Node→Go / npm wipe before any other work,
	// so short commands still bring the background service back.
	if runtime.GOOS == "darwin" && command != "stop" && command != "help" && command != "version" {
		if healed, healErr := (service.Manager{}).HealIfNeeded(); healErr != nil {
			fmt.Fprintf(errOut, "LaunchAgent heal failed: %v\n", healErr)
		} else if healed {
			fmt.Fprintln(errOut, "LaunchAgent was pointing at a missing or pre-cutover binary; rewritten onto this install.")
		}
	}
	foregroundServe := command == "serve" && !(runtime.GOOS == "darwin" && !foreground(a))
	if command != "update" && !foregroundServe {
		c.printCachedUpdateNotice()
		defer c.finishUpdateCheck()
	}
	if command == "serve" {
		if runtime.GOOS == "darwin" && !foreground(a) {
			// LAN settings are persistent: the background service runs bare `serve`, so
			// --lan-host / --lan-port must reach config.json before the service starts.
			if a.has("lan-host") || a.has("lan-port") {
				cfg, path, loadErr := config.Load()
				if loadErr == nil {
					loadErr = applyServeFlags(&cfg, a, path)
				}
				if loadErr != nil {
					fmt.Fprintln(errOut, loadErr)
					return 1
				}
				c.printLanState(cfg)
			}
			err = c.start(a, false)
		} else {
			return runServe(rest)
		}
	} else if command == "launch" {
		return c.launch(rest)
	} else if fn, ok := commands[command]; ok {
		err = fn(c, a)
	} else {
		fmt.Fprintf(errOut, "unknown command %q", command)
		if s := nearestCommand(command); s != "" {
			suggestion := "`jevonian " + s + "`"
			if term.err {
				suggestion = ansiStyles(errOut).accent.Render(suggestion)
			}
			fmt.Fprintf(errOut, ". Did you mean %s?", suggestion)
		}
		fmt.Fprintf(errOut, "\n\n%s", renderHelp(term.err, errOut))
		return 1
	}
	if err != nil {
		fmt.Fprintln(errOut, err)
		return 1
	}
	return 0
}

type commandContext struct {
	in          io.Reader
	out, errOut io.Writer
	term        termEnv
}

// renderHelp styles the static help text for terminals. Command names in the
// "Usage:" column get the accent; flag names get dim styling; the body is
// untouched so column alignment and wording stay identical.
func renderHelp(tty bool, w io.Writer) string {
	return styleHelpText(helpText, tty, w)
}

func renderVersion(tty bool, w io.Writer) string {
	if !tty {
		return "jevonian " + Version
	}
	pal := ansiStyles(w)
	return pal.emph.Render("jevonian") + " " + pal.accent.Render(Version)
}

// styleHelpText colors `jevonian`, command words in the usage column, and
// --flags inside an otherwise unchanged help block.
func styleHelpText(text string, tty bool, w io.Writer) string {
	if !tty {
		return text
	}
	pal := ansiStyles(w)
	lines := strings.Split(text, "\n")
	for i, ln := range lines {
		if strings.HasPrefix(ln, "Jevonian —") {
			lines[i] = pal.emph.Render("Jevonian") + strings.TrimPrefix(ln, "Jevonian")
			continue
		}
		if strings.HasPrefix(ln, "Usage:") {
			lines[i] = pal.accent.Render("Usage:") + strings.TrimPrefix(ln, "Usage:")
			continue
		}
		// Accent the leading command word in the usage column, dim the rest.
		trimmed := strings.TrimLeft(ln, " ")
		indent := ln[:len(ln)-len(trimmed)]
		if trimmed == "" || strings.HasPrefix(trimmed, "Usage:") || strings.HasPrefix(trimmed, "Serve flags") || strings.HasPrefix(trimmed, "Service flags") || strings.HasPrefix(trimmed, "Add flags") || strings.HasPrefix(trimmed, "Keys flags") {
			if strings.HasPrefix(trimmed, "Serve flags") || strings.HasPrefix(trimmed, "Service flags") || strings.HasPrefix(trimmed, "Add flags") || strings.HasPrefix(trimmed, "Keys flags") {
				colon := strings.IndexByte(trimmed, ':')
				if colon >= 0 {
					lines[i] = indent + pal.accent.Render(trimmed[:colon+1]) + trimmed[colon+1:]
				}
			}
			continue
		}
		if word, rest, ok := splitUsageLine(trimmed); ok {
			lines[i] = indent + pal.accent.Render(word) + rest
		}
	}
	return strings.Join(lines, "\n")
}

// splitUsageLine splits a usage-column line into its command word and the
// remainder, or reports false when the line is a flags/section line.
func splitUsageLine(ln string) (string, string, bool) {
	fields := strings.Fields(ln)
	if len(fields) < 2 {
		return "", "", false
	}
	first := fields[0]
	if strings.HasPrefix(first, "--") || strings.HasSuffix(first, ":") {
		return "", "", false
	}
	return first, strings.TrimPrefix(ln, first), true
}

func (c commandContext) printCachedUpdateNotice() {
	m := update.New(update.Options{Current: Version, CachePath: paths.UpdateStatePath()})
	st := m.Status()
	if st.UpdateAvailable {
		fmt.Fprint(c.errOut, update.FormatUpdateNotice(st, stderrIsTTY(c.errOut)))
	}
}

// finishUpdateCheck gives a due registry check a short window to refresh the
// cached notice for the next short command (TS notifyCachedUpdate's background
// check). Cached/fresh and source/unknown installs return immediately.
func (c commandContext) finishUpdateCheck() {
	m := update.New(update.Options{Current: Version, CachePath: paths.UpdateStatePath(), HTTP: cliHTTP()})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	m.Check(ctx, false)
}

// runningServeVersion asks the serve process on the configured port which build it runs,
// so `update` can tell a stale LaunchAgent from a new binary on disk.
func runningServeVersion(ctx context.Context) string {
	cfg, _, err := config.Load()
	if err != nil {
		return ""
	}
	host := probeHost(cfg.Listen.Host)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, fmt.Sprint(cfg.Listen.Port))+"/api/update", nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var body struct {
		Update struct {
			Current string `json:"current"`
		} `json:"update"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body) != nil {
		return ""
	}
	return body.Update.Current
}

func (c commandContext) update(a arguments) error {
	client := cliHTTP()
	m := update.New(update.Options{
		Current:   Version,
		CachePath: paths.UpdateStatePath(),
		HTTP:      client,
	})
	return m.Command(context.Background(), c.out, c.errOut, update.CommandOptions{
		CheckOnly:      a.has("check"),
		Colors:         stderrIsTTY(c.errOut),
		RunningVersion: runningServeVersion,
		RestartBackground: func(ctx context.Context) bool {
			if runtime.GOOS != "darwin" || service.ManagedByLaunchd() {
				return false
			}
			m := service.Manager{}
			if !m.Status().PlistInstalled {
				return false
			}
			// RestartOntoCurrent rewrites a stale Node cli.mjs LaunchAgent after
			// cutover/update; bare Restart would leave the service broken.
			_, err := m.RestartOntoCurrent()
			return err == nil
		},
	})
}

func (c commandContext) refresh(a arguments) error {
	fmt.Fprintln(c.out, "refreshing catalog (models.dev pricing + benchmarks)…")
	c.printCatalogRefresh(c.catalogDeps().Refresh(context.Background(), true), false)
	return nil
}

func foreground(a arguments) bool {
	return os.Getenv("XPC_SERVICE_NAME") == "ai.jevonian.serve" || a.has("foreground") || a.has("fg") || a.has("tunnel") || a.has("no-tunnel") || a.has("lan") || a.has("no-lan")
}

// stderrIsTTY mirrors TS `process.stderr.isTTY`: colors only on a real terminal.
func stderrIsTTY(w io.Writer) bool {
	return isColorTTY(rawWriter(w))
}
