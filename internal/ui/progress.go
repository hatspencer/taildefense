package ui

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"taildefense/internal/platform"
)

// SpinnerFrames is a braille spinner. It is one cell wide in every terminal,
// unlike the block and arrow sets, which are double-width in some fonts and make
// the line jitter as they animate.
var SpinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// SpinnerPeriod is how long one frame lasts.
//
// Exported because it is the cadence every animated surface has to share. Three places
// redraw a spinner — this progress line, the shell's status strip and the board build
// table — and each used to pick its own interval: 100 ms here, 120 ms in the shell, one
// second in the table. Since the frame is chosen from elapsed time, a redraw interval
// that is not the frame interval does not slow the spin down, it makes it uneven. The
// shell advanced 1.2 frames per redraw, and the table advanced ten — which is not a spin
// at all, but a glyph changing to an unrelated one once a second. All three tick on this
// now, so one redraw is exactly one frame everywhere.
const SpinnerPeriod = 100 * time.Millisecond

// Spinner picks a frame from an elapsed duration rather than from a counter the
// caller has to keep.
//
// Driving it off the clock is what lets several independent things animate in step:
// a table redraws every row on one tick, and a frame counter per row
// would leave them visibly out of phase. It also means a dropped or coalesced tick
// skips a frame instead of stalling the animation.
func Spinner(elapsed time.Duration) string {
	return SpinnerFrames[int(elapsed/SpinnerPeriod)%len(SpinnerFrames)]
}

// Elapsed renders a duration the way a person reads a wait: seconds up to a
// minute, then minutes and seconds. Milliseconds are noise while you are waiting
// and are dropped.
func Elapsed(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
}

// Progress is a live status line for a long operation. It occupies exactly ONE
// line, and only when there is a terminal to draw on.
//
// # Why not Bubble Tea
//
// The operations this wraps are ordinary line-oriented output: cloning a repo,
// compiling, probing a stack. A Bubble Tea program takes over the whole screen,
// which means everything printed before it has to be reprinted inside it and
// everything after it starts on a cleared screen. A single line rewritten with a
// carriage return composes with the plain output above and below it, which is what
// a transcript you intend to paste into a ticket needs.
//
// Bubble Tea earns its place in the shell, where
// where rows genuinely update out of order and there is no useful line-by-line
// rendering. See cmd/shell.
//
// # Why it degrades rather than disabling
//
// Piped into a file or into `less`, carriage returns and the erase-to-end-of-line
// sequence are recorded literally, and a spinner becomes thousands of lines of
// escape codes. Detecting that and falling back to one plain line at the start
// keeps the information in a form that survives redirection — which matters
// because `td update` output is exactly what someone pastes when it fails.
type Progress struct {
	label string
	start time.Time
	live  bool

	mu      sync.Mutex
	stopped bool
	done    chan struct{}

	// lastLine is the most recent output line from the operation, shown after the
	// elapsed counter so the spinner says what is happening rather than only that
	// something is.
	lastLine string
}

// StartProgress begins a progress line. Always arrange for Stop to be called,
// normally with defer.
func StartProgress(label string) *Progress {
	p := &Progress{
		label: label,
		start: time.Now(),
		// The same conditions the rest of the package uses to decide on colour: a
		// real terminal, not TERM=dumb, and NO_COLOR unset. Reusing ColorEnabled
		// keeps `--no-color` and NO_COLOR from having to be handled twice. Captured
		// output is excluded too: this line rewrites itself with a carriage return, and
		// a caller gathering the output does not own the cursor (captured.go).
		live: platform.IsTTY() && ColorEnabled() && !Captured(),
		done: make(chan struct{}),
	}

	if !p.live {
		// Captured, the line is dropped rather than printed: it is a substitute for a
		// spinner, not a finding, and on stdout it would land outside the buffer the caller
		// is collecting into and read as output of whatever ran next.
		if !Captured() {
			fmt.Printf("  %s %s...\n", StyleInfo.Render("·"), label)
		}
		return p
	}

	go p.animate()
	return p
}

func (p *Progress) animate() {
	// One redraw per spinner frame, or the reduced rate over SSH; see tick.go.
	ticker := time.NewTicker(TickInterval())
	defer ticker.Stop()

	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			p.draw()
		}
	}
}

func (p *Progress) draw() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped {
		return
	}

	elapsed := time.Since(p.start)
	// The spinner pulses through the accent ramp rather than sitting on one colour, and
	// the label is dropped to plain text. Between them the eye lands on the moving glyph
	// instead of on the wording, which does not change for the length of the operation.
	line := fmt.Sprintf("  %s %s %s",
		Pulse(elapsed).Render(Spinner(elapsed)),
		p.label,
		StyleDim.Render("("+Elapsed(elapsed)+")"))
	// With animation on, honey flows beside the spinner (honey.go). Off, the line is the line.
	if honey := HoneyFlow(elapsed); honey != "" {
		line = fmt.Sprintf("  %s %s %s %s",
			Pulse(elapsed).Render(Spinner(elapsed)), honey,
			p.label,
			StyleDim.Render("("+Elapsed(elapsed)+")"))
	}

	if p.lastLine != "" {
		line += "  " + StyleDim.Render(p.lastLine)
	}

	// \r back to column zero, draw, then erase to end of line so a shorter line does
	// not leave the tail of a longer one behind it.
	fmt.Printf("\r%s\x1b[K", truncateVisible(line, termWidthOr(120)))
}

// Line reports an output line from the operation.
//
// On a terminal it is folded into the progress line and replaced by the next one:
// a build's warnings are worth glancing at but not worth scrolling for. Without a
// terminal it is printed, because that is the only place it can go.
func (p *Progress) Line(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}

	if !p.live {
		if !Captured() {
			fmt.Printf("    %s\n", StyleDim.Render(text))
		}
		return
	}

	p.mu.Lock()
	p.lastLine = text
	p.mu.Unlock()
}

// Stop ends the progress line, clearing it so the caller's own result line takes
// its place. Safe to call more than once, which is what makes a deferred Stop plus
// an explicit one on the success path harmless.
func (p *Progress) Stop() {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	p.mu.Unlock()

	close(p.done)

	if p.live {
		fmt.Print("\r\x1b[K")
	}
}

// termWidthOr is the terminal's width, or fallback when there is no terminal to measure.
//
// It used to ask TermCols, which never reports "no terminal": it answers 80 for a pipe. So the
// fallback was dead, and output sized for a reader in an editor came out sized for an 80-column
// window.
func termWidthOr(fallback int) int {
	if w, ok := platform.TermWidth(); ok {
		return w
	}
	return fallback
}

// truncateVisible shortens a styled line to width cells, counting only the visible
// text. Measuring the raw string instead would cut in the middle of an escape
// sequence and leave the terminal in whatever colour it was mid-sequence.
func truncateVisible(s string, width int) string {
	if width <= 1 {
		return s
	}

	visible := 0
	inEscape := false
	var b strings.Builder

	for _, r := range s {
		if r == '\x1b' {
			inEscape = true
			b.WriteRune(r)
			continue
		}
		if inEscape {
			b.WriteRune(r)
			// A CSI sequence ends at the first byte in @..~ other than '['.
			if r >= '@' && r <= '~' && r != '[' {
				inEscape = false
			}
			continue
		}
		if visible >= width-1 {
			b.WriteString("\x1b[0m")
			return b.String()
		}
		b.WriteRune(r)
		visible++
	}
	return b.String()
}
