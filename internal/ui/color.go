package ui

import (
	"fmt"
	"image/color"
	"math"
	"os"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
	"github.com/lucasb-eyer/go-colorful"
	"golang.org/x/term"
)

// The colour decision.
//
// Lip Gloss v2 has no renderer: a Style renders exactly the colours it was given, at full
// fidelity, whatever it is printed to. So the decision is made here, once, and built into
// the colours themselves: Color hands a style a colour already brought down to what the
// terminal shows, and nothing at all when colour is off. A styled string is then right for
// any writer, a pipe and a captured child included, with no wrapper to forget.
var (
	// profile is how many colours are emitted. NoTTY while colour is off.
	profile = colorprofile.NoTTY
	// dark is the background adaptive pairs resolve against.
	dark = true
	// termDark is the terminal's own background, asked once; see terminalIsDark.
	termDark, termDarkKnown = true, false
)

// AdaptiveColor is a colour with a shade for light backgrounds and one for dark, as #rrggbb.
// The zero value is no colour.
type AdaptiveColor struct{ Light, Dark string }

// hex is the shade for the background in force.
func (c AdaptiveColor) hex() string {
	if dark {
		return c.Dark
	}
	return c.Light
}

func (c AdaptiveColor) color() color.Color { return Color(c.hex()) }

// Color resolves a #rrggbb value to what a style should carry: the colour itself on a
// truecolor terminal, its nearest match on a lesser one, and no colour when colour is off or
// hex is empty.
func Color(hex string) color.Color {
	if !colorEnabled || hex == "" {
		return lipgloss.NoColor{}
	}
	return convert(profile, hex)
}

// convert brings hex down to p.
//
// The 256- and 16-colour picks are made here rather than by p.Convert, which goes through a
// fixed table that turns some of the palette's yellows red and its cyans blue. These are the
// picks td has always made: the nearest colour of the xterm cube, then the nearest of the
// sixteen to that by HSLuv distance.
func convert(p colorprofile.Profile, hex string) color.Color {
	c, err := colorful.Hex(hex)
	if err != nil {
		return lipgloss.NoColor{}
	}
	switch {
	case p >= colorprofile.TrueColor:
		return lipgloss.Color(hex)
	case p == colorprofile.ANSI256:
		return ansi.IndexedColor(cubeIndex(c))
	case p == colorprofile.ANSI:
		return ansi.BasicColor(nearestBasic(cubeIndex(c)))
	}
	return lipgloss.NoColor{}
}

// cubeIndex is the 256-colour index for c: the nearest point of the 6×6×6 cube, or the grey
// ramp when that is nearer by HSLuv distance.
//
// Kept exactly as td's colours were picked before (termenv's hexToANSI256Color), down to its
// grey index, which is worked out from the cube coordinates rather than the colour and so
// always lands on the darkest grey: a faithful copy keeps the picks where people have seen
// them.
func cubeIndex(c colorful.Color) int {
	v2ci := func(v float64) int {
		if v < 48 {
			return 0
		}
		if v < 115 {
			return 1
		}
		return int((v - 35) / 40)
	}
	r, g, b := v2ci(c.R*255), v2ci(c.G*255), v2ci(c.B*255)
	ci := 36*r + 6*g + b

	average := (r + g + b) / 3
	grayIdx := (average - 3) / 10
	if average > 238 {
		grayIdx = 23
	}
	gv := float64(8+10*grayIdx) / 255

	i2cv := [6]float64{0, 0x5f, 0x87, 0xaf, 0xd7, 0xff}
	c2 := colorful.Color{R: i2cv[r] / 255, G: i2cv[g] / 255, B: i2cv[b] / 255}
	g2 := colorful.Color{R: gv, G: gv, B: gv}
	if c.DistanceHSLuv(c2) <= c.DistanceHSLuv(g2) {
		return 16 + ci
	}
	return 232 + grayIdx
}

// basicHex is the sixteen colours as the 16-colour pick measures them.
var basicHex = [16]string{
	"#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
	"#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
}

// xtermHex is the colour a 256-colour index stands for.
func xtermHex(i int) string {
	if i < 16 {
		return basicHex[i]
	}
	if i >= 232 {
		v := 8 + 10*(i-232)
		return fmt.Sprintf("#%02x%02x%02x", v, v, v)
	}
	l := [6]int{0, 0x5f, 0x87, 0xaf, 0xd7, 0xff}
	i -= 16
	return fmt.Sprintf("#%02x%02x%02x", l[i/36], l[i/6%6], l[i%6])
}

// nearestBasic is the one of the sixteen nearest to a 256-colour index, by HSLuv distance.
func nearestBasic(i int) int {
	h, _ := colorful.Hex(xtermHex(i))
	best, bestD := 0, math.MaxFloat64
	for j, hex := range basicHex {
		b, _ := colorful.Hex(hex)
		if d := h.DistanceHSLuv(b); d < bestD {
			best, bestD = j, d
		}
	}
	return best
}

// newStyle starts a style, and bold makes it bold only while colour is on. With colour off
// every style stays empty: bold and reverse are escapes too, and `td doctor | pbcopy` has to
// yield plain text.
func newStyle() lipgloss.Style { return lipgloss.NewStyle() }

func bold(s lipgloss.Style) lipgloss.Style {
	if !colorEnabled {
		return s
	}
	return s.Bold(true)
}

// Profile is the colour profile a full-screen program should render with, so it agrees with
// every line printed outside one. With colour off the styles are already empty, and ASCII
// rather than NoTTY leaves the program its own cursor and screen sequences.
func Profile() colorprofile.Profile {
	if !colorEnabled {
		return colorprofile.ASCII
	}
	return profile
}

// detectProfile reads what the terminal supports. A forced run on a pipe detects nothing,
// and is given the sixteen colours every terminal has.
func detectProfile() colorprofile.Profile {
	p := colorprofile.Detect(os.Stdout, os.Environ())
	if inherited, ok := inheritedProfile(); ok {
		p = inherited
	}
	if p < colorprofile.ANSI {
		p = colorprofile.ANSI
	}
	return p
}

// terminalIsDark asks the terminal for its background, once, and only when stdout is a
// terminal: the question is written there, and the answer read from stdin, or from stdout
// itself when stdin is redirected. A terminal that does not answer falls back to COLORFGBG,
// which some terminals set, and then to dark, which is what such a terminal most often is.
//
// It must run before any full-screen program starts: a running program's input reader would
// eat the reply.
func terminalIsDark(ask bool) bool {
	if d, ok := inheritedDarkBackground(); ok {
		return d
	}
	if !termDarkKnown && ask && term.IsTerminal(int(os.Stdout.Fd())) {
		in := os.Stdin
		if !term.IsTerminal(int(in.Fd())) {
			in = os.Stdout
		}
		bg, err := lipgloss.BackgroundColor(in, os.Stdout)
		if err != nil || bg == nil {
			bg = colorFGBG(os.Getenv("COLORFGBG"))
		}
		termDark, termDarkKnown = isDark(bg), true
	}
	return termDark
}

// colorFGBG reads the background from COLORFGBG ("15;0": white on black), nil when it is
// unset or says nothing usable.
func colorFGBG(v string) color.Color {
	i := strings.LastIndexByte(v, ';')
	if i < 0 {
		return nil
	}
	n, err := strconv.Atoi(v[i+1:])
	if err != nil || n < 0 || n > 255 {
		return nil
	}
	c, _ := colorful.Hex(xtermHex(n))
	return c
}

// isDark is whether a background is dark: under half lightness, measured as HSL lightness,
// which is the line td has always drawn. Dark when there is no colour to measure.
func isDark(bg color.Color) bool {
	if bg == nil {
		return true
	}
	c, ok := colorful.MakeColor(bg)
	if !ok {
		return true
	}
	_, _, l := c.Hsl()
	return l < 0.5
}

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

// inheritedProfile reads EnvColorProfile.
func inheritedProfile() (colorprofile.Profile, bool) {
	switch os.Getenv(EnvColorProfile) {
	case "truecolor":
		return colorprofile.TrueColor, true
	case "256":
		return colorprofile.ANSI256, true
	case "16":
		return colorprofile.ANSI, true
	case "none":
		return colorprofile.ASCII, true
	}
	return colorprofile.ASCII, false
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
