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
//     The exception is a live region (pane.go): a block handed to the session as
//     whole frames, which the session paints in place itself. While one is open
//     the effects draw inside the pane, because nothing there moves the cursor.

//
//  3. Frames are a pure function of elapsed time, never of a counter. That is the
//     rule Spinner already follows and the reason is the same: a redrawn table
//     redraws every row from one tick, and per-row counters drift out of phase, so
//     the table shimmers where nothing has changed. Off the clock, a dropped or
//     coalesced tick skips a frame instead of stalling.
//
//  4. It never changes a visible width. Shimmer recolours cells and adds no cells,
//     so a shimmering header still measures the same as a still one. The wordmark
//     sits next to a column of facts sized by measuring it; an animation that grew
//     by a cell would push that column back and forth on every frame.
//
// Colour only, no glyph substitution. The braille spinner is one cell wide in every
// font, which is why it was chosen over the block and arrow sets, and animating the
// hue keeps that property where swapping in wider glyphs would reintroduce the jitter.
//
// One consequence of being made of colour: on a sixteen-colour terminal every stop of
// the ramp maps to the same ANSI red, so the shimmer and the pulse are static there.
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

// AnimateSetting reports the remembered choice alone, ignoring the terminal and the
// environment, for `td config animate` to display.
func AnimateSetting() bool { return animPref }

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
	// purpose; see the note above the ambient set.
	fracCalm = 0.6
	// fracBreath is the top of a breathing glyph or badge.
	fracBreath = 0.8
	// fracHot is the leading edge of a sweep or a wipe.
	fracHot = 1.0
)

// rampStyles is AccentRamp resolved to styles once, because Shimmer touches every
// visible cell of a six-row wordmark on every frame and building a style per cell per
// frame is thousands of allocations a second for a decoration.
var rampStyles []lipgloss.Style

// rampBadgeStyles is the same ramp as backgrounds, for the one piece of chrome that is a
// filled block rather than text: the active tab. Text on it stays ColorOnAccent at every
// stop, so a breathing badge never loses its contrast against its own label.
var rampBadgeStyles []lipgloss.Style

// initAnim rebuilds the ramp. Called from InitColor, so a test that toggles colour
// gets styles that agree with the profile in force.
func initAnim() {
	rampStyles = make([]lipgloss.Style, len(AccentRamp))
	rampBadgeStyles = make([]lipgloss.Style, len(AccentRamp))
	for i, c := range AccentRamp {
		rampStyles[i] = lipgloss.NewStyle().Foreground(c).Bold(true)
		rampBadgeStyles[i] = lipgloss.NewStyle().Foreground(ColorOnAccent).Background(c).Bold(true)
	}
	invalidateCandy()
	paletteVersion.Add(1)
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
	// Output collected by a caller in this process, see captured.go. Same reason as the
	// shell pane below: the cursor does not belong to a command whose output is being
	// gathered rather than shown.
	if Captured() {
		return false
	}
	// Inside a shell pane the output is captured and cursor control is stripped; see
	// rule 2 above. The session exports this marker to every command it runs. The one
	// exception is a live region: while a PaneFrames sink is open the frames reach the
	// session whole and are painted in place, so the effects draw there exactly as they
	// would on a terminal. See pane.go.
	if InShellPane() {
		return paneLive.Load() > 0
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
//
// s must be unstyled wherever this is used. Every caller passes wordmark rows or a rule,
// which are plain, and requiring that is what keeps the renderer from having to parse
// escape sequences it might cut in half — the failure mode there is a terminal left stuck
// in whatever colour the truncated sequence was setting.
const shimmerBand = 7

// shimmerAt renders s with the highlight centred on cell head.
//
// Cells are emitted in runs of one shade rather than one escape sequence per cell. That
// is not a micro-optimisation, it is the difference between a banner costing 60 KB and
// costing 480 KB: the artwork is six rows of eighty cells, a truecolor foreground is
// nineteen bytes, and this is drawn thirty times. Most of a frame is the base shade
// either side of the band, so run-length colouring collapses eighty sequences to a
// handful — and the tool is used over a VPN, where half a megabyte per banner is a
// visible pause rather than a rounding error.
//
// Whitespace joins the run it lands in rather than breaking it. A foreground colour on a
// space paints nothing, so the only effect of including it is a shorter string.
func shimmerAt(s string, head int) string {
	return shimmerGraded(s, head, shimmerBand, rampIdx(fracHot))
}

// shimmerGraded is shimmerAt with the band width and the hottest stop as parameters.
//
// A sweep uses the full band and the top of the ramp. The idle drift uses a wider, cooler
// one: an always-on animation at a prompt somebody is reading has to be felt rather than
// noticed, and the same effect at full contrast strobes.
func shimmerGraded(s string, head, band, top int) string {
	return shimmerHeads(s, []int{head}, band, top)
}

// shimmerHeads is the frame renderer: text lit by one or more travelling highlights.
//
// More than one head exists for the wordmark's converge and diverge sweeps, where two
// highlights move toward or away from each other. A cell takes its shade from whichever
// head is nearest, so where two heads overlap the brighter one wins rather than the two
// summing into a band brighter than the ramp has.
func shimmerHeads(s string, heads []int, band, top int) string {
	if len(rampStyles) == 0 {
		initAnim()
	}
	if band < 1 {
		band = 1
	}
	base := rampIdx(fracRest)
	if top > rampIdx(fracHot) {
		top = rampIdx(fracHot)
	}
	if top < base {
		top = base
	}

	var b strings.Builder
	b.Grow(len(s) + 64)

	run := strings.Builder{}
	runIdx := -1
	flush := func() {
		if run.Len() == 0 {
			return
		}
		b.WriteString(rampStyles[runIdx].Render(run.String()))
		run.Reset()
	}

	col := 0
	for _, r := range s {
		idx := runIdx
		if r != ' ' && r != '\t' {
			// Distance to the nearest head. Cheaper than it looks: heads is one or two
			// entries, and this is the inner loop of a six-row wordmark.
			d := band
			for _, head := range heads {
				delta := col - head
				if delta < 0 {
					delta = -delta
				}
				if delta < d {
					d = delta
				}
			}
			idx = base
			if d < band {
				// Linear from the base shade at the edge of the band to the top shade at
				// its centre, rounded so the middle cell actually reaches the top.
				idx = base + (top-base)*(band-d)/band
			}
		}
		if idx < 0 {
			idx = base
		}
		if idx != runIdx {
			flush()
			runIdx = idx
		}
		run.WriteRune(r)
		col++
	}
	flush()
	return b.String()
}

// ── the ambient set ─────────────────────────────────────────────────────────
//
// Everything above is transient: it runs while an operation runs and stops. What follows
// runs at an idle prompt, which is a different bargain, because it needs the shell's
// ticker to keep waking up when nothing is happening.
//
// So the ambient effects are deliberately slow and low contrast. Two reasons, and the
// second is the one that matters. A prompt that pulses at the same rate and contrast as a
// working spinner tells you the session is busy when it is not, and the animation stops
// being decoration and becomes a lie. And a person is reading the text next to it.

// rulePeriod is one pass of the highlight along a rule. Slower than the wordmark's idle
// drift, because a rule is a single row of identical cells and the eye tracks motion in it
// far more readily than in artwork.
//
// The rule animates only while busy (Rule returns the still row otherwise), so this is the
// busy-pass speed: 2s, a third of the earlier 6s, so a working session's separators read as
// active motion rather than a slow drift.
const rulePeriod = 2 * time.Second

// Rule is the horizontal separator with a soft highlight travelling along it.
//
// The still version is what every rule in this tool was: one dim row. The animated one is
// the same row with a wide, cool band moving through it, which is what turns three
// separate rules into one frame that feels continuous, because they all move on one clock.
//
// busy is what gates the motion. At an idle prompt the rule rests as one dim row: the
// separator is chrome, and a highlight sweeping through it forever is motion in peripheral
// vision that says "working" when nothing is. It travels only while the session is thinking,
// executing, or waiting on a result, so the moving band becomes the same signal the spinner
// carries — activity — and its absence means the prompt is yours.
func Rule(width int, elapsed time.Duration, busy bool) string {
	if !motion() || !busy || width <= 0 {
		return StyleDim.Render(strings.Repeat("─", max(0, width)))
	}
	return ruleAt(width, elapsed)
}

// ruleAt is Rule without the terminal check, so the width invariant that keeps the frame
// from wrapping is testable where there is no terminal.
func ruleAt(width int, elapsed time.Duration) string {
	if width <= 0 {
		return ""
	}
	if len(rampStyles) == 0 {
		initAnim()
	}

	const band = 14
	travel := width + 2*band
	head := int(int64(elapsed%rulePeriod)*int64(travel)/int64(rulePeriod)) - band

	// Dim is the base rather than the ramp's darkest stop: a rule is chrome, and lifting
	// it into the accent for its whole length would make the frame look like it was
	// warning about something.
	var b strings.Builder
	b.Grow(width * 3)
	runStart, runIdx := 0, -2
	flush := func(end int) {
		if end <= runStart {
			return
		}
		seg := strings.Repeat("─", end-runStart)
		if runIdx < 0 {
			b.WriteString(StyleDim.Render(seg))
			return
		}
		b.WriteString(rampStyles[runIdx].Render(seg))
	}
	for col := 0; col < width; col++ {
		d := col - head
		if d < 0 {
			d = -d
		}
		idx := -1
		if d < band {
			// Graded from the ramp's dark end rather than from the resting accent, and
			// never past the ambient ceiling. Two reasons: a rule lifted to the top of the
			// ramp reads as a warning about something, and starting the grade at the accent
			// put a hard step at the edge of the band — dim grey in one cell and full
			// scarlet in the next, which reads as a seam travelling along the rule rather
			// than as a highlight.
			lo, hi := rampIdx(0.1), rampIdx(fracCalm)
			idx = lo + (hi-lo)*(band-d)/band
		}
		if idx != runIdx {
			flush(col)
			runStart, runIdx = col, idx
		}
	}
	flush(width)
	return b.String()
}

// badgePeriod is one breath of a filled badge. Longer than the pulse used for "working",
// so the two cannot be confused.
const badgePeriod = 2100 * time.Millisecond

// BadgeBreath is the active tab: a block of accent colour that rises and falls.
//
// It is the "you are here" marker, so it animates whether or not anything is running, and
// it is the one ambient effect on a *background* rather than on text. The rise stays in
// the top third of the ramp: a badge that dropped to the dark end would read as an
// inactive tab for part of every cycle, which is worse than not animating at all.
func BadgeBreath(elapsed time.Duration) lipgloss.Style {
	if !motion() {
		return StyleBadge
	}
	if len(rampBadgeStyles) == 0 {
		initAnim()
	}
	lo := rampIdx(fracRest)
	span := rampIdx(fracBreath) - lo
	steps := 2 * span
	pos := int(int64(elapsed%badgePeriod) * int64(steps) / int64(badgePeriod))
	if pos >= span {
		pos = steps - pos
	}
	return rampBadgeStyles[lo+pos]
}

// BreathText is a short piece of text rising and falling on the ramp, for a single glyph
// that should look alive without claiming anything is happening.
//
// Slower than Pulse and it never reaches the top stop. Pulse means "working, wait"; this
// means "idle, yours". Two effects that looked the same would make one of them useless.
func BreathText(s string, elapsed time.Duration) string {
	if !motion() {
		return StyleBrand.Render(s)
	}
	if len(rampStyles) == 0 {
		initAnim()
	}
	const period = 2600 * time.Millisecond
	lo := rampIdx(fracRest)
	span := rampIdx(fracBreath) - lo
	steps := 2 * span
	pos := int(int64(elapsed%period) * int64(steps) / int64(period))
	if pos >= span {
		pos = steps - pos
	}
	return rampStyles[lo+pos].Render(s)
}

// Decay is a marker cooling from the hot end of the ramp to nothing over d.
//
// Used for the gutter pip beside a line that just arrived. It reports false once it has
// cooled out, which is what lets the caller draw a space instead of a stale marker — an
// animation that ends by leaving its last frame on screen forever is a smear, not an
// animation.
func Decay(age, d time.Duration) (lipgloss.Style, bool) {
	if !AnimEnabled() {
		return StyleDim, false
	}
	return decayAt(age, d)
}

// decayAt is Decay without the terminal check, so the cooling itself is testable where
// there is no terminal to draw on.
func decayAt(age, d time.Duration) (lipgloss.Style, bool) {
	if age < 0 || d <= 0 || age >= d {
		return StyleDim, false
	}
	if len(rampStyles) == 0 {
		initAnim()
	}
	top := rampIdx(fracHot)
	base := rampIdx(fracRest)
	idx := top - int(int64(age)*int64(top-base+1)/int64(d))
	if idx < base {
		idx = base
	}
	return rampStyles[idx], true
}

// Wipe is artwork revealed to a fraction of its width, behind a hot leading edge.
//
// The shell's opening frame uses it: the header wipes in, so a session that has just
// started looks like it started rather than like it was always there. Fraction is
// clamped, and 1 or more returns the settled string, so a caller does not have to stop
// calling it at exactly the right moment.
func Wipe(s string, fraction float64) string {
	if !AnimEnabled() || fraction >= 1 {
		return StyleBrand.Render(s)
	}
	if fraction < 0 {
		fraction = 0
	}
	width := visibleWidth(s)
	head := int(float64(width) * fraction)
	return shimmerAt(clipCells(s, head), head)
}

// RuleWipe is a rule drawn to a fraction of its width, for the same opening frame.
func RuleWipe(width int, fraction float64) string {
	if !AnimEnabled() || fraction >= 1 {
		return StyleDim.Render(strings.Repeat("─", max(0, width)))
	}
	if fraction < 0 {
		fraction = 0
	}
	n := int(float64(width) * fraction)
	if n <= 0 {
		return ""
	}
	// The leading cell is hot, so the rule reads as being drawn rather than as a rule
	// that happens to be short.
	return StyleDim.Render(strings.Repeat("─", n-1)) + rampStyles[rampIdx(fracHot)].Render("─")
}

// ── the wordmark's own sweep ─────────────────────────────────────────────────
//
// The wordmark is the one surface that does not animate continuously, and the reason is
// that it is the largest thing on screen. A highlight cycling across it forever is motion
// in peripheral vision that never resolves into anything, which is exactly the kind of
// decoration that becomes irritating on the second day. So it rests in the brand colour,
// and every few seconds one sweep crosses it and stops.
//
// Resting also costs nothing: between sweeps the header renders to the same string every
// frame, and Bubble Tea diffs frames, so the terminal is written to only while a sweep is
// actually playing.
//
// The timing and the direction look random and are not: both come from a hash of the cycle
// number, so they are still a pure function of elapsed time. That matters for the same
// reason it matters everywhere else here — six rows are rendered independently from one
// clock, and a real random source would give each row a different direction.

// SweepStyle is a direction the wordmark's highlight can travel.
type SweepStyle int

const (
	// SweepLeftToRight is the plain reading-direction pass.
	SweepLeftToRight SweepStyle = iota
	// SweepRightToLeft is the same pass reversed.
	SweepRightToLeft
	// SweepConverge starts a highlight at each end and meets in the middle.
	SweepConverge
	// SweepDiverge starts in the middle and splits outward to both ends.
	SweepDiverge
	sweepStyles = 4
)

const (
	// sweepDuration is one pass across the artwork.
	sweepDuration = 1100 * time.Millisecond
	// idleSweepCycle and busySweepCycle are how often a sweep may start. The busy one is
	// shorter so a running command still reads as activity, and it is a rate rather than a
	// continuous animation because that distinction is what the spinner is for.
	idleSweepCycle = 5 * time.Second
	busySweepCycle = 2200 * time.Millisecond
)

// WordmarkSweep renders one row of the wordmark: resting most of the time, swept
// occasionally, in a direction that changes each time.
//
// busy shortens the interval. Every row of the artwork must be passed the same elapsed
// value, which is what keeps the sweep one event crossing a block rather than six rows
// disagreeing about where the highlight is.
func WordmarkSweep(s string, elapsed time.Duration, busy bool) string {
	// motion rather than AnimEnabled: over SSH the sweep skips and the wordmark rests,
	// because a band crossing eighty cells at four frames a second is a stutter, not a
	// sweep. See tick.go.
	if !motion() {
		return StyleBrand.Render(s)
	}
	return wordmarkSweepAt(s, elapsed, busy)
}

// wordmarkSweepAt is WordmarkSweep without the terminal check, so the schedule and the
// resting behaviour are testable where there is no terminal to draw on.
func wordmarkSweepAt(s string, elapsed time.Duration, busy bool) string {
	cycle := idleSweepCycle
	if busy {
		cycle = busySweepCycle
	}
	i := int64(elapsed / cycle)
	start, style := sweepSchedule(i, cycle)

	within := elapsed % cycle
	if within < start || within >= start+sweepDuration {
		return StyleBrand.Render(s)
	}
	progress := float64(within-start) / float64(sweepDuration)
	return sweepFrame(s, progress, style)
}

// sweepSchedule is when in cycle i the sweep starts and which direction it takes.
//
// The delay is what makes the gap between sweeps uneven: the cycle is fixed, the sweep
// floats inside it, so two sweeps can fall close together or nearly a cycle apart. Without
// it a sweep every five seconds is a metronome, which is the thing that reads as mechanical.
//
// The direction comes from a shuffled block of four rather than a fresh draw each time.
// Four independent draws would give the same direction twice in a row often, and would
// sometimes not show one of the four for a minute; a shuffled block guarantees that every
// four sweeps contain all four directions in a random order. Two the same can still meet
// across a block boundary, which is fine — it is one repeat, not a pattern.
func sweepSchedule(i int64, cycle time.Duration) (time.Duration, SweepStyle) {
	room := cycle - sweepDuration
	if room < 0 {
		room = 0
	}
	delay := time.Duration(0)
	if room > 0 {
		delay = time.Duration(hash64(uint64(i)) % uint64(room))
	}

	perm := sweepBlock(i / sweepStyles)
	return delay, perm[i%sweepStyles]
}

// sweepBlock is the order the four directions are used in for one block of four sweeps.
//
// A Fisher-Yates shuffle driven by the hash of the block number, which is the same trick as
// everywhere else in this file: it looks random and it is reproducible, so six rows of one
// wordmark cannot disagree about which direction the current sweep is going.
func sweepBlock(block int64) [sweepStyles]SweepStyle {
	p := [sweepStyles]SweepStyle{SweepLeftToRight, SweepRightToLeft, SweepConverge, SweepDiverge}
	h := hash64(uint64(block) ^ 0x5bf03635)
	for i := len(p) - 1; i > 0; i-- {
		j := int(h % uint64(i+1))
		h /= uint64(i + 1)
		p[i], p[j] = p[j], p[i]
	}
	return p
}

// sweepFrame is the artwork at one instant of a sweep.
//
// Each direction is a rule for where the heads are at progress p. The band overshoots both
// ends of the artwork so a highlight enters and leaves rather than appearing mid-letter,
// and for the two-headed styles that also means both heads reach the far edge.
func sweepFrame(s string, p float64, style SweepStyle) string {
	width := visibleWidth(s)
	travel := width + 2*shimmerBand
	top := rampIdx(fracHot)

	switch style {
	case SweepRightToLeft:
		head := width + shimmerBand - int(p*float64(travel))
		return shimmerHeads(s, []int{head}, shimmerBand, top)

	case SweepConverge:
		// Both heads travel half the artwork plus the band, so they meet at the centre
		// exactly as the sweep ends.
		reach := width/2 + shimmerBand
		left := -shimmerBand + int(p*float64(reach))
		right := width + shimmerBand - int(p*float64(reach))
		return shimmerHeads(s, []int{left, right}, shimmerBand, top)

	case SweepDiverge:
		mid := width / 2
		reach := mid + shimmerBand
		return shimmerHeads(s, []int{mid - int(p*float64(reach)), mid + int(p*float64(reach))},
			shimmerBand, top)

	default:
		head := -shimmerBand + int(p*float64(travel))
		return shimmerHeads(s, []int{head}, shimmerBand, top)
	}
}

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

// clipCells keeps the first n visible cells of plain text, padding nothing.
//
// Used by the wipe. It counts runes rather than bytes because the artwork is box-drawing
// characters, every one of which is multi-byte and one cell wide.
func clipCells(s string, n int) string {
	if n <= 0 {
		return ""
	}
	col := 0
	for i, r := range s {
		if col >= n {
			return s[:i]
		}
		col++
		_ = r
	}
	return s
}
