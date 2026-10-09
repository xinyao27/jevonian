package paths

import "testing"

func TestSQLiteFileURL(t *testing.T) {
	for in, want := range map[string]string{
		"/home/me/.local/share/jevonian/ledger.sqlite": "file:///home/me/.local/share/jevonian/ledger.sqlite",
		"C:/Users/me/ledger.sqlite":                    "file:///C:/Users/me/ledger.sqlite",
		"/tmp/with space/ledger.sqlite":                "file:///tmp/with%20space/ledger.sqlite",
	} {
		u := SQLiteFileURL(in)
		if got := u.String(); got != want {
			t.Errorf("SQLiteFileURL(%q) = %q, want %q", in, got, want)
		}
		if u.Host != "" {
			t.Errorf("SQLiteFileURL(%q) has host %q; SQLite reads a host as an authority and fails", in, u.Host)
		}
	}
}
