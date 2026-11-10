// SPDX-License-Identifier: AGPL-3.0-or-later

package render

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/jnnngs/3270Web/internal/host"
)

// A TSO session in line mode does not draw a form. Every line it writes is an
// unprotected field, the operator's input area is another one, and the cursor
// is left wherever the next line will go. The keyboard has to follow it there:
// an operator who types TIME at READY means the line under the cursor, and
// typing into the first field on the screen instead rewrites old output and
// sends the host nonsense.
//
// These screens are built the way the terminal reports them, as a buffer read
// with a status line, so the field list and the cursor come from the same
// decode a live session goes through.

// lineModeScreen is a buffer under construction, one token per cell.
type lineModeScreen struct {
	rows, cols int
	cells      [][]string
}

func newLineModeScreen(rows, cols int) *lineModeScreen {
	s := &lineModeScreen{rows: rows, cols: cols, cells: make([][]string, rows)}
	for y := range s.cells {
		s.cells[y] = make([]string, cols)
		for x := range s.cells[y] {
			s.cells[y][x] = "00"
		}
	}
	return s
}

// line writes one line of host output the way TSO does: an unprotected,
// intensified field attribute, the text, and an unprotected attribute that
// opens an empty field to the end of the row.
func (s *lineModeScreen) line(row int, text string) {
	s.cells[row][0] = "SF(c0=c8)"
	for i, ch := range text {
		s.cells[row][1+i] = fmt.Sprintf("%02x", ch)
	}
	if end := 1 + len(text); end < s.cols {
		s.cells[row][end] = "SF(c0=c0)"
	}
}

func (s *lineModeScreen) attribute(row, col int, attr string) {
	s.cells[row][col] = "SF(c0=" + attr + ")"
}

func (s *lineModeScreen) decode(t *testing.T, cursorRow, cursorCol int) *host.Screen {
	t.Helper()
	var dump strings.Builder
	for _, row := range s.cells {
		dump.WriteString("data: ")
		dump.WriteString(strings.Join(row, " "))
		dump.WriteString("\n")
	}
	fmt.Fprintf(&dump, "U F U C(host) I 4 %d %d %d %d 0x0 0.000\nok\n", s.rows, s.cols, cursorRow, cursorCol)
	screen, err := host.NewScreenFromDump(strings.NewReader(dump.String()))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if screen.CursorY != cursorRow || screen.CursorX != cursorCol {
		t.Fatalf("decoded cursor (%d,%d), want (%d,%d)", screen.CursorY, screen.CursorX, cursorRow, cursorCol)
	}
	return screen
}

var renderedInput = regexp.MustCompile(`<input type="text" name="(field_[0-9_]+)"[^>]*? data-x="(\d+)" data-y="(\d+)" data-w="(\d+)"`)

// inputAtCell answers the question the browser asks when a new screen
// arrives: which rendered input covers this cell. An input covers the cells
// its data-x, data-y and data-w name, and nothing else.
func inputAtCell(t *testing.T, html string, row, col int) (name string, caret int, ok bool) {
	t.Helper()
	for _, m := range renderedInput.FindAllStringSubmatch(html, -1) {
		x, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])
		w, _ := strconv.Atoi(m[4])
		if y == row && col >= x && col < x+w {
			return m[1], col - x, true
		}
	}
	return "", 0, false
}

var focusMarker = regexp.MustCompile(`<div hidden data-initial-focus[^>]*>`)

func markerAttr(t *testing.T, html, attr string) string {
	t.Helper()
	marker := focusMarker.FindString(html)
	if marker == "" {
		t.Fatalf("no focus marker in the rendered screen")
	}
	m := regexp.MustCompile(attr + `="([^"]*)"`).FindStringSubmatch(marker)
	if m == nil {
		return ""
	}
	return m[1]
}

// After ISPF exits to READY, TSO writes READY in an unprotected field, opens
// the input field straight after it, and leaves the cursor at the start of
// the next row. That row is the input field wrapping round, so the cursor is
// inside it. This is the screen as an MVS 3.8j TSO system draws it.
func TestLineModeCursorOnWrappedLineIsInTheInputField(t *testing.T) {
	b := newLineModeScreen(43, 80)
	b.attribute(0, 0, "c8")
	for i, ch := range "READY " {
		b.cells[0][1+i] = fmt.Sprintf("%02x", ch)
	}
	b.attribute(0, 7, "c0")
	screen := b.decode(t, 1, 0)

	html := NewHtmlRenderer().Render(screen, "/submit", "s")

	name, caret, ok := inputAtCell(t, html, 1, 0)
	if !ok {
		t.Fatalf("no rendered input covers the host cursor at row 1, column 0; "+
			"the browser finds nothing there and puts the keyboard in the first field (READY)\n%s",
			strings.Join(renderedInput.FindAllString(html, -1), "\n"))
	}
	if name != "field_8_0_1" || caret != 0 {
		t.Errorf("the input under the host cursor is %s at caret %d, want field_8_0_1 at caret 0", name, caret)
	}
	if got := markerAttr(t, html, "data-field-name"); got != "field_8_0_1" {
		t.Errorf("initial focus goes to %q, want field_8_0_1", got)
	}
	if got := markerAttr(t, html, "data-caret"); got != "0" {
		t.Errorf("initial caret %q, want 0", got)
	}
}

// Every output line is its own unprotected field, so after a few commands the
// next empty line starts with a field attribute and TSO leaves the cursor on
// it. No field contains an attribute position, and falling back to the first
// field on the screen sends the operator's command to the host spliced into a
// message it printed earlier. The keyboard belongs on the cursor's line: the
// field the attribute opens.
func TestLineModeCursorOnAttributeTypesOnItsLine(t *testing.T) {
	b := newLineModeScreen(24, 80)
	b.line(0, "IKJ56455I USER01 LOGON IN PROGRESS AT 01:02:03 ON")
	b.line(1, "READY")
	for row := 3; row <= 15; row += 2 {
		b.line(row, "READY")
	}
	b.attribute(16, 0, "c8")
	screen := b.decode(t, 16, 0)

	html := NewHtmlRenderer().Render(screen, "/submit", "s")

	if got := markerAttr(t, html, "data-field-name"); got != "field_1_16_0" {
		t.Errorf("with the cursor on the attribute at row 16, column 0, focus goes to %q; want field_1_16_0, the first line of the field on the cursor's line", got)
	}
	if got := markerAttr(t, html, "data-caret"); got != "0" {
		t.Errorf("caret %q, want 0 (the first position of the field)", got)
	}
}

// The same rule where the attribute is the last cell of a row: the field it
// opens starts at column 0 of the next row, and the caret goes there rather
// than eighty columns along.
func TestLineModeCursorOnAttributeAtEndOfRow(t *testing.T) {
	b := newLineModeScreen(24, 80)
	b.line(0, strings.Repeat("X", 78))
	// line() put the trailing attribute at column 79, so the empty field it
	// opens begins at row 1, column 0.
	screen := b.decode(t, 0, 79)

	html := NewHtmlRenderer().Render(screen, "/submit", "s")

	if got := markerAttr(t, html, "data-field-name"); !strings.HasPrefix(got, "field_0_1") {
		t.Errorf("focus goes to %q, want the field starting at row 1, column 0", got)
	}
	if got := markerAttr(t, html, "data-caret"); got != "0" {
		t.Errorf("caret %q, want 0", got)
	}
}

// An attribute that opens a protected field is protected text. The cursor is
// left where the host put it, which is what the browser's free cursor shows.
func TestCursorOnAttributeOfProtectedFieldGetsNoField(t *testing.T) {
	b := newLineModeScreen(24, 80)
	b.attribute(5, 10, "e0")
	b.attribute(5, 20, "c0")
	screen := b.decode(t, 5, 10)

	html := NewHtmlRenderer().Render(screen, "/submit", "s")

	if got := markerAttr(t, html, "data-field-name"); got != "" {
		t.Errorf("focus goes to %q for a cursor on a protected field's attribute, want none", got)
	}
}
