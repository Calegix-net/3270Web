// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jnnngs/3270Web/internal/session"
)

const (
	// screenStreamPollInterval is how often the handler checks the host for
	// changes to push. Matches workflow.js's playbackFastMs so an idle
	// screen refreshes about as promptly as an active chaos/playback run.
	screenStreamPollInterval = 700 * time.Millisecond
	// screenStreamFollowInterval and screenStreamFollowWindow are the pace
	// after a key. A host is under no obligation to answer before it frees
	// the keyboard, and TSO in line mode routinely does not: the key returns,
	// the screen fetched straight after it is the old one, and the answer
	// arrives a fraction of a second later. This stream is then the only
	// thing that will bring it, and at the idle pace that added most of a
	// second to every command. So for a few seconds after a key the screen is
	// read often enough to show the answer about when the host sends it, and
	// then the stream goes back to idling. Reading the screen is a local
	// command to the terminal process, not a round trip to the host.
	screenStreamFollowInterval = 50 * time.Millisecond
	screenStreamFollowWindow   = 3 * time.Second
	// screenStreamHeartbeatInterval keeps the connection alive through
	// proxies/load balancers that time out an idle stream.
	screenStreamHeartbeatInterval = 25 * time.Second
	// screenStreamMaxDuration caps one SSE connection so a browser tab left
	// open indefinitely doesn't pin a server goroutine (and its polling load
	// on the s3270 subprocess) forever. EventSource reconnects automatically
	// once the connection ends, so this is invisible to the user.
	screenStreamMaxDuration = 30 * time.Minute
)

// ScreenStreamHandler pushes screen updates to the browser over
// Server-Sent Events. Without this, a plain interactive session only ever
// saw updates in response to that browser's own request (a keystroke or
// submit) — any other change to the screen (e.g. a Copilot tool call
// acting on the same session) stayed invisible until the next local
// interaction. It defers entirely to the existing chaos/playback polling
// (workflow.js) while either is active for this session, since that
// already refreshes the screen at its own tighter, purpose-tuned cadence.
func (app *App) ScreenStreamHandler(c *gin.Context) {
	s := app.getSession(c)
	if s == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "session not found"})
		return
	}

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), screenStreamMaxDuration)
	defer cancel()

	keySentAt, keySent := s.KeySignal()
	poll := time.NewTimer(screenStreamInterval(keySentAt, time.Now()))
	defer poll.Stop()
	heartbeat := time.NewTicker(screenStreamHeartbeatInterval)
	defer heartbeat.Stop()

	lastHTML := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(c.Writer, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-keySent:
			// A key has just gone to the host. Start following it now rather
			// than at the end of whatever idle wait was in progress.
			keySentAt, keySent = s.KeySignal()
			if !poll.Stop() {
				select {
				case <-poll.C:
				default:
				}
			}
			poll.Reset(screenStreamInterval(keySentAt, time.Now()))
		case <-poll.C:
			keySentAt, keySent = s.KeySignal()
			poll.Reset(screenStreamInterval(keySentAt, time.Now()))
			data, changed := app.renderScreenStreamUpdate(s, &lastHTML)
			if !changed {
				continue
			}
			if _, err := io.WriteString(c.Writer, "data: "+string(data)+"\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// screenStreamInterval is how long the stream waits before its next look at
// the host: the follow pace within screenStreamFollowWindow of a key, the
// idle pace otherwise.
func screenStreamInterval(keySentAt, now time.Time) time.Duration {
	if !keySentAt.IsZero() && now.Sub(keySentAt) < screenStreamFollowWindow {
		return screenStreamFollowInterval
	}
	return screenStreamPollInterval
}

// renderScreenStreamUpdate renders the current screen and reports whether
// it changed since the last push. It yields (returns unchanged) whenever a
// chaos run or workflow playback is active for this session, since those
// already drive their own polling loop at a tighter cadence — pushing here
// too would just make the same DOM patch race two sources.
func (app *App) renderScreenStreamUpdate(s *session.Session, lastHTML *string) ([]byte, bool) {
	var playbackActive bool
	withSessionLock(s, func() {
		playbackActive = s.Playback != nil && s.Playback.Active
	})
	if playbackActive {
		return nil, false
	}
	if app.chaosEngines != nil {
		if eng, ok := app.chaosEngines.get(s.ID); ok && eng != nil && eng.Active() {
			return nil, false
		}
	}

	h := app.sessionHost(s)
	if h == nil {
		return nil, false
	}
	if err := h.UpdateScreen(); err != nil {
		return nil, false
	}
	screen := hostScreenSnapshot(h)
	if screen == nil {
		return nil, false
	}
	seq := s.NextScreenSeq()
	if rows, cols, ok := app.modelDimensions(); ok {
		screen = limitScreenForDisplay(screen, rows, cols)
	}
	recordScreenHistory(s, screen)
	rendered := app.Renderer.Render(screen, app.basePath+"/submit", s.ID)
	oia := screenOIA(screen)
	// Dedup on the OIA as well as the HTML: a host that locks the keyboard or
	// drops the connection without repainting the screen produces byte-identical
	// HTML, and suppressing that update would leave the operator looking at a
	// stale "ready" indicator during exactly the wait it exists to report.
	fingerprint := rendered + "\x00" + fmt.Sprint(oia["oiaIndicator"], oia["oiaOnline"])
	if fingerprint == *lastHTML {
		return nil, false
	}
	*lastHTML = fingerprint

	keyboardLabel, modelLabel, dimensionLabel, cursorLabel := screenStatusLabels(screen)
	payload := mergeOIA(gin.H{
		"html":             rendered,
		"statusKeyboard":   keyboardLabel,
		"statusModel":      modelLabel,
		"statusDimensions": dimensionLabel,
		"statusCursor":     cursorLabel,
		"seq":              seq,
	}, screen)
	if cursorRow, cursorCol, ok := screen.StatusCursor(); ok {
		payload["cursorRow"] = cursorRow
		payload["cursorCol"] = cursorCol
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, false
	}
	return data, true
}
