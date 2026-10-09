package tui

import (
	"math"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"taildefense/internal/ui"
)

// The boot splash, the terminal twin of the browser's (web/src/hud/splash.ts): the wordmark is
// laid brick by brick like a base wall while creeps crawl in along the ground from both sides,
// then the wall's guns open up and pick them off, a searchlight crosses the word, and the
// tagline types in under it. Drawn in half-block pixels, two to a cell, in the theme's colours.
// Every frame is a pure function of the elapsed time, so `td frame --view splash --at S` shows
// any moment of it. Any key skips it.

// SplashFor is how long the splash plays.
const SplashFor = 2200 * time.Millisecond

// splashTick is the splash's frame interval: falling bricks want more than the spinner's ten
// frames a second.
const splashTick = 40 * time.Millisecond

// Tagline is typed in under the wordmark, the same as in the browser.
const Tagline = "hold the base · loot the dark · bring everyone home"

// The wordmark font: 6x7 blocks with 2-wide strokes, I a 2-wide bar. Every '#' is a brick.
var splashGlyphs = map[rune][7]string{
	'T': {"######", "######", "..##..", "..##..", "..##..", "..##..", "..##.."},
	'A': {".####.", "##..##", "##..##", "######", "##..##", "##..##", "##..##"},
	'I': {"##", "##", "##", "##", "##", "##", "##"},
	'L': {"##....", "##....", "##....", "##....", "##....", "######", "######"},
	'D': {"#####.", "##..##", "##..##", "##..##", "##..##", "##..##", "#####."},
	'E': {"######", "##....", "##....", "#####.", "##....", "##....", "######"},
	'F': {"######", "##....", "##....", "#####.", "##....", "##....", "##...."},
	'N': {"##..##", "###.##", "######", "##.###", "##..##", "##..##", "##..##"},
	'S': {".#####", "##....", "##....", ".####.", "....##", "....##", "#####."},
}

// "tail" is laid in the text colour, "defense" in the accent.
const splashWord, splashSplit = "TAILDEFENSE", 4

type brick struct {
	x, y   int
	at     float64 // when it lands, seconds
	accent bool
}

var bricks, brickW = func() ([]brick, int) {
	var out []brick
	x := 0
	for i, r := range splashWord {
		g := splashGlyphs[r]
		for y, row := range g {
			for c, ch := range row {
				if ch == '#' {
					out = append(out, brick{x: x + c, y: y, accent: i >= splashSplit})
				}
			}
		}
		x += len(g[0]) + 1
	}
	w := x - 1
	// Laid left to right, bottom course first within a stretch, with some scatter, the way a
	// wall goes up.
	for i := range out {
		b := &out[i]
		col := float64(b.x) / float64(w)
		b.at = splashT.lay0 + (splashT.lay1-splashT.lay0)*(0.8*col+0.12*float64(6-b.y)/6+0.08*hash01(uint64(i), 1))
	}
	return out, w
}()

const brickH = 7

// The timeline, in seconds.
var splashT = struct {
	lay0, lay1, fall, cool, guns, sweep0, sweep1, type0, type1 float64
}{
	lay0: 0.08, lay1: 1.0, fall: 0.2, cool: 0.4,
	guns: 1.0, sweep0: 1.35, sweep1: 1.9,
	type0: 0.95, type1: 1.75,
}

// splashFits reports whether the splash has room: the word plus a margin, and rows for the
// word, the ground and the tagline.
func splashFits(w, h int) bool { return w >= brickW+4 && h >= 12 }

// hash01 is a stable pseudo-random number in [0, 1) for an id and a salt.
func hash01(id, salt uint64) float64 {
	x := id*0x9e3779b97f4a7c15 ^ salt*0xbf58476d1ce4e5b9
	x ^= x >> 31
	x *= 0x94d049bb133111eb
	x ^= x >> 29
	return float64(x>>11) / float64(1<<53)
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// pixels is a grid two rows per cell; "" is an empty pixel. Brighter writes win.
type pixels struct {
	w, h int
	c    []string
	lv   []float64
}

func newPixels(w, h int) *pixels {
	p := &pixels{w: w, h: h, c: make([]string, w*h), lv: make([]float64, w*h)}
	for i := range p.lv {
		p.lv[i] = -1
	}
	return p
}

func (p *pixels) set(x, y int, c string, lv float64) {
	if x < 0 || y < 0 || x >= p.w || y >= p.h || lv < p.lv[y*p.w+x] {
		return
	}
	p.c[y*p.w+x], p.lv[y*p.w+x] = c, lv
}

func (p *pixels) setf(x, y float64, c string, lv float64) {
	p.set(int(math.Floor(x+0.5)), int(math.Floor(y+0.5)), c, lv)
}

// line draws from a to b, one pixel per step along the longer axis, fading from c0 at a to c1
// at b.
func (p *pixels) line(ax, ay, bx, by float64, c0, c1 string, lv float64) {
	n := int(math.Max(math.Abs(bx-ax), math.Abs(by-ay))) + 1
	for i := 0; i <= n; i++ {
		f := float64(i) / float64(n)
		p.setf(ax+(bx-ax)*f, ay+(by-ay)*f, ui.Mix(c0, c1, f), lv)
	}
}

// splashStyles caches a style per colour pair; a frame has a few dozen of them.
var splashStyles = map[[2]string]lipgloss.Style{}

func cellStyle(fg, bg string) lipgloss.Style {
	k := [2]string{fg, bg}
	s, ok := splashStyles[k]
	if !ok {
		s = lipgloss.NewStyle()
		if fg != "" {
			s = s.Foreground(lipgloss.Color(fg))
		}
		if bg != "" {
			s = s.Background(lipgloss.Color(bg))
		}
		splashStyles[k] = s
	}
	return s
}

// rows renders the grid as cells: ▀ for a lit top, ▄ for a lit bottom, █ when both match,
// and ▀ over a background when they differ. Runs of one style are painted once.
func (p *pixels) rows() []string {
	out := make([]string, p.h/2)
	for r := range out {
		var b, run strings.Builder
		var cur [2]string
		flush := func() {
			if run.Len() == 0 {
				return
			}
			if cur == [2]string{} {
				b.WriteString(run.String())
			} else {
				b.WriteString(cellStyle(cur[0], cur[1]).Render(run.String()))
			}
			run.Reset()
		}
		for x := 0; x < p.w; x++ {
			top, bot := p.c[2*r*p.w+x], p.c[(2*r+1)*p.w+x]
			var k [2]string
			g := " "
			switch {
			case top == "" && bot == "":
			case bot == "":
				k, g = [2]string{top, ""}, "▀"
			case top == "":
				k, g = [2]string{bot, ""}, "▄"
			case top == bot:
				k, g = [2]string{top, ""}, "█"
			default:
				k, g = [2]string{top, bot}, "▀"
			}
			if k != cur && !(g == " " && cur[1] == "") {
				flush()
				cur = k
			}
			run.WriteString(g)
		}
		flush()
		out[r] = b.String()
	}
	return out
}

// splashInk is the palette, from the theme, so a light terminal gets a light-terminal splash.
type splashInk struct {
	ramp                         []string
	rest, hot, text, dim, bg     string
	red, yellow, ground, creepHd string
}

func newSplashInk() splashInk {
	k := splashInk{bg: ui.Background(), text: ui.Hex(ui.ColorText), dim: ui.Hex(ui.ColorGray),
		red: ui.Hex(ui.ColorRed), yellow: ui.Hex(ui.ColorYellow)}
	for _, c := range ui.AccentRamp {
		k.ramp = append(k.ramp, ui.Hex(c))
	}
	if len(k.ramp) == 0 {
		k.ramp = []string{ui.Hex(ui.ColorAccent)}
	}
	k.rest, k.hot = k.ramp[ui.RampRest(len(k.ramp))], k.ramp[len(k.ramp)-1]
	k.ground = ui.Mix(k.dim, k.bg, 0.55)
	k.creepHd = ui.Mix(k.text, k.dim, 0.5)
	return k
}

// quant rounds a blend to eighths, so cooling bricks share a handful of colours.
func quant(f float64) float64 { return math.Round(clamp01(f)*8) / 8 }

type creep struct {
	born, speed, dies float64 // speed: a share of the way to the wall by the time the guns open
	left              bool
}

// The creeps: born over the first second, from either side, walking in until the guns open up,
// then dying one after another.
var splashCreeps = func() []creep {
	out := make([]creep, 12)
	for i := range out {
		out[i] = creep{
			born:  0.05 + 0.75*hash01(uint64(i), 2),
			speed: 0.75 + 0.45*hash01(uint64(i), 3),
			left:  i%2 == 0,
			dies:  splashT.guns + 0.06*float64(i) + 0.04*hash01(uint64(i), 4),
		}
	}
	return out
}()

// splashView is the splash at t seconds in, exactly w by h cells.
func splashView(w, h int, t float64) string {
	k := newSplashInk()
	ph := h * 2
	g := newPixels(w, ph)

	// The word sits a little above the middle; the ground runs three pixels under it and the
	// tagline two cells under that.
	mx := (w - brickW) / 2
	my := max((ph-brickH-14)/2+3, 1)
	ground := my + brickH + 3
	tagRow := ground/2 + 2

	// The ground, drawn in from the middle.
	if f := clamp01(t / 0.5); f > 0 {
		half := int(float64(w) / 2 * (1 - math.Pow(1-f, 2)))
		for x := w/2 - half; x < w/2+half; x++ {
			g.set(x, ground, k.ground, 0)
		}
	}

	// Bricks fall into place, land hot and cool to their colour. The searchlight lifts them.
	for i, b := range bricks {
		u := (t - b.at + splashT.fall) / splashT.fall
		if u <= 0 {
			continue
		}
		rest := ui.Mix(k.text, k.dim, 0.15+0.25*hash01(uint64(i), 5))
		if b.accent {
			rest = ui.Mix(k.rest, k.bg, 0.2*hash01(uint64(i), 5))
		}
		x, y := float64(mx+b.x), float64(my+b.y)
		if u < 1 {
			y -= 9 * (1 - u) * (1 - u)
			g.setf(x, y, ui.Mix(k.hot, rest, 0.3), 2)
			continue
		}
		c := ui.Mix(k.hot, rest, quant((t-b.at)/splashT.cool))
		if t > splashT.sweep0 && t < splashT.sweep1 {
			s := (t - splashT.sweep0) / (splashT.sweep1 - splashT.sweep0)
			head := -12 + s*float64(brickW+24)
			d := math.Abs(float64(b.x) + 0.8*float64(b.y) - head)
			if d < 8 {
				c = ui.Mix(c, k.hot, quant(math.Pow(1-d/8, 1.5)))
			}
		}
		g.set(int(x), int(y), c, 2)
	}

	// Creeps crawl in along the ground, a red body under a grey head, and stop short of the
	// wall. When its turn comes the wall's nearest gun fires and it bursts.
	wallL, wallR := float64(mx-3), float64(mx+brickW+2)
	for i, c := range splashCreeps {
		if t < c.born {
			continue
		}
		// Each walks so as to reach the wall about when the guns open up, give or take.
		walk := math.Min(t, c.dies) - c.born
		x := -2 + (wallL+3)*c.speed*walk/math.Max(splashT.guns-c.born, 0.3)
		if x > wallL {
			x = wallL - 3*float64(i/2%4)
		}
		if !c.left {
			x = float64(w) - x
			if x < wallR {
				x = wallR + 3*float64(i/2%4)
			}
		}
		if t < c.dies {
			// Two pixels wide: legs that alternate, a body, a head that bobs.
			step := int(walk*8) % 2
			dir := 1.0
			if !c.left {
				dir = -1
			}
			g.setf(x+dir*float64(step), float64(ground-1), k.red, 3)
			g.setf(x, float64(ground-2), k.red, 3)
			g.setf(x+dir, float64(ground-2), k.red, 3)
			g.setf(x+dir, float64(ground-3-step), k.creepHd, 3)
			continue
		}
		age := t - c.dies
		// The shot: a tracer from the top of the wall above the creep's side.
		if age < 0.09 {
			gx := float64(mx + 1)
			if !c.left {
				gx = float64(mx + brickW - 2)
			}
			gy := float64(my - 1)
			g.line(gx, gy, x, float64(ground-1), k.hot, k.yellow, 4)
			g.setf(gx, gy-1, k.hot, 5)
		}
		// The burst: a few bits thrown up that fall back and bounce off the ground.
		if age < 0.55 {
			for j := 0; j < 7; j++ {
				id := uint64(i*16 + j)
				vx := (hash01(id, 6) - 0.5) * 22
				vy := -10 - 14*hash01(id, 7)
				bx, by := x+vx*age, float64(ground-1)+vy*age+0.5*70*age*age
				if by > float64(ground-1) {
					by = float64(ground-1) - (by-float64(ground-1))*0.3
				}
				f := quant(age / 0.55)
				g.setf(bx, by, ui.Mix(ui.Mix(k.yellow, k.red, math.Min(1, 2*f)), k.bg, f*0.7), 3)
			}
		}
	}

	lines := g.rows()

	// The tagline types in, centred, the newest letter in the accent and a caret after it.
	if tagRow < len(lines) {
		tag := []rune(Tagline)
		if len(tag) > w {
			tag = tag[:w]
		}
		n := int(math.Round(float64(len(tag)) * clamp01((t-splashT.type0)/(splashT.type1-splashT.type0))))
		pad := strings.Repeat(" ", (w-len(tag))/2)
		line := pad + cellStyle(k.dim, "").Render(string(tag[:max(n-1, 0)]))
		if n > 0 {
			last := cellStyle(k.dim, "")
			if n < len(tag) {
				last = cellStyle(k.hot, "")
			}
			line += last.Render(string(tag[n-1]))
		}
		if t > splashT.type0-0.2 && t < splashT.type1+0.3 && int(t/0.26)%2 == 0 {
			line += cellStyle(k.rest, "").Render("▏")
		}
		lines[tagRow] = line
	}
	return strings.Join(lines, "\n")
}
