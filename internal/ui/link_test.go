package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestLinkIsAHyperlinkWithTheLabelVisible(t *testing.T) {
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { InitColor(false) })

	got := Link("https://ui.example/t?x=1", "Jump to kafbat")

	// OSC 8, BEL-terminated as x/ansi writes it.
	if !strings.HasPrefix(got, "\x1b]8;;https://ui.example/t?x=1\x07") || !strings.HasSuffix(got, "\x1b]8;;\x07") {
		t.Fatalf("not an OSC 8 hyperlink: %q", got)
	}
	if visible := ansi.Strip(linkLabel(got)); visible != "Jump to kafbat" {
		t.Fatalf("visible text is %q", visible)
	}
}

// A link label is one styled run, not one per letter. With underline in the style lipgloss
// styled each character on its own, so a ten-letter label became ten escape pairs in every
// transcript; steering forbids underline on an inline run for exactly that reason.
func TestAlinkLabelIsOneStyledRun(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() { InitColor(false) })
	InitColor(false)

	label := linkLabel(Link("file:///tmp/x.md", "slip--02-rule"))
	if n := strings.Count(label, "\x1b["); n > 2 {
		t.Fatalf("the label carries %d escape sequences, want one run and its reset: %q", n, label)
	}
	if ansi.Strip(label) != "slip--02-rule" {
		t.Fatalf("visible text is %q", ansi.Strip(label))
	}
}

func TestLinkPrintsTheURLWhenEscapesAreOff(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	InitColor(false)
	t.Cleanup(func() { InitColor(false) })

	if got := Link("https://ui.example/t", "Jump to kafbat"); got != "Jump to kafbat  https://ui.example/t" {
		t.Fatalf("got %q", got)
	}
}

// linkLabel strips a Link back to its styled label.
func linkLabel(s string) string {
	for {
		start := strings.Index(s, "\x1b]8;;")
		if start < 0 {
			return s
		}
		end := strings.Index(s[start:], "\x07")
		if end < 0 {
			return s
		}
		s = s[:start] + s[start+end+1:]
	}
}
