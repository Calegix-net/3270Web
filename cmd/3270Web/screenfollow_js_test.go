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
