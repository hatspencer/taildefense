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

// The wide effects skip over SSH while the glyph-sized effects keep going: a spinner at four
// frames a second still turns, a sweep does not.
func TestWideEffectsRestOverSSHAndGlyphsKeepMoving(t *testing.T) {
	forceTruecolor(t)
	t.Setenv("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 22")

	if Motion() {
		t.Error("wide effects are still allowed over SSH")
	}

	// Still alive: the pulse is made of one cell and survives a slow tick.
	if Pulse(0).Render("x") == Pulse(400*time.Millisecond).Render("x") {
		t.Error("the pulse stopped over SSH")
	}
}
