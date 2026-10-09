// Package ledger stores request/brain records in SQLite and answers rolling-window
// spend queries with the same semantics as the TypeScript ledger-index.
package ledger

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/xinyao27/jevonian/internal/paths"
	_ "modernc.org/sqlite"
)

// Rolling windows used by quota / stats (matching src/quota.ts).
const (
	Window5h  = 5 * time.Hour
	Window1d  = 24 * time.Hour
	Window7d  = 7 * 24 * time.Hour
	Window30d = 30 * 24 * time.Hour
)

// Record is the subset of LedgerRecord fields that matter for quota, stats, and migration.
type Record struct {
	ID               string
	RequestID        string
	TS               time.Time
	Session          string
	Path             string
	Provider         string
	Model            string
	Stream           bool
	Status           int
	LatencyMs        int
	PromptTokens     int
	CompletionTokens int
	CacheReadTokens  int
	CacheWriteTokens int
	CostUSD          *float64
	PricingKnown     bool
	Kind             string // "request" | "brain" | ""
	Billing          string // "api" | "subscription" | ""
	RequestedModel   string
	Phase            string
	Routed           *bool
	Reason           string
	Brain            string
	Confidence       *float64
	Canonical        string
	Effort           string
	EffortNote       string
	SavedTokens      *int
	Retries          *int
	Failovers        *int
	TTFTMs           *int
	Error            string
	KeyID            string
	KeyName          string
	SwitchPenaltyUSD *float64

	// Extended TS-ledger fields, stored only after ExtendSchema. Tries, Skipped
	// and Cache are JSON text exactly as the TS LedgerRecord carries them.
	Tries        json.RawMessage // attempt waterfall; omitted for a clean first try
	Skipped      json.RawMessage // models routing withheld, with reasons
	Cache        json.RawMessage // cache-affinity estimate
	CacheKeep    string          // why the conversation stayed or moved
	BrainChannel string          // brain channel that chose the route

	// ExclusiveInput records the usage convention the serving wire used. When
	// true, PromptTokens already excludes CacheReadTokens (Anthropic Messages,
	// Connect-RPC hosts); when false, PromptTokens includes them (OpenAI,
	// Responses). It is *bool so pre-existing rows stay NULL, and readers keep
	// the historical "prompt is uncached" reading for them.
	ExclusiveInput *bool
}

// SpendTotal is a windowed (or all-time) money rollup.
type SpendTotal struct {
	CostUSD         float64
	APIUsd          float64
	SubscriptionUsd float64
	Requests        int64
}

// DB is an open ledger database.
type DB struct {
	extended bool // ExtendSchema ran: Append also writes the extended columns
	// Exactly one writer serializes SQLite mutations. Indexed reads use a
	// separate bounded pool so dashboard work cannot queue ahead of appends.
	db   *sql.DB
	read *sql.DB
}

const schemaSQL = `
CREATE TABLE IF NOT EXISTS records (
	id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL DEFAULT '',
	ts_ms INTEGER NOT NULL,
	ts TEXT NOT NULL,
	session TEXT NOT NULL DEFAULT '',
	path TEXT NOT NULL DEFAULT '',
	provider TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	stream INTEGER NOT NULL DEFAULT 0,
	status INTEGER NOT NULL DEFAULT 0,
	latency_ms INTEGER NOT NULL DEFAULT 0,
	prompt_tokens INTEGER NOT NULL DEFAULT 0,
	completion_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL,
	pricing_known INTEGER NOT NULL DEFAULT 0,
	kind TEXT NOT NULL DEFAULT '',
	billing TEXT NOT NULL DEFAULT '',
	requested_model TEXT NOT NULL DEFAULT '',
	phase TEXT NOT NULL DEFAULT '',
	routed INTEGER,
	reason TEXT NOT NULL DEFAULT '',
	brain TEXT NOT NULL DEFAULT '',
	confidence REAL,
	canonical TEXT NOT NULL DEFAULT '',
	effort TEXT NOT NULL DEFAULT '',
	effort_note TEXT NOT NULL DEFAULT '',
	saved_tokens INTEGER,
	retries INTEGER,
	failovers INTEGER,
	ttft_ms INTEGER,
	error TEXT NOT NULL DEFAULT '',
	key_id TEXT NOT NULL DEFAULT '',
	key_name TEXT NOT NULL DEFAULT '',
	switch_penalty_usd REAL
);

CREATE INDEX IF NOT EXISTS idx_records_provider_ts
	ON records(provider, ts_ms);

CREATE INDEX IF NOT EXISTS idx_records_key_ts
	ON records(key_id, ts_ms);
`

// Open opens (or creates) a SQLite ledger at path and applies the schema.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("ledger: create dir: %w", err)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("ledger: absolute path: %w", err)
	}
	u := paths.SQLiteFileURL(abs)
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("ledger: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	// WAL lets read-only queries run independently of this single writer.
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ledger: pragma: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ledger: schema: %w", err)
	}
	// exclusive_input is written by the plain Append path too, so it must exist
	// even before ExtendSchema runs. Add it only when the table lacks it.
	if !tableHasColumn(db, "records", "exclusive_input") {
		if _, err := db.Exec(`ALTER TABLE records ADD COLUMN exclusive_input INTEGER`); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("ledger: add exclusive_input: %w", err)
		}
	}
	read, err := sql.Open("sqlite", u.String())
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ledger: read pool: %w", err)
	}
	read.SetMaxOpenConns(4)
	read.SetMaxIdleConns(4)
	return &DB{db: db, read: read}, nil
}

// Close closes the underlying database.
func (d *DB) Close() error {
	if d == nil || d.db == nil {
		return nil
	}
	return errors.Join(d.read.Close(), d.db.Close())
}

// Append inserts one record. Missing IDs are generated; zero TS defaults to now.
func (d *DB) Append(record Record) error {
	if record.ID == "" {
		record.ID = uuid.NewString()
	}
	if record.TS.IsZero() {
		record.TS = time.Now().UTC()
	}
	ts := record.TS.UTC()
	if d.extended {
		return d.appendExtended(record, ts)
	}
	// Open guarantees exclusive_input exists, so Append can always write it.
	_, err := d.db.Exec(`
INSERT INTO records (
	id, request_id, ts_ms, ts, session, path, provider, model, stream, status, latency_ms,
	prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
	cost_usd, pricing_known, kind, billing, requested_model, phase, routed, reason,
	brain, confidence, canonical, effort, effort_note, saved_tokens, retries, failovers,
	ttft_ms, error, key_id, key_name, switch_penalty_usd, exclusive_input
) VALUES (
	?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
	?, ?, ?, ?,
	?, ?, ?, ?, ?, ?, ?, ?,
	?, ?, ?, ?, ?, ?, ?, ?,
	?, ?, ?, ?, ?, ?
)`,
		record.ID,
		record.RequestID,
		ts.UnixMilli(),
		ts.Format(time.RFC3339Nano),
		record.Session,
		record.Path,
		record.Provider,
		record.Model,
		boolToInt(record.Stream),
		record.Status,
		record.LatencyMs,
		record.PromptTokens,
		record.CompletionTokens,
		record.CacheReadTokens,
		record.CacheWriteTokens,
		nullFloat(record.CostUSD),
		boolToInt(record.PricingKnown),
		record.Kind,
		record.Billing,
		record.RequestedModel,
		record.Phase,
		nullBool(record.Routed),
		record.Reason,
		record.Brain,
		nullFloat(record.Confidence),
		record.Canonical,
		record.Effort,
		record.EffortNote,
		nullInt(record.SavedTokens),
		nullInt(record.Retries),
		nullInt(record.Failovers),
		nullInt(record.TTFTMs),
		record.Error,
		record.KeyID,
		record.KeyName,
		nullFloat(record.SwitchPenaltyUSD),
		nullBool(record.ExclusiveInput),
	)
	if err != nil {
		return fmt.Errorf("ledger: append: %w", err)
	}
	return nil
}

// ProviderWindow returns provider spend inside [now-window, now], excluding brain rows.
func (d *DB) ProviderWindow(provider string, window time.Duration, now time.Time) (SpendTotal, error) {
	return d.querySpend(`
SELECT
	COALESCE(SUM(COALESCE(cost_usd, 0)), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN COALESCE(cost_usd, 0) ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN 0 ELSE COALESCE(cost_usd, 0) END), 0),
	COUNT(*)
FROM records
WHERE provider = ?
  AND provider != ''
  AND (kind = '' OR kind != 'brain')
  AND ts_ms >= ? AND ts_ms <= ?
`, provider, now.Add(-window).UnixMilli(), now.UnixMilli())
}

// KeyWindow returns key spend inside [now-window, now], excluding brain rows.
func (d *DB) KeyWindow(keyID string, window time.Duration, now time.Time) (SpendTotal, error) {
	return d.querySpend(`
SELECT
	COALESCE(SUM(COALESCE(cost_usd, 0)), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN COALESCE(cost_usd, 0) ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN 0 ELSE COALESCE(cost_usd, 0) END), 0),
	COUNT(*)
FROM records
WHERE key_id = ?
  AND key_id != ''
  AND provider != ''
  AND (kind = '' OR kind != 'brain')
  AND ts_ms >= ? AND ts_ms <= ?
`, keyID, now.Add(-window).UnixMilli(), now.UnixMilli())
}

// KeyAllTime returns lifetime api vs subscription totals for a key.
func (d *DB) KeyAllTime(keyID string) (SpendTotal, error) {
	return d.querySpend(`
SELECT
	COALESCE(SUM(COALESCE(cost_usd, 0)), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN COALESCE(cost_usd, 0) ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN 0 ELSE COALESCE(cost_usd, 0) END), 0),
	COUNT(*)
FROM records
WHERE key_id = ?
  AND key_id != ''
  AND provider != ''
  AND (kind = '' OR kind != 'brain')
`, keyID)
}

// ProviderAllTime returns lifetime totals for a provider.
func (d *DB) ProviderAllTime(provider string) (SpendTotal, error) {
	return d.querySpend(`
SELECT
	COALESCE(SUM(COALESCE(cost_usd, 0)), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN COALESCE(cost_usd, 0) ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN billing = 'subscription' THEN 0 ELSE COALESCE(cost_usd, 0) END), 0),
	COUNT(*)
FROM records
WHERE provider = ?
  AND provider != ''
  AND (kind = '' OR kind != 'brain')
`, provider)
}

// Count returns how many rows are stored (any kind).
func (d *DB) Count() (int64, error) {
	var n int64
	if err := d.read.QueryRow(`SELECT COUNT(*) FROM records`).Scan(&n); err != nil {
		return 0, fmt.Errorf("ledger: count: %w", err)
	}
	return n, nil
}

func (d *DB) querySpend(query string, args ...any) (SpendTotal, error) {
	var (
		cost, sub, api float64
		requests       int64
	)
	// SELECT order: cost, subscription, api, requests — remap to SpendTotal field names.
	err := d.read.QueryRow(query, args...).Scan(&cost, &sub, &api, &requests)
	if err != nil {
		return SpendTotal{}, fmt.Errorf("ledger: spend query: %w", err)
	}
	return SpendTotal{
		CostUSD:         cost,
		SubscriptionUsd: sub,
		APIUsd:          api,
		Requests:        requests,
	}, nil
}

// tableHasColumn reports whether a table carries a column, using the live schema.
// The table name is a code constant, never user input.
func tableHasColumn(db *sql.DB, table, column string) bool {
	rows, err := db.Query(fmt.Sprintf("SELECT name FROM pragma_table_info('%s')", table))
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) != nil {
			return false
		}
		if name == column {
			return true
		}
	}
	return false
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func nullFloat(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullBool(v *bool) any {
	if v == nil {
		return nil
	}
	return boolToInt(*v)
}
