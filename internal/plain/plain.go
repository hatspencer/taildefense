// Package plain makes text from elsewhere safe to print: what a peer, a host or a tool wrote
// reaches the terminal as one line of text and never as a sequence that drives it.
package plain

import (
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
)

// Line strips escape sequences and control characters from s and collapses runs of
// whitespace, so it fits one table cell and cannot write the clipboard, retitle the window,
// move the cursor or start a row of its own.
func Line(s string) string {
	s = ansi.Strip(s)
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}
