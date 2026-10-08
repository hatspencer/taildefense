package ui

import (
	"bytes"
	"strings"
	"testing"

	"taildefense/internal/platform"
)

// A frame has to survive the trip through the child's stdout and the session's line
// reader byte for byte: its own colour, its blank rows, and its final flag. A frame that
// came back with a row missing would paint a chart with a stage gone.
func TestPaneFrameRoundTrips(t *testing.T) {
	rows := []string{
		"  \x1b[38;2;22;163;74m✔\x1b[0m session",
		"",
		"  ⠹ \x1b[1mplacement\x1b[22m  ▓▓░░",
		"  · enriched",
	}
	for _, final := range []bool{false, true} {
		seq := PaneFrameSequence(rows, final)
		if strings.Contains(seq, "\n") {
			t.Errorf("the sequence carries a newline, which the line reader would split on: %q", seq)
		}
		got, gotFinal, ok := DecodePaneFrame(seq)
		if !ok {
			t.Fatalf("a frame the encoder wrote did not decode: %q", seq)
		}
		if gotFinal != final {
			t.Errorf("final came back as %v, want %v", gotFinal, final)
		}
		if strings.Join(got, "|") != strings.Join(rows, "|") {
			t.Errorf("rows changed on the way through:\n got %q\nwant %q", got, rows)
		}
	}
}

// An empty frame is a frame with no rows, not a frame with one empty row: the session
// appends every row of a final frame to the transcript, and a phantom blank line is what
// a nil-versus-empty mistake here would print.
func TestPaneFrameEmptyIsEmpty(t *testing.T) {
	rows, final, ok := DecodePaneFrame(PaneFrameSequence(nil, true))
	if !ok || !final {
		t.Fatalf("an empty final frame did not decode: ok=%v final=%v", ok, final)
	}
	if len(rows) != 0 {
		t.Errorf("an empty frame decoded to %d rows", len(rows))
	}
}

// Only a line that is exactly one frame is a frame. Everything else is the child's
// ordinary output, and treating a notification or a printed line as a picture would
// swallow it.
func TestDecodePaneFrameRejectsWhatIsNotAFrame(t *testing.T) {
	frame := PaneFrameSequence([]string{"a"}, false)
	for name, line := range map[string]string{
		"plain text":          "slipNumber 10014861650",
		"a notification":      NotifySequence("hive", "done"),
		"a window title":      "\x1b]0;title\a",
		"text before a frame": "output" + frame,
		"text after a frame":  frame + "output",
		"unterminated":        strings.TrimSuffix(frame, "\a"),
		"bad flag":            paneFramePrefix + "2;YQ==\a",
		"bad body":            paneFramePrefix + "0;not base64!\a",
		"no flag":             paneFramePrefix + "YQ==\a",
	} {
		if _, _, ok := DecodePaneFrame(line); ok {
			t.Errorf("%s decoded as a frame: %q", name, line)
		}
	}
}

// The region is only for a pane that paints frames, on a terminal, and never under --json
// or a capture: a frame anywhere else is bytes in a document.
func TestPaneLiveEnabledGates(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	t.Setenv("TAILDEFENSE_SHELL", "1")
	t.Setenv(EnvPaneLive, "1")

	if !PaneLiveEnabled() {
		t.Fatal("a pane that paints frames, on a terminal, was refused")
	}

	t.Setenv(EnvPaneLive, "")
	if PaneLiveEnabled() {
		t.Error("enabled in a pane that never said it paints frames")
	}
	t.Setenv(EnvPaneLive, "1")

	t.Setenv("TAILDEFENSE_SHELL", "")
	if PaneLiveEnabled() {
		t.Error("enabled outside a shell pane")
	}
	t.Setenv("TAILDEFENSE_SHELL", "1")

	SetCaptured(true)
	if PaneLiveEnabled() {
		t.Error("enabled while the output is being captured in-process")
	}
	SetCaptured(false)

	off := platform.SetTTYForTest(false)
	if PaneLiveEnabled() {
		t.Error("enabled on a pipe: `e2e | tee` would get frames in its log")
	}
	off()
}

func TestPaneRowsReadsTheSessionsHint(t *testing.T) {
	t.Setenv(EnvPaneRows, "37")
	if got := PaneRows(); got != 37 {
		t.Errorf("PaneRows = %d, want 37", got)
	}
	for _, bad := range []string{"", "0", "-3", "tall"} {
		t.Setenv(EnvPaneRows, bad)
		if got := PaneRows(); got != 0 {
			t.Errorf("PaneRows with %q = %d, want 0", bad, got)
		}
	}
}

// Inside a pane the effects are off — except while a live region is open, because then
// every frame reaches the session whole and nothing moves the cursor. The gate has to
// close again afterwards, or the next thing the process prints animates into a line
// buffer.
func TestAnimationIsOnInsideAPaneOnlyWhileALiveRegionIsOpen(t *testing.T) {
	forceTruecolor(t)
	t.Setenv("TAILDEFENSE_SHELL", "1")

	if AnimEnabled() {
		t.Fatal("animation is enabled inside a shell pane with no live region")
	}
	var out bytes.Buffer
	frames := StartPaneFrames(&out)
	if !AnimEnabled() {
		t.Error("animation stayed off while a live region was open")
	}
	frames.Finish(nil)
	if AnimEnabled() {
		t.Error("animation stayed on after the live region finished")
	}
}

// Finish with no rows resends the last frame drawn, and nothing is accepted after it: a
// late Draw from a ticker that has not stopped yet must not paint over a run that has
// ended.
func TestPaneFramesFinishKeepsTheLastFrameAndClosesTheRegion(t *testing.T) {
	var out bytes.Buffer
	frames := StartPaneFrames(&out)
	frames.Draw([]string{"one"})
	frames.Draw([]string{"two"})
	frames.Finish(nil)
	frames.Draw([]string{"late"})
	frames.Finish([]string{"later"})

	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("wrote %d sequences, want 3:\n%q", len(lines), lines)
	}
	rows, final, ok := DecodePaneFrame(lines[2])
	if !ok || !final || strings.Join(rows, "") != "two" {
		t.Errorf("the final frame is ok=%v final=%v rows=%q, want the last drawn frame, flagged final", ok, final, rows)
	}
	if _, final, _ := DecodePaneFrame(lines[0]); final {
		t.Error("the first frame was flagged final")
	}
}

// In a pane a LiveBlock is a live region: the same fixed-height rows, as frames, with
// no cursor movement at all — the pane would strip it, and the rows would land as one
// copy per frame.
func TestLiveBlockInAPaneSendsFramesAndNoCursorMovement(t *testing.T) {
	var out bytes.Buffer
	block := newLiveBlock(&out, 3, true)
	block.Draw([]string{"first", "second"})
	block.Draw([]string{"first", "second", "third", "dropped"})
	block.Done()

	if strings.Contains(out.String(), "\x1b[") {
		t.Errorf("the block moved the cursor inside a pane: %q", out.String())
	}
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("wrote %d sequences, want two frames and a final: %q", len(lines), lines)
	}
	for i, line := range lines {
		rows, final, ok := DecodePaneFrame(line)
		if !ok {
			t.Fatalf("line %d is not a frame: %q", i, line)
		}
		if len(rows) != 3 {
			t.Errorf("frame %d has %d rows, want the block's fixed height of 3", i, len(rows))
		}
		if final != (i == 2) {
			t.Errorf("frame %d final=%v", i, final)
		}
	}
	rows, _, _ := DecodePaneFrame(lines[2])
	if strings.Join(rows, "|") != "first|second|third" {
		t.Errorf("the final frame is %q, want the last drawn rows, clipped to the height", rows)
	}
}

// And on a terminal it is what it was: cursor movement, one row per line, padded to the
// height. Pinned so the pane path cannot change the terminal path by accident.
func TestLiveBlockOnATerminalRedrawsInPlace(t *testing.T) {
	var out bytes.Buffer
	block := newLiveBlock(&out, 2, false)
	block.Draw([]string{"only"})
	block.Draw([]string{"only", "both"})
	block.Done()

	got := out.String()
	want := "\ronly\x1b[K\n\r\x1b[K\n" + "\x1b[2A" + "\ronly\x1b[K\n\rboth\x1b[K\n"
	if got != want {
		t.Errorf("terminal block:\n got %q\nwant %q", got, want)
	}
}
