package ui

import "strings"

// Link renders label as a terminal hyperlink to url.
//
// OSC 8 is what makes a label clickable: the terminal shows the label and opens the url,
// and every terminal in use here — iTerm2, kitty, WezTerm, GNOME Terminal, VS Code —
// honours it. A terminal that does not shows the label as plain text, which is the
// graceful failure the sequence was designed to have.
//
// When escapes are off the link cannot exist, so the url is printed after the label:
// output going to a file or a pipe is exactly the output someone will want to follow
// later, and a label with nothing behind it would be a dead end there.
func Link(url, label string) string {
	if !colorEnabled {
		return label + "  " + url
	}
	// The label is styled first and the link wrapped around the result, rather than the
	// other way round, so lipgloss never sees the OSC sequence: it measures what it
	// renders, and a url it cannot see is a url it cannot mangle.
	return "\x1b]8;;" + url + "\x1b\\" + StyleLink.Render(label) + "\x1b]8;;\x1b\\"
}

// LinkLabel strips a Link back to its visible text — for tests and for anything that
// needs to measure a line containing one.
func LinkLabel(s string) string {
	for {
		start := strings.Index(s, "\x1b]8;;")
		if start < 0 {
			return s
		}
		end := strings.Index(s[start:], "\x1b\\")
		if end < 0 {
			return s
		}
		s = s[:start] + s[start+end+2:]
	}
}
