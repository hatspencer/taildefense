package ui

import (
	"os"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// Colour inheritance for captured children.
//
// A process whose stdout is a pipe cannot see the terminal, so it cannot know how
// many colours are available or whether the background is light. Normally that is
// fine — no terminal means no colour — but the shell TUI captures its children's
// output and renders it beside its own, so the child needs to produce exactly what
// the parent would have produced.
//
// These two variables carry that. They are read only when colour is already forced,
// so they cannot turn colour on somewhere it should be off; they only decide what
// *kind* of colour is produced once the decision to produce it has been made.
const (
	// EnvColorProfile is the number of colours the parent's terminal supports:
	// "truecolor", "256", "16" or "none".
	EnvColorProfile = "TAILDEFENSE_COLOR_PROFILE"
	// EnvDarkBackground is "1" or "0", from the parent's own detection.
	EnvDarkBackground = "TAILDEFENSE_DARK_BG"
	// EnvForceColor turns colour on whatever the terminal, for `taildefense frame | less -R`.
	EnvForceColor = "TAILDEFENSE_FORCE_COLOR"
)

// ColorEnviron describes the current terminal for a child process.
//
// Called by the shell TUI when building a child's environment. It reports what this
// process actually resolved rather than re-detecting, so the child is guaranteed to
// agree with the parent even if detection is somehow non-deterministic.
func ColorEnviron() []string {
	if !colorEnabled {
		return nil
	}
	return []string{
		EnvColorProfile + "=" + profileName(lipgloss.ColorProfile()),
		EnvDarkBackground + "=" + boolDigit(lipgloss.HasDarkBackground()),
	}
}

// inheritedProfile reads EnvColorProfile.
func inheritedProfile() (termenv.Profile, bool) {
	switch os.Getenv(EnvColorProfile) {
	case "truecolor":
		return termenv.TrueColor, true
	case "256":
		return termenv.ANSI256, true
	case "16":
		return termenv.ANSI, true
	case "none":
		return termenv.Ascii, true
	}
	return termenv.Ascii, false
}

// inheritedDarkBackground reads EnvDarkBackground.
func inheritedDarkBackground() (bool, bool) {
	switch os.Getenv(EnvDarkBackground) {
	case "1":
		return true, true
	case "0":
		return false, true
	}
	return false, false
}

func profileName(p termenv.Profile) string {
	switch p {
	case termenv.TrueColor:
		return "truecolor"
	case termenv.ANSI256:
		return "256"
	case termenv.ANSI:
		return "16"
	default:
		return "none"
	}
}

func boolDigit(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
