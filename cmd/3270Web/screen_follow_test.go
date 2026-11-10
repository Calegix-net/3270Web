// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jnnngs/3270Web/internal/host"
	"github.com/jnnngs/3270Web/internal/render"
	"github.com/jnnngs/3270Web/internal/session"
)

// slowAnswerHost is a host that answers a key the way TSO in line mode does:
// the key returns at once with the keyboard free, and the screen it produces
// arrives a little later. The answer is painted the first time the screen is
// read after answerAt.
type slowAnswerHost struct {
	*host.MockHost
	mu       sync.Mutex
	answerAt time.Time
	answered bool
}

func (h *slowAnswerHost) answerIn(d time.Duration) time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.answerAt = time.Now().Add(d)
	h.answered = false
	return h.answerAt
}

func (h *slowAnswerHost) UpdateScreen() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.answerAt.IsZero() && !h.answered && !time.Now().Before(h.answerAt) {
		h.MockHost.Screen.Buffer[0] = []rune("ANSWER")
		h.answered = true
	}
	return nil
}

func (h *slowAnswerHost) GetScreenSnapshot() *host.Screen {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.MockHost.GetScreenSnapshot()
}

func (h *slowAnswerHost) SubmitOperatorInput(edit func(*host.Screen) string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.MockHost.SubmitOperatorInput(edit)
}

func (h *slowAnswerHost) SendKey(key string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.MockHost.SendKey(key)
}

func (h *slowAnswerHost) MoveCursor(row, col int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.MockHost.MoveCursor(row, col)
}

func newSlowAnswerApp(t *testing.T) (*App, *slowAnswerHost, *session.Session) {
	t.Helper()
	mh, err := host.NewMockHost("")
	if err != nil {
		t.Fatal(err)
	}
	mh.Connected = true
	mh.Screen = &host.Screen{Width: 80, Height: 24, Buffer: make([][]rune, 24)}
	for y := range mh.Screen.Buffer {
		mh.Screen.Buffer[y] = []rune(strings.Repeat(" ", 80))
	}
	h := &slowAnswerHost{MockHost: mh}
	app := &App{
		SessionManager: session.NewManager(),
		Renderer:       render.NewHtmlRenderer(),
		chaosEngines:   newChaosEngineStore(),
	}
	return app, h, app.SessionManager.CreateSession(h)
}

type streamEvent struct {
	at      time.Time
	payload map[string]interface{}
}

func readStream(t *testing.T, body *bufio.Scanner, events chan<- streamEvent) {
	t.Helper()
	for body.Scan() {
		line := body.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload); err != nil {
			continue
		}
		events <- streamEvent{at: time.Now(), payload: payload}
	}
	close(events)
}

// The screen a key produces has to reach the browser about when the host
// sends it. On a host that frees the keyboard before it answers, the screen
// fetched straight after the key is the old one, and the live stream is the
// only thing that will ever bring the answer. Polling that at its idle pace
// added most of a second to every TSO command; the stream follows the host
// closely for a short while after a key instead.
func TestScreenStreamFollowsTheHostAfterAKey(t *testing.T) {
	app, h, sess := newSlowAnswerApp(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/screen/stream", app.ScreenStreamHandler)
	r.POST("/submit/async", app.SubmitAsyncHandler)
	srv := httptest.NewServer(r)
	defer srv.Close()
	cookie := &http.Cookie{Name: "3270Web_session", Value: sess.ID}

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/screen/stream", nil)
	req.AddCookie(cookie)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer resp.Body.Close()
	events := make(chan streamEvent, 16)
	go readStream(t, bufio.NewScanner(resp.Body), events)

	select {
	case <-events:
	case <-time.After(3 * time.Second):
		t.Fatal("no first screen on the stream")
	}

	post, _ := http.NewRequest(http.MethodPost, srv.URL+"/submit/async", strings.NewReader(url.Values{"key": {"Enter"}}.Encode()))
	post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	post.AddCookie(cookie)
	presp, err := http.DefaultClient.Do(post)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	presp.Body.Close()
	if presp.StatusCode != http.StatusOK {
		t.Fatalf("submit returned %d", presp.StatusCode)
	}
	answeredAt := h.answerIn(150 * time.Millisecond)

	select {
	case ev := <-events:
		if lag := ev.at.Sub(answeredAt); lag > 350*time.Millisecond {
			t.Errorf("the host answered and the stream took %v to bring it; want it within a few hundred milliseconds", lag.Round(time.Millisecond))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the host's answer never reached the stream")
	}
}

// Away from a key, the stream keeps its idle pace: following the host closely
// is for the moments the operator is waiting on it, not for every open tab.
func TestScreenStreamIntervalIsIdleAwayFromAKey(t *testing.T) {
	if got := screenStreamInterval(time.Time{}, time.Now()); got != screenStreamPollInterval {
		t.Errorf("with no key sent, interval = %v, want %v", got, screenStreamPollInterval)
	}
	now := time.Now()
	if got := screenStreamInterval(now.Add(-time.Hour), now); got != screenStreamPollInterval {
		t.Errorf("an hour after a key, interval = %v, want %v", got, screenStreamPollInterval)
	}
	if got := screenStreamInterval(now.Add(-100*time.Millisecond), now); got >= screenStreamPollInterval {
		t.Errorf("just after a key, interval = %v, want shorter than the idle %v", got, screenStreamPollInterval)
	}
}

// Two paths bring a new screen to the browser, the fetch after a key and the
// live stream, and they can arrive in either order. Each payload carries a
// number that only goes up, so the browser can keep the newer screen instead
// of whichever answer happened to land last.
func TestScreenPayloadsAreNumberedInOrder(t *testing.T) {
	app, h, sess := newSlowAnswerApp(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/screen/content", app.ScreenContentHandler)

	seqOf := func(payload map[string]interface{}) float64 {
		t.Helper()
		v, ok := payload["seq"].(float64)
		if !ok {
			t.Fatalf("payload has no numeric seq: %v", payload["seq"])
		}
		return v
	}

	lastHTML := ""
	data, changed := app.renderScreenStreamUpdate(sess, &lastHTML)
	if !changed {
		t.Fatal("first stream render reported unchanged")
	}
	var first map[string]interface{}
	if err := json.Unmarshal(data, &first); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/screen/content", nil)
	req.AddCookie(&http.Cookie{Name: "3270Web_session", Value: sess.ID})
	r.ServeHTTP(w, req)
	var content map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &content); err != nil {
		t.Fatalf("content: %v (%s)", err, w.Body.String())
	}

	h.answerIn(0)
	data, changed = app.renderScreenStreamUpdate(sess, &lastHTML)
	if !changed {
		t.Fatal("stream render after a host change reported unchanged")
	}
	var second map[string]interface{}
	if err := json.Unmarshal(data, &second); err != nil {
		t.Fatal(err)
	}

	a, b, c := seqOf(first), seqOf(content), seqOf(second)
	if !(a < b && b < c) {
		t.Errorf("screens read in the order stream, content, stream are numbered %v, %v, %v; want increasing", a, b, c)
	}
}
