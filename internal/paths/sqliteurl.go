package paths

import (
	"net/url"
	"path/filepath"
	"strings"
)

// SQLiteFileURL returns the file: URL SQLite expects for an absolute path.
//
// A Windows path such as C:\Users\me\ledger.sqlite has to become
// file:///C:/Users/me/ledger.sqlite. As a bare url.URL path, "C:" would print as
// the host and SQLite would refuse it with "invalid uri authority". On macOS and
// Linux the path already starts with "/", so nothing changes there.
func SQLiteFileURL(abs string) url.URL {
	path := filepath.ToSlash(abs)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return url.URL{Scheme: "file", Path: path}
}
