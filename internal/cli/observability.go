package cli

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/xinyao27/jevonian/internal/brain"
	"github.com/xinyao27/jevonian/internal/catalogsync"
	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/ledger"
	"github.com/xinyao27/jevonian/internal/oauth"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/provider/cursor"
	"github.com/xinyao27/jevonian/internal/provider/multiacct"
	"github.com/xinyao27/jevonian/internal/quota"
	"github.com/xinyao27/jevonian/internal/routing"
	"github.com/xinyao27/jevonian/internal/service"
	"github.com/xinyao27/jevonian/internal/upstream"
)

// printServiceDoctor reports LaunchAgent health on macOS (stale Node entry after
// the Go cutover, loaded-but-dead jobs).
func (c commandContext) printServiceDoctor() {
	if runtime.GOOS != "darwin" {
		return
	}
	m := service.Manager{}
	s := m.Status()
	fmt.Fprintf(c.out, "service: %s", s.Label)
	switch {
	case !s.PlistInstalled:
		fmt.Fprintln(c.out, " — not installed (foreground only, or run bare `jevonian`)")
		return
	case s.Loaded && s.PID > 0:
		fmt.Fprintf(c.out, " — running pid %d\n", s.PID)
	case s.Loaded:
		fmt.Fprintln(c.out, " — loaded but no pid (check serve.log or `jevonian restart`)")
	default:
		fmt.Fprintln(c.out, " — installed but not loaded (`jevonian start`)")
	}
	if entry := m.InspectEntry(); entry.Path != "" {
		fmt.Fprintf(c.out, "         binary %s\n", entry.Path)
		if entry.Missing {
			fmt.Fprintln(c.out, "         warning: ProgramArguments path is missing — run `jevonian restart`")
		}
	}
}

// openLedger preserves the Go runtime's idempotent JSONL import-on-first-use.
func openLedger() (*ledger.DB, error) {
	db, err := ledger.Open(paths.LedgerDBPath())
	if err != nil {
		return nil, err
	}
	if err := db.ExtendSchema(); err != nil {
		db.Close()
		return nil, err
	}
	n, err := db.Count()
	if err != nil {
		db.Close()
		return nil, err
	}
	if n == 0 {
		if st, err := os.Stat(paths.LedgerPath()); err == nil && st.Size() > 0 {
			if _, err := db.ImportJSONL(paths.LedgerPath()); err != nil {
				db.Close()
				return nil, err
			}
		}
	}
	backfillConventions(db)
	return db, nil
}

// reconcileConventions labels rows written before exclusive_input existed, and
// corrects Connect-RPC rows the Go cutover mislabeled, so the dashboard divides
// cache coverage by each wire's real denominator. The call is idempotent: only
// rows whose stored label disagrees with the derived convention change. A
// failure is not fatal — the UI keeps the historical reading.
func backfillConventions(db *ledger.DB) {
	cfg, _, err := config.Load()
	if err != nil {
		return
	}
	updated, err := db.ReconcileExclusiveInput(upstream.GoEngineCutover, upstream.ConventionClassifierFor(&cfg))
	if err != nil || updated == 0 {
		return
	}
	fmt.Fprintf(os.Stderr, "jevonian (go): reconciled %d ledger rows with their cache convention\n", updated)
}

type reportRow struct {
	requests, prompt, output, cache, saved, unpriced int
	cost                                             float64
}

func (c commandContext) report() error {
	db, err := openLedger()
	if err != nil {
		return err
	}
	defer db.Close()
	reader, err := sql.Open("sqlite", paths.LedgerDBPath())
	if err != nil {
		return err
	}
	defer reader.Close()
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	prices := loadPricing()
	baseline := cfg.Routing.BaselineModel
	if baseline == "" {
		tiers := routing.DeriveTiers(&cfg, pricingDeps())
		if len(tiers.Plan) > 0 {
			baseline = tiers.Plan[0]
		}
	}
	if baseline == "" {
		models, queryErr := reader.Query(`SELECT DISTINCT model FROM records`)
		if queryErr != nil {
			return queryErr
		}
		maxOutput := -1.0
		for models.Next() {
			var model string
			if err := models.Scan(&model); err != nil {
				models.Close()
				return err
			}
			if price := priceFor(prices, model, ""); price != nil && price.Output > maxOutput {
				baseline = model
				maxOutput = price.Output
			}
		}
		if err := models.Err(); err != nil {
			models.Close()
			return err
		}
		models.Close()
	}
	rows, err := reader.Query(`SELECT model,canonical,session,prompt_tokens,completion_tokens,cache_read_tokens,cache_write_tokens,cost_usd,COALESCE(saved_tokens,0),brain,phase,effort,ts FROM records ORDER BY ts_ms`)
	if err != nil {
		return err
	}
	defer rows.Close()
	byModel := map[string]*reportRow{}
	byPhase := map[string]*reportRow{}
	byEffort := map[string]*reportRow{}
	sessions := map[string]bool{}
	total := reportRow{}
	brainDecided := 0
	baselineCost := 0.0
	baselinePrice := priceFor(prices, baseline, "")
	for rows.Next() {
		var model, canonical, session, brain, phase, effort, ts string
		var prompt, output, cache, write, saved int
		var cost sql.NullFloat64
		if err := rows.Scan(&model, &canonical, &session, &prompt, &output, &cache, &write, &cost, &saved, &brain, &phase, &effort, &ts); err != nil {
			return err
		}
		key := routing.CanonicalModelID(model)
		if canonical != "" {
			key = routing.CanonicalModelID(canonical)
		}
		if key == "" {
			key = "unknown"
		}
		if phase == "" {
			phase = "-"
		}
		if effort == "" {
			effort = "default"
		}
		sessions[session] = true
		if brain != "" {
			brainDecided++
		}
		for _, group := range []struct {
			table map[string]*reportRow
			key   string
		}{{byModel, key}, {byPhase, phase}, {byEffort, effort}} {
			r := group.table[group.key]
			if r == nil {
				r = &reportRow{}
				group.table[group.key] = r
			}
			r.requests++
			r.prompt += prompt
			r.output += output
			r.cache += cache
			r.saved += saved
			if cost.Valid {
				r.cost += cost.Float64
			} else {
				r.unpriced++
			}
		}
		total.requests++
		total.prompt += prompt
		total.output += output
		total.cache += cache
		total.saved += saved
		if cost.Valid {
			total.cost += cost.Float64
		} else {
			total.unpriced++
		}
		if baselinePrice != nil {
			at, _ := time.Parse(time.RFC3339Nano, ts)
			value, _ := routing.CostOf(routePrice(baselinePrice), routing.Usage{Input: prompt, Output: output, CacheRead: cache, CacheWrite: write}, at)
			baselineCost += value
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if total.requests == 0 {
		fmt.Fprintln(c.out, "No requests recorded yet.")
		return nil
	}
	fmt.Fprint(c.out, c.styleValue(fmt.Sprintf("%-24s %6s %10s %10s %12s %10s %10s\n", "model", "reqs", "prompt", "output", "cache read", "saved", "cost")))
	sorted := func(table map[string]*reportRow) []string {
		var keys []string
		for key := range table {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool {
			if table[keys[i]].cost == table[keys[j]].cost {
				return keys[i] < keys[j]
			}
			return table[keys[i]].cost > table[keys[j]].cost
		})
		return keys
	}
	for _, key := range sorted(byModel) {
		r := byModel[key]
		note := ""
		if r.unpriced > 0 {
			note = fmt.Sprintf(" (+%d unpriced)", r.unpriced)
		}
		saved := "0"
		if r.saved > 0 {
			saved = fmt.Sprintf("~%d", r.saved)
		}
		fmt.Fprintf(c.out, "%s %6d %10d %10d %12d %10s %10s\n", c.styleValue(fmt.Sprintf("%-24s", key)), r.requests, r.prompt, r.output, r.cache, saved, fmt.Sprintf("$%.4f", r.cost)+note)
	}
	hit := 0.0
	if total.cache+total.prompt > 0 {
		hit = float64(total.cache) / float64(total.cache+total.prompt) * 100
	}
	fmt.Fprintf(c.out, "\n%s requests, %s sessions\n%s %.1f%% (%d cached tokens)\n", c.styleValue(fmt.Sprint(total.requests)), c.styleValue(fmt.Sprint(len(sessions))), c.styleValue("cache hits:"), hit, total.cache)
	if total.saved > 0 {
		percent := ""
		if total.prompt > 0 {
			percent = fmt.Sprintf(" (%.1f%% of input)", float64(total.saved)/float64(total.prompt+total.saved)*100)
		}
		fmt.Fprintf(c.out, "token saver: ~%s tokens kept out of prompts%s\n", groupThousands(total.saved), percent)
	}
	fmt.Fprintf(c.out, "%s %d\n", c.styleValue("brain-decided:"), brainDecided)
	for _, section := range []struct {
		name  string
		table map[string]*reportRow
	}{{"phase", byPhase}, {"thinking effort", byEffort}} {
		fmt.Fprintf(c.out, "\n%s\n", c.styleValue("by "+section.name+":"))
		for _, key := range sorted(section.table) {
			r := section.table[key]
			fmt.Fprintf(c.out, "%s %6d reqs %12s\n", c.styleValue(fmt.Sprintf("%-12s", key)), r.requests, fmt.Sprintf("$%.4f", r.cost))
		}
	}
	fmt.Fprintf(c.out, "\nactual:   $%.4f\n", total.cost)
	if baselinePrice != nil {
		saved := baselineCost - total.cost
		percent := 0.0
		if baselineCost > 0 {
			percent = saved / baselineCost * 100
		}
		fmt.Fprintf(c.out, "baseline: $%.4f (%s for everything)\nsavings:  $%.4f (%.1f%%)\n", baselineCost, c.styleValue(baseline), saved, percent)
	} else if baseline != "" {
		fmt.Fprintf(c.out, "baseline: %s (unpriced; savings unavailable)\n", c.styleValue(baseline))
	}
	return nil
}
func groupThousands(n int) string {
	digits := fmt.Sprint(n)
	var out []byte
	for i := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, digits[i])
	}
	return string(out)
}
func (c commandContext) doctor(a arguments) error {
	fmt.Fprintf(c.out, "config:  %s\n", paths.ConfigPath())
	if _, err := os.Stat(paths.ConfigPath()); os.IsNotExist(err) {
		fmt.Fprintln(c.out, "         missing — run `jevonian init` or configure in the web UI")
		return nil
	}
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	c.printServiceDoctor()
	db, err := openLedger()
	if err != nil {
		return err
	}
	defer db.Close()
	n, err := db.Count()
	if err != nil {
		return err
	}
	s := loadPricing()
	hint := ""
	if cliPricingSource(s) == "bundled-fallback" {
		hint = " — run `jevonian pricing --refresh`"
	}
	fmt.Fprintf(c.out, "data:    %s\nledger:  %s (%d records)\ncatalog: %s (%d providers cached)\npricing: %s (%d models)%s\n\n", paths.DataDir(), paths.LedgerDBPath(), n, catalogPath(), len(loadCatalog()), cliPricingSource(s), len(s.Models), hint)
	for _, p := range cfg.Providers {
		source := keySource(p)
		if source == "none" && p.APIKeyEnv != "" {
			source = "missing (" + p.APIKeyEnv + ")"
		}
		fmt.Fprintf(c.out, "%s: %s %s auth=%s", c.styleValue(p.Name), p.Type, p.BaseURL, p.Auth)
		if p.OAuthSource != "" {
			fmt.Fprintf(c.out, ":%s", p.OAuthSource)
		}
		fmt.Fprintf(c.out, " billing=%s credential=%s models=%d\n", p.Billing, source, len(p.Models))
	}
	// Show what routing uses right now: with a schedule, the active window's models.
	routings := routing.EffectiveRoutings(&cfg, pricingDeps())
	fmt.Fprintf(c.out, "\nrouting: %s\n", c.styleValue(cfg.Routing.Mode))
	for _, line := range scheduleLines(&cfg, time.Now()) {
		fmt.Fprintf(c.out, "  %s\n", line)
	}
	for _, r := range routings {
		models := strings.Join(r.Models, ", ")
		if models == "" {
			models = "(none)"
		}
		fmt.Fprintf(c.out, "  %s: %s — %s\n", c.styleValue(r.ID), models, r.Description)
	}
	baseline := cfg.Routing.BaselineModel
	if baseline == "" {
		baseline = "(none)"
		for _, r := range routings {
			if r.ID == "plan" && len(r.Models) > 0 {
				baseline = r.Models[0]
			}
		}
	}
	fmt.Fprintf(c.out, "  %s %s\n", c.styleValue("baseline:"), c.styleValue(baseline))
	if len(cfg.Routing.Brains) == 0 {
		fmt.Fprintf(c.out, "  %s  (none) — jevonian/auto is disabled until one is configured\n", c.styleValue("brains:"))
	} else {
		fmt.Fprintf(c.out, "  %s  %d configured (tried in order)\n", c.styleValue("brains:"), len(cfg.Routing.Brains))
		for i, b := range cfg.Routing.Brains {
			key := "none"
			env := b.APIKeyEnv
			if channel := brain.FindChannel(b.Channel); env == "" && channel != nil {
				env = channel.APIKeyEnv
			}
			if multiacct.DefaultStore().Get("brain:"+b.Channel) != "" {
				key = "credentials"
			} else if env != "" && os.Getenv(env) != "" {
				key = "env:" + env
			}
			label := b.Channel
			if channel := brain.FindChannel(b.Channel); channel != nil {
				label = channel.Label
			}
			model := ""
			if b.Model != "" {
				model = " · " + c.styleValue(b.Model)
			}
			fmt.Fprintf(c.out, "    %d. %s%s · key=%s\n", i+1, c.styleValue(label), model, key)
		}
	}
	for _, r := range routings {
		for _, model := range r.Models {
			variants := routing.CanonicalVariants(&cfg, model, "", nil)
			if len(variants) == 0 {
				fmt.Fprintf(c.out, "  %s %s has no configured provider\n", c.styleValue("warning:"), c.styleValue(model))
			}
		}
	}
	printIdentityGaps(c, &cfg, routings)
	if a.has("network") {
		fmt.Fprintln(c.out, "\nprobing providers...")
		entries, err := c.refreshModels(cfg)
		if err != nil {
			return err
		}
		failed := false
		for _, e := range entries {
			if e.Error != "" {
				failed = true
				fmt.Fprintf(c.out, "  %s: %s %s\n", c.styleValue(e.Provider), c.styleValue("error:"), e.Error)
			} else {
				fmt.Fprintf(c.out, "  %s: %d models\n", c.styleValue(e.Provider), len(e.Models))
			}
		}
		fmt.Fprintln(c.out)
		tracker := quota.New(nil)
		client := cliHTTP()
		auth := &oauth.Resolver{HTTP: client, Credentials: multiacct.DefaultStore(), CursorToken: cursor.Token}
		svc := quota.NewService(tracker, quota.LiveOptions{HTTP: client, OAuth: auth})
		quotas, qerr := svc.ProviderQuotas(context.Background(), &cfg, true)
		if qerr != nil {
			fmt.Fprintf(c.out, "  %s %v\n", c.styleValue("quota probe failed:"), qerr)
		}
		for _, item := range quotas {
			var windows []string
			for _, w := range item.Windows {
				windows = append(windows, fmt.Sprintf("%s %.0f%%", w.Label, w.UsedPercent))
			}
			suffix := ""
			if item.Error != "" {
				suffix = " (" + item.Error + ")"
			}
			if len(windows) > 0 {
				suffix += " — " + strings.Join(windows, " · ")
			}
			fmt.Fprintf(c.out, "  %s: %s%s\n", c.styleValue(item.Provider), item.Source, suffix)
		}
		_ = failed
	}
	return nil
}

// printIdentityGaps prints the `identity (same model, different ids)` doctor
// section. src/cli.ts doctor.
func printIdentityGaps(c commandContext, cfg *config.Config, routings []config.RoutingEntry) {
	declared := map[string]bool{}
	for _, r := range routings {
		for _, model := range r.Models {
			declared[model] = true
		}
	}
	models := make([]string, 0, len(declared))
	for model := range declared {
		models = append(models, model)
	}
	sort.Strings(models)

	lines := []string{}
	for _, gap := range catalogsync.IdentityGaps(cfg, models) {
		name := gap.Identity.DisplayName
		if name == "" {
			name = gap.Identity.Label
		}
		lines = append(lines, fmt.Sprintf("  %s — catalog: %s", c.styleValue(gap.Model), c.styleValue(name)))
		served := make([]string, 0, len(gap.SameModel))
		for _, entry := range gap.SameModel {
			label := c.styleValue(entry.Provider + "/" + entry.Model)
			if entry.Official {
				label += " (official)"
			}
			served = append(served, label)
		}
		lines = append(lines, "    "+c.styleValue("same model served by:")+" "+strings.Join(served, ", "))
		if gap.Suggestion != "" {
			lines = append(lines, "    "+c.styleValue("fix:")+" "+gap.Suggestion)
		}
	}
	for _, canonical := range catalogsync.RedundantAliases(cfg) {
		lines = append(lines, fmt.Sprintf("  %s — alias already redundant: identity routing finds the provider", c.styleValue(canonical)))
	}
	if len(lines) == 0 {
		return
	}
	fmt.Fprintf(c.out, "\n%s\n", c.styleValue("identity (same model, different ids):"))
	for _, line := range lines {
		fmt.Fprintln(c.out, line)
	}
}

func (c commandContext) quota(a arguments) error {
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	if len(cfg.Providers) == 0 {
		fmt.Fprintln(c.out, "No providers configured. Run `jevonian add`.")
		return nil
	}
	db, err := openLedger()
	if err != nil {
		return err
	}
	defer db.Close()
	tracker := quota.New(db)
	tracker.SetStatePath(filepath.Join(paths.DataDir(), "quota.json"))
	client := cliHTTP()
	auth := &oauth.Resolver{HTTP: client, Credentials: multiacct.DefaultStore(), CursorToken: cursor.Token}
	svc := quota.NewService(tracker, quota.LiveOptions{HTTP: client, OAuth: auth})
	// --refresh blocks on live probes; without it cached snapshots print immediately.
	quotas, err := svc.ProviderQuotas(context.Background(), &cfg, a.has("refresh"))
	if err != nil {
		return err
	}
	low := cfg.Routing.QuotaGuard.LowPercent
	for _, q := range quotas {
		plan := ""
		if q.Plan != "" {
			plan = " · " + c.styleValue(q.Plan)
		}
		healthLabel := ""
		var health *quota.Health
		for _, p := range cfg.Providers {
			if p.Name == q.Provider {
				h := tracker.ProviderHealth(p, quota.HealthOptions{LowPercent: &low})
				health = &h
				healthLabel = " · " + c.styleValue(string(h.Status))
			}
		}
		fmt.Fprintf(c.out, "%s · %s · %s%s%s\n", c.styleValue(q.Provider), q.Billing, q.Source, plan, healthLabel)
		for _, w := range q.Windows {
			used := fmt.Sprintf("%.1f%%", w.UsedPercent)
			if w.UsedUSD != nil && w.UsedPercent == 0 {
				used = fmt.Sprintf("$%.4f", *w.UsedUSD)
			}
			limit := ""
			if w.LimitUSD != nil {
				limit = fmt.Sprintf(" / $%.4f", *w.LimitUSD)
			}
			reset := ""
			if w.ResetsAt != "" {
				reset = " · resets " + w.ResetsAt
			}
			fmt.Fprintf(c.out, "  %s %s%s%s\n", c.styleValue(fmt.Sprintf("%-8s", w.Label)), used, limit, reset)
		}
		if q.Balance != nil {
			fmt.Fprintf(c.out, "  %s %.2f %s\n", c.styleValue("balance:"), q.Balance.Amount, q.Balance.Currency)
		}
		fmt.Fprintf(c.out, "  %s 5h $%.4f · 24h $%.4f · 7d $%.4f · 30d $%.4f (%d reqs)\n", c.styleValue("spend:"), q.Spend.FiveHourUSD, q.Spend.DayUSD, q.Spend.WeekUSD, q.Spend.MonthUSD, q.Spend.MonthRequests)
		if q.Note != "" {
			fmt.Fprintf(c.out, "  %s %s\n", c.styleValue("note:"), q.Note)
		}
		if q.Error != "" {
			fmt.Fprintf(c.out, "  %s %s\n", c.styleValue("note:"), q.Error)
		}
		if health != nil && health.RemainingUSD != nil {
			average := ""
			if health.AvgRequestUSD != nil {
				average = fmt.Sprintf(" · ~$%.4f/request", *health.AvgRequestUSD)
			}
			fmt.Fprintf(c.out, "  %s $%.4f%s\n", c.styleValue("remaining:"), *health.RemainingUSD, average)
		}
		if len(q.Windows) == 0 && q.Error == "" {
			fmt.Fprintln(c.out, "  no quota source for this provider")
		}
	}
	return nil
}
