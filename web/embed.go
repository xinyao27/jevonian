// Package web serves the existing React dashboard from assets embedded at build
// time. Build release assets with npm run web:build before compiling the binary.
package web

import (
	"bytes"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

// Generate uses the repository's existing npm/Vite toolchain. The tracked marker
// keeps source-only Go builds compilable; it is never served as a dashboard.
//go:generate npm --prefix .. run web:build

// all: includes the tracked .keep marker even before the first frontend build.
// Vite copies public/.keep back into dist after emptying the output directory.
//
//go:embed all:dist
var assets embed.FS

// Handler returns the dashboard HTTP handler. JEVONIAN_WEB_DEV takes precedence
// and redirects GET requests to a Vite server URL. JEVONIAN_WEB_DIR selects a
// built dashboard directory instead of the embedded files. Environment values
// are captured when the handler is constructed, not on every request.
//
// Mount this only on the loopback server's catch-all route; /api and /v1 must
// remain owned by the server. Missing builds return 503 rather than a fake UI.
func Handler() http.Handler {
	if dev := strings.TrimSpace(os.Getenv("JEVONIAN_WEB_DEV")); dev != "" {
		return devHandler(dev)
	}
	if dir := os.Getenv("JEVONIAN_WEB_DIR"); dir != "" {
		return staticHandler(os.DirFS(dir))
	}
	built, err := fs.Sub(assets, "dist")
	if err != nil {
		return unavailableHandler()
	}
	return staticHandler(built)
}

func reserved(p string) bool {
	for _, prefix := range []string{"/api", "/v1", "/health", "/healthz", "/stats"} {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

// Reject unclean or hidden paths rather than normalizing traversal into a SPA
// route. Hidden build markers and directory listings are never exposed.
func validPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return false
	}
	for _, segment := range strings.Split(p, "/") {
		if strings.HasPrefix(segment, ".") {
			return false
		}
	}
	return true
}

func staticHandler(files fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reserved(r.URL.Path) || !validPath(r.URL.Path) ||
			(r.Method != http.MethodGet && r.Method != http.MethodHead) {
			http.NotFound(w, r)
			return
		}
		// Require the real entrypoint even when an isolated asset exists. An
		// explicit filesystem override never falls back to the embedded UI.
		index, err := fs.ReadFile(files, "index.html")
		if err != nil || len(bytes.TrimSpace(index)) == 0 {
			unavailableHandler().ServeHTTP(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			serveFile(w, r, "index.html", index)
			return
		}
		if fs.ValidPath(name) {
			if data, err := fs.ReadFile(files, name); err == nil {
				serveFile(w, r, name, data)
				return
			}
		}
		// Only GET navigation routes may fall back. A missing JS/CSS/image
		// must be a 404, not HTML with a successful status.
		if r.Method != http.MethodGet || path.Ext(strings.TrimSuffix(name, "/")) != "" ||
			name == "assets" || strings.HasPrefix(name, "assets/") {
			http.NotFound(w, r)
			return
		}
		serveFile(w, r, "index.html", index)
	})
}

// contentTypes covers every file type the dashboard ships. It is checked before
// mime.TypeByExtension because that function reads the host: on Windows it reads
// the registry, where a wrong .js entry (text/plain) makes browsers refuse the
// module scripts, and where the first lookup needs an extra OS thread that locked
// down machines may refuse (the process then dies with "failed to create new OS
// thread").
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".map":   "application/json",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".webp":  "image/webp",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".txt":   "text/plain; charset=utf-8",
}

func contentTypeOf(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if contentType, ok := contentTypes[ext]; ok {
		return contentType
	}
	return mime.TypeByExtension(ext)
}

func serveFile(w http.ResponseWriter, r *http.Request, name string, data []byte) {
	if contentType := contentTypeOf(name); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The entrypoint must not cache references to an obsolete hashed bundle.
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	// Embedded files have no useful modification timestamp. ServeContent
	// still supplies Content-Length, HEAD and Range support.
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

func unavailableHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Jevonian dashboard assets are unavailable. Run npm run web:build before compiling the Go binary, or set JEVONIAN_WEB_DIR to a built dashboard directory (JEVONIAN_WEB_DEV for live development).", http.StatusServiceUnavailable)
	})
}

func devHandler(raw string) http.Handler {
	target, err := url.Parse(raw)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") ||
		target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if reserved(r.URL.Path) || !validPath(r.URL.Path) || r.Method != http.MethodGet {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "JEVONIAN_WEB_DEV must be an absolute http or https URL without credentials, query or fragment.", http.StatusServiceUnavailable)
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reserved(r.URL.Path) || !validPath(r.URL.Path) || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		location := strings.TrimRight(target.String(), "/") + r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			location += "?" + r.URL.RawQuery
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, location, http.StatusFound)
	})
}
