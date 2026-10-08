package ui

import (
	"bytes"
	"strings"
	"testing"

	"taildefense/internal/platform"
)

// paintable puts the package in the one state where painting is allowed — colour forced, a
// terminal, the preference on, and no sign of being a child of the shell session — and captures
// what gets written.
func paintable(t *testing.T) *bytes.Buffer {
	t.Helper()
	t.Setenv("NO_COLOR", "")
	// Not TAILDEFENSE_FORCE_COLOR: that variable outranks --no-color by design, so a test
	// holding it would never see the path where colour is turned off mid-run. The fake
	// terminal below is enough to enable colour on its own.
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	// Deliberately cleared: this variable is how the shell session tells a child what the
	// terminal supports, and a child must not paint a terminal it does not own.
	t.Setenv(EnvColorProfile, "")
	t.Setenv(EnvNoBg, "")
	restore := platform.SetTTYForTest(true)
	SetPaintBackground(true)
	InitColor(false)
	if !colorEnabled {
		t.Fatal("colour is off in a state where painting is supposed to be possible")
	}

	buf := &bytes.Buffer{}
	old := bgOut
	bgOut = buf
	t.Cleanup(func() {
		bgOut = old
		painted = false
		SetPaintBackground(true)
		restore()
		_ = SetTheme(DefaultTheme)
		InitColor(false)
	})
	return buf
}

// A full theme sets the terminal's background and foreground, and the values are its own.
func TestAFullThemePaintsTheTerminal(t *testing.T) {
	buf := paintable(t)
	if err := SetTheme("regal"); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	if !strings.Contains(got, "\x1b]11;#fffdf6\x07") {
		t.Errorf("no background sequence for regal's ivory in %q", got)
	}
	if !strings.Contains(got, "\x1b]10;#2b2417\x07") {
		t.Errorf("no foreground sequence for regal's ink in %q", got)
	}
}

// Switching to a theme that follows the terminal hands the terminal back, rather than leaving
// the previous theme's background under a palette that no longer matches it.
func TestSwitchingToATerminalFollowingThemeResets(t *testing.T) {
	buf := paintable(t)
	if err := SetTheme("ocean"); err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	if err := SetTheme(DefaultTheme); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); !strings.Contains(got, "\x1b]111\x07") || !strings.Contains(got, "\x1b]110\x07") {
		t.Errorf("switching to default did not reset the terminal, wrote %q", got)
	}
}

// Reset is idempotent and silent when nothing was painted, which is what lets the dispatcher
// defer it unconditionally on every exit path.
func TestResetIsSilentWhenNothingWasPainted(t *testing.T) {
	buf := paintable(t)
	painted = false
	ResetTerminal()
	ResetTerminal()
	if got := buf.String(); got != "" {
		t.Errorf("reset wrote %q with nothing painted", got)
	}

	if err := SetTheme("midnight"); err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	ResetTerminal()
	first := buf.String()
	if first == "" {
		t.Fatal("reset wrote nothing after a paint")
	}
	buf.Reset()
	ResetTerminal()
	if got := buf.String(); got != "" {
		t.Errorf("a second reset wrote %q, want nothing", got)
	}
}

// Every condition that suppresses colour suppresses painting, and painting the terminal is
// exactly as wrong as emitting a colour escape in all of them. The child case is the one worth
// a test of its own: the shell session forces colour for its children and reads their stdout,
// so a child that painted would either have the sequence stripped as noise or, worse, applied
// to a terminal it does not own.
func TestPaintingIsSuppressedWhereverColourIs(t *testing.T) {
	for _, tc := range []struct {
		name  string
		apply func(t *testing.T)
	}{
		{"NO_COLOR", func(t *testing.T) { t.Setenv("NO_COLOR", "1") }},
		{"not a terminal", func(t *testing.T) {
			t.Cleanup(platform.SetTTYForTest(false))
		}},
		{"a child of the session", func(t *testing.T) { t.Setenv(EnvColorProfile, "truecolor") }},
		{"the switch is off", func(t *testing.T) { SetPaintBackground(false) }},
		{"$" + EnvNoBg, func(t *testing.T) { t.Setenv(EnvNoBg, "1") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			buf := paintable(t)
			tc.apply(t)
			InitColor(false)
			buf.Reset()
			if err := SetTheme("ember"); err != nil {
				t.Fatal(err)
			}
			if got := buf.String(); got != "" {
				t.Errorf("painted anyway, wrote %q", got)
			}
		})
	}
}

// Turning colour off after a theme has painted hands the terminal back. --no-color and --json
// both rebuild the styles mid-run, and a plain-text run left sitting on a coloured background
// is the one outcome neither flag can be asked for.
func TestTurningColourOffResetsAPaintedTerminal(t *testing.T) {
	buf := paintable(t)
	if err := SetTheme("forest"); err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	InitColor(true)
	if got := buf.String(); !strings.Contains(got, "\x1b]111\x07") {
		t.Errorf("turning colour off did not reset the terminal, wrote %q", got)
	}
}
