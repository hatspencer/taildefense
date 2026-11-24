package cli

import (
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
)

// oneLine makes transcript text safe for one table cell: escapes and control characters are
// stripped, because a title or a tool summary is text an agent wrote and must not be able to
// drive the terminal, and runs of whitespace collapse so nothing wraps.
func oneLine(s string) string {
	s = ansi.Strip(s)
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// tilde shortens a path under the home directory to ~/...
func tilde(p string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" || home == "/" {
		return p
	}
	if p == home {
		return "~"
	}
	if rest, ok := strings.CutPrefix(p, home+string(filepath.Separator)); ok {
		return "~/" + rest
	}
	return p
}
