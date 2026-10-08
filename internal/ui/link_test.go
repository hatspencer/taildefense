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

	if !strings.HasPrefix(got, "\x1b]8;;https://ui.example/t?x=1\x1b\\") || !strings.HasSuffix(got, "\x1b]8;;\x1b\\") {
		t.Fatalf("not an OSC 8 hyperlink: %q", got)
	}
	if visible := ansi.Strip(LinkLabel(got)); visible != "Jump to kafbat" {
		t.Fatalf("visible text is %q", visible)
	}
}

// A link label is one styled run, not one per letter. With underline in the style lipgloss
// styled each character on its own, so a ten-letter label became ten escape pairs in every
// transcript; steering forbids underline on an inline run for exactly that reason.
func TestALinkLabelIsOneStyledRun(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() { InitColor(false) })
	InitColor(false)

	label := LinkLabel(Link("file:///tmp/x.md", "slip--02-rule"))
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
