package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var routingIDRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

const maxPromptPatternLength = 500

// envPort is JEVONIAN_PORT when it holds a positive integer, else 0
// (src/config.ts: Number.isInteger(envPort) && envPort > 0).
func envPort() int {
	raw := strings.TrimSpace(os.Getenv("JEVONIAN_PORT"))
	if raw == "" {
		return 0
	}
	if p, err := strconv.Atoi(raw); err == nil && p > 0 {
		return p
	}
	return 0
}

// ParseConfig builds a Config from a decoded JSON object (map[string]any or nil).
// Missing sections fall back to the same defaults as src/config.ts parseConfig.
func ParseConfig(raw any) (Config, error) {
	value := asRecord(raw)
	listen := asRecord(value["listen"])
	host := defaultListenHost
	if h, ok := listen["host"].(string); ok && h != "" {
		host = h
	}
	port := defaultListenPort
	// A valid JEVONIAN_PORT wins; an unset or invalid one falls through to
	// listen.port (src/config.ts: Number.isInteger(envPort) && envPort > 0).
	if p, ok := asInt(listen["port"]); ok && p > 0 {
		port = p
	}
	if p := envPort(); p > 0 {
		port = p
	}

	var providers []Provider
	if arr, ok := value["providers"].([]any); ok {
		providers = make([]Provider, 0, len(arr))
		for i, item := range arr {
			p, err := parseProvider(item, i)
			if err != nil {
				return Config{}, err
			}
			providers = append(providers, p)
		}
	} else {
		providers = []Provider{}
	}

	tunnel := parseTunnel(value["tunnel"])
	modelAliases := map[string][]string{}
	for canonical, entry := range asRecord(value["modelAliases"]) {
		models := stringArray(entry)
		if len(models) > 0 {
			modelAliases[canonical] = models
		}
	}

	routing, err := parseRouting(value["routing"])
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		Listen:       ListenConfig{Host: host, Port: port},
		Providers:    providers,
		Tunnel:       tunnel,
		Lan:          parseLan(value["lan"]),
		Routing:      routing,
		ModelSync:    parseModelSync(value["modelSync"]),
		PromptPolicy: parsePromptPolicy(value["promptPolicy"]),
		TokenSaver:   parseTokenSaver(value["tokenSaver"]),
	}
	if dp, ok := value["defaultProvider"].(string); ok && dp != "" {
		cfg.DefaultProvider = dp
	}
	if len(modelAliases) > 0 {
		cfg.ModelAliases = modelAliases
	}
	return cfg, nil
}

func parseProvider(raw any, index int) (Provider, error) {
	value := asRecord(raw)
	name, _ := value["name"].(string)
	baseURL, _ := value["baseUrl"].(string)
	if name == "" {
		return Provider{}, fmt.Errorf("providers[%d].name must be a non-empty string", index)
	}
	if baseURL == "" {
		return Provider{}, fmt.Errorf("providers[%d].baseUrl must be a non-empty string", index)
	}
	typeRaw := value["type"]
	if typeRaw == nil {
		typeRaw = "openai"
	}
	ptype, err := parseProviderType(typeRaw, index)
	if err != nil {
		return Provider{}, err
	}
	ptype = normalizeProviderType(ptype, baseURL)

	auth := AuthAPIKey
	if value["auth"] == "oauth" {
		auth = AuthOAuth
	}
	var oauthSource OAuthSource
	if auth == AuthOAuth {
		oauthSource = parseOAuthSource(value["oauthSource"])
	}
	billing := BillingAPI
	if value["billing"] == "subscription" {
		billing = BillingSubscription
	}

	p := Provider{
		Name:              name,
		Type:              ptype,
		BaseURL:           baseURL,
		Auth:              auth,
		Billing:           billing,
		Models:            parseModelEntries(value["models"]),
		InjectStreamUsage: value["injectStreamUsage"] != false,
	}
	if oauthSource != "" {
		p.OAuthSource = oauthSource
	}
	if k, ok := value["apiKey"].(string); ok {
		p.APIKey = k
	}
	if k, ok := value["apiKeyEnv"].(string); ok {
		p.APIKeyEnv = k
	}
	if q := parseProviderQuota(value["quota"]); q != nil {
		p.Quota = q
	}
	login, err := parseProviderLogin(value["login"], index)
	if err != nil {
		return Provider{}, err
	}
	if login != nil {
		p.Login = login
	}
	if headers := asStringMap(value["headers"]); headers != nil {
		p.Headers = headers
	}
	if value["syncModels"] == false {
		f := false
		p.SyncModels = &f
	} else if value["syncModels"] == true {
		t := true
		p.SyncModels = &t
	}
	if value["noKey"] == true || ptype == ProviderTypeChatGPTWeb {
		p.NoKey = true
	}
	if excl := stringArray(value["excludeModels"]); len(excl) > 0 {
		p.ExcludeModels = excl
	}
	return p, nil
}

func parseProviderType(value any, index int) (ProviderType, error) {
	s, ok := value.(string)
	if !ok || !providerTypes[s] {
		return "", fmt.Errorf(
			`providers[%d].type must be "openai", "anthropic", "responses", "both", "gemini", "devin", "cursor", or "chatgpt-web"`,
			index,
		)
	}
	return ProviderType(s), nil
}

func normalizeProviderType(ptype ProviderType, baseURL string) ProviderType {
	if ptype == ProviderTypeOpenAI && isNativeDualWireHost(baseURL) {
		return ProviderTypeBoth
	}
	return ptype
}

func isNativeDualWireHost(baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range nativeDualWireHosts {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

func parseOAuthSource(value any) OAuthSource {
	s, ok := value.(string)
	if !ok || !oauthSources[s] {
		return ""
	}
	return OAuthSource(s)
}

func parseProviderQuota(raw any) *ProviderQuotaSpec {
	value := asRecord(raw)
	q := &ProviderQuotaSpec{}
	set := false
	if v, ok := asPositiveFloat(value["fiveHourUsd"]); ok {
		q.FiveHourUSD = &v
		set = true
	}
	if v, ok := asPositiveFloat(value["weeklyUsd"]); ok {
		q.WeeklyUSD = &v
		set = true
	}
	if v, ok := asPositiveFloat(value["monthlyUsd"]); ok {
		q.MonthlyUSD = &v
		set = true
	}
	if !set {
		return nil
	}
	return q
}

func parseProviderLogin(raw any, index int) (*ProviderLogin, error) {
	if raw == nil {
		return nil, nil
	}
	value := asRecord(raw)
	login := &ProviderLogin{
		Label:           textField(value["label"]),
		Home:            textField(value["home"]),
		CredentialsPath: textField(value["credentialsPath"]),
		KeychainService: textField(value["keychainService"]),
		KeychainAccount: textField(value["keychainAccount"]),
	}
	if login.Label == "" && login.Home == "" && login.CredentialsPath == "" &&
		login.KeychainService == "" && login.KeychainAccount == "" {
		return nil, nil
	}
	if login.Home != "" && !isAbsolutePath(login.Home) {
		return nil, fmt.Errorf(`providers[%d].login.home must be an absolute path, not "%s"`, index, login.Home)
	}
	if login.CredentialsPath != "" && !isAbsolutePath(login.CredentialsPath) {
		return nil, fmt.Errorf(
			`providers[%d].login.credentialsPath must be an absolute path, not "%s"`,
			index, login.CredentialsPath,
		)
	}
	return login, nil
}

func isAbsolutePath(p string) bool {
	if strings.HasPrefix(p, "/") {
		return true
	}
	// Windows drive path: C:\ or C:/
	if len(p) >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) &&
		p[1] == ':' && (p[2] == '\\' || p[2] == '/') {
		return true
	}
	return false
}

func parseModelEntries(value any) []ModelEntry {
	arr, ok := value.([]any)
	if !ok {
		return []ModelEntry{}
	}
	entries := make([]ModelEntry, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok && s != "" {
			entries = append(entries, ModelEntry{ID: s})
			continue
		}
		rec := asRecord(item)
		id, _ := rec["id"].(string)
		if id == "" {
			id, _ = rec["model"].(string)
		}
		if id == "" {
			continue
		}
		wires := parseWireValue(rec["wire"])
		if len(wires) > 0 {
			entries = append(entries, ModelEntry{ID: id, Wire: wires})
		} else {
			entries = append(entries, ModelEntry{ID: id})
		}
	}
	return entries
}

func parseWireValue(value any) []UpstreamWire {
	one := func(raw any) (UpstreamWire, bool) {
		s, ok := raw.(string)
		if !ok {
			return "", false
		}
		switch UpstreamWire(s) {
		case WireOpenAI, WireAnthropic, WireResponses:
			return UpstreamWire(s), true
		}
		return "", false
	}
	if arr, ok := value.([]any); ok {
		var wires []UpstreamWire
		for _, item := range arr {
			if w, ok := one(item); ok {
				wires = append(wires, w)
			}
		}
		return wires
	}
	if w, ok := one(value); ok {
		return []UpstreamWire{w}
	}
	return nil
}

func parseRouting(raw any) (RoutingConfig, error) {
	value := asRecord(raw)
	mode := "auto"
	if m, ok := value["mode"].(string); ok {
		mode = m
	}
	if mode != "auto" && mode != "off" {
		return RoutingConfig{}, fmt.Errorf(`routing.mode must be "auto" or "off"`)
	}
	routings, err := parseRoutings(value["routings"], value["tiers"])
	if err != nil {
		return RoutingConfig{}, err
	}
	sessionTTL := 720
	if v, ok := asInt(value["sessionTtlMinutes"]); ok && v > 0 {
		sessionTTL = v
	}
	rc := RoutingConfig{
		Mode:              mode,
		Routings:          routings,
		Tiers:             tiersFromRoutings(routings),
		SessionTTLMinutes: sessionTTL,
		QuotaGuard:        parseQuotaGuard(value["quotaGuard"]),
		Brains:            parseBrains(value["brains"], value["brain"]),
		BrainPicksEffort:  value["brainPicksEffort"] != false,
	}
	if bm, ok := value["baselineModel"].(string); ok && bm != "" {
		rc.BaselineModel = bm
	}
	if caps := parseCapacities(value["capacities"]); caps != nil {
		rc.Capacities = caps
	}
	if de, ok := value["defaultEffort"].(string); ok && reasoningEfforts[de] {
		rc.DefaultEffort = de
	}
	schedule, err := parseSchedule(value["schedule"])
	if err != nil {
		return RoutingConfig{}, err
	}
	rc.Schedule = schedule
	pruneWindows(rc.Routings, schedule)
	return rc, nil
}

func parseRoutings(rawRoutings, rawTiers any) ([]RoutingEntry, error) {
	tiers := asRecord(rawTiers)
	legacy := RoutingTiers{
		Plan:    stringArray(tiers["plan"]),
		Execute: stringArray(tiers["execute"]),
		Utility: stringArray(tiers["utility"]),
		Chat:    stringArray(tiers["chat"]),
	}

	arr, ok := rawRoutings.([]any)
	if !ok || len(arr) == 0 {
		return defaultRoutings(legacy), nil
	}

	parsed := make([]RoutingEntry, 0, len(arr))
	seen := map[string]bool{}
	for i, item := range arr {
		entry, err := parseRoutingEntry(item, i)
		if err != nil {
			return nil, err
		}
		if seen[entry.ID] {
			return nil, fmt.Errorf(`routing.routings: duplicate id "%s"`, entry.ID)
		}
		seen[entry.ID] = true
		parsed = append(parsed, entry)
	}

	merged := defaultRoutings(legacy)
	for i, builtin := range merged {
		for _, override := range parsed {
			if override.ID == builtin.ID {
				merged[i] = override
				break
			}
		}
	}
	for _, entry := range parsed {
		if !isBuiltinRoutingID(entry.ID) {
			merged = append(merged, entry)
		}
	}
	return merged, nil
}

func parseRoutingEntry(raw any, index int) (RoutingEntry, error) {
	value := asRecord(raw)
	id, _ := value["id"].(string)
	if !isRoutingID(id) {
		return RoutingEntry{}, fmt.Errorf(
			`routing.routings[%d].id must be a slug (lowercase letters, digits, hyphens; not "auto")`,
			index,
		)
	}
	label, _ := value["label"].(string)
	if strings.TrimSpace(label) == "" {
		return RoutingEntry{}, fmt.Errorf("routing.routings[%d].label must be a non-empty string", index)
	}
	description, _ := value["description"].(string)
	models := stringArray(value["models"])
	providersRaw := value["providers"]
	if providersRaw == nil {
		providersRaw = value["providerOrder"]
	}
	windows := parseRoutingWindows(value["windows"])
	// Provider order covers the routing's own models and the ones it lists for a window.
	providers := pruneProviderOrder(routingModels(models, windows), parseProviderOrder(providersRaw))
	entry := RoutingEntry{
		ID:          id,
		Label:       strings.TrimSpace(label),
		Description: description,
		Models:      models,
	}
	if providers != nil {
		entry.Providers = providers
	}
	if effort, ok := value["effort"].(string); ok && reasoningEfforts[effort] {
		entry.Effort = effort
	}
	if windows != nil {
		entry.Windows = windows
	}
	return entry, nil
}

func isRoutingID(value string) bool {
	return routingIDRe.MatchString(value) && value != "auto"
}

func parseProviderOrder(raw any) map[string][]string {
	if raw == nil {
		return nil
	}
	value := asRecord(raw)
	out := map[string][]string{}
	for model, list := range value {
		if model == "" {
			continue
		}
		arr, ok := list.([]any)
		if !ok {
			continue
		}
		names := stringArray(arr)
		filtered := names[:0]
		for _, name := range names {
			if name != "" {
				filtered = append(filtered, name)
			}
		}
		out[model] = filtered
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func pruneProviderOrder(models []string, order map[string][]string) map[string][]string {
	if order == nil {
		return nil
	}
	kept := map[string][]string{}
	for _, model := range models {
		list, ok := order[model]
		if !ok {
			continue
		}
		providers := make([]string, 0, len(list))
		seen := map[string]bool{}
		for _, name := range list {
			if name != "" && !seen[name] {
				seen[name] = true
				providers = append(providers, name)
			}
		}
		kept[model] = providers
	}
	if len(kept) == 0 {
		return nil
	}
	return kept
}

func parseQuotaGuard(raw any) QuotaGuardConfig {
	value := asRecord(raw)
	low := DefaultQuotaGuard.LowPercent
	if v, ok := asFloat(value["lowPercent"]); ok && v >= 0 && v <= 100 {
		low = v
	}
	return QuotaGuardConfig{
		Enabled:    value["enabled"] != false,
		LowPercent: low,
		ResetAware: value["resetAware"] != false,
	}
}

func parseBrains(rawBrains, rawBrain any) []BrainConfig {
	if arr, ok := rawBrains.([]any); ok {
		out := make([]BrainConfig, 0, len(arr))
		for _, entry := range arr {
			out = append(out, parseBrain(entry))
		}
		return out
	}
	legacy := asRecord(rawBrain)
	if len(legacy) > 0 {
		return []BrainConfig{parseBrain(legacy)}
	}
	return []BrainConfig{}
}

func parseBrain(raw any) BrainConfig {
	value := asRecord(raw)
	channel := "typesafe"
	if c, ok := value["channel"].(string); ok && c != "" {
		channel = c
	}
	timeoutMs := DefaultBrain.TimeoutMs
	if v, ok := asInt(value["timeoutMs"]); ok && v > 0 {
		timeoutMs = v
	}
	minConf := DefaultBrain.MinConfidence
	if v, ok := asFloat(value["minConfidence"]); ok && v >= 0 && v <= 1 {
		minConf = v
	}
	brain := BrainConfig{
		Channel:       channel,
		TimeoutMs:     timeoutMs,
		MinConfidence: minConf,
	}
	if u, ok := value["baseUrl"].(string); ok {
		brain.BaseURL = u
	}
	if a, ok := value["accountId"].(string); ok && strings.TrimSpace(a) != "" {
		brain.AccountID = strings.TrimSpace(a)
	}
	if k, ok := value["apiKeyEnv"].(string); ok {
		brain.APIKeyEnv = k
	}
	if m, ok := value["model"].(string); ok {
		brain.Model = m
	}
	if value["fullPrompt"] == true {
		brain.FullPrompt = true
	}
	return brain
}

func parseCapacities(raw any) map[string]ModelCapacityConfig {
	value := asRecord(raw)
	out := map[string]ModelCapacityConfig{}
	for model, rawCap := range value {
		capacity := asRecord(rawCap)
		cap := ModelCapacityConfig{}
		has := false
		if v, ok := asInt(capacity["contextWindow"]); ok && v > 0 {
			cap.ContextWindow = &v
			has = true
		}
		if v, ok := asInt(capacity["maxOutput"]); ok && v > 0 {
			cap.MaxOutput = &v
			has = true
		}
		efforts := stringArray(capacity["efforts"])
		filtered := efforts[:0]
		for _, e := range efforts {
			if reasoningEfforts[e] {
				filtered = append(filtered, e)
			}
		}
		if len(filtered) > 0 {
			cap.Efforts = filtered
			has = true
		}
		if has {
			out[model] = cap
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseTunnel(raw any) TunnelConfig {
	value := asRecord(raw)
	provider := "cloudflare"
	if p, ok := value["provider"].(string); ok && (p == "ngrok" || p == "custom") {
		provider = p
	}
	t := TunnelConfig{
		Enabled:  value["enabled"] == true,
		Provider: provider,
	}
	if c, ok := value["command"].(string); ok && strings.TrimSpace(c) != "" {
		t.Command = c
	}
	if u, ok := value["url"].(string); ok {
		if n := normalizeTunnelURL(u); n != "" {
			t.URL = n
		}
	}
	if p, ok := asInt(value["publicPort"]); ok && p > 0 {
		t.PublicPort = &p
	}
	return t
}

func normalizeTunnelURL(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return trimmed
	}
	re := regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/:].*)?$`)
	if re.MatchString(trimmed) {
		return "https://" + trimmed
	}
	return ""
}

func parseLan(raw any) LanConfig {
	value := asRecord(raw)
	lan := LanConfig{Enabled: value["enabled"] == true}
	if h, ok := value["host"].(string); ok && strings.TrimSpace(h) != "" {
		lan.Host = strings.TrimSpace(h)
	}
	if p, ok := asInt(value["port"]); ok && p > 0 {
		lan.Port = &p
	}
	return lan
}

func parseModelSync(raw any) ModelSyncConfig {
	value := asRecord(raw)
	interval := DefaultModelSync.IntervalMinutes
	if v, ok := asFloat(value["intervalMinutes"]); ok {
		iv := int(v)
		if iv < minModelSyncIntervalMinutes {
			iv = minModelSyncIntervalMinutes
		}
		interval = iv
	}
	return ModelSyncConfig{
		Enabled:         value["enabled"] != false,
		IntervalMinutes: interval,
	}
}

func parsePromptPolicy(raw any) PromptPolicyConfig {
	value := asRecord(raw)
	rewrites := []PromptRewriteRule{}
	if arr, ok := value["rewrites"].([]any); ok {
		for _, entry := range arr {
			rule := asRecord(entry)
			match, _ := rule["match"].(string)
			replace, replaceOK := rule["replace"].(string)
			if match == "" || len(match) > maxPromptPatternLength || !replaceOK {
				continue
			}
			flags := ""
			if f, ok := rule["flags"].(string); ok {
				flags = sanitizeFlags(f)
			}
			if _, err := regexp.Compile("(?:" + match + ")"); err != nil {
				continue
			}
			r := PromptRewriteRule{Match: match, Replace: replace}
			if flags != "" {
				r.Flags = flags
			}
			rewrites = append(rewrites, r)
		}
	}
	return PromptPolicyConfig{
		Builtins: value["builtins"] != false,
		Rewrites: rewrites,
	}
}

func sanitizeFlags(flags string) string {
	allowed := "gimsuy"
	var out strings.Builder
	seen := map[rune]bool{}
	for _, f := range flags {
		if strings.ContainsRune(allowed, f) && !seen[f] {
			seen[f] = true
			out.WriteRune(f)
		}
	}
	return out.String()
}

func parseTokenSaver(raw any) TokenSaverConfig {
	value := asRecord(raw)
	command := DefaultTokenSaver.Command
	if c, ok := value["command"].(string); ok && strings.TrimSpace(c) != "" {
		command = strings.TrimSpace(c)
	}
	timeout := DefaultTokenSaver.TimeoutMs
	if v, ok := asInt(value["timeoutMs"]); ok && v > 0 {
		timeout = v
	}
	return TokenSaverConfig{
		Enabled:   value["enabled"] != false,
		Command:   command,
		TimeoutMs: timeout,
	}
}

// --- helpers ---

func asRecord(value any) map[string]any {
	if m, ok := value.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}

func stringArray(value any) []string {
	arr, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func asStringMap(value any) map[string]string {
	if value == nil {
		return nil
	}
	rec, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for k, v := range rec {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

func textField(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

func asInt(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case int64:
		return int(v), true
	default:
		return 0, false
	}
}

func asFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}

func asPositiveFloat(value any) (float64, bool) {
	v, ok := asFloat(value)
	if !ok || v <= 0 {
		return 0, false
	}
	return v, true
}
