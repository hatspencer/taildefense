package ui

import (
	"fmt"
	"os"
	"strings"

	"taildefense/internal/platform"
)

// The wordmark: TAIL DEFENSE in a three row box-drawing font, 35 columns. Printed by the
// launcher, by version, and by install.
const wordmark = `  ╔╦╗╔═╗╦╦    ╔╦╗╔═╗╔═╗╔═╗╔╗╔╔═╗╔═╗
   ║ ╠═╣║║     ║║║╣ ╠╣ ║╣ ║║║╚═╗║╣ 
   ╩ ╩ ╩╩╩═╝  ═╩╝╚═╝╚  ╚═╝╝╚╝╚═╝╚═╝`

// A narrow wordmark for terminals too small for the full one: TD.
const wordmarkSmall = `  ╔╦╗╔╦╗
   ║  ║║
   ╩ ═╩╝`

// WordmarkSmall returns the narrow wordmark unstyled, as three lines.
//
// Exported for the shell TUI, which composes it into a header alongside the target
// environment and so needs the rows rather than a finished block.
func WordmarkSmall() []string {
	return strings.Split(wordmarkSmall, "\n")
}

// WordmarkLarge returns the full wordmark unstyled, as three lines.
//
// Also for the shell header, which shows this one when the window can afford it. Two
// sizes of the same word rather than one compromise: the header is where the tool says
// which of your environments you are pointed at, and a logo that has room to be a logo
// makes that strip read as a title bar rather than as scrolled-past output.
func WordmarkLarge() []string {
	return strings.Split(wordmark, "\n")
}

// WordmarkWidth is the width in cells of the widest row of a wordmark.
//
// Callers deciding whether one fits should ask rather than hard-code a number, because
// the answer changed the moment a missing letter was added back.
func WordmarkWidth(rows []string) int {
	w := 0
	for _, r := range rows {
		if n := visibleWidth(r); n > w {
			w = n
		}
	}
	return w
}

// Banner prints the wordmark plus a one line context strip. An empty subtitle
// omits the second line rather than printing a blank one.
//
// The wordmark is revealed rather than printed when this Printer is the terminal's own
// stdout and animation is allowed; see ui.Reveal. Everything under it prints normally,
// because those lines are words someone may want to read at their own speed, and a
// staggered fade on a sentence is an obstacle rather than a flourish.
//
// Under TAILDEFENSE_NO_BANNER it prints nothing. `td update` runs the newly built
// binary's own `install`, and that command opens with a banner too; without this, one
// update draws the wordmark twice.
func (p *Printer) Banner(subtitle string) {
	if BannerSuppressed() {
		return
	}
	p.printf("\n")
	p.reveal(WordmarkRows())
	// Typed out behind a caret where a scene may play; the same bytes as a plain printf
	// everywhere else (swarm.go).
	p.Typewrite("  ", "co-op wave defense over your tailnet", StyleDim)
	if subtitle != "" {
		p.printf("  %s\n", StyleDim.Render(subtitle))
	}
	// No blank line after: what follows is a section, and a section brings its own.
}

// reveal animates artwork onto this Printer, holding the lock for the duration.
//
// The lock matters: a parallel walk gives each worker its own Printer, but they
// can share a writer, and an animation that interleaved with another goroutine's line
// would move the cursor up over that line and overwrite it.
func (p *Printer) reveal(rows []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	Reveal(p.w, rows)
}

// WordmarkRows is the widest wordmark that fits the current terminal, unstyled, as rows, for
// callers that animate it a row at a time.
//
// The width is measured rather than assumed: the full wordmark is 35 cells, so anything
// narrower than that wraps, and a wrapped ASCII banner looks like a rendering bug rather
// than a logo.
func WordmarkRows() []string {
	if platform.TermCols() >= 38 {
		return WordmarkLarge()
	}
	return WordmarkSmall()
}

// Banner prints the default Printer's banner.
func Banner(subtitle string) { Std.Banner(subtitle) }

// EnvNoBanner suppresses the banner in a child process.
//
// It is set by `td update` on the installer it execs, so that an update prints one
// wordmark rather than one per process in the chain. An environment variable rather
// than a flag, so an older installer that predates this ignores it instead of
// rejecting an unknown argument — the same reason install.EnvInstallVersion is one.
const EnvNoBanner = "TAILDEFENSE_NO_BANNER"

// BannerSuppressed reports whether a caller has asked for no banner.
func BannerSuppressed() bool { return os.Getenv(EnvNoBanner) == "1" }

// ContextLine is the one line "who and where am I" strip under the wordmark.
func ContextLine(version string) string {
	return fmt.Sprintf("  %s  ·  %s  ·  %s",
		StyleAccent.Render(platform.OS()),
		platform.Arch(),
		StyleDim.Render("version "+version))
}

// Table renders aligned columns without a border, which is the shape almost
// every listing in this tool wants: the inbox, the ledger, a theme list.
//
// Written by hand rather than with lipgloss/table because the output has to stay
// greppable and paste-friendly — box drawing characters around every cell would
// break `taildefense deployed | grep betting`.
func Table(rows [][]string, indent string) string {
	if len(rows) == 0 {
		return ""
	}
	widths := make([]int, 0, len(rows[0]))
	for _, row := range rows {
		for i, cell := range row {
			w := visibleWidth(cell)
			if i >= len(widths) {
				widths = append(widths, w)
			} else if w > widths[i] {
				widths[i] = w
			}
		}
	}

	var b strings.Builder
	for _, row := range rows {
		var line strings.Builder
		line.WriteString(indent)
		for i, cell := range row {
			line.WriteString(cell)
			// No padding after the final column: trailing whitespace shows up in
			// diffs and in copied output for no benefit.
			if i < len(row)-1 {
				pad := widths[i] - visibleWidth(cell)
				line.WriteString(strings.Repeat(" ", pad+2))
			}
		}
		// An empty final cell leaves the previous column's padding at the end of the
		// line, which is the one case the rule above does not cover.
		b.WriteString(strings.TrimRight(line.String(), " "))
		b.WriteString("\n")
	}
	return b.String()
}

// stripANSI removes escape sequences so column widths are measured in visible
// characters. A styled cell is longer than it looks, and padding to the byte
// length misaligns every row after the first coloured one.
func stripANSI(s string) string {
	var b strings.Builder
	inEscape := false
	for _, r := range s {
		switch {
		case r == '\x1b':
			inEscape = true
		case inEscape && (r == 'm' || r == 'K'):
			inEscape = false
		case !inEscape:
			b.WriteRune(r)
		}
	}
	return b.String()
}
