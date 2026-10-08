package ui

import (
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// Bars and rails, for a view that has to show a pipeline rather than a spinner.
//
// Everything here obeys the four rules at the top of anim.go, and the fourth one is
// the reason these are functions of a width rather than of a string: a caller sizes a
// column once and every frame fills exactly that many cells. A bar that grew by a cell
// when it filled would push the column beside it back and forth on every frame.
//
// The distinction that matters between the two bar kinds is what they claim. Meter says
// "this much of a known total is done". SweepBar says "something is happening and there
// is no total to report". Using a Meter for the second is the classic lie: a bar that
// creeps to 90% and sits there is worse than no bar, because a person waits on it.

// Meter is a determinate bar: width cells, filled to frac of them in fill's colour and
// dim for the rest.
//
// A non-zero fraction always draws at least one cell. Rounding a real but tiny fraction
// down to an empty bar reads as "not started", which is the one thing it is not.
func Meter(width int, frac float64, fill lipgloss.Style) string {
	if width <= 0 {
		return ""
	}
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	n := int(frac*float64(width) + 0.5)
	if frac > 0 && n == 0 {
		n = 1
	}
	if n > width {
		n = width
	}
	return fill.Render(strings.Repeat("█", n)) + StyleDim.Render(strings.Repeat("░", width-n))
}

// sweepPeriod is one traverse of a SweepBar. Slower than the spinner on purpose: the
// spinner says "alive" and wants to be quick, while this says "in progress" beside a
// stage name and a fast band there reads as agitation.
const sweepPeriod = 1100 * time.Millisecond

// SweepBar is an indeterminate bar: a warm band travelling through a dim track, for a
// stage that is running and cannot say how far along it is.
//
// The band enters at the left and leaves at the right rather than wrapping around. A
// wrapping band has a frame where it is at both edges at once, which reads as two
// things happening instead of one thing moving.
//
// With animation off it settles to a half-tone track in the accent. Still legibly
// "running, no progress known", which is the information; only the motion is decoration.
func SweepBar(width int, elapsed time.Duration) string {
	if width <= 0 {
		return ""
	}
	if !AnimEnabled() {
		return StyleAccent.Render(strings.Repeat("▒", width))
	}
	return sweepBarAt(width, elapsed)
}

// sweepBarAt is SweepBar without the terminal check, so the width invariant is testable
// where there is no terminal to draw on.
func sweepBarAt(width int, elapsed time.Duration) string {
	if len(rampStyles) == 0 {
		initAnim()
	}
	band := width / 3
	if band < 2 {
		band = 2
	}
	span := width + band
	head := int(int64(elapsed%sweepPeriod) * int64(span) / int64(sweepPeriod))

	lo, hi := rampIdx(fracRest), rampIdx(fracHot)
	var b strings.Builder
	for i := 0; i < width; i++ {
		d := head - i
		if d < 0 || d >= band {
			b.WriteString(StyleDim.Render("░"))
			continue
		}
		// Hottest at the leading edge, cooling back through the band, so the bar has a
		// direction. A uniformly bright band is a block sliding about; a graded one is
		// a thing moving.
		b.WriteString(rampStyles[hi-(hi-lo)*d/band].Render("▓"))
	}
	return b.String()
}

// pipePeriod is one descent of a packet down a Pipe. Slowest of the three cadences here,
// because it crosses the tallest distance: matching it to the sweep would have the packet
// covering a sixteen-row column in the time the bar beside it crosses eight cells, which
// looks like a glitch rather than like flow.
const pipePeriod = 1400 * time.Millisecond

// Pipe is a vertical rail of rows cells, returned one cell per row, with a packet
// descending it while flowing is true.
//
// It is the connector in a flow chart, and it is made of colour alone: every row is the
// same box-drawing glyph at every frame, and only the shade moves. That is anim.go's
// no-glyph-substitution rule, and here it also buys the right degradation — on a
// sixteen-colour terminal or with animation off, the column is a plain rail, which is
// exactly what a still flow chart should look like.
//
// The caller sizes the rail to the part of the pipeline that is live, so the packet
// descends into the stage currently running and never past it. A packet travelling
// through stages that have not started would say data is there when it is not.
func Pipe(rows int, elapsed time.Duration, flowing bool) []string {
	if rows <= 0 {
		return nil
	}
	out := make([]string, rows)
	if !AnimEnabled() || !flowing {
		for i := range out {
			out[i] = StyleDim.Render("│")
		}
		return out
	}
	if len(rampStyles) == 0 {
		initAnim()
	}

	// A three-cell comet. One cell is a blink that the eye loses between frames on a
	// long column; a longer tail on a short pipe is lit end to end and stops reading as
	// movement at all.
	const tail = 3
	span := rows + tail
	head := int(int64(elapsed%pipePeriod) * int64(span) / int64(pipePeriod))

	lo, hi := rampIdx(fracRest), rampIdx(fracHot)
	for i := range out {
		d := head - i
		if d < 0 || d >= tail {
			out[i] = StyleDim.Render("│")
			continue
		}
		out[i] = rampStyles[hi-(hi-lo)*d/tail].Render("│")
	}
	return out
}

// Gauge is a stacked determinate bar: several counts in their own colours, sharing one
// track of width cells against an explicit total, with the remainder left dim.
//
// The total is a parameter rather than the sum of the segments, and that is the whole
// design of it. Summing the segments makes every gauge full: three passed stages of eight
// with the other five not passed to it is a bar reading 100%, which is the opposite of the
// truth and looks plausible. Passing the total means the caller has to say what it is
// counting against, and a caller that genuinely wants the segments to fill the track says
// so by passing their sum.
//
// Rounding goes to each segment in turn and a non-zero count always gets a cell, so the
// first of twenty files to change shows as a cell rather than as nothing.
func Gauge(width, total int, segs []GaugeSeg) string {
	if width <= 0 {
		return ""
	}
	if total <= 0 {
		return StyleDim.Render(strings.Repeat("░", width))
	}

	cells := make([]int, len(segs))
	used := 0
	sum := 0
	for i, s := range segs {
		n := s.Count * width / total
		if s.Count > 0 && n == 0 {
			n = 1
		}
		cells[i] = n
		used += n
		sum += s.Count
	}
	// Segments that make up the whole total fill the whole track. Rounding each one down on its
	// own leaves a dim cell at the end of a bar whose parts are everything there is, and a dim
	// cell reads as "not all of it". The cells still owed go to the largest remainders, so the
	// rounding lands where it is least wrong.
	if sum == total {
		taken := make([]bool, len(segs))
		for used < width {
			best, bestRem := -1, -1
			for i, s := range segs {
				if s.Count == 0 || taken[i] {
					continue
				}
				if rem := s.Count * width % total; rem > bestRem {
					best, bestRem = i, rem
				}
			}
			if best < 0 {
				break
			}
			cells[best]++
			taken[best] = true
			used++
		}
	}
	// Trim from the end back if the per-segment minimums overflowed the track. Each pass
	// takes at most one cell per segment, and a pass that takes none breaks out rather
	// than spinning: with more non-zero segments than cells there is nothing left to give
	// and a bar one cell over is better than a hung frame.
	for over := used - width; over > 0; {
		took := 0
		for i := len(cells) - 1; i >= 0 && over > 0; i-- {
			if cells[i] > 0 {
				cells[i]--
				over--
				took++
			}
		}
		if took == 0 {
			break
		}
	}

	var b strings.Builder
	drawn := 0
	for i, s := range segs {
		b.WriteString(s.Style.Render(strings.Repeat("█", cells[i])))
		drawn += cells[i]
	}
	if rest := width - drawn; rest > 0 {
		b.WriteString(StyleDim.Render(strings.Repeat("░", rest)))
	}
	return b.String()
}

// GaugeSeg is one coloured run of a Gauge.
type GaugeSeg struct {
	Count int
	Style lipgloss.Style
}

// ── the remembered flow-view choice ──────────────────────────────────────────
//
// It lives here rather than in the command that draws one because the dispatcher applies every
// remembered preference in one place at startup, and because the shell has to reapply
// them when a `td config` run inside the session changes the file. A preference the
// single command owned would be invisible to both.

// EnvNoFlow turns the flow view off for one run, the way TAILDEFENSE_NO_ANIM turns
// animation off for one run.
//
// Worth having beyond the flag because a script or an agent driving `taildefense` does not
// always control the argument list, and the flow view off a terminal is already
// impossible rather than merely unwanted. This covers the case in between: a terminal
// that can host it, where the caller wants the transcript alone.
const EnvNoFlow = "TAILDEFENSE_NO_FLOW"

var flowPref = true

// SetFlow records whether a long run — a promote, a full render — draws the live view.
func SetFlow(on bool) { flowPref = on }

// FlowSetting reports whether the flow view is wanted: the remembered choice, unless
// EnvNoFlow overrides it for this process.
//
// Unlike AnimateSetting this folds the environment variable in, because its one caller is
// deciding what to draw rather than reporting a setting back to the operator. `td config
// flow` reads the preferences file directly and names the override separately, the same
// way `td config animate` does.
func FlowSetting() bool {
	if os.Getenv(EnvNoFlow) != "" {
		return false
	}
	return flowPref
}
