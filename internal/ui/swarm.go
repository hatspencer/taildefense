package ui

import (
	"context"
	"io"
	"math"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/platform"
)

// The swarm.
//
// The banner is no longer wiped in: it is built. Every visible cell of the wordmark is a bee,
// and every bee flies its own quadratic Bezier from somewhere to the right of the word into
// its cell, landing hot and cooling to the brand colour. A lead bee loops over the swarm on a
// cubic path and dives into the word as the last cells land, and one highlight sweeps the
// finished letters. The final frame is the still banner, byte for byte.
//
// Arrival times come from a hash of the cell's index, not from its column, so the word does not
// fill left to right like a progress bar: it condenses, which is what a swarm settling looks like.

const (
	// swarmDuration is the whole scene. Drawn from the opening budget, with the typewriter.
	swarmDuration = 330 * time.Millisecond
	// swarmFlight is the share of the scene one bee spends in the air.
	swarmFlight = 0.32
	// swarmCool is how long a landed cell stays hot.
	swarmCool = 0.16
	// swarmSweep is when the closing highlight starts.
	swarmSweep = 0.70
	// swarmMargin is how far right of the word bees may start, in cells.
	swarmMargin = 26
)

// swarmFrame renders the wordmark rows at progress p on a canvas cols wide. At p of 1 it is
// the still banner.
func swarmFrame(rows []string, cols int, p float64) []string {
	if p >= 1 {
		out := make([]string, len(rows))
		for i, r := range rows {
			out[i] = StyleBrand.Render(r)
		}
		return out
	}
	h := len(rows)
	wordW := WordmarkWidth(rows)
	cw := max(wordW, min(cols, wordW+swarmMargin))
	c := newCanvas(cw, h)

	styles, _ := candyRamp()
	hot := len(styles) - 1

	// Landed cells first, so a bee still in the air never overwrites a letter.
	type bee struct {
		at   pt
		prog float64
	}
	var flying []bee
	k := 0
	for y, row := range rows {
		x := 0
		for _, r := range row {
			if r == ' ' {
				x++
				continue
			}
			seed := uint64(k)*0x9e3779b97f4a7c15 + 0x5eed
			k++
			land := 0.18 + 0.50*hashf(seed)
			takeoff := land - swarmFlight
			switch {
			case p >= land:
				age := (p - land) / swarmCool
				st := &StyleBrand
				if age < 1 {
					st = &styles[round((1-age)*float64(hot))]
				}
				if p >= swarmSweep {
					if s := sweepHeat(x, wordW, (p-swarmSweep)/(1-swarmSweep)); s > 0 {
						st = &styles[round(s*float64(hot))]
					}
				}
				c.put(x, y, string(r), st)
			case p >= takeoff:
				t := easeInOut((p - takeoff) / swarmFlight)
				from := pt{float64(wordW) + hashf(seed^1)*float64(cw-wordW+4), hashf(seed^2) * float64(h-1)}
				ctrl := pt{(from.x+float64(x))/2 + (hashf(seed^3)-0.5)*14, (hashf(seed^4) - 0.5) * float64(h) * 2.4}
				flying = append(flying, bee{quad(from, ctrl, pt{float64(x), float64(y)}, t), t})
			}
			x++
		}
	}
	for _, b := range flying {
		x, y := round(b.at.x), round(b.at.y)
		if !c.empty(x, y) {
			continue
		}
		g := "·"
		if b.prog > 0.55 {
			g = "•"
		}
		c.put(x, y, g, &styles[round((0.4+0.6*b.prog)*float64(hot))])
	}
	drawLeadBee(c, wordW, p)
	return c.rows()
}

// sweepHeat is the closing highlight at column x, 0 outside the band.
func sweepHeat(x, width int, q float64) float64 {
	head := -shimmerBand + int(q*float64(width+2*shimmerBand))
	d := x - head
	if d < 0 {
		d = -d
	}
	if d >= shimmerBand {
		return 0
	}
	return float64(shimmerBand-d) / float64(shimmerBand)
}

// drawLeadBee flies one bee on a cubic loop: in from the far right, over the top of the word,
// back under it, and into the hive at the H, gone before the sweep starts.
func drawLeadBee(c *canvas, wordW int, p float64) {
	const end = 0.68
	if p >= end || c.w < wordW+4 {
		return
	}
	t := easeInOut(p / end)
	from := pt{float64(c.w - 2), float64(c.h - 1)}
	c1 := pt{float64(wordW) * 0.9, -2.5}
	c2 := pt{float64(wordW) * 0.2, float64(c.h) + 1.5}
	to := pt{3, float64(c.h) / 2}
	for i := 3; i >= 1; i-- {
		back := cubic(from, c1, c2, to, clamp01(t-float64(i)*0.035))
		x, y := round(back.x), round(back.y)
		if c.empty(x, y) {
			c.put(x, y, "·", &StyleDim)
		}
	}
	at := cubic(from, c1, c2, to, t)
	x, y := round(at.x), int(math.Max(0, math.Min(float64(c.h-1), math.Round(at.y))))
	c.put(x, y, beeGlyph, nil)
}

// revealScene plays the swarm on stdout and reports whether it left the still banner on
// screen. False means nothing was drawn, or the scene was skipped and erased, and the caller
// prints the still banner itself.
func revealScene(w io.Writer, rows []string) bool {
	cols := platform.TermCols()
	return playScene(context.Background(), w, openingBudget, len(rows), swarmDuration, true,
		func(p float64) []string { return swarmFrame(rows, cols, p) })
}

// typewriterDuration is the tagline's reveal: short, because it is a sentence someone reads.
const typewriterDuration = 120 * time.Millisecond

// typewriterFrame is prefix plus text typed to progress p behind a hot caret; at 1 it is
// prefix plus style.Render(text), the still line.
func typewriterFrame(prefix, text string, style lipgloss.Style, p float64) string {
	if p >= 1 {
		return prefix + style.Render(text)
	}
	runes := []rune(text)
	n := int(easeOutCubic(p) * float64(len(runes)))
	out := prefix + style.Render(string(runes[:n]))
	if n < len(runes) {
		out += heat(1).Render("▌")
	}
	return out
}

// Typewrite prints prefix plus text as one line, typed out when a scene may play.
func (p *Printer) Typewrite(prefix, text string, style lipgloss.Style) {
	p.mu.Lock()
	defer p.mu.Unlock()
	still := prefix + style.Render(text)
	if p.dest() == p.w && ansi.StringWidth(still) < platform.TermCols() &&
		playScene(context.Background(), p.w, openingBudget, 1, typewriterDuration, true,
			func(q float64) []string { return []string{typewriterFrame(prefix, text, style, q)} }) {
		return
	}
	io.WriteString(p.dest(), still+"\n")
}
