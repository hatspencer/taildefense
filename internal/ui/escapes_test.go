package ui

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
)

// The sequences the scenes and the progress line write come from x/ansi now; these are the
// bytes they wrote by hand before, so a terminal receives the same.
func TestASceneWritesTheSameSequences(t *testing.T) {
	var buf bytes.Buffer
	runScene(context.Background(), &buf, 2, time.Millisecond, true, 40, func(float64) []string {
		return []string{"one", "two"}
	})
	got := buf.String()
	want := "\x1b[?25l" + "\n\n" + "\x1b[2A" + "\rone\x1b[K\n" + "\rtwo\x1b[K\n"
	if !strings.HasPrefix(got, want) {
		t.Errorf("scene began %q, want %q", got, want)
	}
	if !strings.HasSuffix(got, "\x1b[?25h") {
		t.Errorf("scene did not show the cursor again: %q", got)
	}

	// An interrupted scene erases its block and goes back up over it.
	buf.Reset()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runScene(ctx, &buf, 2, time.Hour, true, 40, func(float64) []string { return []string{"a", "b"} })
	if want := "\x1b[2A\r\x1b[K\n\r\x1b[K\n\x1b[2A\x1b[?25h"; !strings.HasSuffix(buf.String(), want) {
		t.Errorf("interrupted scene ended %q, want %q", buf.String(), want)
	}

	// One row is moved up with CSI A, the same move as the CSI 1 A written before: the
	// parameter defaults to one.
	buf.Reset()
	runScene(context.Background(), &buf, 1, time.Millisecond, true, 40, func(float64) []string { return []string{"x"} })
	if !strings.Contains(buf.String(), "\n\x1b[A\rx\x1b[K\n") {
		t.Errorf("one-row scene wrote %q", buf.String())
	}
}

func TestTruncateVisibleStillEndsInAFullReset(t *testing.T) {
	if got := truncateVisible("\x1b[32mabcdef\x1b[0m", 4); got != "\x1b[32mabc\x1b[0m" {
		t.Errorf("got %q", got)
	}
}

// The second try lipgloss.BackgroundColor makes fails before it writes a byte.
func TestTheBackgroundIsAskedOnce(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "tty")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	once := askedOnce{f}
	if n, err := once.Write([]byte("\x1b]11;?\x07")); n != 0 || !errors.Is(err, errAskedOnce) {
		t.Errorf("write went through: %d, %v", n, err)
	}
	if once.Fd() != f.Fd() {
		t.Error("askedOnce is another file")
	}
	if fi, _ := f.Stat(); fi.Size() != 0 {
		t.Errorf("%d bytes reached the file", fi.Size())
	}
}

// A style given no colour stays silent. Lip Gloss writes the default-colour codes (39, 49)
// for a nil colour, so Color must never return one: not with colour off, not for an empty or
// bad hex.
func TestNoColourIsNoEscape(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() { InitColor(false) })
	InitColor(false)
	for _, hex := range []string{"", "not-a-colour"} {
		c := Color(hex)
		if c == nil {
			t.Fatalf("Color(%q) is nil", hex)
		}
		if got := lipgloss.NewStyle().Foreground(c).Background(c).Render("x"); got != "x" {
			t.Errorf("Color(%q) renders %q", hex, got)
		}
	}

	t.Setenv("NO_COLOR", "1")
	t.Setenv(EnvForceColor, "")
	InitColor(false)
	if got := lipgloss.NewStyle().Foreground(Color("#ff0000")).Background(ColorSurface.color()).Render("x"); got != "x" {
		t.Errorf("colour off renders %q", got)
	}
}

// The colour depth td starts from, for the terminals people run it in, is what termenv
// gave the same environment before the move to colorprofile. colorprofile.Detect can only
// raise it from here, for a terminal whose terminfo or tmux says it takes 24-bit colour.
func TestColourDepthMatchesWhatTermenvGave(t *testing.T) {
	for _, c := range []struct {
		env  []string
		want colorprofile.Profile
	}{
		{[]string{"TERM=xterm"}, colorprofile.ANSI},
		{[]string{"TERM=linux"}, colorprofile.ANSI},
		{[]string{"TERM=xterm-256color"}, colorprofile.ANSI256},
		{[]string{"TERM=rxvt-unicode-256color"}, colorprofile.ANSI256},
		{[]string{"TERM=xterm-256color", "COLORTERM=truecolor"}, colorprofile.TrueColor},
		{[]string{"TERM=xterm-256color", "COLORTERM=24bit"}, colorprofile.TrueColor},
		{[]string{"TERM=xterm-kitty"}, colorprofile.TrueColor},
		{[]string{"TERM=alacritty"}, colorprofile.TrueColor},
		{[]string{"TERM=xterm-ghostty"}, colorprofile.TrueColor},
		{[]string{"TERM=wezterm"}, colorprofile.TrueColor},
		{[]string{"TERM=screen-256color"}, colorprofile.ANSI256},
		{[]string{"TERM=screen-256color", "COLORTERM=truecolor"}, colorprofile.ANSI256},
	} {
		if got := colorprofile.Env(c.env); got != c.want {
			t.Errorf("%v: %v, want %v", c.env, got, c.want)
		}
	}
}
