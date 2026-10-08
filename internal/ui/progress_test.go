package ui

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestSpinnerIsAPureFunctionOfElapsedTime(t *testing.T) {
	// The batch e2e table redraws every row from one tick, so two rows at the same
	// elapsed time must show the same frame or the table visibly shimmers.
	if a, b := Spinner(700*time.Millisecond), Spinner(700*time.Millisecond); a != b {
		t.Errorf("Spinner is not deterministic: %q then %q", a, b)
	}

	// It must advance, and it must wrap rather than index out of range.
	first := Spinner(0)
	if Spinner(100*time.Millisecond) == first {
		t.Error("the spinner does not advance after one frame interval")
	}
	if got := Spinner(time.Duration(len(SpinnerFrames)) * 100 * time.Millisecond); got != first {
		t.Errorf("the spinner did not wrap: got %q, want %q", got, first)
	}

	// A long-running batch must not panic hours in.
	Spinner(9 * time.Hour)
}

func TestSpinnerFramesAreSingleWidth(t *testing.T) {
	// Double-width glyphs make the line jitter as they animate, and in a table they
	// push the column after them back and forth by one cell on every tick.
	for _, f := range SpinnerFrames {
		if n := len([]rune(f)); n != 1 {
			t.Errorf("frame %q is %d runes; every frame must be exactly one cell", f, n)
		}
	}
}

func TestElapsedReadsTheWayAPersonWaits(t *testing.T) {
	tests := []struct {
		in   time.Duration
		want string
	}{
		{0, "0s"},
		{999 * time.Millisecond, "1s"}, // rounded, not truncated
		{5 * time.Second, "5s"},
		{59 * time.Second, "59s"},
		{time.Minute, "1m00s"},
		{90 * time.Second, "1m30s"},
		{2*time.Minute + 5*time.Second, "2m05s"},
		{61 * time.Minute, "61m00s"},
	}

	for _, tt := range tests {
		if got := Elapsed(tt.in); got != tt.want {
			t.Errorf("Elapsed(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestTruncateVisibleCountsVisibleCellsNotBytes(t *testing.T) {
	// A styled string is mostly escape bytes. Measuring the raw length would cut
	// several times too early, and cutting inside an escape sequence leaves the
	// terminal stuck in whatever colour was half-applied.
	styled := StyleInfo.Render("hello") + " world"

	got := truncateVisible(styled, 100)
	if !strings.Contains(got, "world") {
		t.Errorf("a wide budget truncated anyway: %q", got)
	}

	narrow := truncateVisible(styled, 4)
	if strings.Contains(narrow, "world") {
		t.Errorf("a narrow budget kept text past the limit: %q", narrow)
	}
	if !strings.HasSuffix(narrow, "\x1b[0m") {
		t.Errorf("a truncated line does not reset the terminal style: %q", narrow)
	}
}

func TestTruncateVisibleLeavesPlainTextAloneWithinBudget(t *testing.T) {
	const s = "  ⠋ fetching origin (3s)"
	if got := truncateVisible(s, 200); got != s {
		t.Errorf("truncateVisible altered a short plain line:\n got %q\nwant %q", got, s)
	}
}

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = saved }()

	done := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				b.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
		done <- b.String()
	}()

	fn()
	w.Close()
	out := <-done
	r.Close()
	return out
}

func TestProgressDegradesToPlainOutputWithoutATerminal(t *testing.T) {
	// Under a pipe, carriage returns and erase-to-end-of-line are recorded literally.
	// A spinner would become thousands of lines of escape codes in a file someone
	// intends to read — so it has to fall back to one plain line.
	//
	// os.Pipe is not a terminal, which is exactly the condition being tested.
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	defer func() { t.Setenv("NO_COLOR", ""); InitColor(false) }()

	out := captureStdout(t, func() {
		p := StartProgress("fetching origin")
		p.Line("resolving deltas")
		p.Stop()
	})

	if strings.Contains(out, "\r") {
		t.Errorf("the non-terminal path emitted a carriage return: %q", out)
	}
	if strings.Contains(out, "\x1b[K") {
		t.Errorf("the non-terminal path emitted an erase sequence: %q", out)
	}
	if !strings.Contains(out, "fetching origin") {
		t.Errorf("the label was not printed: %q", out)
	}
	if !strings.Contains(out, "resolving deltas") {
		t.Errorf("a reported line was dropped instead of printed: %q", out)
	}
}

func TestProgressStopIsIdempotent(t *testing.T) {
	// Callers defer Stop and also call it on the success path, so that a result line
	// can be printed in place of the spinner. Double Stop must not panic on a closed
	// channel.
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	defer func() { t.Setenv("NO_COLOR", ""); InitColor(false) }()

	captureStdout(t, func() {
		p := StartProgress("work")
		p.Stop()
		p.Stop()
		p.Stop()
		// Reporting a line after stopping must also be safe: a goroutine belonging to
		// the finished operation can still be draining its output.
		p.Line("late output")
	})
}

func TestProgressEmptyLinesAreIgnored(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	defer func() { t.Setenv("NO_COLOR", ""); InitColor(false) }()

	out := captureStdout(t, func() {
		p := StartProgress("work")
		p.Line("")
		p.Line("   ")
		p.Line("\t\n")
		p.Stop()
	})

	// One line for the label, and nothing for the three blank reports.
	if n := strings.Count(strings.TrimSpace(out), "\n"); n != 0 {
		t.Errorf("blank reports produced output:\n%q", out)
	}
}
