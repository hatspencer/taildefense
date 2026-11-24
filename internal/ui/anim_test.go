package ui

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"

	"taildefense/internal/platform"
)

// forceTruecolor puts the package in the state a modern terminal produces: colour on,
// and enough of it to tell the ramp's stops apart.
//
// The profile has to be forced as well as the colour. With colour forced on a pipe,
// InitColor widens the profile to a flat sixteen, and all six stops of a red ramp map to
// the same ANSI red — so the animation is genuinely, correctly static there, and a test
// that asserted motion would be asserting against the degradation rather than the code.
func forceTruecolor(t *testing.T) {
	t.Helper()
	t.Setenv("NO_COLOR", "")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "1")
	t.Setenv(EnvColorProfile, "truecolor")
	// The wide effects also skip over SSH, and a test run from an SSH session would
	// otherwise see still frames where it expects a sweep. See tick.go.
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("SSH_TTY", "")
	t.Setenv(EnvFullAnim, "")
	// Animation gates on a terminal as well as on colour, and a test has no terminal, so
	// without this every IsTTY-gated frame stays unreachable here.
	restoreTTY := platform.SetTTYForTest(true)
	InitColor(false)
	t.Cleanup(func() {
		restoreTTY()
		t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
		t.Setenv(EnvColorProfile, "")
		InitColor(false)
	})
}

// Frames must be a pure function of elapsed time: the shell redraws every animated glyph
// in one frame from one clock, and anything reading a counter of its own drifts out of
// phase with the rest of the frame.
func TestAnimationFramesArePureFunctionsOfTime(t *testing.T) {
	forceTruecolor(t)

	at := 640 * time.Millisecond
	if a, b := pulseAt(at), pulseAt(at); a.Render("x") != b.Render("x") {
		t.Error("Pulse is not deterministic at a fixed elapsed time")
	}

	// And they must actually animate.
	seen := map[string]bool{}
	for ms := 0; ms < 950; ms += 50 {
		seen[pulseAt(time.Duration(ms)*time.Millisecond).Render("x")] = true
	}
	if len(seen) < 3 {
		t.Errorf("the pulse produced only %d distinct frames over one period", len(seen))
	}

	// A long-running session must not index past the end of the ramp hours in.
	pulseAt(9 * time.Hour)
}

// Pulse must stay in the bright half of the ramp. A glyph that dims to the darkest shade
// reads as disabled, which is the opposite of what "still working" should look like.
func TestPulseStaysBright(t *testing.T) {
	forceTruecolor(t)

	dimmest := rampStyles[0].Render("x")
	for ms := 0; ms < 4000; ms += 25 {
		if got := pulseAt(time.Duration(ms) * time.Millisecond).Render("x"); got == dimmest {
			t.Fatalf("at %dms the pulse reached the darkest ramp stop", ms)
		}
	}
}

// Without a terminal there must be no animation and no cursor control, because the
// output is being captured: piped to a file or into a ticket, a reveal would land as one
// complete copy of the artwork per frame.
func TestRevealIsOneStaticFrameWithoutATerminal(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	var buf bytes.Buffer
	rows := WordmarkSmall()
	Reveal(&buf, rows)

	got := buf.String()
	if want := strings.Join(rows, "\n") + "\n"; got != want {
		t.Errorf("Reveal off a terminal produced %q, want the plain artwork", got)
	}
	for _, seq := range []string{"\x1b[?25l", "\x1b[A", "\x1b[K"} {
		if strings.Contains(got, seq) {
			t.Errorf("Reveal emitted %q with no terminal to draw on", seq)
		}
	}
}

// Inside a shell pane the output is captured and cursor control is stripped by
// cmd/shell/sanitize.go, so an animation there is not degraded but multiplied: every
// frame survives as its own copy of the artwork. The session marker is the gate.
func TestAnimationIsOffInsideAShellPane(t *testing.T) {
	forceTruecolor(t)

	t.Setenv("TAILDEFENSE_SHELL", "1")
	if AnimEnabled() {
		t.Error("animation is enabled inside a shell pane")
	}

	// And the opt-out, for a link too slow to draw frames over.
	t.Setenv("TAILDEFENSE_SHELL", "")
	t.Setenv(EnvNoAnim, "1")
	if AnimEnabled() {
		t.Errorf("animation is enabled with %s set", EnvNoAnim)
	}
}

// The ramp positions are fractions so that lengthening the ramp to smooth the gradient
// cannot move every resting colour. This pins the ordering and the clamping; if a future
// ramp length silently collapsed two of these onto one stop, every effect built from them
// would lose its contrast at once.
func TestRampFractionsAreOrderedAndClamped(t *testing.T) {
	forceTruecolor(t)

	rest, calm, hot := rampIdx(fracRest), rampIdx(fracCalm), rampIdx(fracHot)
	if !(rest < calm && calm < hot) {
		t.Errorf("ramp positions are not strictly increasing: rest=%d calm=%d hot=%d",
			rest, calm, hot)
	}
	if hot != len(rampStyles)-1 {
		t.Errorf("fracHot is %d, not the last stop %d", hot, len(rampStyles)-1)
	}
	if got := rampIdx(-5); got != 0 {
		t.Errorf("rampIdx(-5) = %d, want 0", got)
	}
	if got := rampIdx(9); got != len(rampStyles)-1 {
		t.Errorf("rampIdx(9) = %d, want the last stop", got)
	}
	// Enough stops that a wide band grades rather than bands. Below this the ambient drift
	// steps visibly, which is the whole reason the ramp was lengthened.
	if len(rampStyles) < 9 {
		t.Errorf("the ramp has only %d stops; the ambient drift needs a finer gradient", len(rampStyles))
	}
}

// The resting shade of an animated surface has to be the accent itself, on both themes.
//
// This is the one palette relationship that cannot be seen by reading either definition. It
// was #ef2b1f against a #ff3b2f accent on dark themes, close enough to look deliberate and
// far enough that the whole wordmark visibly darkened the instant a sweep started and lifted
// again when it ended — a colour change much louder than the animation it was carrying.
func TestTheRestingRampShadeIsTheAccent(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() {
		lipgloss.SetHasDarkBackground(true)
		_ = SetTheme(DefaultTheme)
	})

	for _, theme := range Themes() {
		if err := SetTheme(theme.Name); err != nil {
			t.Fatal(err)
		}
		for _, dark := range []bool{true, false} {
			lipgloss.SetHasDarkBackground(dark)
			InitColor(false)

			rest := rampStyles[rampIdx(fracRest)].Render("HIVE")
			brand := StyleBrand.Render("HIVE")
			if rest != brand {
				t.Errorf("%s dark=%v: the resting ramp shade is %q, the brand style is %q", theme.Name, dark, rest, brand)
			}
		}
	}
}
