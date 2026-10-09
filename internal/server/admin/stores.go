package admin

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	"github.com/xinyao27/jevonian/internal/keys"
	"github.com/xinyao27/jevonian/internal/paths"
	_ "modernc.org/sqlite"
)

// SQLiteLogs reads the same SQLite ledger written by internal/ledger. It owns
// a separate read connection; Close it at shutdown. rowid keeps append cursors
// stable even when a historical record has a timestamp older than prior rows.
type SQLiteLogs struct {
	db         *sql.DB
	projection string
	columns    map[string]bool
}

func OpenSQLiteLogs(path string) (*SQLiteLogs, error) {
	if path == "" {
		path = paths.LedgerDBPath()
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	dsn := paths.SQLiteFileURL(abs)
	params := url.Values{}
	params.Add("_pragma", "busy_timeout(5000)")
	dsn.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	s := &SQLiteLogs{db: db}
	if err := s.prepare(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}
func (s *SQLiteLogs) Close() error { return s.db.Close() }
func (s *SQLiteLogs) Records() ([]LogRecord, error) {
	rows, err := s.db.Query("SELECT " + s.projection + " FROM records ORDER BY rowid ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return decodeLogRows(rows)
}

func decodeLogRows(rows *sql.Rows) ([]LogRecord, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []LogRecord{}
	for rows.Next() {
		r, err := decodeLogRow(rows, columns)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func decodeLogRow(rows *sql.Rows, columns []string) (LogRecord, error) {
	names := map[string]string{"request_id": "requestId", "latency_ms": "latencyMs", "prompt_tokens": "promptTokens", "completion_tokens": "completionTokens", "cache_read_tokens": "cacheReadTokens", "cache_write_tokens": "cacheWriteTokens", "cost_usd": "costUsd", "pricing_known": "pricingKnown", "requested_model": "requestedModel", "effort_note": "effortNote", "saved_tokens": "savedTokens", "ttft_ms": "ttftMs", "key_id": "keyId", "key_name": "keyName", "switch_penalty_usd": "switchPenaltyUsd", "brain_channel": "brainChannel", "cache_keep": "cacheKeep", "exclusive_input": "exclusiveInput"}
	required := map[string]bool{"id": true, "ts": true, "session": true, "path": true, "provider": true, "model": true, "stream": true, "status": true, "latencyMs": true, "promptTokens": true, "completionTokens": true, "cacheReadTokens": true, "cacheWriteTokens": true, "costUsd": true, "pricingKnown": true}
	v := make([]any, len(columns))
	ptr := make([]any, len(columns))
	for i := range v {
		ptr[i] = &v[i]
	}
	if err := rows.Scan(ptr...); err != nil {
		return nil, err
	}
	r := LogRecord{}
	for i, col := range columns {
		if col == "ts_ms" {
			continue
		}
		key := col
		if n := names[col]; n != "" {
			key = n
		}
		x := v[i]
		if b, ok := x.([]byte); ok {
			x = string(b)
		}
		if x == nil && !required[key] {
			continue
		}
		if x == "" && !required[key] {
			continue
		}
		if key == "stream" || key == "pricingKnown" || key == "routed" || key == "exclusiveInput" {
			x = number(x) != 0
		}
		if key == "tries" || key == "skipped" || key == "cache" {
			var parsed any
			if json.Unmarshal([]byte(text(x)), &parsed) == nil {
				x = parsed
			} else {
				continue
			}
		}
		r[key] = x
	}
	return r, nil
}

// JSONLLogs is a compatibility source for the TS ledger. Torn trailing lines
// are ignored until complete; malformed records do not hide subsequent rows.
type JSONLLogs struct{ Path string }

func (s JSONLLogs) Records() ([]LogRecord, error) {
	path := s.Path
	if path == "" {
		path = paths.LedgerPath()
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return []LogRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := []LogRecord{}
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, os.ErrClosed) {
				return nil, err
			}
			break
		}
		var r LogRecord
		if json.Unmarshal(line, &r) == nil && r != nil {
			out = append(out, r)
		}
	}
	return out, nil
}

// FileKeys adapts the shared keys.Store to the admin contract. All mutations
// use the store's lock, including its background usage flusher.
type FileKeys struct {
	Store   *keys.Store
	DataDir string
	mu      sync.Mutex
}

func OpenKeys(dataDir string, store *keys.Store) *FileKeys {
	if store == nil {
		store = keys.Open(dataDir, nil)
	}
	return &FileKeys{Store: store, DataDir: dataDir}
}
func (s *FileKeys) HasKeys() bool                          { return s.Store.HasKeys() }
func (s *FileKeys) ListWithUsage() ([]keys.Summary, error) { return s.Store.ListWithUsage() }
func (s *FileKeys) Create(opts keys.CreateOptions) (keys.CreateResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Store.Create(opts)
}
func (s *FileKeys) change(id string, patch *KeyPatch) (bool, error) {
	if patch == nil {
		return s.Store.Revoke(id)
	}
	_, found, err := s.Store.Update(id, keys.UpdateOptions{Name: patch.Name, LimitUSD: patch.LimitUSD, HasLimit: patch.HasLimit})
	return found, err
}
func (s *FileKeys) Update(id string, p KeyPatch) (keys.Summary, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	found, err := s.change(id, &p)
	if err != nil || !found {
		return keys.Summary{}, found, err
	}
	all, err := s.Store.ListWithUsage()
	if err != nil {
		return keys.Summary{}, false, err
	}
	for _, k := range all {
		if k.ID == id {
			return k, true, nil
		}
	}
	return keys.Summary{}, false, fmt.Errorf("updated key could not be read")
}
func (s *FileKeys) Revoke(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.change(id, nil)
}
