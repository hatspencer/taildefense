package ui

import (
	"testing"
	"time"
)

// Over SSH the redraw rate drops and the wide effects rest, so a slow link never tears a
// sweep across the wordmark. Locally nothing changes.
func TestTickIntervalDropsOverSSH(t *testing.T) {
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("SSH_TTY", "")
	t.Setenv(EnvFullAnim, "")
	if got := TickInterval(); got != SpinnerPeriod {
		t.Errorf("locally the tick is %s, want one spinner frame %s", got, SpinnerPeriod)
	}
	if ReducedMotion() {
		t.Error("ReducedMotion reported true with no SSH variable set")
	}

	t.Setenv("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 22")
	if got := TickInterval(); got != reducedTick {
		t.Errorf("over SSH the tick is %s, want %s", got, reducedTick)
	}
	if got := TickInterval(); got%SpinnerPeriod != 0 {
		t.Errorf("the reduced tick %s is not a whole number of spinner frames", got)
	}

	// SSH_TTY alone is enough: some environments clear SSH_CONNECTION and keep it.
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("SSH_TTY", "/dev/pts/3")
	if !ReducedMotion() {
		t.Error("SSH_TTY alone did not reduce motion")
	}

	// The opt-out for a fast link.
	t.Setenv(EnvFullAnim, "1")
	if ReducedMotion() {
		t.Errorf("%s=1 did not restore full motion", EnvFullAnim)
	}
}

// The sweeps and the breathing skip over SSH while the glyph-sized effects keep going:
// a spinner at four frames a second still turns, a sweep does not.
func TestWideEffectsRestOverSSHAndGlyphsKeepMoving(t *testing.T) {
	forceTruecolor(t)
	t.Setenv("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 22")

	row := WordmarkSmall()[0]
	still := StyleBrand.Render(row)
	// 900 ms into a busy cycle is inside the first sweep on a local terminal; see
	// TestWordmarkRestsBetweenSweeps for the schedule this relies on.
	if got := WordmarkSweep(row, 900*time.Millisecond, true); got != still {
		t.Error("the wordmark swept over SSH")
	}
	if got := BreathText("02", 900*time.Millisecond); got != StyleBrand.Render("02") {
		t.Error("BreathText breathed over SSH")
	}
	if BadgeBreath(900*time.Millisecond).Render("x") != StyleBadge.Render("x") {
		t.Error("BadgeBreath breathed over SSH")
	}
	if got, want := Rule(12, 900*time.Millisecond, true), StyleDim.Render("────────────"); got != want {
		t.Error("the busy rule swept over SSH")
	}

	// Still alive: the pulse and the decay are made of one cell and survive a slow tick.
	if Pulse(0).Render("x") == Pulse(400*time.Millisecond).Render("x") {
		t.Error("the pulse stopped over SSH")
	}
	if _, live := Decay(100*time.Millisecond, time.Second); !live {
		t.Error("Decay stopped reporting live over SSH")
	}
}
