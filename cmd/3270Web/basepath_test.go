// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestNormalizeBasePath(t *testing.T) {
	valid := map[string]string{
		"":             "",
		"   ":          "",
		"/":            "",
		"///":          "",
		"/3270":        "/3270",
		"3270":         "/3270",
		"/3270/":       "/3270",
		" /3270/ ":     "/3270",
		"/apps/3270":   "/apps/3270",
		"/a.b_c~d-e/f": "/a.b_c~d-e/f",
	}
	for raw, want := range valid {
		got, err := normalizeBasePath(raw)
		if err != nil {
			t.Errorf("normalizeBasePath(%q) returned %v", raw, err)
		}
		if got != want {
			t.Errorf("normalizeBasePath(%q) = %q, want %q", raw, got, want)
		}
	}

	for _, raw := range []string{
		"//3270",
		"/a//b",
		"/..",
		"/a/../b",
		"/./a",
		"/a b",
		"/a%2Fb",
		"/a?b=c",
		"/a#b",
		`/a\b`,
		`/a"b`,
		"/a'b",
		"/<a>",
		"/a;b",
		"/a\nb",
		"https://example.com/3270",
		"/healthz",
		"/healthz/",
	} {
		if got, err := normalizeBasePath(raw); err == nil {
			t.Errorf("normalizeBasePath(%q) = %q, want an error", raw, got)
		}
	}
}

// pathEcho answers with the path it was given, the way a route would see it.
var pathEcho = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "path=%s raw=%s query=%s", r.URL.Path, r.URL.RawPath, r.URL.RawQuery)
})

func serveThrough(prefix string, next http.Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	withBasePath(prefix, next).ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestBasePathStripsThePrefix(t *testing.T) {
	cases := map[string]string{
		"/3270/":                 "path=/ raw= query=",
		"/3270/screen":           "path=/screen raw= query=",
		"/3270/screen?a=1":       "path=/screen raw= query=a=1",
		"/3270/3270":             "path=/3270 raw= query=",
		"/3270/api/x%2Fy":        "path=/api/x/y raw=/api/x%2Fy query=",
		"/3270/static/style.css": "path=/static/style.css raw= query=",
	}
	for target, want := range cases {
		rec := serveThrough("/3270", pathEcho, http.MethodGet, target)
		if rec.Code != http.StatusOK || rec.Body.String() != want {
			t.Errorf("GET %s = %d %q, want 200 %q", target, rec.Code, rec.Body.String(), want)
		}
	}
}

func TestBasePathRefusesEverythingOutsideThePrefix(t *testing.T) {
	for _, target := range []string{
		"/",
		"/screen",
		"/login",
		"/static/style.css",
		"/api/v1/sessions",
		"/32701",
		"/32701/screen",
		"/3270%2Fscreen",
		"//3270/screen",
		"/other/3270/screen",
		"/healthz/extra",
	} {
		rec := serveThrough("/3270", pathEcho, http.MethodGet, target)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", target, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "path=") {
			t.Errorf("GET %s reached the application", target)
		}
	}
}

func TestBasePathRedirectsThePrefixItself(t *testing.T) {
	rec := serveThrough("/3270", pathEcho, http.MethodGet, "/3270?embed=1")
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/3270/?embed=1" {
		t.Errorf("GET /3270 = %d to %q", rec.Code, rec.Header().Get("Location"))
	}
	if rec := serveThrough("/3270", pathEcho, http.MethodPost, "/3270"); rec.Code != http.StatusNotFound {
		t.Errorf("POST /3270 = %d, want 404", rec.Code)
	}
}

func TestBasePathKeepsHealthCheckWithoutPrefix(t *testing.T) {
	for _, target := range []string{"/healthz", "/3270/healthz"} {
		rec := serveThrough("/3270", pathEcho, http.MethodGet, target)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "path=/healthz") {
			t.Errorf("GET %s = %d %q", target, rec.Code, rec.Body.String())
		}
	}
	if rec := serveThrough("/3270", pathEcho, http.MethodPost, "/healthz"); rec.Code != http.StatusNotFound {
		t.Errorf("POST /healthz = %d, want 404", rec.Code)
	}
}

func TestBasePathRewritesLocation(t *testing.T) {
	cases := map[string]string{
		"/":                     "/3270/",
		"/screen":               "/3270/screen",
		"/?disconnected=1":      "/3270/?disconnected=1",
		"https://idp.test/auth": "https://idp.test/auth",
		// A rooted Location stays inside the prefix however it is written, so
		// nothing the application emits can become an offsite redirect here.
		"//elsewhere.test/x": "/3270//elsewhere.test/x",
	}
	for location, want := range cases {
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", location)
			w.WriteHeader(http.StatusFound)
		})
		rec := serveThrough("/3270", next, http.MethodPost, "/3270/x")
		if got := rec.Header().Get("Location"); got != want {
			t.Errorf("Location %q became %q, want %q", location, got, want)
		}
	}
}

// http.Redirect writes a link to the target it was given, which is the
// unprefixed one, so a browser that showed the body would leave the prefix.
func TestBasePathDropsTheRedirectBody(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/screen", http.StatusFound)
	})
	rec := serveThrough("/3270", next, http.MethodGet, "/3270/x")
	if rec.Header().Get("Location") != "/3270/screen" {
		t.Errorf("Location = %q", rec.Header().Get("Location"))
	}
	if rec.Body.Len() != 0 {
		t.Errorf("redirect kept a body: %q", rec.Body.String())
	}
}

func TestBasePathRewritesLocationWhenTheBodyCommitsTheHeaders(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/thing/1")
		fmt.Fprint(w, "made")
	})
	rec := serveThrough("/3270", next, http.MethodPost, "/3270/x")
	if rec.Header().Get("Location") != "/3270/thing/1" {
		t.Errorf("Location = %q", rec.Header().Get("Location"))
	}
	if rec.Body.String() != "made" {
		t.Errorf("a non-redirect lost its body: %q", rec.Body.String())
	}
}

func TestScopeCookieToPrefix(t *testing.T) {
	cases := map[string]string{
		"a=1; Path=/; Max-Age=60; HttpOnly": "a=1; Path=/3270; Max-Age=60; HttpOnly",
		"a=1; path=/; Secure":               "a=1; Path=/3270; Secure",
		"a=1; HttpOnly; Path=/sub":          "a=1; HttpOnly; Path=/3270/sub",
		"a=1; HttpOnly":                     "a=1; HttpOnly; Path=/3270",
		"a=1":                               "a=1; Path=/3270",
		"path=/x; Secure":                   "path=/x; Secure; Path=/3270",
	}
	for cookie, want := range cases {
		if got := scopeCookieToPrefix(cookie, "/3270"); got != want {
			t.Errorf("scopeCookieToPrefix(%q) = %q, want %q", cookie, got, want)
		}
	}
}

func TestBasePathScopesEveryCookieThroughGin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/set", func(c *gin.Context) {
		c.SetCookie("one", "1", 60, "/", "", true, true)
		c.SetCookie("two", "", -1, "/", "", false, true)
		c.String(http.StatusOK, "ok")
	})
	rec := serveThrough("/3270", r, http.MethodGet, "/3270/set")
	cookies := rec.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("got %d cookies", len(cookies))
	}
	for _, cookie := range cookies {
		if cookie.Path != "/3270" {
			t.Errorf("cookie %s has Path %q", cookie.Name, cookie.Path)
		}
	}
	if !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].MaxAge != 60 {
		t.Errorf("attributes were lost: %+v", cookies[0])
	}
}

func TestBasePathUnsetIsThePlainHandler(t *testing.T) {
	var called int
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		http.SetCookie(w, &http.Cookie{Name: "a", Value: "1", Path: "/"})
		http.Redirect(w, r, "/screen", http.StatusFound)
	})
	rec := httptest.NewRecorder()
	withBasePath("", next).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/anything", nil))
	if called != 1 {
		t.Fatalf("handler called %d times", called)
	}
	if rec.Header().Get("Location") != "/screen" {
		t.Errorf("Location = %q", rec.Header().Get("Location"))
	}
	if cookie := rec.Result().Cookies()[0]; cookie.Path != "/" {
		t.Errorf("cookie Path = %q", cookie.Path)
	}
	if !strings.Contains(rec.Body.String(), `href="/screen"`) {
		t.Errorf("body changed: %q", rec.Body.String())
	}
}

// Gin's trailing-slash redirect prepends X-Forwarded-Prefix, which some proxies
// send. The wrapper adds the prefix as well, and twice would leave the prefix.
func TestBasePathIgnoresForwardedPrefix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/admin", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	req := httptest.NewRequest(http.MethodGet, "/3270/admin/", nil)
	req.Header.Set("X-Forwarded-Prefix", "/3270")
	rec := httptest.NewRecorder()
	withBasePath("/3270", r).ServeHTTP(rec, req)
	if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != "/3270/admin" {
		t.Errorf("GET /3270/admin/ = %d to %q", rec.Code, rec.Header().Get("Location"))
	}
}

// The screen stream and the MCP transport flush through Gin's writer, which
// asserts these interfaces on whatever it wraps. A real server rather than a
// recorder, because a recorder cannot hijack.
func TestBasePathForwardsStreamingAndHijacking(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/stream", func(c *gin.Context) {
		c.Header("Location", "/committed-by-flush")
		c.Writer.WriteString("first\n")
		c.Writer.Flush()
		select {
		case <-c.Writer.CloseNotify():
		default:
		}
		c.Writer.WriteString("second\n")
	})
	r.GET("/hijack", func(c *gin.Context) {
		conn, buf, err := c.Writer.Hijack()
		if err != nil {
			t.Errorf("Hijack: %v", err)
			return
		}
		defer conn.Close()
		fmt.Fprint(buf, "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
		buf.Flush()
	})
	srv := httptest.NewServer(withBasePath("/3270", r))
	defer srv.Close()

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(srv.URL + "/3270/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Location"); got != "/3270/committed-by-flush" {
		t.Errorf("Location = %q", got)
	}
	reader := bufio.NewReader(resp.Body)
	if line, _ := reader.ReadString('\n'); line != "first\n" {
		t.Errorf("first line = %q", line)
	}
	if rest, _ := io.ReadAll(reader); string(rest) != "second\n" {
		t.Errorf("rest = %q", rest)
	}

	hijacked, err := client.Get(srv.URL + "/3270/hijack")
	if err != nil {
		t.Fatal(err)
	}
	hijacked.Body.Close()
	if hijacked.StatusCode != http.StatusNoContent {
		t.Errorf("hijacked status = %d", hijacked.StatusCode)
	}
}

func routedApp(t *testing.T, basePath string) (http.Handler, *App) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv(basePathEnv, basePath)
	t.Setenv("AUTH_MODE", "local")
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	app := newAppAt(root, t.TempDir())
	router, err := buildRouter(app)
	if err != nil {
		t.Fatalf("buildRouter: %v", err)
	}
	return withBasePath(app.basePath, router), app
}

func TestBuildRouterRefusesAnUnsafeBasePath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv(basePathEnv, "/a/../b")
	if _, err := buildRouter(newAppAt(t.TempDir(), t.TempDir())); err == nil {
		t.Fatal("buildRouter accepted an unsafe BASE_PATH")
	}
}

// absoluteAttr finds a URL in a page that would leave the prefix.
var absoluteAttr = regexp.MustCompile(`\b(?:href|src|action|formaction)="/[^"]*"`)

func TestPagesRenderUnderTheirPrefix(t *testing.T) {
	handler, _ := routedApp(t, "/3270")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/3270/setup", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /3270/setup = %d", rec.Code)
	}
	page := rec.Body.String()
	for _, want := range []string{
		`<meta name="base-path" content="/3270">`,
		`<script src="/3270/static/base-path.js"></script>`,
		`action="/3270/setup"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("setup page is missing %s", want)
		}
	}
	for _, attr := range absoluteAttr.FindAllString(page, -1) {
		if !strings.Contains(attr, `="/3270/`) {
			t.Errorf("setup page has %s", attr)
		}
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/3270/screen", nil))
	if got := rec.Header().Get("Location"); got != "/3270/setup" {
		t.Errorf("an instance with no accounts redirected to %q", got)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/3270/static/base-path.js", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("GET /3270/static/base-path.js = %d", rec.Code)
	}
}

func TestPagesRenderWithoutAPrefixWhenUnset(t *testing.T) {
	handler, _ := routedApp(t, "")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/setup", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /setup = %d", rec.Code)
	}
	page := rec.Body.String()
	for _, want := range []string{
		`<meta name="base-path" content="">`,
		`<script src="/static/base-path.js"></script>`,
		`action="/setup"`,
		`href="/static/favicon-32.png"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("setup page is missing %s", want)
		}
	}
}

// The next two keep a merge honest. A new link or navigation written the way
// the rest of the application used to write them would work at the root, pass
// every other test, and quietly leave the prefix for anyone serving under one.
func TestTemplatesKeepURLsUnderPrefix(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "web", "templates", "*.html"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("glob templates: %v (%d found)", err, len(paths))
	}
	rooted := regexp.MustCompile(`\b(?:href|src|action|formaction|poster|srcset)\s*=\s*["']?/`)
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range rooted.FindAllString(string(data), -1) {
			t.Errorf("%s: %s... starts a rooted URL; write {{basePath}}/ in front of the path", filepath.Base(path), match)
		}
		body := string(data)
		if strings.Contains(body, "<head>") && !strings.Contains(body, `{{template "base-path"}}`) {
			t.Errorf(`%s: a page with a <head> needs {{template "base-path"}} first, or its scripts cannot find the prefix`, filepath.Base(path))
		}
	}
}

func TestStaticScriptsKeepNavigationsUnderPrefix(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "web", "static", "*.js"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("glob scripts: %v (%d found)", err, len(paths))
	}
	// base-path.js handles fetch, XMLHttpRequest and EventSource. These have no
	// such hook, so a rooted path has to go through basePath.url.
	sinks := regexp.MustCompile(`(?:\.href\s*=|\.src\s*=|\.action\s*=|\.formAction\s*=|location\s*=|location\.(?:assign|replace)\(|window\.open\(|new WebSocket\(|new Worker\(|sendBeacon\(|setAttribute\(\s*["'](?:href|src|action)["']\s*,)\s*["'\x60]/`)
	// A selector or pathname comparison written against an exact route stops
	// matching once the prefix is on the page.
	exact := regexp.MustCompile(`\[action=|\[href=["']/|pathname\s*===?\s*["'\x60]/`)
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(data), "\n") {
			if match := sinks.FindString(line); match != "" {
				t.Errorf("%s: %s... navigates to a rooted path; use window.basePath.url", filepath.Base(path), match)
			}
			if match := exact.FindString(line); match != "" {
				t.Errorf("%s: %s... compares against an exact route; use [action$=...] or window.basePath.strip", filepath.Base(path), match)
			}
		}
	}
}
