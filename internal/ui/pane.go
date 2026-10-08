package ui

import (
	"encoding/base64"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"taildefense/internal/platform"
)

// Live frames inside a `taildefense shell` pane.
//
// A child of the shell writes into a pane, not a terminal. The pane is a line buffer: it
// keeps colour and drops every cursor movement, because "go back up and overwrite" cannot
// be honoured by something that appends lines (cmd/shell/sanitize.go). That is what kept
// the doctor map and the promote pipeline out of the session — each of them
// is a block redrawn in place, and redrawn into a line buffer a block does not degrade, it
// multiplies: one complete copy per frame, ten a second, scrolling the pane.
//
// So inside a pane a live view does not move the cursor at all. It hands the whole frame
// to the session as one sequence, and the session paints it in place itself — at the
// bottom of the transcript, replacing the last frame — with the same tick the rest of the
// chrome is drawn from. The final frame is flagged, and the session writes that one into
// the transcript as ordinary lines, so it stays in scrollback exactly as it would on a
// terminal. What the session paints is what the child rendered: the same model, the same
// glyphs, the same clock-driven animation, only the delivery differs.
//
// The sequence is an OSC with a private number and a base64 body, for three reasons. It
// rides the same pseudo-terminal as the child's ordinary output, so the order between a
// frame and the lines around it is the order the child wrote them — the final frame is
// always frozen before the transcript that follows it. A terminal that ever receives one
// ignores an OSC it does not know, and base64 keeps the frame's own escape sequences from
// being taken for the end of the OSC. And the pane's sanitiser drops any OSC that is not a
// hyperlink, so a session too old to paint frames loses the picture and nothing else.
//
// The session says whether it paints frames with TAILDEFENSE_PANE_LIVE=1, over and above
// the TAILDEFENSE_SHELL=1 marker every pane child gets. The two are separate because they
// answer different questions: the first says the output is captured, the second says a
// live region is available in it.

// EnvPaneLive is exported by a session whose panes paint live frames.
const EnvPaneLive = "TAILDEFENSE_PANE_LIVE"

// EnvPaneRows is the pane's height in rows, exported by the session so a child can lay
// a frame out for the space it will be painted into rather than for a terminal it does
// not have. Set once at start; a pane that shrinks afterwards clips the frame.
const EnvPaneRows = "TAILDEFENSE_PANE_ROWS"

// paneFramePrefix opens a frame sequence. 5150 is a private-use OSC number no terminal
// assigns; the word after it is there so a stray sequence in a log can be read.
const paneFramePrefix = "\x1b]5150;taildefense-frame;"

// InShellPane reports whether this process is a child of `taildefense shell`, writing into a pane.
func InShellPane() bool { return os.Getenv("TAILDEFENSE_SHELL") == "1" }

// PaneLiveEnabled reports whether a live region can be drawn here: a `taildefense shell` pane
// that paints frames, on a pseudo-terminal rather than a pipe, and not under --json or
// an in-process capture, where stdout is a document rather than a display.
//
// The terminal check is what keeps frames out of a pipeline typed into the session:
// `taildefense audit | tee audit.log` gives the child a pipe, and a frame in a log is garbage.
func PaneLiveEnabled() bool {
	if !InShellPane() || os.Getenv(EnvPaneLive) != "1" {
		return false
	}
	return platform.IsTTY() && !JSONMode() && !Captured()
}

// PaneRows is the pane height the session reported, or 0 when it did not.
func PaneRows() int {
	n, err := strconv.Atoi(os.Getenv(EnvPaneRows))
	if err != nil || n < 1 {
		return 0
	}
	return n
}

// PaneFrameSequence encodes one frame for the session: the rows as the child rendered
// them, and whether this is the last one.
func PaneFrameSequence(rows []string, final bool) string {
	flag := "0"
	if final {
		flag = "1"
	}
	body := base64.StdEncoding.EncodeToString([]byte(strings.Join(rows, "\n")))
	return paneFramePrefix + flag + ";" + body + "\a"
}

// DecodePaneFrame reads a frame back out of one line of a child's output. It matches
// only a line that is exactly one frame sequence, which is how a child writes them;
// anything else is the child's ordinary output and is not a frame.
func DecodePaneFrame(line string) (rows []string, final bool, ok bool) {
	if !strings.HasPrefix(line, paneFramePrefix) || !strings.HasSuffix(line, "\a") {
		return nil, false, false
	}
	rest := line[len(paneFramePrefix) : len(line)-1]
	flag, body, found := strings.Cut(rest, ";")
	if !found || (flag != "0" && flag != "1") {
		return nil, false, false
	}
	raw, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return nil, false, false
	}
	if len(raw) > 0 {
		rows = strings.Split(string(raw), "\n")
	}
	return rows, flag == "1", true
}

// paneLive counts the frame sinks open in this process. While one is open the animation
// gate in AnimEnabled lets the effects draw inside a pane: every frame reaches the session
// whole, so the reason rule 2 of anim.go keeps them out of a pane does not apply.
var paneLive atomic.Int32

// PaneFrames is a live region in a session pane: a sink that a caller draws frames into
// and finishes once, with the frame that is to stay.
type PaneFrames struct {
	w io.Writer

	mu   sync.Mutex
	last []string
	done bool
}

// StartPaneFrames opens a live region writing to w, normally os.Stdout. Always finish it,
// or the session is left holding a picture of a run that has ended.
func StartPaneFrames(w io.Writer) *PaneFrames {
	paneLive.Add(1)
	return &PaneFrames{w: w}
}

// Draw replaces the region with rows.
func (p *PaneFrames) Draw(rows []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return
	}
	p.last = rows
	p.write(rows, false)
}

// Finish sends the final frame, which the session keeps as transcript, and closes the
// region. A nil rows means the last frame drawn. Safe to call more than once.
func (p *PaneFrames) Finish(rows []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return
	}
	p.done = true
	if rows == nil {
		rows = p.last
	}
	p.write(rows, true)
	paneLive.Add(-1)
}

// write is one sequence and a newline. The newline is what makes it a line of its own
// in the session's reader, which splits the child's output on newlines before it looks
// for frames; a frame glued to the end of a printed line would be dropped as an unknown
// sequence rather than painted.
func (p *PaneFrames) write(rows []string, final bool) {
	_, _ = io.WriteString(p.w, PaneFrameSequence(rows, final)+"\n")
}
