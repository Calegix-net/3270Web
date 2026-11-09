// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bufio"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// Serving under a path prefix, for a reverse proxy that publishes this instance
// at something like https://example.com/3270 and passes the path unchanged.
//
// The routes do not know about the prefix. withBasePath takes it off every
// request before the router sees it and puts it back on what the response
// says about URLs (Location and Set-Cookie). The only other things that need
// to know are the ones the browser reads: the templates, through the basePath
// template function, and the scripts, through web/static/base-path.js.

// basePathEnv names the setting. Unset or empty means served from the root.
const basePathEnv = "BASE_PATH"

// healthPath stays reachable without the prefix, because the container's
// HEALTHCHECK has no way to know about a setting chosen by whoever deployed it.
const healthPath = "/healthz"

// basePathPattern is deliberately narrower than what a URL path allows. The
// value is concatenated into HTML attributes, a Location header, a Set-Cookie
// attribute and script-built URLs, so it must mean the same thing in all of
// them unescaped.
var basePathPattern = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+)+$`)

// normalizeBasePath returns the prefix with one leading slash and no trailing
// slash, or "" for the root. A value that cannot be a safe prefix is an error
// rather than something to tidy up: an operator who typed a prefix and got a
// different one would be left debugging a proxy that looks correct.
func normalizeBasePath(raw string) (string, error) {
	value := strings.TrimRight(strings.TrimSpace(raw), "/")
	if value == "" {
		return "", nil
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	if !basePathPattern.MatchString(value) {
		return "", fmt.Errorf("%s=%q is not a usable path prefix: use path segments of letters, digits, '.', '_', '~' and '-', such as /3270", basePathEnv, raw)
	}
	for _, segment := range strings.Split(value[1:], "/") {
		if segment == "." || segment == ".." {
			return "", fmt.Errorf("%s=%q must not contain %q segments", basePathEnv, raw, segment)
		}
	}
	// The unprefixed health check would have to answer and redirect at once.
	if value == healthPath {
		return "", fmt.Errorf("%s=%q collides with the health check at %s", basePathEnv, raw, healthPath)
	}
	return value, nil
}

// templateFuncs is what every page template can call. {{basePath}} comes before
// any rooted URL in an attribute, and prints nothing when served from the root.
func (app *App) templateFuncs() template.FuncMap {
	return template.FuncMap{
		"basePath": func() string { return app.basePath },
	}
}

// prefixedPageBaseURL is pageBaseURL with the prefix on it, for the absolute URLs
// in a page's social preview tags. Empty stays empty, which is what tells the
// template to leave those tags out.
func (app *App) prefixedPageBaseURL(c *gin.Context) string {
	base := pageBaseURL(c)
	if base == "" {
		return ""
	}
	return base + app.basePath
}

// withBasePath serves next under prefix. With no prefix it returns next itself,
// so a deployment that does not set one runs exactly the handler it always did.
func withBasePath(prefix string, next http.Handler) http.Handler {
	if prefix == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Gin puts this header in front of the paths it redirects to, and the
		// response wrapper below is already adding the prefix.
		r.Header.Del("X-Forwarded-Prefix")

		switch {
		case r.URL.Path == prefix:
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.NotFound(w, r)
				return
			}
			target := prefix + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusFound)
		case strings.HasPrefix(r.URL.Path, prefix+"/"):
			// RawPath is the encoded form, and a prefix spelled differently
			// there is not this prefix. http.StripPrefix treats it the same way.
			if r.URL.RawPath != "" && !strings.HasPrefix(r.URL.RawPath, prefix+"/") {
				http.NotFound(w, r)
				return
			}
			stripped := new(http.Request)
			*stripped = *r
			stripped.URL = new(url.URL)
			*stripped.URL = *r.URL
			stripped.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
			if r.URL.RawPath != "" {
				stripped.URL.RawPath = strings.TrimPrefix(r.URL.RawPath, prefix)
			}
			next.ServeHTTP(&basePathWriter{ResponseWriter: w, prefix: prefix}, stripped)
		case r.URL.Path == healthPath && (r.Method == http.MethodGet || r.Method == http.MethodHead):
			next.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

// basePathWriter puts the prefix back on the headers that name a path on this
// server. The headers are finished the moment the status goes out, so that is
// when it looks at them.
//
// Gin's own writer asserts Flusher, Hijacker and CloseNotifier on whatever it
// wraps and panics or fails without them, and the screen stream and MCP
// transport both flush, so all three are forwarded.
type basePathWriter struct {
	http.ResponseWriter
	prefix      string
	wroteHeader bool
	// dropBody discards the body of a redirect, whose only content is a link
	// to the unprefixed target that http.Redirect wrote before this saw it.
	dropBody bool
}

func (w *basePathWriter) rewriteHeaders(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	header := w.Header()
	if location := header.Get("Location"); strings.HasPrefix(location, "/") {
		header.Set("Location", w.prefix+location)
		if status >= 300 && status < 400 {
			w.dropBody = true
			header.Del("Content-Type")
			header.Del("Content-Length")
		}
	}
	if cookies := header.Values("Set-Cookie"); len(cookies) > 0 {
		rewritten := make([]string, len(cookies))
		for i, cookie := range cookies {
			rewritten[i] = scopeCookieToPrefix(cookie, w.prefix)
		}
		header["Set-Cookie"] = rewritten
	}
}

// scopeCookieToPrefix moves a Set-Cookie value's Path under prefix, adding one
// if it has none. Another application behind the same proxy then never receives
// this one's cookies, and cannot overwrite them.
func scopeCookieToPrefix(cookie, prefix string) string {
	parts := strings.Split(cookie, ";")
	for i, part := range parts[1:] {
		attribute := strings.TrimSpace(part)
		if len(attribute) < 5 || !strings.EqualFold(attribute[:5], "path=") {
			continue
		}
		path := attribute[5:]
		if path == "/" || !strings.HasPrefix(path, "/") {
			path = ""
		}
		parts[i+1] = " Path=" + prefix + path
		return strings.Join(parts, ";")
	}
	return cookie + "; Path=" + prefix
}

func (w *basePathWriter) WriteHeader(status int) {
	// An informational status is followed by the real one.
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.rewriteHeaders(status)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *basePathWriter) Write(data []byte) (int, error) {
	w.rewriteHeaders(http.StatusOK)
	if w.dropBody {
		return len(data), nil
	}
	return w.ResponseWriter.Write(data)
}

func (w *basePathWriter) ReadFrom(src io.Reader) (int64, error) {
	w.rewriteHeaders(http.StatusOK)
	if w.dropBody {
		return io.Copy(io.Discard, src)
	}
	// Through the underlying writer, which uses sendfile for a static asset
	// where it can.
	return io.Copy(w.ResponseWriter, src)
}

func (w *basePathWriter) Flush() {
	w.rewriteHeaders(http.StatusOK)
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *basePathWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("the response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (w *basePathWriter) CloseNotify() <-chan bool {
	if notifier, ok := w.ResponseWriter.(http.CloseNotifier); ok { //nolint:staticcheck // Gin's Context.Stream still calls it.
		return notifier.CloseNotify()
	}
	return make(chan bool)
}

// Unwrap lets http.NewResponseController reach the connection underneath.
func (w *basePathWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
