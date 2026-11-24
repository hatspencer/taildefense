package platform

import (
	"runtime"
	"testing"
)

// SetTTYForTest is the write-only seam that lets terminal-gated code (the busy rule sweep,
// the batch table) be exercised where `go test` has no terminal. It must force the answer
// while set and restore the real detection when the returned function runs — a leak would
// make every later test in the process believe it has, or has not, a terminal.
func TestSetTTYForTest(t *testing.T) {
	// Whatever the real answer is here, forcing the opposite must take, and restoring must
	// return to the real answer rather than to the forced one.
	real := IsTTY()

	restore := SetTTYForTest(!real)
	if IsTTY() == real {
		t.Errorf("SetTTYForTest(%v) did not take: IsTTY still %v", !real, real)
	}
	restore()
	if IsTTY() != real {
		t.Errorf("after restore IsTTY = %v, want the real %v", IsTTY(), real)
	}

	// Nested overrides restore in LIFO order, so a helper that forces a TTY inside another
	// that forced no-TTY leaves the outer one intact.
	outer := SetTTYForTest(false)
	inner := SetTTYForTest(true)
	if !IsTTY() {
		t.Error("inner override of true did not take")
	}
	inner()
	if IsTTY() {
		t.Error("after the inner restore the outer false override should hold")
	}
	outer()
	if IsTTY() != real {
		t.Error("after both restores IsTTY should be back to the real value")
	}
}

// Arch uses uname's vocabulary (x86_64) so existing notes line up, where Go says amd64.
func TestArchVocabulary(t *testing.T) {
	switch runtime.GOARCH {
	case "amd64":
		if Arch() != "x86_64" {
			t.Errorf("Arch() = %q on amd64, want x86_64 (uname vocabulary)", Arch())
		}
	case "arm64":
		if Arch() != "arm64" {
			t.Errorf("Arch() = %q on arm64, want arm64", Arch())
		}
	}
}

// TermCols falls back to a sane default rather than 0 when there is no terminal, because
// the banner and rules are sized from it and a width of 0 would render nothing.
func TestTermColsFallsBackWhenNotATerminal(t *testing.T) {
	// Under `go test` stdout is a pipe; COLUMNS may or may not be set in the environment,
	// so clear it to exercise the hard-coded fallback deterministically.
	t.Setenv("COLUMNS", "")
	if got := TermCols(); got <= 0 {
		t.Errorf("TermCols = %d with no terminal; it must fall back to a positive default", got)
	}
}

// TermWidth says when there is no width to report, which TermCols cannot: it answers 80 either
// way. Under `go test` neither stdout nor stderr is a terminal, so COLUMNS decides.
func TestTermWidthReportsWhetherAWidthWasFound(t *testing.T) {
	t.Setenv("COLUMNS", "")
	if w, ok := TermWidth(); ok {
		t.Skipf("a terminal is attached here (%d columns); nothing to assert", w)
	}
	t.Setenv("COLUMNS", "132")
	if w, ok := TermWidth(); !ok || w != 132 {
		t.Fatalf("TermWidth with COLUMNS=132 = %d, %v; want 132, true", w, ok)
	}
	t.Setenv("COLUMNS", "wide")
	if _, ok := TermWidth(); ok {
		t.Fatal("TermWidth accepted a COLUMNS that is not a number")
	}
}

// A guard so the test file itself does not depend on the host having a specific OS: OS()
// must return something non-empty on whatever this runs on.
func TestOSIsNamed(t *testing.T) {
	if OS() == "" {
		t.Error("OS() returned an empty name")
	}
}

// CanHostFullscreen needs BOTH a terminal to draw on and a terminal to read from. Under
// `go test` stdin is not a terminal, so even with IsTTY forced true it must stay false.
// That is the exact shape of a child of `taildefense shell`: a pseudo-terminal on stdout, no
// stdin, and a full-screen program launched there hangs. Pinning it here stops the guard
// from silently regressing to IsTTY alone.
func TestCanHostFullscreenNeedsStdinToo(t *testing.T) {
	restore := SetTTYForTest(true)
	defer restore()

	if IsStdinTTY() {
		t.Skip("stdin is a terminal in this runner; the no-stdin path cannot be exercised here")
	}
	if CanHostFullscreen() {
		t.Error("CanHostFullscreen is true with a stdout TTY but no stdin TTY; a shell-pane child would hang")
	}
}
