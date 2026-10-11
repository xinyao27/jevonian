package catalogsync

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/paths"
	"github.com/xinyao27/jevonian/internal/provider/cursor"
	"github.com/xinyao27/jevonian/internal/provider/devin"
	"github.com/xinyao27/jevonian/internal/routing"
)

// Catalog-backed sources for routing.Deps.Capabilities and routing.Deps.Identity.
// Ports of src/capabilities.ts modelCapabilities, src/identity.ts,
// src/identityIndex.ts and the identity half of src/models.ts. The data comes
// from the models.dev snapshot (<dataDir>/pricing.json, `capabilities` and
// `identities`), plus Devin's and Cursor's own on-disk model metadata.

// officialProviders is src/modelsdev.ts OFFICIAL_PROVIDERS.
var officialProviders = map[string]bool{
	"alibaba": true, "anthropic": true, "deepseek": true, "google": true, "meta": true,
	"minimax": true, "mistral": true, "moonshotai": true, "openai": true, "qwen": true,
	"tencent": true, "xai": true, "xiaomi": true, "zai": true,
}

// catalogIdentity is what the catalog states about one model's identity
// (src/modelsdev.ts CatalogIdentity).
type catalogIdentity struct {
	Name        string `json:"name"`
	Family      string `json:"family"`
	ReleaseDate string `json:"releaseDate"`
}

type orderedIdentity struct {
	key      string
	identity catalogIdentity
}

// snapshot is the parsed pricing.json slice routing reads: stated limits and
// identities. Identities keep file order because the index's tie-breaks are
// first-named-wins.
type snapshot struct {
	// rawCapabilities is decoded on first use: identity-only callers (doctor's
	// identity gaps) never pay for the large capabilities map.
	rawCapabilities json.RawMessage
	capsOnce        sync.Once
	capabilities    map[string]routing.ModelCapabilities
	identities      []orderedIdentity
	index           *identityIndex
}

// caps returns the decoded capabilities map, decoding it once.
func (s *snapshot) caps() map[string]routing.ModelCapabilities {
	s.capsOnce.Do(func() {
		s.capabilities = decodeCapabilities(s.rawCapabilities)
		s.rawCapabilities = nil
	})
	return s.capabilities
}

type snapshotCacheEntry struct {
	path  string
	mtime time.Time
	size  int64
	snap  *snapshot
}

// snapshotCache is process-wide on purpose: routing asks for capabilities and
// identities on every turn, and re-parsing the multi-megabyte pricing.json
// per call is the cost. It re-reads on mtime/size change, guards with a mutex,
// and never hands out a mutable map. It holds only the capability/identity
// half; cli's pricingCache holds the price half.
var snapshotCache struct {
	sync.Mutex
	entry *snapshotCacheEntry
}

// loadSnapshot parses the pricing snapshot, cached until its mtime or size
// changes (src/modelsdev.ts loadSnapshotFile). A missing or corrupt file reads
// as an empty snapshot: unknown is never evidence of a small window.
func loadSnapshot() *snapshot {
	path := filepath.Join(paths.DataDir(), "pricing.json")
	info, err := os.Stat(path)
	if err != nil {
		return &snapshot{}
	}
	snapshotCache.Lock()
	defer snapshotCache.Unlock()
	if e := snapshotCache.entry; e != nil && e.path == path && e.mtime.Equal(info.ModTime()) && e.size == info.Size() {
		return e.snap
	}
	snap := parseSnapshot(path)
	snapshotCache.entry = &snapshotCacheEntry{path: path, mtime: info.ModTime(), size: info.Size(), snap: snap}
	return snap
}

func parseSnapshot(path string) *snapshot {
	snap := &snapshot{}
	data, err := os.ReadFile(path)
	if err != nil {
		return snap
	}
	var top struct {
		Capabilities json.RawMessage `json:"capabilities"`
		Identities   json.RawMessage `json:"identities"`
	}
	if json.Unmarshal(data, &top) != nil {
		return snap
	}
	snap.rawCapabilities = top.Capabilities
	if len(top.Identities) > 0 {
		snap.identities = decodeOrderedIdentities(top.Identities)
	}
	snap.index = buildIdentityIndex(snap.identities)
	return snap
}

// decodeCapabilities reads the stated limits per model id. A corrupt or absent
// section yields an empty map: unknown is never evidence of a small window.
func decodeCapabilities(rawSection json.RawMessage) map[string]routing.ModelCapabilities {
	out := map[string]routing.ModelCapabilities{}
	if len(rawSection) == 0 {
		return out
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(rawSection, &raw) != nil {
		return out
	}
	for key, entry := range raw {
		var caps struct {
			ContextWindow *float64 `json:"contextWindow"`
			MaxOutput     *float64 `json:"maxOutput"`
			Efforts       []any    `json:"efforts"`
		}
		if json.Unmarshal(entry, &caps) != nil {
			continue
		}
		c := routing.ModelCapabilities{}
		if caps.ContextWindow != nil && *caps.ContextWindow > 0 {
			c.ContextWindow = int(*caps.ContextWindow)
		}
		if caps.MaxOutput != nil && *caps.MaxOutput > 0 {
			c.MaxOutput = int(*caps.MaxOutput)
		}
		for _, e := range caps.Efforts {
			if s, ok := e.(string); ok && routing.IsReasoningEffort(s) {
				c.Efforts = append(c.Efforts, s)
			}
		}
		out[key] = c
	}
	return out
}

func decodeOrderedIdentities(raw json.RawMessage) []orderedIdentity {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var out []orderedIdentity
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return out
		}
		key, _ := keyTok.(string)
		var entry json.RawMessage
		if dec.Decode(&entry) != nil {
			return out
		}
		var id catalogIdentity
		if json.Unmarshal(entry, &id) != nil {
			continue
		}
		out = append(out, orderedIdentity{key: key, identity: id})
	}
	return out
}

// ---- capabilities ----

// Capabilities is the production routing.CapabilitySource: what the catalog
// states about one model id, merged with Devin's and Cursor's own metadata.
// Missing metadata yields the zero value — an unknown model is never filtered
// out. src/capabilities.ts modelCapabilities.
func Capabilities() routing.CapabilitySource {
	return func(model string) routing.ModelCapabilities {
		return ModelCapabilities(model)
	}
}

// ModelCapabilities resolves one model id against the live snapshot.
func ModelCapabilities(model string) routing.ModelCapabilities {
	caps := loadSnapshot().caps()
	tail := routing.BareModelID(model)
	var catalog routing.ModelCapabilities
	if c, ok := caps[model]; ok {
		catalog = c
	} else if c, ok := caps[tail]; ok {
		catalog = c
	} else if c, ok := caps[routing.CanonicalModelID(model)]; ok {
		catalog = c
	}
	// A models.dev row with no limits (or only one of them) must not hide
	// Devin's or Cursor's more specific limits. Where both state the same
	// field, models.dev remains authoritative: {...devin, ...cursor, ...catalog}.
	out := devinCapabilities(model)
	if c := cursorCapabilities(model); c.ContextWindow > 0 {
		out.ContextWindow = c.ContextWindow
	}
	if c := xaiCapabilities(model); c.ContextWindow > 0 {
		if out.ContextWindow == 0 {
			out.ContextWindow = c.ContextWindow
		}
		if out.MaxOutput == 0 {
			out.MaxOutput = c.MaxOutput
		}
		if len(out.Efforts) == 0 {
			out.Efforts = c.Efforts
		}
	}
	if catalog.ContextWindow > 0 {
		out.ContextWindow = catalog.ContextWindow
	}
	if catalog.MaxOutput > 0 {
		out.MaxOutput = catalog.MaxOutput
	}
	if len(catalog.Efforts) > 0 {
		out.Efforts = append([]string(nil), catalog.Efforts...)
	}
	return out
}

// xaiCapabilities falls back to the window, max output, and accepted reasoning
// efforts from official xAI specifications (https://docs.x.ai/developers/pricing).
func xaiCapabilities(model string) routing.ModelCapabilities {
	id := strings.ToLower(routing.BareModelID(model))
	switch id {
	case "grok-4.5", "grok-4.5-latest", "grok-build-latest":
		return routing.ModelCapabilities{
			ContextWindow: 500000,
			MaxOutput:     65536,
			Efforts:       []string{"low", "medium", "high", "xhigh"},
		}
	case "grok-4.7":
		return routing.ModelCapabilities{
			ContextWindow: 500000,
			MaxOutput:     65536,
			Efforts:       []string{"low", "medium", "high", "xhigh"},
		}
	case "grok-4.6":
		return routing.ModelCapabilities{
			ContextWindow: 500000,
			MaxOutput:     65536,
			Efforts:       []string{"low", "medium", "high", "xhigh"},
		}
	case "grok-4.3", "grok-4.3-latest":
		return routing.ModelCapabilities{
			ContextWindow: 1000000,
			MaxOutput:     65536,
			Efforts:       []string{"none", "low", "medium", "high", "xhigh"},
		}
	case "grok-build-0.1", "grok-code-fast-1", "grok-code-fast":
		return routing.ModelCapabilities{
			ContextWindow: 256000,
			MaxOutput:     65536,
			Efforts:       []string{"low", "medium", "high"},
		}
	case "grok-4.20-0309-reasoning", "grok-4.20":
		return routing.ModelCapabilities{
			ContextWindow: 1000000,
			MaxOutput:     65536,
			Efforts:       []string{"low", "medium", "high"},
		}
	case "grok-4.20-0309-non-reasoning", "grok-4.20-non-reasoning":
		return routing.ModelCapabilities{
			ContextWindow: 1000000,
			MaxOutput:     65536,
			Efforts:       []string{"none"},
		}
	case "grok-4.20-multi-agent-0309", "grok-4.20-multi-agent":
		return routing.ModelCapabilities{
			ContextWindow: 1000000,
			MaxOutput:     65536,
			Efforts:       []string{"low", "medium", "high"},
		}
	}
	return routing.ModelCapabilities{}
}

// devinCapabilities falls back to the window and output cap Devin's own
// catalog states. src/capabilities.ts devinCapabilities.
func devinCapabilities(model string) routing.ModelCapabilities {
	meta, ok := devin.LookupModelMeta(model)
	if !ok {
		return routing.ModelCapabilities{}
	}
	return routing.ModelCapabilities{ContextWindow: meta.ContextWindow, MaxOutput: meta.MaxOutput}
}

// cursorCapabilities uses the window Cursor's own list stated.
// src/capabilities.ts cursorCapabilities.
func cursorCapabilities(model string) routing.ModelCapabilities {
	file := cursor.LoadCatalog()
	if file == nil {
		return routing.ModelCapabilities{}
	}
	id := routing.BareModelID(model)
	for _, list := range [][]cursor.Model{file.Models, file.Raw} {
		for _, entry := range list {
			if entry.ID == id {
				if entry.Context <= 0 {
					return routing.ModelCapabilities{}
				}
				return routing.ModelCapabilities{ContextWindow: entry.Context}
			}
		}
	}
	return routing.ModelCapabilities{}
}

// ---- identity ----

// ServingMode says how an id is served, not which model it is.
// src/identity.ts ServingMode.
type ServingMode string

const (
	ModeStandard ServingMode = "standard"
	ModeFree     ServingMode = "free"
	ModeBatch    ServingMode = "batch"
	ModeFast     ServingMode = "fast"
	ModeThinking ServingMode = "thinking"
)

var modeTokens = []struct {
	mode    ServingMode
	pattern *regexp.Regexp
}{
	{ModeThinking, regexp.MustCompile(`(^|[:@-])(thinking|think)(-|$|[:@])`)},
	{ModeBatch, regexp.MustCompile(`(^|[:@-])batch(-|$|[:@])`)},
	{ModeFree, regexp.MustCompile(`(^|[:@-])free(-|$|[:@])`)},
	{ModeFast, regexp.MustCompile(`(^|[:@-])fast(-|$|[:@])`)},
}

// ServingModeOf is the serving mode an id declares; absent evidence means
// standard. src/identity.ts servingMode.
func ServingModeOf(model string) ServingMode {
	tail := strings.ToLower(routing.BareModelID(model))
	for _, m := range modeTokens {
		if m.pattern.MatchString(tail) {
			return m.mode
		}
	}
	return ModeStandard
}

var (
	bracketed     = regexp.MustCompile(`[(\[{][^)\]}]*[)\]}]+`)
	nonLabelChars = regexp.MustCompile(`[^a-z0-9.]+`)
	spaceRuns     = regexp.MustCompile(`\s+`)
)

// NormalizeModelName reduces a vendor label to its comparable form: reseller
// qualifiers removed, punctuation dropped, case folded. Version tokens stay.
// src/identity.ts normalizeModelName.
func NormalizeModelName(name string) string {
	value := strings.ToLower(name)
	value = bracketed.ReplaceAllString(value, " ")
	if colon := strings.Index(value, ":"); colon > 0 {
		value = value[colon+1:]
	}
	value = nonLabelChars.ReplaceAllString(value, " ")
	value = spaceRuns.ReplaceAllString(value, " ")
	return strings.TrimSpace(value)
}

// ModelIdentity is one model's identity: the catalog's comparable label plus
// the serving mode parsed from the id. src/identity.ts ModelIdentity.
type ModelIdentity struct {
	// Label is the comparable vendor label; "" when the catalog says nothing.
	Label       string
	Family      string
	ReleaseDate string
	// DisplayName is the catalog's label as written.
	DisplayName string
	Mode        ServingMode
}

// Key is the key two entries must share to be the same model; "" when the
// catalog does not name the model. src/identity.ts identityKey.
func (i ModelIdentity) Key() string {
	if i.Label == "" {
		return ""
	}
	return i.Label + "@" + string(i.Mode)
}

func identityFrom(model string, id *catalogIdentity) ModelIdentity {
	out := ModelIdentity{Mode: ServingModeOf(model)}
	if id == nil {
		return out
	}
	if id.Name != "" {
		out.Label = NormalizeModelName(id.Name)
		out.DisplayName = id.Name
	}
	out.Family = id.Family
	out.ReleaseDate = id.ReleaseDate
	return out
}

// identityIndex is the catalog indexed once for identity lookup
// (src/identityIndex.ts).
type identityIndex struct {
	byKey           map[string]catalogIdentity
	byBare          map[string]catalogIdentity
	byCanonical     map[string]catalogIdentity
	officialByLabel map[string]map[string]bool
}

func buildIdentityIndex(entries []orderedIdentity) *identityIndex {
	idx := &identityIndex{
		byKey:           map[string]catalogIdentity{},
		byBare:          map[string]catalogIdentity{},
		byCanonical:     map[string]catalogIdentity{},
		officialByLabel: map[string]map[string]bool{},
	}
	// Prefer an entry that actually names the model, and among those an
	// official vendor's — resellers often ship the same id as the vendor with
	// a reseller-flavoured label.
	claim := func(m map[string]catalogIdentity, key string, id catalogIdentity, official bool) {
		existing, ok := m[key]
		better := !ok ||
			(existing.Name == "" && id.Name != "") ||
			(existing.Name != "" && id.Name != "" && official)
		if better {
			m[key] = id
		}
	}
	for _, e := range entries {
		model := routing.BareModelID(e.key)
		raw := e.identity
		resolved := identityFrom(model, &raw)
		vendor := vendorOf(e.key)
		official := vendor != "" && officialProviders[vendor]
		id := catalogIdentity{Name: resolved.DisplayName, Family: resolved.Family, ReleaseDate: resolved.ReleaseDate}
		claim(idx.byKey, e.key, id, official)
		claim(idx.byBare, model, id, false)
		if canonical := routing.CanonicalModelID(model); canonical != "" {
			claim(idx.byCanonical, canonical, id, false)
		}
		if official && resolved.Label != "" {
			set := idx.officialByLabel[resolved.Label]
			if set == nil {
				set = map[string]bool{}
				idx.officialByLabel[resolved.Label] = set
			}
			set[vendor] = true
		}
	}
	return idx
}

func vendorOf(id string) string {
	if slash := strings.Index(id, "/"); slash > 0 {
		return id[:slash]
	}
	return ""
}

// identityOf is what the catalog states about one model id: the id as
// written, its bare form, then the canonical id. src/models.ts identityOf.
func (idx *identityIndex) identityOf(model string) ModelIdentity {
	if idx == nil {
		return identityFrom(model, nil)
	}
	tail := routing.BareModelID(model)
	var stated *catalogIdentity
	if v, ok := idx.byKey[model]; ok {
		stated = &v
	} else if v, ok := idx.byBare[tail]; ok {
		stated = &v
	} else if v, ok := idx.byCanonical[routing.CanonicalModelID(model)]; ok {
		stated = &v
	}
	return identityFrom(model, stated)
}

// Identity is the production routing.IdentityIndex over the live models.dev
// snapshot: cross-spelling same-model matching and official-vendor tagging.
// It also exposes the catalog label for display. src/models.ts identityOf /
// identityKeyOf / isOfficial.
type Identity struct{}

var _ routing.IdentityIndex = Identity{}

// NewIdentity returns the snapshot-backed identity index. The snapshot is
// re-read when pricing.json changes, so a long-lived serve picks up a refresh.
func NewIdentity() routing.IdentityIndex { return Identity{} }

// Of is the identity of one model id (diagnostics, display names).
func (Identity) Of(model string) ModelIdentity {
	return loadSnapshot().index.identityOf(model)
}

// IdentityKey implements routing.IdentityIndex.
func (Identity) IdentityKey(model string) string {
	return loadSnapshot().index.identityOf(model).Key()
}

// IsOfficial implements routing.IdentityIndex: a provider is official when the
// catalog lists the same identity under a vendor id the provider advertises
// as its own endpoint (`deepseek` for `DeepSeek V4.1 Flash`).
func (Identity) IsOfficial(cfg *config.Config, providerName, requested string) bool {
	idx := loadSnapshot().index
	if idx == nil || cfg == nil {
		return false
	}
	identity := idx.identityOf(requested)
	if identity.Label == "" {
		return false
	}
	winners := idx.officialByLabel[identity.Label]
	if len(winners) == 0 {
		return false
	}
	var provider *config.Provider
	for i := range cfg.Providers {
		if cfg.Providers[i].Name == providerName {
			provider = &cfg.Providers[i]
			break
		}
	}
	if provider == nil {
		return false
	}
	for vendor := range winners {
		if matchesVendor(*provider, vendor) {
			return true
		}
	}
	return false
}

func matchesVendor(p config.Provider, vendor string) bool {
	if p.Name == vendor {
		return true
	}
	u, err := url.Parse(p.BaseURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host != "" && (host == vendor || strings.HasSuffix(host, "."+vendor))
}
