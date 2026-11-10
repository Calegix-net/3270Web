// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"strings"
	"testing"
)

// functionBody returns the source of one top-level function in a browser
// script, from its declaration to the next declaration at the same depth.
func functionBody(t *testing.T, src, name string) string {
	t.Helper()
	start := strings.Index(src, "function "+name+"(")
	if start < 0 {
		t.Fatalf("no function %s; this test is pinned to the wrong thing", name)
	}
	body := src[start:]
	if end := strings.Index(body[1:], "\n  function "); end > 0 {
		body = body[:end+1]
	}
	return body
}

// An update the stream brings while the operator is typing is held and shown
// once they stop, never dropped. The server sends each screen once, so a
// dropped one stays missing until the host draws something else, which on a
// TSO prompt can be never. And typing protects only the screen it was done
// on: a host that answers within a second of the key that the operator just
// sent must not be held back on account of the keystrokes that key carried.
func TestScreenStreamUpdatesAreDeferredNotDropped(t *testing.T) {
	live := staticSource(t, "screen-live.js")
	apply := functionBody(t, live, "applyUpdate")

	if !strings.Contains(apply, "deferUpdate(container, payload)") {
		t.Error("screen-live.js applyUpdate no longer defers an update that arrives while the operator types; a dropped update is never sent again")
	}
	if !strings.Contains(functionBody(t, live, "typingOnThisScreen"), "container.contains(lastInputForm)") {
		t.Error("screen-live.js holds updates back for typing on a screen that has already been replaced, which is how the answer to a fast key went unshown")
	}
	if !strings.Contains(apply, "screens.accept(payload)") {
		t.Error("screen-live.js puts up a stream update without checking whether a newer screen is already showing")
	}
}

// The fetch after a key and the live stream can arrive in either order. The
// fetch must not put an older screen over a newer one the stream has shown.
func TestKeyFetchDoesNotOverwriteANewerScreen(t *testing.T) {
	keyboard := staticSource(t, "keyboard.js")
	submit := functionBody(t, keyboard, "submitFormWithoutNavigation")
	if !strings.Contains(submit, "screens.accept(payload)") || !strings.Contains(submit, "screens.shown(payload)") {
		t.Error("keyboard.js submitFormWithoutNavigation does not take part in screen ordering; a slow fetch can put an older screen over the stream's newer one")
	}
}

// When the host cursor is not inside a field, the keyboard still has to go
// where the host put it. Two things in restoreScreenFocus make that so: the
// server's own resolution of the cursor (which covers a cursor on the
// attribute byte that opens an input field) is consulted before giving up,
// and a cursor left out on protected text is not cancelled by the focus that
// only gives keystrokes somewhere to arrive.
func TestRestoreScreenFocusFollowsTheHostCursor(t *testing.T) {
	keyboard := staticSource(t, "keyboard.js")
	restore := functionBody(t, keyboard, "restoreScreenFocus")

	if !strings.Contains(restore, "markedFocus(form)") {
		t.Error("keyboard.js restoreScreenFocus ignores the field the server resolved for the host cursor")
	}
	if !strings.Contains(restore, "sinkFocusPending = true") {
		t.Error("keyboard.js restoreScreenFocus focuses a field without marking it as bookkeeping, so the free cursor is dropped and typing lands in that field")
	}
}
