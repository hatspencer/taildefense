package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/platform"
)

// A pipeline: a chain of nodes drawn as a flow chart, one row per node.
//
// A chain drawn in place beats a list of lines: when a chain is
// slow or stuck, the question is always "where", and a picture answers it without making
// the reader count back from the bottom of a transcript. This is that picture with the
// no command-specific parts, so `doctor` can draw its checks as the dependency chain they
// are and `promote` can draw the steps a decided rule passes through on its way to steering.
//
// The visual language is the flow view's exactly — the same glyphs, the same rail, the same
// bar widths — so a person who has watched one promote reads a doctor map without learning
// anything new. The promote pipeline is the intended second caller of this renderer;
// it keeps its own copy for now because its rows carry probes and side panels this one
// does not, and moving it is a change to a view that is already right.
//
// Everything here obeys the four rules at the top of anim.go. In particular every row is
// at most width cells, measured in cells, so a frame redrawn in place never wraps — a
// wrapped row is what turns a live block into a smear of scrolled copies.

// NodeState is what a node has done so far.
type NodeState int

const (
	// NodePending has not started.
	NodePending NodeState = iota
	// NodeRunning is in flight.
	NodeRunning
	// NodePassed finished cleanly.
	NodePassed
	// NodeFailed finished and something is wrong.
	NodeFailed
	// NodeUnreached never ran because a node before it failed. Distinct from pending on
	// purpose: after a failure, everything below it drawn as "not yet" reads as a run
	// still going, and a run that has stopped should look stopped.
	NodeUnreached
	// NodeInfo ran and has something to say that is neither a pass nor a failure: a
	// skipped check, a fact.
	NodeInfo
	// NodeWarn finished with something worth knowing that does not stop the chain.
	NodeWarn
)

// Node is one stage of a pipeline.
type Node struct {
	// Label is the node's name, the column the eye scans down. Kept short by the caller;
	// the column is sized to the longest one and a long label pushes every bar right.
	Label string
	// Desc says what the node does or reads, in the terms an investigation uses. Static
	// text about the node, never something observed, so it cannot disagree with the
	// state beside it.
	Desc  string
	State NodeState
	// Bar is how much of the track to fill, 0..1, for a finished node; negative draws
	// no bar at all. A running node ignores it and draws a sweep, because a running
	// node has no total to report.
	Bar float64
	// Duration is printed beside the bar when it is positive.
	Duration time.Duration
	// Detail is the failure, or whatever else is worth a second row. It is drawn on the
	// connector row under the node rather than on the node row, because it is usually
	// long and pushing the node row out would move every column the moment something
	// went wrong.
	Detail string
}

// Pipeline renders nodes as rows of at most width cells. Failed nodes get a second row
// carrying their Detail; nothing else does, so the height is len(nodes) plus one per
// failure with a detail.
//
// elapsed drives the running node's sweep and spinner and nothing else, so two renders at
// the same elapsed produce the same bytes.
func Pipeline(nodes []Node, width int, elapsed time.Duration) []string {
	if width < 20 {
		width = 20
	}
	labelW := 0
	for _, n := range nodes {
		labelW = max(labelW, ansi.StringWidth(n.Label))
	}
	labelW = min(labelW, 18)

	// Everything after a failure rides a red rail: the rail is the chain, and a chain
	// broken at one node is broken below it.
	broken := false
	var lines []string
	for _, n := range nodes {
		rail := StyleDim.Render("│")
		if broken {
			rail = StyleRed.Render("│")
		}
		lines = append(lines, pipelineRow(n, rail, labelW, width, elapsed))
		if n.State == NodeFailed {
			broken = true
			if n.Detail != "" {
				line := "  " + StyleRed.Render("│") + "   " + StyleRed.Render(n.Detail)
				lines = append(lines, clipRow(line, width))
			}
		}
	}
	return lines
}

// pipelineBarWidth is the cells a node's bar gets, the flow view's railWidth.
const pipelineBarWidth = 14

func pipelineRow(n Node, rail string, labelW, width int, elapsed time.Duration) string {
	var glyph, bar, timing string
	labelStyle := StyleDim
	descStyle := StyleDim

	track := StyleDim.Render(strings.Repeat("·", pipelineBarWidth))
	switch n.State {
	case NodePending:
		glyph = StyleDim.Render("·")
		bar = track
	case NodeRunning:
		glyph = Pulse(elapsed).Render(Spinner(elapsed))
		bar = SweepBar(pipelineBarWidth, elapsed)
		labelStyle = StyleAccent
	case NodePassed:
		glyph = StyleGreen.Render("✔")
		bar = meterOrTrack(n, StyleGreen, track)
		labelStyle = StyleGreen
	case NodeFailed:
		glyph = StyleRed.Render("✘")
		bar = meterOrTrack(n, StyleRed, track)
		labelStyle = StyleRed
	case NodeWarn:
		glyph = StyleYellow.Render("●")
		bar = meterOrTrack(n, StyleYellow, track)
		labelStyle = StyleYellow
	case NodeInfo:
		glyph = StyleDim.Render("○")
		bar = meterOrTrack(n, StyleDim, track)
	case NodeUnreached:
		glyph = StyleDim.Render("○")
		bar = track
		descStyle = StyleDim
	}
	if n.Duration > 0 && n.State != NodePending && n.State != NodeUnreached {
		timing = StyleDim.Render(shortDuration(n.Duration))
	}

	// Fixed cells are padded before styling: lipgloss counts escape sequences in a styled
	// string, so padding afterwards lands in the wrong column and the columns walk.
	head := fmt.Sprintf("  %s %s %s %s %s",
		glyph, rail, labelStyle.Render(padCells(n.Label, labelW)), bar, padCells(timing, 6))

	rest := width - ansi.StringWidth(head) - 2
	if rest > 8 && n.Desc != "" {
		head += "  " + descStyle.Render(clipRow(n.Desc, rest))
	}
	return clipRow(head, width)
}

func meterOrTrack(n Node, fill lipgloss.Style, track string) string {
	if n.Bar < 0 {
		return track
	}
	return Meter(pipelineBarWidth, n.Bar, fill)
}

// shortDuration renders a duration at the precision a person compares stages at:
// milliseconds under a second, tenths above it.
func shortDuration(d time.Duration) string {
	if d <= 0 {
		return ""
	}
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	return Elapsed(d)
}

// padCells widens s to n cells, never truncates.
func padCells(s string, n int) string {
	if gap := n - ansi.StringWidth(s); gap > 0 {
		return s + strings.Repeat(" ", gap)
	}
	return s
}

// clipRow shortens s to n cells with an ellipsis, measured in cells so a wide rune cannot
// push a row past the column and cutting between escape sequences rather than inside one.
func clipRow(s string, n int) string {
	if n <= 1 || ansi.StringWidth(s) <= n {
		return s
	}
	return ansi.Truncate(s, n, "…")
}

// ── A block redrawn in place ─────────────────────────────────────────────────
//
// The progress line in progress.go rewrites one line with a carriage return so it composes
// with the ordinary output above and below it. A pipeline is several lines, so this is the
// same idea taller: the block is printed once, and every redraw moves the cursor back up
// to its first row and rewrites each row, erasing to the end of the line so a shorter row
// leaves no tail of a longer one behind it.
//
// It is not Bubble Tea and not the alternate screen for the same reason the progress line
// is not: when it ends the final block stays in scrollback like any other output, and the
// transcript printed after it is the transcript it always was.
//
// Two things keep it from smearing. Every row is clipped to the terminal width, because a
// row that wraps is two rows and the cursor arithmetic is then off by one for the rest of
// the run. And the height is fixed at the first draw: a block that grew a row would push
// the rows below its original extent and the next move-up would land in the wrong place.

// LiveBlock is a region of the terminal redrawn in place.
//
// Inside a `hive shell` pane it is a live region instead (pane.go): the same rows, handed
// to the session as whole frames rather than drawn with cursor movement, and the session
// keeps the final one as transcript. The caller does not know which it got.
type LiveBlock struct {
	w      io.Writer
	height int
	drawn  bool
	width  int
	pane   *PaneFrames
}

// LiveBlockEnabled reports whether a block can be redrawn where the caller is about to
// print: a real terminal with colour, or a shell pane that paints live frames; not under
// --json, where stdout is a document, and not while a caller in this process is
// collecting the output (captured.go). A pane that cannot paint frames strips cursor
// movement (anim.go rule 2), so there the answer is no.
func LiveBlockEnabled() bool {
	if !platform.IsTTY() || !ColorEnabled() || JSONMode() || Captured() {
		return false
	}
	if InShellPane() {
		return PaneLiveEnabled()
	}
	return true
}

// NewLiveBlock prepares a block of height rows on stdout. Draw it with Draw as often as
// wanted and finish with Done, which leaves the last frame in place.
func NewLiveBlock(height int) *LiveBlock {
	return newLiveBlock(os.Stdout, height, PaneLiveEnabled())
}

// newLiveBlock is NewLiveBlock with the destination and the pane choice explicit, so a
// test can catch the bytes without a terminal or a session.
func newLiveBlock(w io.Writer, height int, pane bool) *LiveBlock {
	b := &LiveBlock{w: w, height: height, width: termWidthOr(120)}
	if pane {
		b.pane = StartPaneFrames(w)
	}
	return b
}

// Draw replaces the block with rows. Fewer rows than the height are padded with blank
// rows; more are dropped, because growing would break the cursor arithmetic described
// above. The pane keeps the same fixed height, so a block reads the same in both.
func (b *LiveBlock) Draw(rows []string) {
	fitted := make([]string, b.height)
	for i := 0; i < b.height && i < len(rows); i++ {
		fitted[i] = clipRow(rows[i], b.width)
	}
	if b.pane != nil {
		b.pane.Draw(fitted)
		return
	}
	if b.drawn {
		fmt.Fprintf(b.w, "\x1b[%dA", b.height)
	}
	for _, row := range fitted {
		fmt.Fprintf(b.w, "\r%s\x1b[K\n", row)
	}
	b.drawn = true
}

// Done ends the block. The final frame stays where it is; nothing is erased, because the
// picture is the output. In a pane that means telling the session to keep the last frame.
func (b *LiveBlock) Done() {
	if b.pane != nil {
		b.pane.Finish(nil)
	}
}
