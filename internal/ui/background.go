package ui

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"taildefense/internal/platform"
)

// Painting the terminal.
//
// A theme that owns its background has to put that background somewhere, and there are only
// two ways to do it.
//
// The first is to set a background on every style and pad every line to the terminal width.
// That was rejected: it multiplies the escape sequences in every line of every transcript,
// it leaves a ragged edge wherever a line is measured wrong, it cannot reach the blank space
// below the last line, and it makes a copied transcript carry colour into wherever it was
// pasted.
//
// The second is OSC 11, which sets the terminal's own default background, and OSC 10 for the
// default foreground. Everything printed afterwards sits on the theme without carrying a
// single extra byte, the region below the output is painted too, `less -R` and a redirected
// file stay clean, and turning the theme off is one more escape sequence rather than a
// re-render. That is what this file does.
//
// The cost is that it changes the terminal rather than the output, so two rules follow and
// neither is optional: it must never run when the output is not a terminal we own, and it
// must always be undone before the process exits.

// EnvNoBg disables painting the terminal while leaving the theme's colours alone.
//
// Separate from NO_COLOR, and separate from the remembered switch, because it answers a
// different complaint: "my terminal already has the background I want, give me the theme's
// text colours on top of it". Most often that is a terminal that ignores OSC 11 — Apple's
// Terminal.app is the one on these machines — where painting silently does nothing and the
// theme's text colours are then the only half that arrives.
const EnvNoBg = "TAILDEFENSE_NO_BG"

// bgPref is the remembered choice: `td config theme bg off` keeps a theme's palette
// without letting it repaint the terminal.
var bgPref = true

// painted records whether this process has changed the terminal, so ResetTerminal is a
// no-op when there is nothing to undo and cannot emit a reset into a pipe.
var painted bool

// bgOut is where the sequences go, indirected so a test can read them.
//
// stderr, not stdout. stdout is the command's document — the thing a caller pipes into jq or
// reads as a report — and an escape sequence in it corrupts that even though it produces no
// visible characters. stderr is where every other piece of decoration already goes.
var bgOut io.Writer = os.Stderr

// SetPaintBackground records whether a full theme may repaint the terminal.
func SetPaintBackground(on bool) { bgPref = on }

// bgEnabled reports whether painting is allowed right now.
//
// Colour being enabled is the load-bearing condition: it already accounts for NO_COLOR,
// TERM=dumb, --no-color and a non-terminal stdout, and painting the terminal is exactly as
// wrong in all four cases as emitting a colour escape would be. A child of the shell TUI is
// excluded separately: its stdout is a pipe the session reads and re-renders, so an OSC there
// would either be stripped as noise or, worse, forwarded and applied twice.
func bgEnabled() bool {
	if !colorEnabled || !bgPref {
		return false
	}
	if os.Getenv(EnvNoBg) != "" {
		return false
	}
	// The parent forces colour for its children and tells them so; only the parent owns the
	// terminal, so only the parent paints.
	if os.Getenv(EnvColorProfile) != "" {
		return false
	}
	return platform.IsTTY()
}

// PaintTerminal applies the active theme's background and foreground to the terminal.
//
// Called by SetTheme, so every path that changes the theme repaints: the dispatcher at
// startup, the environment-derived theme once the target is known, and a `config theme` run
// inside a session. A theme that follows the terminal resets instead of painting, which is
// what makes switching from a full theme back to `default` restore what was there before.
func PaintTerminal() {
	if !bgEnabled() {
		return
	}
	if !active.Full() {
		ResetTerminal()
		return
	}
	bg, fg := resolve(active.Bg), resolve(active.Fg)
	if bg == "" {
		return
	}
	var b strings.Builder
	b.WriteString(osc(11, bg))
	if fg != "" {
		b.WriteString(osc(10, fg))
	}
	fmt.Fprint(bgOut, b.String())
	painted = true
}

// ResetTerminal puts the terminal's own background and foreground back.
//
// Idempotent, and a no-op if nothing was painted, so the dispatcher can defer it
// unconditionally. It has to run on every exit path including a signal: a process that dies
// having repainted the terminal leaves the shell prompt in the theme's colours, which looks
// like the theme leaked rather than like a crash, and nothing the person types afterwards
// will put it back.
func ResetTerminal() {
	// A scene hides the cursor while it plays and shows it again when it ends; this covers the
	// exit that skips that, a second Ctrl-C mid-scene. See candy.go.
	showCursor(os.Stdout)
	if !painted {
		return
	}
	// OSC 111 and 110 reset the background and the foreground to the terminal's configured
	// values, rather than to a colour we would have to have remembered. Guessing white or
	// black here would be worse than not resetting at all.
	fmt.Fprint(bgOut, "\x1b]111\x07\x1b]110\x07")
	painted = false
}

// osc builds one OSC colour-setting sequence, BEL-terminated.
//
// BEL rather than ST (ESC backslash): both are valid and every terminal that supports these
// sequences at all accepts BEL, while a few older ones mishandle ST and print the backslash.
func osc(code int, hex string) string {
	return fmt.Sprintf("\x1b]%d;%s\x07", code, hex)
}

// resolve picks the side of an adaptive pair that applies. A full theme's pairs hold the same
// value on both sides, so this is only ever ambiguous for a theme that does not paint.
func resolve(c lipgloss.AdaptiveColor) string {
	if c.Dark != "" {
		return c.Dark
	}
	return c.Light
}
