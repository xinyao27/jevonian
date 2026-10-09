package web

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func dashboardFixture() fs.FS {
	return fstest.MapFS{
		"index.html":       {Data: []byte(`<!doctype html><div id="root"></div><script src="/assets/app.js"></script>`)},
		"assets/app.js":    {Data: []byte(`console.log("dashboard")`)},
		"assets/app.css":   {Data: []byte(`body { color: black; }`)},
		"favicon.png":      {Data: []byte("\x89PNG\r\n\x1a\n")},
		".keep":            {Data: []byte("marker")},
		"api/private.json": {Data: []byte(`{"secret":true}`)},
	}
}

func request(h http.Handler, method, target string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(method, target, nil))
	return rr
}

func TestStaticAssetsAndSPA(t *testing.T) {
	h := staticHandler(dashboardFixture())
	for _, target := range []string{"/", "/index.html", "/models", "/models?source=legacy", "/providers", "/logs/request-123", "/keys?tab=new", "/routing/"} {
		rr := request(h, "GET", target)
		if rr.Code != 200 || !strings.Contains(rr.Body.String(), `id="root"`) || !strings.HasPrefix(rr.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("GET %s: %d %s %q", target, rr.Code, rr.Header().Get("Content-Type"), rr.Body.String())
		}
		if rr.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("index cache policy: %v", rr.Header())
		}
	}
	for target, contentType := range map[string]string{"/assets/app.js": "javascript", "/assets/app.css": "text/css", "/favicon.png": "image/png"} {
		rr := request(h, "GET", target)
		if rr.Code != 200 || !strings.Contains(rr.Header().Get("Content-Type"), contentType) || strings.Contains(rr.Body.String(), `id="root"`) {
			t.Fatalf("asset %s: %d %v", target, rr.Code, rr.Header())
		}
	}
	rr := request(h, "HEAD", "/assets/app.js")
	if rr.Code != 200 || rr.Body.Len() != 0 || rr.Header().Get("Content-Length") == "" {
		t.Fatalf("HEAD asset: %d %v %q", rr.Code, rr.Header(), rr.Body.String())
	}
	req := httptest.NewRequest("GET", "/assets/app.js", nil)
	req.Header.Set("Range", "bytes=0-6")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 206 || rr.Body.String() != "console" {
		t.Fatalf("range: %d %q", rr.Code, rr.Body.String())
	}
}

func TestReservedAndMissingPaths(t *testing.T) {
	h := staticHandler(dashboardFixture())
	for _, target := range []string{
		"/api", "/api/", "/api/unknown", "/api/private.json", "/v1", "/v1/unknown",
		"/health", "/healthz", "/stats", "/stats/unknown", "/assets/missing.js", "/missing.css",
		"/assets", "/assets/unknown", "/.keep", "/.git/config", "/../index.html", "/%2e%2e/index.html",
	} {
		if rr := request(h, "GET", target); rr.Code != 404 || strings.Contains(rr.Body.String(), `id="root"`) {
			t.Errorf("GET %s: %d %q", target, rr.Code, rr.Body.String())
		}
	}
	for _, method := range []string{"POST", "PUT", "DELETE", "OPTIONS", "HEAD"} {
		if rr := request(h, method, "/providers"); rr.Code != 404 {
			t.Errorf("%s SPA fallback: %d", method, rr.Code)
		}
	}
}

func TestCatchAllMuxPreservesAPI(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	})
	mux.Handle("/", staticHandler(dashboardFixture()))
	for _, target := range []string{"/api/state", "/v1/models"} {
		rr := request(mux, "GET", target)
		if rr.Code != 200 || rr.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("API shadowed at %s: %d %v", target, rr.Code, rr.Header())
		}
	}
	for _, target := range []string{"/api", "/api/unknown", "/v1", "/v1/unknown"} {
		if rr := request(mux, "GET", target); rr.Code != 404 {
			t.Errorf("unknown API %s: %d", target, rr.Code)
		}
	}
	if rr := request(mux, "GET", "/providers"); rr.Code != 200 {
		t.Fatalf("SPA behind mux: %d", rr.Code)
	}
}

func TestMissingBuildIsUnavailable(t *testing.T) {
	for _, files := range []fs.FS{fstest.MapFS{".keep": {Data: []byte("marker")}}, fstest.MapFS{"index.html": {Data: []byte(" ")}}} {
		h := staticHandler(files)
		rr := request(h, "GET", "/providers")
		if rr.Code != 503 || !strings.Contains(rr.Body.String(), "npm run web:build") || strings.Contains(rr.Body.String(), `id="root"`) {
			t.Fatalf("missing build: %d %q", rr.Code, rr.Body.String())
		}
		if rr := request(h, "GET", "/api/unknown"); rr.Code != 404 {
			t.Fatalf("missing build reserved path: %d", rr.Code)
		}
	}
}

func TestDirectoryOverride(t *testing.T) {
	t.Setenv("JEVONIAN_WEB_DEV", "")
	dir := t.TempDir()
	t.Setenv("JEVONIAN_WEB_DIR", dir)
	if rr := request(Handler(), "GET", "/"); rr.Code != 503 {
		t.Fatalf("empty override silently fell back: %d", rr.Code)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>override dashboard</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	if rr := request(Handler(), "GET", "/logs/123"); rr.Code != 200 || !strings.Contains(rr.Body.String(), "override dashboard") {
		t.Fatalf("override: %d %q", rr.Code, rr.Body.String())
	}
}

func TestDevOverride(t *testing.T) {
	t.Setenv("JEVONIAN_WEB_DIR", t.TempDir())
	t.Setenv("JEVONIAN_WEB_DEV", "http://127.0.0.1:15174/base/")
	h := Handler()
	rr := request(h, "GET", "/logs/hello%20world?tab=detail")
	if rr.Code != 302 || rr.Header().Get("Location") != "http://127.0.0.1:15174/base/logs/hello%20world?tab=detail" {
		t.Fatalf("dev redirect: %d %v", rr.Code, rr.Header())
	}
	for _, target := range []string{"/api", "/api/unknown", "/v1/unknown", "/.keep", "/../index.html"} {
		if rr := request(h, "GET", target); rr.Code != 404 || rr.Header().Get("Location") != "" {
			t.Errorf("dev reserved %s: %d %v", target, rr.Code, rr.Header())
		}
	}
	if rr := request(h, "POST", "/keys"); rr.Code != 404 {
		t.Fatalf("dev POST: %d", rr.Code)
	}
	for _, invalid := range []string{"javascript:alert(1)", "//example.com", "http://user:password@localhost", "http://localhost?x=1"} {
		t.Setenv("JEVONIAN_WEB_DEV", invalid)
		if rr := request(Handler(), "GET", "/"); rr.Code != 503 {
			t.Errorf("invalid dev URL %q: %d", invalid, rr.Code)
		}
	}
}

// Works in a source-only checkout as well as release builds; when a build is
// present, verify that the embedded entrypoint references actual built assets.
func TestEmbeddedDashboard(t *testing.T) {
	t.Setenv("JEVONIAN_WEB_DIR", "")
	t.Setenv("JEVONIAN_WEB_DEV", "")
	rr := request(Handler(), "GET", "/")
	index, err := fs.ReadFile(assets, "dist/index.html")
	if err != nil {
		if rr.Code != 503 {
			t.Fatalf("source-only checkout: %d", rr.Code)
		}
		return
	}
	if rr.Code != 200 || rr.Body.String() != string(index) || strings.Contains(string(index), "/src/main.tsx") {
		t.Fatalf("embedded entrypoint not a real build: %d", rr.Code)
	}
	entries, err := fs.ReadDir(assets, "dist/assets")
	if err != nil {
		t.Fatal(err)
	}
	var jsCount int
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".js") {
			continue
		}
		jsCount++
		asset := request(Handler(), "GET", "/assets/"+entry.Name())
		if asset.Code != 200 || asset.Body.Len() == 0 {
			t.Fatalf("embedded JS asset %s: %d", entry.Name(), asset.Code)
		}
	}
	if jsCount == 0 {
		t.Fatal("no embedded JavaScript bundle")
	}
}

func TestContentTypesDoNotDependOnTheHostRegistry(t *testing.T) {
	for name, want := range map[string]string{
		"index.html":        "text/html; charset=utf-8",
		"assets/app.js":     "text/javascript; charset=utf-8",
		"assets/app.CSS":    "text/css; charset=utf-8",
		"assets/font.woff2": "font/woff2",
		"favicon.png":       "image/png",
		"logo.svg":          "image/svg+xml",
	} {
		if got := contentTypeOf(name); got != want {
			t.Errorf("contentTypeOf(%q) = %q, want %q", name, got, want)
		}
	}
	// Other types still use the system table.
	if got := contentTypeOf("notes.pdf"); got != "" && !strings.HasPrefix(got, "application/pdf") {
		t.Errorf("contentTypeOf(notes.pdf) = %q", got)
	}
}
