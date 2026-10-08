package ui

import (
	"os"
	"time"
)

// Reduced motion.
//
// Every animated surface redraws on a ticker, and every ticker used to pick its own
// interval. Over a VPN that is fine; over SSH it is not. A sweep drawn at 20 fps sends
// a few tens of kilobytes a second, which on a slow link arrives late and out of step,
// and the wordmark tears — half a frame from one tick, half from the next. The tearing
// looks like a rendering bug and is really the link.
//
// So the interval is decided in one place, from where the process is running. Over SSH
// the frame rate drops to about three a second: a spinner still turns and a decaying
// marker still fades, because those are glyph-sized and a step every 300 ms reads as a
// step. A sweep across an eighty-cell wordmark at three frames a second reads as a
// stutter, so the sweeps and the breathing skip to their still frames instead; see
// motion below.
//
// This is not the same as TAILDEFENSE_NO_ANIM. That turns animation off, and someone on
// a fast SSH link who wants the sweeps back has TAILDEFENSE_FULL_ANIM=1, which says "my
// link can take it" without touching the remembered preference.

// EnvFullAnim restores the full frame rate over SSH.
const EnvFullAnim = "TAILDEFENSE_FULL_ANIM"

// reducedTick is the redraw interval over SSH: three spinner frames, a little over three
// redraws a second, which is the slowest rate at which a spinner still reads as turning
// rather than as a glyph changing.
//
// A whole number of spinner frames on purpose. The spinner picks its frame from elapsed
// time, so a redraw interval that is not a multiple of SpinnerPeriod does not slow it
// down, it makes it uneven — two frames on one redraw and three on the next. That is the
// pathology progress.go describes, and a reduced rate must not reintroduce it.
const reducedTick = 3 * SpinnerPeriod

// ReducedMotion reports whether the process is on a link where frames are expensive.
//
// SSH_CONNECTION is set by every sshd for every session; SSH_TTY only for interactive
// ones, and it is checked as well because some environments clear the first and keep the
// second. Neither is set by a local terminal, tmux or a container shell, and a false
// positive only costs smoothness, which is the cheap direction to be wrong in.
func ReducedMotion() bool {
	if os.Getenv(EnvFullAnim) == "1" {
		return false
	}
	return os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != ""
}

// TickInterval is how often an animated surface should redraw: one spinner frame
// normally, and the reduced rate over SSH.
//
// Every ticker reads this rather than SpinnerPeriod directly, so a redraw is always a
// whole number of spinner frames and the rate is changed in exactly one place.
func TickInterval() time.Duration {
	if ReducedMotion() {
		return reducedTick
	}
	return SpinnerPeriod
}

// motion reports whether a wide, continuous effect — a sweep across the wordmark, a
// highlight along a rule, a breathing badge — may be drawn.
//
// It is AnimEnabled with the link taken into account. The glyph-sized effects keep using
// AnimEnabled on its own: they degrade gracefully at a low frame rate, and switching them
// off as well would leave a running command with no visible sign of life.
func motion() bool {
	return AnimEnabled() && !ReducedMotion()
}
