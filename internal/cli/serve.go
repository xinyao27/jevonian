package cli

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/xinyao27/jevonian/internal/brain"
	"github.com/xinyao27/jevonian/internal/catalogsync"
	"github.com/xinyao27/jevonian/internal/clients"
	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/guard"
	"github.com/xinyao27/jevonian/internal/keys"
	"github.com/xinyao27/jevonian/internal/ledger"
	"github.com/xinyao27/jevonian/internal/modelsync"
	"github.com/xinyao27/jevonian/internal/oauth"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/provider/cursor"
	"github.com/xinyao27/jevonian/internal/provider/multiacct"
	"github.com/xinyao27/jevonian/internal/proxy"
	"github.com/xinyao27/jevonian/internal/quota"
	"github.com/xinyao27/jevonian/internal/routing"
	"github.com/xinyao27/jevonian/internal/server"
	"github.com/xinyao27/jevonian/internal/server/admin"
	"github.com/xinyao27/jevonian/internal/service"
	"github.com/xinyao27/jevonian/internal/tunnel"
	"github.com/xinyao27/jevonian/internal/update"
	"github.com/xinyao27/jevonian/internal/upstream"
)

func runServe(args []string) int {
	stdout := styledWriter(os.Stdout)
	stderr := styledWriter(os.Stderr)
	cfg, cfgPath, err := config.Load()
	if err != nil {
		fmt.Fprintf(stderr, "config: %v\n", err)
		return 1
	}

	a, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := applyServeFlags(&cfg, a, cfgPath); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if a.has("lan") || a.has("no-lan") || a.has("lan-host") || a.has("lan-port") {
		commandContext{out: stdout, errOut: stderr}.printLanState(cfg)
	}
	if _, statErr := os.Stat(cfgPath); os.IsNotExist(statErr) {
		fmt.Fprintln(stdout, "No config yet — starting with defaults. Add a provider in the web UI:")
		fmt.Fprintf(stdout, "  http://%s:%d/providers\n", cfg.Listen.Host, cfg.Listen.Port)
	}
	// Machine-wide launchd PATH is /usr/bin:/bin:...; restore Homebrew / local bins so
	// tunnel providers (ngrok, cloudflared) resolve without a shell profile.
	tunnel.ApplyUserBinPath()
	addr := net.JoinHostPort(cfg.Listen.Host, strconv.Itoa(cfg.Listen.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if !service.ManagedByLaunchd() {
			fmt.Fprintf(stderr, "%s\n", portInUseMessage(cfg.Listen.Port, err))
		} else {
			fmt.Fprintf(stderr, "serve: cannot bind %s: %v\n", addr, err)
		}
		return 1
	}
	defer ln.Close()

	transport, sysProxy := proxy.UseSystemProxy()
	forceHTTP1(transport)
	client := &http.Client{Transport: transport, Timeout: 0}
	if sysProxy != nil {
		fmt.Fprintf(stderr, "jevonian (go): system proxy %s\n", sysProxy.URL)
	} else if proxy.HasProxyEnv(nil) {
		fmt.Fprintln(stderr, "jevonian (go): using HTTP(S)_PROXY from environment")
	}

	dbPath := paths.LedgerDBPath()
	db, err := ledger.Open(dbPath)
	if err != nil {
		fmt.Fprintf(stderr, "ledger: %v\n", err)
		return 1
	}
	if err := db.ExtendSchema(); err != nil {
		fmt.Fprintf(stderr, "ledger: extend schema: %v\n", err)
		return 1
	}
	defer db.Close()

	if n, err := db.Count(); err == nil && n == 0 {
		jsonl := paths.LedgerPath()
		if st, err := os.Stat(jsonl); err == nil && st.Size() > 0 {
			started := time.Now()
			imported, err := db.ImportJSONL(jsonl)
			if err != nil {
				fmt.Fprintf(stderr, "ledger: import %s: %v\n", jsonl, err)
			} else {
				fmt.Fprintf(stderr, "jevonian (go): imported %d ledger rows from %s in %s\n",
					imported, jsonl, time.Since(started).Round(time.Millisecond))
			}
		}
	}
	// Label rows written before exclusive_input existed, and correct Connect-RPC
	// rows the Go cutover mislabeled, so the dashboard divides cache coverage by
	// each serving wire's real denominator. Idempotent: only rows whose label
	// disagrees with the derived convention change.
	if updated, err := db.ReconcileExclusiveInput(upstream.GoEngineCutover, upstream.ConventionClassifierFor(&cfg)); err != nil {
		fmt.Fprintf(stderr, "ledger: reconcile cache convention: %v\n", err)
	} else if updated > 0 {
		fmt.Fprintf(stderr, "jevonian (go): labeled %d ledger rows with their cache convention\n", updated)
	}

	fmt.Fprintf(stderr, "jevonian (go): config %s (%d providers)\n", cfgPath, len(cfg.Providers))
	fmt.Fprintf(stderr, "jevonian (go): ledger %s\n", dbPath)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// stopServe cancels this ctx from inside the process (dashboard restart).
	ctx, stopServe := context.WithCancel(ctx)
	defer stopServe()
	// SIGINT is a deliberate stop, so the tunnel goes down with the server.
	// SIGTERM is how a supervisor (launchd, `tsx watch`) restarts the process:
	// the tunnel is left running and adopted by the next process with the same
	// URL. src/cli.ts SIGINT/SIGTERM handlers.
	intCh := make(chan os.Signal, 1)
	signal.Notify(intCh, os.Interrupt)
	defer signal.Stop(intCh)

	keyStore := keys.Open(paths.DataDir(), db)
	// Flush pending usage writes on shutdown; the batch writer does file IO off
	// the auth hot path, so a hard exit could lose the last minutes' tallies.
	defer keyStore.Close()

	tracker := quota.New(db)
	tracker.SetStatePath(paths.DataDir() + "/quota.json")

	g := guard.New(guard.OptionsFromEnv())

	// Session TTL mirrors src/cli.ts sessionTtlMinutes.
	sessionTTL := cfg.Routing.SessionTTLMinutes
	if sessionTTL <= 0 {
		sessionTTL = 30
	}
	store := routing.NewSessionStore(int64(sessionTTL) * 60_000)

	credentials := multiacct.DefaultStore()
	auth := &oauth.Resolver{HTTP: client, Credentials: credentials, CursorToken: cursor.Token}
	brainClient := &brain.Client{HTTP: client, Credentials: credentials.Get}
	logs, err := admin.OpenSQLiteLogs(dbPath)
	if err != nil {
		fmt.Fprintf(stderr, "admin ledger: %v\n", err)
		return 1
	}
	defer logs.Close()
	adminDeps := &admin.Deps{
		ConfigPath:  cfgPath,
		Ledger:      logs,
		Keys:        admin.OpenKeys(paths.DataDir(), keyStore),
		Credentials: credentials,
		OAuth:       auth,
		Brain:       brainClient,
		HTTP:        client,
		Prices:      PriceSource(),
		PricingInfo: PricingInfo,
	}

	liveQuotaService := quota.NewService(tracker, quota.LiveOptions{
		HTTP:              client,
		OAuth:             auth,
		BackgroundContext: ctx,
	})
	adminDeps.Quotas = liveQuotaService.Quotas
	adminDeps.ResetQuota = func(ctx context.Context, cfg *config.Config, provider string) error {
		found := false
		for _, item := range cfg.Providers {
			if item.Name == provider {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("provider %q not found", provider)
		}
		tracker.ResetProvider(provider)
		filtered := *cfg
		filtered.Providers = nil
		for _, item := range cfg.Providers {
			if item.Name == provider {
				filtered.Providers = append(filtered.Providers, item)
				break
			}
		}
		_, err := liveQuotaService.ProviderQuotas(ctx, &filtered, true)
		return err
	}

	catalogDeps := catalogsync.Deps{
		HTTP:           client,
		RefreshPricing: RefreshPricing,
		PricingStatus:  PricingInfo,
	}

	routingDeps := routing.Deps{
		Scorer:             brainClient,
		Guard:              g,
		Prices:             adminDeps.Prices,
		LeaderboardView:    catalogsync.LeaderboardView,
		Capabilities:       catalogsync.Capabilities(),
		Identity:           catalogsync.NewIdentity(),
		BrainBreakerOpen:   brainClient.BreakerOpen,
		RecordBrainOutcome: brainClient.RecordOutcome,
		RecordBrainCall:    server.BrainRecorder(db, adminDeps.Prices),
		CaptureUsageLimit: func(provider config.Provider, status int, errText string) {
			tracker.CaptureUsageLimit(provider.Name, status, errText)
		},
	}

	tunnelManager := tunnel.NewManager(cfg.Tunnel, cfg.Listen.Port, tunnel.Options{StatePath: paths.TunnelStatePath(), LogPath: paths.TunnelLogPath()})
	if !cfg.Tunnel.Enabled {
		// Reap a tunnel left running by an earlier serve when it is now disabled.
		tunnelManager.Cleanup()
	}
	adminDeps.Tunnel = tunnelManager
	var current atomic.Pointer[config.Config]
	current.Store(&cfg)

	deps := server.Deps{
		Config:  &cfg,
		Auth:    auth,
		Admin:   adminDeps,
		Ledger:  db,
		Client:  client,
		Quota:   tracker,
		Keys:    keyStore,
		Guard:   g,
		Store:   store,
		Routing: routingDeps,
		Brain:   brainClient,
	}

	modelSyncDeps := &modelsync.Deps{
		Config: current.Load,
		Discover: func(p config.Provider) modelsync.Discovered {
			e := DiscoverProvider(p)
			return modelsync.Discovered{Models: e.Models, Error: e.Error}
		},
		SaveConfig: func(c *config.Config) error {
			return saveConfig(*c)
		},
		Reload: func(c *config.Config) {
			if deps.OnReload != nil {
				deps.OnReload(c)
			}
		},
		Log: func(msg string) {
			fmt.Fprintf(stderr, "jevonian (go): %s\n", msg)
		},
	}
	modelSyncDeps.Start(ctx)

	updater := update.New(update.Options{
		Current:   Version,
		CachePath: paths.UpdateStatePath(),
		HTTP:      client,
	})
	clientManager := clients.New(clients.Options{})
	lifeAdapter := &serverLifecycle{}
	// relaunch is set by the dashboard "install and restart" path outside
	// launchd: instead of exiting into nothing, the process closes its
	// listeners and re-execs the freshly installed binary. src/cli.ts
	// state.restart.
	var relaunch atomic.Bool
	restartFn := func(ctx context.Context) error {
		if runtime.GOOS == "darwin" && service.ManagedByLaunchd() {
			_, err := (service.Manager{}).RestartOntoCurrent()
			return err
		}
		// Ask the serve loop to stop; it re-execs after the listeners close.
		relaunch.Store(true)
		stopServe()
		return nil
	}
	adminDeps.Extensions = admin.BuildExtensions(admin.ExtensionOptions{
		Config:      current.Load,
		Reload:      func(c *config.Config) { deps.OnReload(c) },
		Updater:     updater,
		Lifecycle:   lifeAdapter,
		Restart:     restartFn,
		Clients:     clientManager,
		ModelSync:   modelSyncDeps,
		CatalogDeps: catalogDeps,
	})

	exposure := server.NewExposure(ctx, deps, current.Load, server.ExposureOptions{OnError: func(err error) { fmt.Fprintf(stderr, "public listener: %v\n", err) }})
	defer exposure.Close()
	deps.OnReload = func(next *config.Config) {
		current.Store(next)
		if err := exposure.Reconcile(next); err != nil {
			fmt.Fprintf(stderr, "public listener: %v\n", err)
		}
	}
	srv := server.New(addr, deps)
	lifeAdapter.srv.Store(srv)

	// Hourly cache-aware update poll (registry hit at most every 24h); announce each new latest once.
	go func() {
		announced := ""
		check := func() {
			status := updater.Check(ctx, false)
			if status.UpdateAvailable && status.Latest != "" && status.Latest != announced {
				announced = status.Latest
				fmt.Fprint(stderr, update.FormatUpdateNotice(status, stderrIsTTY(stderr)))
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
		check()
		tick := time.NewTicker(time.Hour)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				check()
			}
		}
	}()
	// Boot-time live quota pull so the guard can route around a provider already at its limit.
	go func() {
		quotas, err := liveQuotaService.ProviderQuotas(ctx, &cfg, true)
		if err != nil {
			fmt.Fprintf(stdout, "quota refresh failed: %v\n", err)
			return
		}
		if spent := spentProviders(quotas); len(spent) > 0 {
			fmt.Fprintf(stdout, "quota: routing around %s (limit reached)\n", strings.Join(spent, ", "))
		}
	}()
	go func() {
		if pStale, bStale := catalogsync.NeedsRefresh(PricingInfo(), time.Now()); pStale || bStale {
			res := catalogDeps.Refresh(ctx, false)
			if cached, ok := res.Pricing["cached"].(bool); ok && !cached {
				fmt.Fprintf(stderr, "jevonian (go): refreshed pricing snapshot\n")
			}
			if cached, ok := res.Leaderboard["cached"].(bool); ok && !cached {
				fmt.Fprintf(stderr, "jevonian (go): refreshed leaderboard benchmarks\n")
			}
		}
	}()
	if err := exposure.Reconcile(&cfg); err != nil {
		fmt.Fprintf(stderr, "public listener: %v\n", err)
	}
	printServeBanner(stdout, cfg, addr)
	if cfg.Tunnel.Enabled {
		fmt.Fprintln(stdout, "tunnel: starting…")
		tunnelManager.Start(ctx)
		go announceTunnel(ctx, stdout, tunnelManager.Status, 500*time.Millisecond, 30*time.Second)
		go func() {
			select {
			case <-intCh:
				tunnelManager.Stop()
			case <-ctx.Done():
			}
		}()
	}
	for _, provider := range cfg.Providers {
		if keySource(provider) == "none" {
			fmt.Fprintf(stderr, "warning: provider %q has no API key. Run `jevonian add %s`.\n", provider.Name, provider.Name)
		}
	}
	if cfg.Lan.Enabled {
		urls := tunnel.LanBaseURLs(&cfg, tunnel.LanIPv4Addresses(nil))
		fmt.Fprintf(stdout, "lan: listening on %s:%d (only /v1, key required)\n", tunnel.LanBindHost(cfg.Lan), tunnel.LanPort(&cfg))
		if len(urls) == 0 {
			fmt.Fprintln(stdout, "lan: no non-loopback IPv4 address found; a peer cannot reach this machine yet.")
		}
		for _, url := range urls {
			fmt.Fprintf(stdout, "lan: provider base URL %s\n", url)
		}
	}
	openDashboard("http://"+net.JoinHostPort(probeHost(cfg.Listen.Host), strconv.Itoa(cfg.Listen.Port))+"/", a, stdout)
	if err := srv.Serve(ctx, ln); err != nil {
		fmt.Fprintf(stderr, "serve: %v\n", err)
		return 1
	}
	if relaunch.Load() {
		if err := relaunchSelf(stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "update installed, but Jevonian could not restart automatically: %v\n", err)
			return 1
		}
	}
	return 0
}

// relaunchSelf re-execs this binary with the same arguments so a freshly
// installed build takes over after a dashboard-triggered restart. The child is
// detached and told not to open a browser (the tab is already there), then this
// process exits. src/cli.ts state.restart.
func relaunchSelf(stdout, stderr io.Writer) error {
	// Keep the raw file descriptors for the child: passing a terminalWriter
	// wrapper would work too, but raw streams match the previous contract.
	if w, ok := stdout.(terminalWriter); ok {
		stdout = w.Writer
	}
	if w, ok := stderr.(terminalWriter); ok {
		stderr = w.Writer
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	child := exec.Command(exe, os.Args[1:]...)
	child.Env = append(os.Environ(), "JEVONIAN_NO_OPEN=1")
	child.Stdin = os.Stdin
	child.Stdout = stdout
	child.Stderr = stderr
	child.SysProcAttr = detachProcAttr()
	if err := child.Start(); err != nil {
		return err
	}
	return nil
}

// announceTunnel polls the tunnel until it is on, failed, or timed out and prints the TS
// `tunnel: <url>/v1 (<provider>)` / `tunnel: <error>` line.
func announceTunnel(ctx context.Context, out io.Writer, status func() tunnel.State, every, limit time.Duration) {
	started := time.Now()
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		st := status()
		if st.Status == tunnel.StatusOn && st.URL != "" {
			fmt.Fprintf(out, "tunnel: %s/v1 (%s)\n", st.URL, st.Provider)
			return
		}
		if st.Status == tunnel.StatusError || time.Since(started) > limit {
			msg := st.Error
			if msg == "" {
				msg = "timed out"
			}
			fmt.Fprintf(out, "tunnel: %s\n", msg)
			return
		}
	}
}

// spentProviders names providers with any quota window at 100% or more.
func spentProviders(quotas []quota.ProviderQuota) []string {
	var spent []string
	for _, item := range quotas {
		for _, w := range item.Windows {
			if w.UsedPercent >= 100 {
				spent = append(spent, item.Provider)
				break
			}
		}
	}
	return spent
}

func portInUseMessage(port int, cause error) string {
	return fmt.Sprintf(strings.Join([]string{
		"port %d is already in use (%v) — a Jevonian instance (or its service) is still",
		"running, and this foreground run will not take its place.",
		"  inspect it:  jevonian status",
		"  stop it:     jevonian stop   (or `jevonian stop --uninstall` to remove the service)",
	}, "\n"), port, cause)
}

// printServeBanner is the TS startup summary: listen URL, providers, routing mode, pricing source.
func printServeBanner(out io.Writer, cfg config.Config, addr string) {
	host := cfg.Listen.Host
	if host == "0.0.0.0" || host == "::" || host == "" {
		host = "127.0.0.1"
	}
	fmt.Fprintf(out, "jevonian listening on http://%s/\n", net.JoinHostPort(host, strconv.Itoa(cfg.Listen.Port)))
	names := make([]string, 0, len(cfg.Providers))
	for _, p := range cfg.Providers {
		names = append(names, p.Name)
	}
	list := strings.Join(names, ", ")
	if list == "" {
		list = "(none) — add one in the web UI"
	}
	fmt.Fprintf(out, "providers: %s\n", list)
	routingLine := "routing: " + string(cfg.Routing.Mode)
	if cfg.Routing.Mode == "auto" {
		models := []string{"jevonian/auto"}
		for _, r := range cfg.Routing.Routings {
			models = append(models, "jevonian/"+r.ID)
		}
		routingLine += " (models: " + strings.Join(models, ", ") + ")"
	}
	fmt.Fprintln(out, routingLine)
	for _, line := range scheduleLines(&cfg, time.Now()) {
		fmt.Fprintln(out, line)
	}
	info := loadPricing()
	fmt.Fprintf(out, "pricing: %s (%d models)\n", cliPricingSource(info), len(info.Models))
}

type serverLifecycle struct {
	srv atomic.Pointer[server.Server]
}

func (l *serverLifecycle) Draining() bool {
	if s := l.srv.Load(); s != nil {
		return s.Draining()
	}
	return false
}

func (l *serverLifecycle) ActiveRequests() int {
	if s := l.srv.Load(); s != nil {
		return s.ActiveRequests()
	}
	return 0
}

func (l *serverLifecycle) Resume() {
	if s := l.srv.Load(); s != nil {
		s.Resume()
	}
}

func (l *serverLifecycle) RestartAfterDrain(ctx context.Context, restart func(context.Context) error) error {
	if s := l.srv.Load(); s != nil {
		return s.RestartAfterDrain(ctx, restart)
	}
	if restart != nil {
		return restart(ctx)
	}
	return nil
}
