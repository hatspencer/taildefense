package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"taildefense/internal/platform"
)

// Animation.
//
// Four rules, in order of how much trouble breaking them causes:
//
//  1. It is decorative. Delete every call in this file and the tool reports exactly
//     the same findings in exactly the same words. Nothing here is the only place
//     some piece of information appears, because a person reading a transcript in a
//     ticket sees none of it.
//
//  2. It draws only on a terminal this process owns. Off a TTY, under NO_COLOR, or
//     inside a `taildefense shell` pane, every function here returns the plain string and
//     Reveal prints one static frame. The pane matters most and is the least
//     obvious: cmd/shell/sanitize.go drops carriage returns and strips cursor
//     movement, because it cannot honour "go back and overwrite" in a line buffer.
//     An animation that reached it would not look broken — it would land as one
//     complete copy of the artwork per frame, forty of them, scrolling the pane.
//
//  3. Frames are a pure function of elapsed time, never of a counter. That is the
//     rule Spinner already follows and the reason is the same: a redrawn table
//     redraws every row from one tick, and per-row counters drift out of phase, so
//     the table shimmers where nothing has changed. Off the clock, a dropped or
//     coalesced tick skips a frame instead of stalling.
//
//  4. It never changes a visible width. A highlight recolours cells and adds no cells,
//     so a swept header still measures the same as a still one. The wordmark
//     sits next to a column of facts sized by measuring it; an animation that grew
//     by a cell would push that column back and forth on every frame.
//
// Colour only, no glyph substitution. The braille spinner is one cell wide in every
// font, which is why it was chosen over the block and arrow sets, and animating the
// hue keeps that property where swapping in wider glyphs would reintroduce the jitter.
//
// One consequence of being made of colour: on a sixteen-colour terminal every stop of
// the ramp maps to the same ANSI red, so the sweep and the pulse are static there.
// That is the correct outcome rather than a gap to fill — it is the same degradation the
// rest of the palette gets, and the alternative would be animating with glyphs, which is
// what makes a line jitter.

// EnvNoAnim disables every animation while leaving colour alone.
//
// Separate from NO_COLOR because they are separate complaints. "I am on a slow SSH
// link and the redraws are tearing" and "I want plain text" ask for different things,
// and someone who wants a still, coloured banner had no way to say so.
const EnvNoAnim = "TAILDEFENSE_NO_ANIM"

// animPref is the remembered choice: `td config animate off` turns it off for every
// run, the environment variable above turns it off for one. Both are read by AnimEnabled,
// so every animated surface honours both through the same guard.
var animPref = true

// SetAnimate records whether animation is wanted. The dispatcher calls it from the
// preferences file at startup; the shell calls it again when a command run inside the
// session changes the file.
func SetAnimate(on bool) { animPref = on }

// AccentRamp is the accent hue from its darkest shade to white-hot, and it is what makes
// an animation read as motion rather than as blinking. It belongs to the theme and is
// copied from it by InitColor; see theme.go for the stops and the rules they follow.
//
// Eleven stops, not six. Six was enough for a fast sweep, where the highlight crosses a
// cell in a frame or two and the eye never resolves the steps. It is not enough for a wide
// slow band, which shows the shades as bands, and that is what "not smooth" looks like.
//
// The stop at fracRest must be ColorAccent exactly, on both themes. It is the shade every
// cell outside the highlight is painted in, so if it merely resembles the accent, the whole
// wordmark changes colour the instant a sweep begins and back again when it ends — which
// reads as a much bigger event than the sweep itself. A test pins the two together for
// every theme, because nothing else about the palette would reveal a drift.
var AccentRamp []lipgloss.AdaptiveColor

// Positions in the ramp, as fractions rather than indices counted back from the end.
//
// They were offsets like len-4 while the ramp had six stops, which quietly encoded the
// length into every effect: lengthening the ramp to smooth the gradient would have moved
// every resting colour and made the whole frame brighter. A fraction survives a ramp of
// any length, and at eleven stops these land on exactly the shades the six-stop offsets
// picked.
const (
	// fracRest is the resting shade of animated artwork: the accent itself.
	fracRest = 0.4
	// fracCalm is the hottest shade the ambient effects reach. Cooler than a sweep on
	// purpose.
	fracCalm = 0.6
	// fracHot is the leading edge of a sweep.
	fracHot = 1.0
)

// rampStyles is AccentRamp resolved to styles once, because a highlight touches every
// visible cell of the wordmark on every frame and building a style per cell per
// frame is thousands of allocations a second for a decoration.
var rampStyles []lipgloss.Style

// initAnim rebuilds the ramp. Called from InitColor, so a test that toggles colour
// gets styles that agree with the profile in force.
func initAnim() {
	rampStyles = make([]lipgloss.Style, len(AccentRamp))
	for i, c := range AccentRamp {
		rampStyles[i] = lipgloss.NewStyle().Foreground(c).Bold(true)
	}
	invalidateCandy()
}

// rampIdx turns a fraction of the ramp into an index, clamped.
func rampIdx(frac float64) int {
	if len(rampStyles) == 0 {
		initAnim()
	}
	i := int(frac*float64(len(rampStyles)-1) + 0.5)
	if i < 0 {
		return 0
	}
	if i > len(rampStyles)-1 {
		return len(rampStyles) - 1
	}
	return i
}

// AnimEnabled reports whether animation may be drawn.
//
// Colour is a precondition rather than a separate question: every animation here is
// made of colour, so with colour off there is nothing left to animate.
func AnimEnabled() bool {
	if !animPref || !colorEnabled || !platform.IsTTY() {
		return false
	}
	if os.Getenv(EnvNoAnim) != "" {
		return false
	}
	// Inside a shell pane the output is captured and cursor control is stripped; see
	// rule 2 above. The session exports this marker to every command it runs.
	if InShellPane() {
		return false
	}
	// A hook gives a command a pipe on stdin and an agent on the far side of stdout, and CI
	// gives it a log. Neither is a person watching, so neither gets a frame.
	if !platform.StdinInteractive() || platform.InCI() {
		return false
	}
	return true
}

// Pulse is the accent breathing, for a glyph that means "still working".
//
// A triangle wave rather than a sawtooth: a ramp that snaps back to the bottom reads
// as a flicker, and the point of this is to look alive without pulling the eye off the
// text next to it. It stays in the top half of the ramp so that a pulsing glyph never
// dims to something a person would read as disabled.
//
// With animation off it is the accent, still: the spinner beside it keeps turning,
// because that is a progress indicator rather than decoration, but the colour holds.
func Pulse(elapsed time.Duration) lipgloss.Style {
	if !AnimEnabled() {
		if len(rampStyles) == 0 {
			initAnim()
		}
		return rampStyles[rampIdx(fracRest)]
	}
	return pulseAt(elapsed)
}

// pulseAt is Pulse without the terminal check, so the wave itself is testable where
// there is no terminal to draw on.
func pulseAt(elapsed time.Duration) lipgloss.Style {
	if len(rampStyles) == 0 {
		initAnim()
	}
	const period = 950 * time.Millisecond
	lo := rampIdx(fracCalm)
	span := rampIdx(fracHot) - lo
	if span <= 0 {
		return rampStyles[rampIdx(fracHot)]
	}

	// Position in a 2*span cycle, folded back on itself to make the triangle.
	steps := 2 * span
	pos := int(int64(elapsed%period) * int64(steps) / int64(period))
	if pos >= span {
		pos = steps - pos
	}
	return rampStyles[lo+pos]
}

// shimmerBand is the half-width of a highlight in cells. Wide enough that the graded edge
// is visible at both ends of it, which is what makes the highlight read as something
// travelling rather than as a block switching on.
const shimmerBand = 7

// hash64 is splitmix64's finalising mix.
//
// A hash rather than math/rand because a generator carries state, and state is what would
// make two rows of the same wordmark disagree about the current sweep. Given the cycle
// number it returns the same well-scattered bits every time, on every row, in every
// process — which is the property that lets "random" and "a pure function of the clock" be
// true at once.
func hash64(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

// Reveal draws artwork once, animated, and leaves it on screen in its settled colour.
// It is the swarm in swarm.go: every cell of the word flies in as a bee, a lead bee loops
// over it, one highlight sweeps the finished letters, and it settles to the plain brand
// colour, all inside the opening budget in candy.go. The settled frame is the same string the
// non-animated path prints, so what stays on screen after the animation is byte for
// byte what a transcript would have shown.
//
// # Why it redraws in place instead of clearing the screen
//
// A banner is printed into a scrollback that already has content above it, and often
// has more printed under it immediately afterwards. Clearing the screen to animate
// would throw away whatever the person was reading. So the block is printed once,
// letting the terminal scroll if it needs to, and every later frame moves the cursor
// back up exactly as many lines as were just written. That composes with ordinary
// line-oriented output above and below it, the same property Progress is built around.
//
// It gives up rather than degrading when the window is too short to hold the artwork
// plus a line: with the block taller than the screen, the first print scrolls part of
// it away, the cursor-up lands somewhere else, and the frames would be drawn over the
// caller's own output.
func Reveal(w io.Writer, rows []string) {
	settled := make([]string, len(rows))
	for i, r := range rows {
		settled[i] = StyleBrand.Render(r)
	}
	still := strings.Join(settled, "\n") + "\n"

	// The swarm (swarm.go) is the reveal now. It plays only where a scene may, and its final
	// frame is still, so a skipped, refused or completed swarm all leave the same bytes.
	if revealScene(w, rows) {
		return
	}
	fmt.Fprint(w, still)
}

// InShellPane reports whether this process is a child of `taildefense shell`, writing into a pane.
func InShellPane() bool { return os.Getenv("TAILDEFENSE_SHELL") == "1" }
