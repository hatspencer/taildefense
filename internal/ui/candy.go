package ui

import (
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/platform"
)

// Eye candy: the transient set.
//
// Everything in anim.go is chrome that sits on screen. What follows is a set of short scenes
// played once, at the edge of a command, and then erased: the swarm that builds the wordmark,
// the honeycomb a run fills, the pollen burst on a clean result, the angry bee on a failing
// one, lessons flying into steering on promote, the bee orbiting the knowledge loop on audit.
//
// The rules from anim.go apply unchanged, and three more are specific to scenes:
//
//  1. Nothing waits on a scene. A scene plays after the work it decorates is done, never in
//     front of it, and every scene draws from a fixed budget per process (budget below), so
//     the most a command can be held up by is the budget, however many scenes it reaches.
//
//  2. A scene is erased when it ends, or keeps exactly the bytes the still path prints. Either
//     way the scrollback is what a transcript would show, so a scene is never the only place
//     a fact appears.
//
//  3. Ctrl-C skips. A scene listens for the interrupt itself, stops, erases, and hands the
//     cursor back. The dispatcher's own handler still sees the same signal, so a command that
//     was interrupted still reports it.
//
// The gate is AnimEnabled plus the link (motion), plus the conditions a scene adds on top:
// stdout is the real stdout, no --json, no --quiet, nothing collecting the output, not inside
// a shell pane, and room on screen for the whole block. Off any of those, a scene writes zero
// bytes, which is what keeps --json, pipes, NO_COLOR, TERM=dumb, CI and hook output identical.

// candyFrame is the redraw interval of a scene. Sixty frames a second: a scene is short and
// local, and a lower rate is what makes a bee's path read as hops instead of flight.
const candyFrame = 16 * time.Millisecond

// beeGlyph is the bee drawn by the transient scenes: the swarm that builds the wordmark, the
// orbit on audit, the angry bee on a failing run. Two cells wide. It is only ever drawn into a
// canvas that is erased when the scene ends, so unlike the former header bee it changes no frame
// height.
const beeGlyph = "🐝"

// budget is a pool of time scenes may spend.
type budget int

const (
	// openingBudget is what the banner's swarm and typewriter share. A banner precedes work, so
	// this is held under the half second the plain wipe used to take.
	openingBudget budget = iota
	// closingBudget is what everything after the work shares: finales, flights, the wheel and
	// cascading tables. The ~400ms the tool promises at most on completion.
	closingBudget
)

var budgetLimit = map[budget]time.Duration{
	openingBudget: 450 * time.Millisecond,
	closingBudget: 400 * time.Millisecond,
}

// minScene is the shortest scene worth starting. Below it a scene is a flash, which reads as a
// rendering glitch rather than an animation, so the remainder of a budget is simply not spent.
const minScene = 60 * time.Millisecond

var budgetSpent = map[budget]*atomic.Int64{
	openingBudget: {},
	closingBudget: {},
}

// takeBudget grants up to want from b, or zero when too little is left.
func takeBudget(b budget, want time.Duration) time.Duration {
	spent := budgetSpent[b]
	limit := int64(budgetLimit[b])
	for {
		cur := spent.Load()
		left := limit - cur
		if left < int64(minScene) {
			return 0
		}
		d := min(int64(want), left)
		if spent.CompareAndSwap(cur, cur+d) {
			return time.Duration(d)
		}
	}
}

// resetBudgets is for tests, which play many scenes in one process.
func resetBudgets() {
	for _, s := range budgetSpent {
		s.Store(0)
	}
}

// cursorHidden records that a scene hid the cursor, so ResetTerminal can show it again on an
// exit path that skips the scene's own deferred restore: a second Ctrl-C calls os.Exit.
var cursorHidden atomic.Bool

func hideCursor(w io.Writer) {
	cursorHidden.Store(true)
	io.WriteString(w, "\x1b[?25l")
}

func showCursor(w io.Writer) {
	if cursorHidden.Swap(false) {
		io.WriteString(w, "\x1b[?25h")
	}
}

// sceneMu serialises scenes. Two goroutines both moving the cursor up over one block is the
// smear every live region in this package exists to avoid.
var sceneMu sync.Mutex

// sceneOK reports whether a scene of height rows may play on w.
func sceneOK(w io.Writer, height int) bool {
	if height <= 0 || w != io.Writer(os.Stdout) {
		return false
	}
	if !motion() || JSONMode() || Quiet() || Captured() || InShellPane() {
		return false
	}
	return platform.TermRows() >= height+2
}

// playScene runs frame from progress 0 to 1 over want, drawn in place on stdout.
//
// frame must be a pure function of progress. With keep, a scene that ran to completion leaves
// its final frame on screen and the cursor under it; every caller using keep makes that frame
// byte for byte its still output. Without keep, or when interrupted, the block is erased and
// the cursor returned to where the block began. Reports whether the final frame was kept.
func playScene(ctx context.Context, w io.Writer, b budget, height int, want time.Duration, keep bool, frame func(p float64) []string) bool {
	if !sceneOK(w, height) {
		return false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return false
	}
	sceneMu.Lock()
	defer sceneMu.Unlock()
	dur := takeBudget(b, want)
	if dur == 0 {
		return false
	}
	return runScene(ctx, w, height, dur, keep, platform.TermCols(), frame)
}

// runScene is the loop itself, with the writer and width explicit so a test can read the bytes.
func runScene(ctx context.Context, w io.Writer, height int, dur time.Duration, keep bool, cols int, frame func(p float64) []string) (kept bool) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	defer signal.Stop(sig)

	hideCursor(w)
	defer showCursor(w)

	// The block is reserved once, scrolling the terminal if it must, so every frame after is a
	// fixed rewind rather than a growing one.
	io.WriteString(w, strings.Repeat("\n", height))
	draw := func(rows []string) {
		var sb strings.Builder
		fmt.Fprintf(&sb, "\x1b[%dA", height)
		for i := 0; i < height; i++ {
			row := ""
			if i < len(rows) {
				// One cell short of the edge: a row that touches the last column puts some
				// terminals into the pending-wrap state, and the next \n then skips a line.
				row = clipRow(rows[i], max(1, cols-1))
			}
			sb.WriteString("\r" + row + "\x1b[K\n")
		}
		io.WriteString(w, sb.String())
	}
	defer func() {
		if kept {
			return
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "\x1b[%dA", height)
		for i := 0; i < height; i++ {
			sb.WriteString("\r\x1b[K\n")
		}
		fmt.Fprintf(&sb, "\x1b[%dA", height)
		io.WriteString(w, sb.String())
	}()

	start := time.Now()
	tick := time.NewTicker(candyFrame)
	defer tick.Stop()
	for {
		p := float64(time.Since(start)) / float64(dur)
		if p > 1 {
			p = 1
		}
		draw(frame(p))
		if p >= 1 {
			return keep
		}
		select {
		case <-ctx.Done():
			return false
		case <-sig:
			return false
		case <-tick.C:
		}
	}
}

// ── a cell canvas ────────────────────────────────────────────────────────────
//
// Scenes are drawn on a grid and then flattened to rows, rather than built as strings,
// because particles overlap: a pollen grain and a honeycomb cell can want the same cell, and
// the only sane way to decide who wins is to have one cell to decide it in. Flattening emits
// runs of one style, the same economy shimmerHeads relies on.

type canvas struct {
	w, h  int
	glyph [][]string
	style [][]*lipgloss.Style
}

// cont marks the second cell of a wide glyph.
const cont = "\x00"

func newCanvas(w, h int) *canvas {
	c := &canvas{w: max(w, 1), h: max(h, 1)}
	c.glyph = make([][]string, c.h)
	c.style = make([][]*lipgloss.Style, c.h)
	for y := range c.glyph {
		c.glyph[y] = make([]string, c.w)
		c.style[y] = make([]*lipgloss.Style, c.w)
	}
	return c
}

// empty reports whether nothing has been drawn at x, y. Out of bounds counts as occupied, so
// a particle never "finds room" off the canvas.
func (c *canvas) empty(x, y int) bool {
	if x < 0 || y < 0 || x >= c.w || y >= c.h {
		return false
	}
	return c.glyph[y][x] == ""
}

// put draws g at x, y. A glyph that would not fit whole is not drawn: there is no half of an
// emoji, and a clipped one makes the row a cell short and every column after it shifts.
func (c *canvas) put(x, y int, g string, st *lipgloss.Style) {
	if y < 0 || y >= c.h || x < 0 {
		return
	}
	gw := ansi.StringWidth(g)
	if gw < 1 || x+gw > c.w {
		return
	}
	for k := 0; k < gw; k++ {
		c.clear(x+k, y)
	}
	c.glyph[y][x] = g
	c.style[y][x] = st
	for k := 1; k < gw; k++ {
		c.glyph[y][x+k] = cont
		c.style[y][x+k] = nil
	}
}

// clear empties one cell, and the other half of any wide glyph it was part of.
func (c *canvas) clear(x, y int) {
	switch {
	case c.glyph[y][x] == cont:
		for k := x - 1; k >= 0; k-- {
			was := c.glyph[y][k]
			c.glyph[y][k], c.style[y][k] = "", nil
			if was != cont {
				break
			}
		}
	case c.glyph[y][x] != "" && ansi.StringWidth(c.glyph[y][x]) > 1:
		for k := x + 1; k < c.w && c.glyph[y][k] == cont; k++ {
			c.glyph[y][k], c.style[y][k] = "", nil
		}
	}
	c.glyph[y][x], c.style[y][x] = "", nil
}

// text writes s from x, one cell per rune.
func (c *canvas) text(x, y int, s string, st *lipgloss.Style) {
	for _, r := range s {
		if r != ' ' {
			c.put(x, y, string(r), st)
		}
		x++
	}
}

// rows flattens the canvas, trimming trailing blanks so a frame never ends in spaces.
func (c *canvas) rows() []string {
	out := make([]string, c.h)
	for y := 0; y < c.h; y++ {
		last := -1
		for x := c.w - 1; x >= 0; x-- {
			if g := c.glyph[y][x]; g != "" && g != cont {
				last = x
				break
			}
		}
		var b, run strings.Builder
		var runStyle *lipgloss.Style
		flush := func() {
			if run.Len() == 0 {
				return
			}
			if runStyle == nil {
				b.WriteString(run.String())
			} else {
				b.WriteString(runStyle.Render(run.String()))
			}
			run.Reset()
		}
		for x := 0; x <= last; x++ {
			g := c.glyph[y][x]
			if g == cont {
				continue
			}
			st := c.style[y][x]
			if g == "" {
				g = " "
				// A space takes whatever run it lands in: a foreground on a space paints
				// nothing, and breaking the run for it only lengthens the string.
				st = runStyle
			}
			if st != runStyle {
				flush()
				runStyle = st
			}
			run.WriteString(g)
		}
		flush()
		out[y] = b.String()
	}
	return out
}

// ── paths ────────────────────────────────────────────────────────────────────

type pt struct{ x, y float64 }

// quad is a quadratic Bezier: the arc a lesson flies from the queue to a steering cell.
func quad(a, ctrl, b pt, t float64) pt {
	u := 1 - t
	return pt{u*u*a.x + 2*u*t*ctrl.x + t*t*b.x, u*u*a.y + 2*u*t*ctrl.y + t*t*b.y}
}

// cubic is a cubic Bezier: the lead bee's loop over the wordmark, which needs the S a single
// control point cannot make.
func cubic(a, c1, c2, b pt, t float64) pt {
	u := 1 - t
	return pt{
		u*u*u*a.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*b.x,
		u*u*u*a.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*b.y,
	}
}

func clamp01(v float64) float64 {
	switch {
	case v < 0:
		return 0
	case v > 1:
		return 1
	}
	return v
}

func easeOutCubic(t float64) float64 {
	t = clamp01(t)
	u := 1 - t
	return 1 - u*u*u
}

func easeInOut(t float64) float64 {
	t = clamp01(t)
	if t < 0.5 {
		return 4 * t * t * t
	}
	u := -2*t + 2
	return 1 - u*u*u/2
}

// hashf is hash64 as a fraction in [0, 1): the scenes' only source of randomness, so a frame
// is still a pure function of its progress.
func hashf(seed uint64) float64 {
	return float64(hash64(seed)>>11) / float64(uint64(1)<<53)
}

func round(v float64) int { return int(math.Floor(v + 0.5)) }

// ── the legible ramp ─────────────────────────────────────────────────────────
//
// A scene is drawn mostly in the accent ramp, and the ramp's hot end is near white: right on
// a dark background, invisible on paper. So scenes do not use the ramp as it is. They use the
// stops of it that meet the 3:1 mark ratio against the background in force, ordered from the
// resting accent to the most conspicuous, which on a dark theme means brighter and on a light
// one means deeper. A test holds every theme to it.

var (
	candyMu     sync.Mutex
	candyStyles []lipgloss.Style
	candyHexes  []string
)

// invalidateCandy drops the cached ramp; initAnim calls it whenever the palette changes.
func invalidateCandy() {
	candyMu.Lock()
	candyStyles, candyHexes = nil, nil
	candyMu.Unlock()
}

// candyBackground is the background a scene is drawn on: the theme's own when it paints one,
// otherwise a typical dark or light terminal, slightly lifted off pure black and white so the
// check errs strict.
func candyBackground() string {
	if active.Full() {
		return resolve(active.Bg)
	}
	if lipgloss.HasDarkBackground() {
		return "#1e1e1e"
	}
	return "#f5f5f5"
}

func adaptiveHex(c lipgloss.AdaptiveColor) string {
	if lipgloss.HasDarkBackground() {
		return c.Dark
	}
	return c.Light
}

// legibleRamp builds the scene ramp from the theme's ramp and accent against bg.
func legibleRamp(ramp []lipgloss.AdaptiveColor, accent lipgloss.AdaptiveColor, bg string, pick func(lipgloss.AdaptiveColor) string) []string {
	rest := 0
	if len(ramp) > 0 {
		rest = int(fracRest*float64(len(ramp)-1) + 0.5)
	}
	var out []string
	seen := map[string]bool{}
	add := func(hex string) {
		if hex == "" || seen[hex] || contrastRatio(hex, bg) < 3.0 {
			return
		}
		seen[hex] = true
		out = append(out, hex)
	}
	add(pick(accent))
	for i := rest; i < len(ramp); i++ {
		add(pick(ramp[i]))
	}
	// A light background leaves few hot stops standing, so the deeper half supplies the
	// contrast instead: on paper "hotter" reads as more ink.
	if len(out) < 4 {
		for i := rest - 1; i >= 0; i-- {
			add(pick(ramp[i]))
		}
	}
	return out
}

// candyRamp is the legible ramp for the palette in force.
func candyRamp() ([]lipgloss.Style, []string) {
	candyMu.Lock()
	defer candyMu.Unlock()
	if candyStyles != nil {
		return candyStyles, candyHexes
	}
	hexes := legibleRamp(AccentRamp, ColorAccent, candyBackground(), adaptiveHex)
	styles := make([]lipgloss.Style, 0, len(hexes))
	for _, h := range hexes {
		styles = append(styles, lipgloss.NewStyle().Foreground(lipgloss.Color(h)).Bold(true))
	}
	if len(styles) == 0 {
		styles = []lipgloss.Style{StyleAccent}
	}
	candyStyles, candyHexes = styles, hexes
	return candyStyles, candyHexes
}

// heat is the scene ramp at h, 0 the resting accent and 1 the most conspicuous stop.
func heat(h float64) *lipgloss.Style {
	styles, _ := candyRamp()
	i := round(clamp01(h) * float64(len(styles)-1))
	return &styles[i]
}

// contrastRatio is the WCAG ratio between two #rrggbb colours.
func contrastRatio(a, b string) float64 {
	la, lb := relLuminance(a), relLuminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func relLuminance(hex string) float64 {
	r, g, b := rgb(hex)
	lin := func(c int) float64 {
		v := float64(c) / 255
		if v <= 0.03928 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
}
