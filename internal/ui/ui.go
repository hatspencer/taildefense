// Package ui is the presentation layer: one place for colour and one vocabulary
// for status lines, so a wall of output from six different commands still reads
// as one tool.
//
//	Step("...")           a section heading
//	Section("...", "...") a section heading with a dim caption
//	Pass("...")   a check that held, counted
//	Fail("...")   a check that did not hold, counted
//	Info("...")   a fact worth printing that is not a verdict
//	Warn("...")   something the user should probably act on
//	Errorf("...") an error on stderr; the command returns its own exit code
//
// The bash version kept the failure count in a global $FAILURES, which broke
// whenever a loop calling fail() was on the right-hand side of a pipe: the
// increments happened in a subshell and were discarded, so a command reported
// ALL CHECKS PASSED under visible FAIL lines. Here the counter belongs to a
// Printer, and a parallel walk gives each worker its own Printer, so
// the counts cannot merge or vanish.
package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/platform"
)

// The palette.
//
// These are AdaptiveColor pairs rather than the eight ANSI indices, for two
// reasons that both showed up in practice.
//
// The first is contrast. ANSI colour 3 is "yellow", but on a light terminal theme it
// resolves to a muddy brown or, on some themes, to something close to the background;
// ANSI 7 is "white", which is invisible on a white background. An adaptive pair names
// a darker shade for light backgrounds and a brighter one for dark, so a warning is
// legible either way. This tool gets run in whatever terminal the person already had
// open, so "looks fine in mine" is not a standard.
//
// The second is that they degrade on their own. InitColor reads what the terminal
// supports and Color brings each hex value down to it; a 16-colour terminal gets the
// nearest ANSI equivalent, so nothing here is worse than what it replaced, and on a
// truecolor terminal it is considerably better.
//
// The values are the Tailwind 600/400 pairs, which is also what the reference fos CLI
// uses — worth keeping identical so that two tools in the same workflow do not
// disagree about what "warning yellow" means.
//
// The base* values are the shared palette: what a theme gets when it does not name a
// colour of its own, which is the case for every colour of the two terminal-following
// themes. They are separate variables rather than the exported ones because the exported
// ones are rebuilt from the active theme on every InitColor, and a theme table that
// referenced them directly would capture whatever the previous theme had left there.
var (
	baseGreen = AdaptiveColor{Light: "#16a34a", Dark: "#4ade80"}
	baseRed   = AdaptiveColor{Light: "#dc2626", Dark: "#f87171"}
	// WARN is orange rather than yellow, because amber is the accent this tool is drawn in
	// and a warning one shade from the accent stops reading as a warning. Full themes that
	// own their whole palette still choose their own; this is what the rest inherit.
	baseYellow  = AdaptiveColor{Light: "#c2410c", Dark: "#fb923c"}
	baseCyan    = AdaptiveColor{Light: "#0891b2", Dark: "#22d3ee"}
	baseBlue    = AdaptiveColor{Light: "#2563eb", Dark: "#60a5fa"}
	baseGray    = AdaptiveColor{Light: "#6b7280", Dark: "#9ca3af"}
	baseText    = AdaptiveColor{Light: "#1f2937", Dark: "#f9fafb"}
	baseSurface = AdaptiveColor{Light: "#e5e7eb", Dark: "#1f2937"}
)

// The palette in force. Every one of these belongs to the active theme and is rebuilt by
// applyTheme, which falls back to the base value above for anything the theme leaves unset.
// Nothing else in the program has to know which theme is current. See theme.go.
var (
	ColorGreen  AdaptiveColor
	ColorRed    AdaptiveColor
	ColorYellow AdaptiveColor
	ColorCyan   AdaptiveColor
	ColorBlue   AdaptiveColor
	ColorGray   AdaptiveColor
	// ColorText is the high-contrast "plain but emphasised" colour: near-black on a
	// light theme, near-white on a dark one. It replaces ANSI 7, which was the one
	// genuinely unreadable choice in the old palette.
	ColorText AdaptiveColor

	// ColorAccent, ColorOnAccent and ColorLink are the brand colour, the text drawn on top
	// of a block of it, and the colour of a link label.
	ColorAccent   AdaptiveColor
	ColorOnAccent AdaptiveColor
	ColorLink     AdaptiveColor
	// ColorSurface is the background of the bars that frame a full-screen view: one
	// step off the background in either direction, so a bar reads as a bar without
	// needing a rule under it.
	ColorSurface AdaptiveColor
	// ColorBg is the background a full theme paints the terminal with, and the zero value
	// for a theme that follows the terminal's own. Read by background.go, and by the
	// full-screen views that have to fill a region rather than let it show through.
	ColorBg AdaptiveColor
)

// Styles are resolved once at startup. Exported so commands can compose their
// own lines without inventing new colours.
var (
	StylePass   lipgloss.Style
	StyleFail   lipgloss.Style
	StyleInfo   lipgloss.Style
	StyleNote   lipgloss.Style
	StyleWarn   lipgloss.Style
	StyleStep   lipgloss.Style
	StyleBold   lipgloss.Style
	StyleCyan   lipgloss.Style
	StyleGreen  lipgloss.Style
	StyleRed    lipgloss.Style
	StyleYellow lipgloss.Style
	StyleWhite  lipgloss.Style
	StyleDim    lipgloss.Style

	// StyleAccent is the brand colour on the terminal's own background; StyleBrand is
	// the same in bold, for the prompt glyph and the wordmark.
	StyleAccent lipgloss.Style
	// StyleAccentBold is the differing run inside a value printed next to another.
	StyleAccentBold lipgloss.Style
	StyleBrand      lipgloss.Style
	// StyleBadge is text on a block of accent colour: the brand segment of a bar, the
	// active tab. StyleSurface, StyleSurfaceDim and StyleSurfaceBold draw on the bar
	// background itself, so a bar can be assembled from segments that each carry the
	// background rather than relying on an outer style that an inner reset would cut
	// short.
	StyleBadge       lipgloss.Style
	StyleSurface     lipgloss.Style
	StyleSurfaceDim  lipgloss.Style
	StyleSurfaceBold lipgloss.Style
	// StyleSelected is the selected row of a list: reverse-video is what every terminal
	// since the VT100 understands as "this one", and it survives the loss of colour.
	StyleSelected lipgloss.Style
	// StyleLink is the label of a hyperlink: accent and underlined, so it reads as a link
	// before anyone hovers over it.
	StyleLink lipgloss.Style
)

var colorEnabled bool

// jsonMode silences the Printer on stdout entirely, set by --json, so a command that still
// writes status lines cannot corrupt the single JSON document the caller is parsing; those
// lines move to stderr where progress belongs.
//
// It is package-level rather than per-Printer because it is a global flag: a parallel walk
// gives each worker its own Printer, and all of them must honour the same decision. It
// is read under the Printer's own lock through the mode accessor.
var (
	jsonMode bool
	modeMu   sync.RWMutex
)

// SetJSON turns JSON mode on or off. In JSON mode the Printer writes to stderr and drops
// everything but findings, so stdout carries only what a command hands to EmitJSON.
func SetJSON(on bool) {
	modeMu.Lock()
	jsonMode = on
	modeMu.Unlock()
}

// JSONMode reports whether JSON mode is on.
func JSONMode() bool {
	modeMu.RLock()
	defer modeMu.RUnlock()
	return jsonMode
}

// suppressDetail reports whether supporting detail (Info, Note, Detail) should be dropped.
// --json wants findings only: those lines would otherwise clutter the stderr channel a caller
// does not read.
func suppressDetail() bool {
	modeMu.RLock()
	defer modeMu.RUnlock()
	return jsonMode
}

// lastNoColor is the flag InitColor was last called with, so SetTheme can rebuild the
// styles under the same colour decision.
var lastNoColor bool

// The package starts with colour decided but the terminal not yet asked for its background:
// main has not parsed --no-color, and a question nobody wanted is still a question.
func init() { initColor(false, false) }

// InitColor decides whether ANSI escapes are emitted and builds the styles.
//
// Suppressed when stdout is not a terminal (so `taildefense failures --curl |
// pbcopy` yields clean text), when NO_COLOR is set (https://no-color.org), when
// TERM is dumb, or when --no-color was passed. TAILDEFENSE_FORCE_COLOR overrides
// every one of those, which is what makes `taildefense ledger | less -R` work.
func InitColor(noColorFlag bool) { initColor(noColorFlag, true) }

func initColor(noColorFlag, ask bool) {
	lastNoColor = noColorFlag
	applyTheme()

	enabled := true
	switch {
	case os.Getenv("NO_COLOR") != "":
		enabled = false
	case os.Getenv("TERM") == "dumb":
		enabled = false
	case noColorFlag:
		enabled = false
	case !platform.IsTTY():
		enabled = false
	}
	if os.Getenv(EnvForceColor) == "1" {
		enabled = true
	}
	colorEnabled = enabled

	if enabled {
		// Read what the terminal supports rather than assuming truecolor: a 16-colour
		// terminal is given the nearest match, and on a 2-colour terminal a 24-bit colour
		// would be unreadable.
		//
		// A child whose stdout is a pipe cannot detect any of this for itself: it sees a
		// pipe and no colours, which is widened to a flat 16, and it cannot query the
		// background so adaptive colours assume dark. Both are wrong in the one place it
		// matters most: a parent that captures its children's output and shows it next to
		// its own. A child limited to 16 colours next to truecolor chrome looks like a
		// rendering fault, and a light-background user gets the dark palette on half the
		// screen.
		//
		// So the parent, which does have a terminal, passes down what it found. This is
		// only trusted when colour has been forced, which is the same condition under
		// which the child's own detection is known to be unavailable.
		profile = detectProfile()

		// Adaptive colours need to know whether the background is dark, and the only way to
		// find out is to ask the terminal. Asked here, while the terminal is still ours:
		// inside a full-screen program the answer would be eaten by the program's own input
		// reader.
		//
		// A full theme owns its background, so it, not the terminal, decides what adaptive
		// means. This has to be settled before any style is built: every adaptive pair
		// resolves against it.
		dark = terminalIsDark(ask)
		if active.Full() {
			dark = active.Dark
		}
	} else {
		profile = colorprofile.NoTTY
		dark = terminalIsDark(false)
	}

	StylePass = bold(newStyle().Foreground(ColorGreen.color()))
	StyleFail = bold(newStyle().Foreground(ColorRed.color()))
	// Cyan, not yellow. INFO and WARN were previously both ANSI 3 and differed only
	// by bold, which is close to no difference at all in a scrolling transcript —
	// the one distinction that has to survive is "here is a fact" versus "you should
	// probably act on this".
	StyleInfo = newStyle().Foreground(ColorCyan.color())
	// An explicit grey rather than Faint. Faint is widely ignored — several
	// terminals render it at full brightness — so dim text was not reliably dim,
	// which matters because it is what separates supporting detail from findings.
	StyleNote = newStyle().Foreground(ColorGray.color())
	StyleWarn = bold(newStyle().Foreground(ColorYellow.color()))
	StyleStep = bold(newStyle().Foreground(ColorBlue.color()))
	StyleBold = bold(newStyle())
	StyleCyan = newStyle().Foreground(ColorCyan.color())
	StyleGreen = newStyle().Foreground(ColorGreen.color())
	StyleRed = newStyle().Foreground(ColorRed.color())
	StyleYellow = newStyle().Foreground(ColorYellow.color())
	StyleWhite = bold(newStyle().Foreground(ColorText.color()))
	StyleDim = newStyle().Foreground(ColorGray.color())

	StyleAccent = newStyle().Foreground(ColorAccent.color())
	// StyleAccentBold marks the run inside a value that differs from the value beside it.
	// Bold as well as coloured, so the mark is not carried by colour alone.
	//
	// Not underlined, which was the first version: lipgloss styles an underlined string one
	// character at a time to control where the line stops, so `false` came out as five
	// separate escape sequences instead of one. Five times the bytes in every transcript,
	// every `less -R` and every copied line, for a second cue that bold already gives.
	StyleAccentBold = bold(newStyle().Foreground(ColorAccent.color()))
	StyleBrand = bold(newStyle().Foreground(ColorAccent.color()))
	StyleBadge = bold(newStyle().Foreground(ColorOnAccent.color()).Background(ColorAccent.color()))
	StyleSurface = newStyle().Foreground(ColorText.color()).Background(ColorSurface.color())
	StyleSurfaceDim = newStyle().Foreground(ColorGray.color()).Background(ColorSurface.color())
	StyleSurfaceBold = bold(newStyle().Foreground(ColorText.color()).Background(ColorSurface.color()))
	StyleSelected = newStyle()
	if enabled {
		StyleSelected = StyleSelected.Reverse(true)
	}
	// The link colour is the theme's. The original violet theme draws links in the accent; the
	// scarlet one moves them to blue, because a "Jump to kafbat" label in red three lines above a
	// green PASS read as an error rather than as a link.
	//
	// No underline. lipgloss renders an underlined run one character at a time, so a link label
	// in the middle of a line became a pair of escapes per letter in every transcript and every
	// `less -R`, the reason steering forbids underline on an inline run. The OSC 8 wrapper is what
	// makes the label a link, and without colour Link prints the URL after it instead.
	StyleLink = newStyle().Foreground(ColorLink.color())

	// The animation ramp is built from the accent, so it is rebuilt whenever the styles
	// are. A test that toggles colour would otherwise keep frames resolved against the
	// previous profile.
	initAnim()

	if !enabled {
		// Colour has just been turned off — by --no-color, by --json, or by a session
		// rebuilding its styles — and a terminal already painted by a full theme has to be
		// handed back. Done here rather than at each call site because every one of them
		// would otherwise have to remember, and the one that forgot would leave a plain-text
		// run sitting on a coloured background.
		ResetTerminal()
	}
}

// ColorEnabled reports whether escapes are being emitted. Used by the few places
// that need to know, such as whether to start a bubbletea program at all.
func ColorEnabled() bool { return colorEnabled }

// Printer accumulates a failure count while writing status lines.
type Printer struct {
	mu       sync.Mutex
	w        io.Writer
	failures int
}

// New returns a Printer writing to w.
func New(w io.Writer) *Printer { return &Printer{w: w} }

// Std is the default Printer, writing to stdout: the one every command reaches as ctx.Out, and
// the one Banner prints through.
var Std = New(os.Stdout)

func (p *Printer) printf(format string, a ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintf(p.dest(), format, a...)
}

// dest is where a line goes. In JSON mode the Printer's ordinary stdout writer is
// redirected to stderr, so stdout carries only the JSON document a command emits; a
// Printer explicitly pointed somewhere else (a test buffer, a shell pane) is left alone,
// because that writer is the capture the caller asked for.
func (p *Printer) dest() io.Writer {
	if jsonModeReadUnlocked() && p.w == io.Writer(os.Stdout) {
		return os.Stderr
	}
	return p.w
}

// jsonModeReadUnlocked reads jsonMode. Split out so dest can call it while already holding
// the Printer lock without taking a second lock ordering dependency: modeMu and the
// Printer mutex are independent, and this only ever read-locks modeMu.
func jsonModeReadUnlocked() bool {
	modeMu.RLock()
	defer modeMu.RUnlock()
	return jsonMode
}

// Pass records a check that held.
func (p *Printer) Pass(format string, a ...any) {
	p.printf("  %s %s\n", StylePass.Render("PASS"), fmt.Sprintf(format, a...))
}

// Fail records a check that did not hold and increments the failure count.
func (p *Printer) Fail(format string, a ...any) {
	p.mu.Lock()
	p.failures++
	p.mu.Unlock()
	p.printf("  %s %s\n", StyleFail.Render("FAIL"), fmt.Sprintf(format, a...))
}

// Info prints a fact that is not a verdict. Suppressed by --json, which wants
// findings only.
func (p *Printer) Info(format string, a ...any) {
	if suppressDetail() {
		return
	}
	p.printf("  %s %s\n", StyleInfo.Render("INFO"), fmt.Sprintf(format, a...))
}

// Note prints dimmed secondary detail. Suppressed by --json.
func (p *Printer) Note(format string, a ...any) {
	if suppressDetail() {
		return
	}
	p.printf("  %s\n", StyleNote.Render(fmt.Sprintf(format, a...)))
}

// detailIndent is where a section's supporting detail sits: one step in from the
// status vocabulary, so a block reads as heading, findings, detail without needing
// a second colour to say so.
const detailIndent = "      "

// Detail prints an indented supporting line under a finding. Suppressed by --json.
func (p *Printer) Detail(format string, a ...any) {
	if suppressDetail() {
		return
	}
	p.printf("%s%s\n", detailIndent, fmt.Sprintf(format, a...))
}

// Fields prints aligned label/value detail under a section heading.
//
// Every block used to pad its own labels by hand — "  tax.taxPercentage  : %g%%"
// next to "  successful : %v" — so no two blocks shared a column, and renaming a
// field broke the alignment of the block it was in without anything noticing. The
// width is measured here instead, and the labels are dimmed so the values are what
// the eye lands on.
func (p *Printer) Fields(rows [][2]string) {
	if len(rows) == 0 {
		return
	}
	tbl := make([][]string, 0, len(rows))
	for _, r := range rows {
		value := r[1]
		// An empty value gets a dash rather than nothing. A row that stops after its
		// label is indistinguishable from a rendering fault, and for several of these —
		// the target a captured rule declares — empty is the finding.
		if value == "" {
			value = StyleDim.Render("—")
		}
		tbl = append(tbl, []string{StyleDim.Render(r[0]), value})
	}
	p.Raw(Table(tbl, detailIndent))
}

// Warn prints something the user should probably act on.
func (p *Printer) Warn(format string, a ...any) {
	p.printf("  %s %s\n", StyleWarn.Render("▲"), fmt.Sprintf(format, a...))
}

// OK prints a tick.
func (p *Printer) OK(format string, a ...any) {
	p.printf("  %s %s\n", StylePass.Render("✔"), fmt.Sprintf(format, a...))
}

// Plain writes a line with no decoration.
func (p *Printer) Plain(format string, a ...any) { p.printf(format+"\n", a...) }

// Raw writes exactly what it is given.
func (p *Printer) Raw(s string) { p.printf("%s", s) }

// Failures is the number of Fail calls so far.
func (p *Printer) Failures() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.failures
}

// Section layout.
//
// Every block of output in this tool is introduced the same way: a blank line, a
// marker, the title, an optional dim caption, then a light rule. `== a section`
// was doing three jobs badly — it had no vertical space of its own, so a heading
// read as one more line of the block above it; it put the heading at column 0
// while every status line under it was indented, so the block had two left edges;
// and it had nowhere to put the "what this is" part of a title, which is why
// captions ended up as parentheses competing with the collection name for
// attention.
//
// The rule is a fixed width rather than the length of its own title. Ragged rules
// draw the eye along their right edge, which is where nothing is; a shared right
// edge makes six sections from six commands read as one document, and it means a
// short title like `auth` gets the same visual weight as a long one.
const (
	// gutter is the left margin every line in this package shares, status lines
	// included, so a section and its findings line up.
	gutter = "  "
	// sectionMark introduces a heading. Filled triangle rather than "==" because a
	// heading is a pointer into what follows, not a divider between equals.
	sectionMark = "▸ "
	// captionSep separates a title from its dim caption. The same `  ·  ` the
	// banners and the shell header use.
	captionSep = "  ·  "
	ruleChar   = "─"
	// ruleWidth is the shared right edge. 56 columns fits an 80-column terminal
	// with room to spare and is what `doctor` already used.
	ruleWidth = 56
)

// rule returns a horizontal rule of at least width columns, never wider than the
// terminal. Narrow terminals shrink it instead of wrapping it, because a wrapped
// rule reads as two rules with a stray fragment.
func rule(char string, width int) string {
	if cols := platform.TermCols() - len([]rune(gutter)); cols > 0 && width > cols {
		width = cols
	}
	if width < 1 {
		width = 1
	}
	return strings.Repeat(char, width)
}

// visibleWidth measures a styled string in terminal cells: escape sequences count for
// nothing and a double-width rune counts for two, which is what a column of headings
// lifted out of markdown needs.
func visibleWidth(s string) int { return ansi.StringWidth(s) }

// Section prints a section heading with a dim caption after the title.
//
// The caption is where "what this collection is" belongs: the title stays the
// thing you would grep for, and the explanation stops competing with it.
// An empty caption prints just the title.
func (p *Printer) Section(title, caption string) {
	head := StyleStep.Render(sectionMark) + StyleWhite.Render(title)
	if caption != "" {
		head += StyleDim.Render(captionSep + caption)
	}
	p.printf("\n%s%s\n%s%s\n", gutter, head, gutter, StyleDim.Render(rule(ruleChar, ruleWidth)))
}

// Step prints a section heading with no caption.
func (p *Printer) Step(format string, a ...any) {
	p.Section(fmt.Sprintf(format, a...), "")
}

// Errorf prints an error line to stderr without exiting, for commands that
// return a non-zero code through the registry rather than calling os.Exit.
func Errorf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "%s %s\n", StyleFail.Render("ERROR"), fmt.Sprintf(format, a...))
}

// Hint prints an indented suggestion to stderr, alongside an error.
func Hint(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "  %s\n", StyleDim.Render(fmt.Sprintf(format, a...)))
}
