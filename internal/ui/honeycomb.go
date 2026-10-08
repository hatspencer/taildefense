package ui

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// The honeycomb finale.
//
// A run that reports verdicts ends with them built into a comb: one hexagonal cell per PASS,
// FAIL and WARN line, in the order they were printed, each capped hot and cooling to its
// colour. Under it a honey bar fills to the share that passed and drips. Then one of two
// endings. Clean: pollen bursts out of the comb. Not clean: the broken cells flash and the bee
// arrives and shakes, angry, beside them.
//
// The glyph carries the verdict as well as the colour, so the comb is honest on a sixteen
// colour terminal: a passed cell is filled, a warned one is filled in the warning colour, a
// failed one is left hollow, which is also what a broken cell in a real comb looks like.
//
// It is a replay rather than a live view: the comb is built from the record the Printer
// keeps, after the command has returned, so it can never hold the work up.

const (
	verdictPass byte = 'p'
	verdictFail byte = 'f'
	verdictWarn byte = 'w'
)

// finaleCommands are the commands that end in a comb. Each is a run of checks with a verdict
// per line; a listing command printing one PASS would get a comb of one, which is noise.
var finaleCommands = map[string]bool{
	"render": true, "check": true, "lint": true, "regen": true, "doctor": true, "publish": true,
	"verify": true,
}

const (
	finaleDuration = 400 * time.Millisecond
	combPerRow     = 12
	combRows       = 3
	// combFill is the share of the scene spent filling cells; the ending has the rest.
	combFill = 0.52
)

// Finale plays the ending for cmd, which exited with code, from the default Printer's record.
func Finale(ctx context.Context, cmd string, code int) { finaleFrom(ctx, Std, cmd, code) }

func finaleFrom(ctx context.Context, p *Printer, cmd string, code int) {
	if !finaleCommands[cmd] || code == 130 {
		return
	}
	v := p.Verdicts()
	if len(v) == 0 {
		return
	}
	cols := termWidthOr(80)
	failed := code != 0
	for _, x := range v {
		if x == verdictFail {
			failed = true
		}
	}
	h := combHeight(len(v))
	playScene(ctx, p.w, closingBudget, h, finaleDuration, false, func(q float64) []string {
		return combFrame(v, failed, cols, q)
	})
}

// combLayout is how many cells per row and how many rows n verdicts take.
func combLayout(n int) (perRow, rows int) {
	perRow = min(max(n, 1), combPerRow)
	rows = min((n+perRow-1)/perRow, combRows)
	return perRow, max(rows, 1)
}

// combHeight is the scene's height: a margin row for pollen, the comb, the bar and its drips.
func combHeight(n int) int {
	_, rows := combLayout(n)
	return rows + 3
}

// combCell is where cell i sits: rows are offset by one cell alternately, which is what makes
// a grid of glyphs read as a comb rather than a table.
func combCell(i, perRow int) (x, y int) {
	r, c := i/perRow, i%perRow
	return 3 + 2*c + r%2, 1 + r
}

// combFrame renders the finale at progress q.
func combFrame(v []byte, failed bool, cols int, q float64) []string {
	perRow, rows := combLayout(len(v))
	shown := min(len(v), perRow*rows)
	h := rows + 3
	labelX := 3 + 2*perRow + 3
	cw := min(cols, labelX+34)
	c := newCanvas(cw, h)
	styles, _ := candyRamp()
	hot := len(styles) - 1

	passed := 0
	broken := 0
	for i := 0; i < shown; i++ {
		x, y := combCell(i, perRow)
		at := 0.04 + combFill*float64(i)/float64(max(shown, 1))
		if q < at {
			c.put(x, y, "⬡", &StyleDim)
			continue
		}
		age := (q - at) / 0.14
		switch v[i] {
		case verdictFail:
			broken++
			st := &StyleFail
			// The broken cells flash once the comb is built: the eye goes to them first.
			if failed && q > combFill+0.05 && int(q*40)%2 == 0 {
				st = &StyleDim
			}
			c.put(x, y, "⬡", st)
		case verdictWarn:
			st := &StyleWarn
			if age < 1 {
				st = &styles[round((1-age)*float64(hot))]
			}
			c.put(x, y, "⬢", st)
		default:
			passed++
			st := &StyleAccent
			if age < 1 {
				st = &styles[round((1-age)*float64(hot))]
			}
			c.put(x, y, "⬢", st)
		}
	}
	if len(v) > shown {
		c.text(3+2*perRow+1, rows, fmt.Sprintf("+%d", len(v)-shown), &StyleDim)
	}

	// The honey bar fills to the share of cells that passed, behind the cells as they cap.
	barW := 2 * perRow
	level := float64(passed) / float64(max(shown, 1)) * easeOutCubic(q/(combFill+0.1))
	honeyBar(c, 3, rows+1, barW, level, q)

	if !failed {
		if q >= combFill {
			c.text(labelX, 1, "✔", &StylePass)
			c.text(labelX+2, 1, fmt.Sprintf("%d cells capped", shown), &StyleDim)
			pollenBurst(c, pt{float64(3 + perRow), float64(rows) / 2}, (q-combFill)/(1-combFill))
		}
		return c.rows()
	}
	if q >= combFill*0.7 {
		c.text(labelX, 1, "✘", &StyleFail)
		c.text(labelX+2, 1, fmt.Sprintf("%d of %d cells broken", max(broken, 1), shown), &StyleDim)
		angryBee(c, labelX, min(2, h-1), (q-combFill*0.7)/(1-combFill*0.7))
	}
	return c.rows()
}

// honeyBar draws a bar of width cells filled to level, honey gradient with a travelling
// glint and drips falling from the filled part on the row under it.
func honeyBar(c *canvas, x0, y, width int, level, q float64) {
	styles, _ := candyRamp()
	hot := len(styles) - 1
	filled := level * float64(width)
	full := int(filled)
	glint := int(q * float64(width+8))
	for i := 0; i < width; i++ {
		switch {
		case i < full:
			st := &StyleAccent
			if d := glint - i; d >= 0 && d < 4 {
				st = &styles[round(float64(4-d)/4*float64(hot))]
			}
			c.put(x0+i, y, "█", st)
		case i == full && filled-float64(full) > 0.5:
			c.put(x0+i, y, "▌", &StyleAccent)
		default:
			c.put(x0+i, y, "░", &StyleDim)
		}
	}
	// Drips: a few columns of the filled part, each falling on its own phase.
	if y+1 >= c.h {
		return
	}
	for k := 0; k < 4; k++ {
		col := int(hashf(uint64(k)+0xd1) * float64(max(full, 1)))
		if col >= full {
			continue
		}
		phase := math.Mod(q*2.2+hashf(uint64(k)+0xd2), 1)
		g := "╻"
		switch {
		case phase > 0.66:
			g = "·"
		case phase > 0.33:
			g = "•"
		}
		c.put(x0+col, y+1, g, &StyleAccent)
	}
}

// pollenBurst throws grains out of origin at progress q, in the theme's warm colours, fading
// as they travel. Cells are about twice as tall as they are wide, so the burst is stretched
// horizontally to read as round.
func pollenBurst(c *canvas, origin pt, q float64) {
	if q <= 0 {
		return
	}
	styles, _ := candyRamp()
	hot := len(styles) - 1
	const grains = 22
	d := easeOutCubic(q)
	for k := 0; k < grains; k++ {
		ang := 2*math.Pi*float64(k)/grains + (hashf(uint64(k)+0x90)-0.5)*0.5
		speed := 0.6 + 0.6*hashf(uint64(k)+0x91)
		r := d * speed * 9
		x := round(origin.x + math.Cos(ang)*r*2)
		y := round(origin.y + math.Sin(ang)*r*0.9)
		if !c.empty(x, y) {
			continue
		}
		g := "✦"
		switch {
		case q > 0.7:
			g = "·"
		case q > 0.4:
			g = "•"
		}
		var st *lipgloss.Style
		switch k % 3 {
		case 0:
			st = &StyleWarn
		case 1:
			st = &StylePass
		default:
			st = &styles[round((1-q)*float64(hot))]
		}
		c.put(x, y, g, st)
	}
}

// angryBee is the bee shaking on row y beside the label: a fast sideways jitter, sparks
// flicking on either side, and the buzz.
func angryBee(c *canvas, x0, y int, q float64) {
	if q <= 0 {
		return
	}
	jitter := round(1.6 * math.Sin(q*95))
	x := x0 + 2 + jitter
	c.put(x, y, beeGlyph, nil)
	sparks := []string{"✘", "*", "✦"}
	flick := int(q * 30)
	c.put(x-2, y+flick%2, sparks[flick%3], &StyleFail)
	c.put(x+3, y+1-flick%2, sparks[(flick+1)%3], &StyleFail)
	buzz := "bzz"
	if flick%2 == 1 {
		buzz = "BZZ"
	}
	c.text(x+5, y, buzz, &StyleFail)
}
