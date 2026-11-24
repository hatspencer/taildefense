// Package platform is what is left of lib/platform.sh.
//
// The bash version existed to paper over coreutils divergences: stat -c versus
// stat -f, base64 -d versus -D, GNU sed -i versus BSD sed -i ”, BSD paste
// treating a multi-character separator as a rotating list. None of that survives
// the port, because the standard library does all of it identically on both
// platforms.
//
// What remains is genuinely platform-specific: how to name the OS for a human,
// how to open a URL, and how wide the terminal is.
package platform

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"golang.org/x/term"
)

// IsMacOS replaces the uname -s test. Linux is the other case everywhere it is asked.
func IsMacOS() bool { return runtime.GOOS == "darwin" }

// OS returns a human readable operating system name for banners and doctor.
//
// On Linux this prefers PRETTY_NAME from /etc/os-release, which is what tells
// "Ubuntu 24.04" apart from "Fedora 41" — the distinction that matters when
// someone reports a bug. On macOS it asks sw_vers, the only source of the
// product version.
func OS() string {
	switch runtime.GOOS {
	case "linux":
		if name := osReleasePretty(); name != "" {
			return name
		}
		return "Linux"
	case "darwin":
		if out, err := exec.Command("sw_vers", "-productVersion").Output(); err == nil {
			if v := strings.TrimSpace(string(out)); v != "" {
				return "macOS " + v
			}
		}
		return "macOS"
	default:
		return runtime.GOOS
	}
}

func osReleasePretty() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return ""
	}
	defer f.Close()

	var name string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, value, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		value = strings.Trim(value, `"'`)
		switch key {
		case "PRETTY_NAME":
			return value
		case "NAME":
			// Remembered but not returned yet: PRETTY_NAME may still appear
			// further down the file and is the better answer.
			name = value
		}
	}
	return name
}

// Arch reports the CPU architecture using the same vocabulary uname -m does, so
// existing notes and bug reports still line up. Go spells them amd64 and arm64;
// uname says x86_64 and arm64.
func Arch() string {
	if runtime.GOARCH == "amd64" {
		return "x86_64"
	}
	return runtime.GOARCH
}

// TermCols is the terminal width, defaulting to 80 when stdout is not a
// terminal (a pipe, a file, CI). The banner and the rules are sized from this.
func TermCols() int {
	if w, ok := TermWidth(); ok {
		return w
	}
	return 80
}

// TermWidth is the width of the terminal on stdout or stderr, else $COLUMNS, and false when
// neither says. Separate from TermCols so a caller with a better default for a pipe than 80 can
// tell "the terminal is 80 wide" from "there is no terminal".
func TermWidth() (int, bool) {
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		if w, _, err := term.GetSize(int(f.Fd())); err == nil && w > 0 {
			return w, true
		}
	}
	if v := os.Getenv("COLUMNS"); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			return n, true
		}
	}
	return 0, false
}

// TermRows is the terminal height in lines, defaulting to 24 when stdout is not a
// terminal. Only the animated banner reveal asks: it redraws artwork in place by moving
// the cursor back up, which needs the block to have fitted on screen in the first place.
func TermRows() int {
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		if _, h, err := term.GetSize(int(f.Fd())); err == nil && h > 0 {
			return h
		}
	}
	if v := os.Getenv("LINES"); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			return n
		}
	}
	return 24
}

// ttyOverride forces the answer of IsTTY for a test, and is nil in any real run.
//
// Every animation and the batch table gate on IsTTY, and `go test` has no terminal, so
// the code paths behind that gate — the busy rule sweep in particular — are otherwise
// unreachable from a test and were shipping unexercised. A test seam here, rather than in
// ui, keeps the single source of truth for "is there a terminal" in one place, and it is
// write-only through SetTTYForTest so nothing in a real run can reach it.
var ttyOverride *bool

// SetTTYForTest forces IsTTY to report want, and returns a function that restores the
// previous state. Intended only for tests that need to exercise terminal-gated behaviour
// where there is no terminal; a real invocation never calls it.
func SetTTYForTest(want bool) func() {
	prev := ttyOverride
	ttyOverride = &want
	return func() { ttyOverride = prev }
}

// IsTTY reports whether stdout is an interactive terminal. Colour, the bubbletea
// batch table and the interactive prompts all key off this.
func IsTTY() bool {
	if ttyOverride != nil {
		return *ttyOverride
	}
	return term.IsTerminal(int(os.Stdout.Fd()))
}

// IsStdinTTY reports whether stdin is interactive, which is what the wizard and
// the shell need: output may legitimately be redirected while input is a
// keyboard.
func IsStdinTTY() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

// stdinOverride is the stdin twin of ttyOverride, for the one test that needs a terminal on
// stdout and a pipe on stdin: the shape a hook gives a command.
var stdinOverride *bool

// SetStdinTTYForTest forces StdinInteractive to report want, and returns a restore function.
func SetStdinTTYForTest(want bool) func() {
	prev := stdinOverride
	stdinOverride = &want
	return func() { stdinOverride = prev }
}

// StdinInteractive reports whether a person is on the other end of stdin.
//
// Animation asks this as well as IsTTY because a hook can hand a command a terminal on stdout
// while stdin is the hook's JSON payload, and an agent reads that output. A stdout override set
// by a test implies an interactive stdin too, so terminal-gated tests need one switch, not two.
func StdinInteractive() bool {
	if stdinOverride != nil {
		return *stdinOverride
	}
	if ttyOverride != nil {
		return *ttyOverride
	}
	return IsStdinTTY()
}

// InCI reports whether the process runs under a CI system. CI is set by every mainstream
// runner, Drone included; "false" and "0" are honoured as the explicit negative some set.
func InCI() bool {
	for _, k := range []string{"CI", "DRONE", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI"} {
		switch v := os.Getenv(k); v {
		case "", "0", "false":
		default:
			return true
		}
	}
	return false
}

// CanHostFullscreen reports whether this process can run an interactive full-screen
// program: a bubbletea TUI, a live table, a picker. It needs a terminal to draw on and
// a terminal to read keys from, so it is the conjunction of the two above.
//
// The stdin half is the one that is easy to forget and expensive to get wrong. A child
// of `taildefense shell` is given a pseudo-terminal on stdout but no stdin at all, so IsTTY is
// true while there is nothing to read; a program gated on IsTTY alone starts, waits for
// input that can never arrive, and hangs with the run apparently stuck. Any command that
// launches a bubbletea program with tea.NewProgram must gate on this, not on IsTTY, and
// fall back to plain output when it is false — or, inside a pane, to driving its model
// without a program and handing the frames to the session (internal/ui/pane.go), which is
// how e2e keeps its chart there. Commands that hand the real terminal over with
// tea.ExecProcess do not, because they are only reachable from a session that has a
// terminal to hand over.
func CanHostFullscreen() bool { return IsTTY() && IsStdinTTY() }

// OpenURL is best effort and used only for informational links.
func OpenURL(url string) error {
	var cmd string
	if IsMacOS() {
		cmd = "open"
	} else {
		cmd = "xdg-open"
	}
	bin, err := exec.LookPath(cmd)
	if err != nil {
		return err
	}
	return exec.Command(bin, url).Start()
}

// LookPath is exec.LookPath with the error swallowed, for the many places that
// only want to know whether a tool exists.
func LookPath(bin string) (string, bool) {
	p, err := exec.LookPath(bin)
	return p, err == nil
}
