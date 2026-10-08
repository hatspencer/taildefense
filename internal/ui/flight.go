package ui

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"
)

// Lessons flying into steering.
//
// After a promote that wrote something, the queue empties on screen: each promoted rule leaves
// the queue on the left and arcs along a quadratic Bezier into the steering cell it landed in
// on the right, and the cell caps hot when it arrives. The first rule is carried by the bee.
// The rules leave in the order the report listed them, so the picture agrees with the text
// above it.

// Flight is one steering file and how many rules landed in it.
type Flight struct {
	Target string
	Rules  int
}

const (
	flightDuration = 400 * time.Millisecond
	flightMaxCells = 5
	flightMaxRules = 14
	// flightAir is the share of the scene one rule spends in the air.
	flightAir = 0.34
)

// LessonFlight plays the flight for the files a promote wrote.
func LessonFlight(ctx context.Context, flights []Flight) { lessonFlightTo(Std.w, ctx, flights) }

func lessonFlightTo(w io.Writer, ctx context.Context, flights []Flight) {
	flights = trimFlights(flights)
	if len(flights) == 0 {
		return
	}
	cols := termWidthOr(80)
	h := flightHeight(flights)
	playScene(ctx, w, closingBudget, h, flightDuration, false, func(q float64) []string {
		return flightFrame(flights, cols, q)
	})
}

func trimFlights(in []Flight) []Flight {
	var out []Flight
	for _, f := range in {
		if f.Rules > 0 && len(out) < flightMaxCells {
			out = append(out, Flight{Target: filepath.Base(f.Target), Rules: f.Rules})
		}
	}
	return out
}

func flightHeight(f []Flight) int { return max(len(f), 2) + 2 }

// flightFrame renders the flight at progress q.
func flightFrame(flights []Flight, cols int, q float64) []string {
	h := flightHeight(flights)
	nameW := 0
	for _, f := range flights {
		nameW = max(nameW, len(f.Target))
	}
	nameW = min(nameW, 30)
	// The right column is as wide as the longest name or the closing line, whichever is wider.
	colW := max(nameW, 14) + 8
	cw := min(cols, 2+flightMaxRules+30+colW)
	cellX := cw - colW
	c := newCanvas(cw, h)
	styles, _ := candyRamp()
	hot := len(styles) - 1

	// Each rule's launch slot and destination.
	type rule struct{ target, idx int }
	var rules []rule
	for t, f := range flights {
		for i := 0; i < f.Rules && len(rules) < flightMaxRules; i++ {
			rules = append(rules, rule{t, len(rules)})
		}
	}
	n := len(rules)
	queueY := h / 2
	landed := make([]int, len(flights))
	lastLand := make([]float64, len(flights))

	c.text(2, h-1, "queue", &StyleDim)
	for _, r := range rules {
		launch := 0.03 + (1-flightAir-0.08)*float64(r.idx)/float64(max(n, 1))
		land := launch + flightAir
		from := pt{float64(2 + r.idx), float64(queueY)}
		to := pt{float64(cellX), float64(1 + r.target)}
		switch {
		case q < launch:
			c.put(int(from.x), int(from.y), "◆", &StyleAccent)
		case q < land:
			t := easeInOut((q - launch) / flightAir)
			ctrl := pt{(from.x + to.x) / 2, -1.5 - 2*hashf(uint64(r.idx)+0xf1)}
			at := quad(from, ctrl, to, t)
			for k := 1; k <= 3; k++ {
				back := quad(from, ctrl, to, clamp01(t-float64(k)*0.05))
				if x, y := round(back.x), round(back.y); c.empty(x, y) {
					c.put(x, y, "·", &StyleDim)
				}
			}
			x, y := round(at.x), round(at.y)
			if r.idx == 0 {
				c.put(x, y, beeGlyph, nil)
			} else {
				c.put(x, y, "◆", &styles[round(t*float64(hot))])
			}
		default:
			landed[r.target]++
			lastLand[r.target] = land
		}
	}

	for t, f := range flights {
		y := 1 + t
		st := &StyleDim
		glyph := "⬡"
		if landed[t] > 0 {
			glyph = "⬢"
			st = &StyleAccent
			if age := (q - lastLand[t]) / 0.15; age < 1 {
				st = &styles[round((1-age)*float64(hot))]
			}
		}
		c.put(cellX, y, glyph, st)
		name := f.Target
		if len(name) > nameW {
			name = name[:nameW-1] + "…"
		}
		c.text(cellX+2, y, name, &StyleDim)
		if landed[t] > 0 {
			c.text(cellX+3+len(name), y, fmt.Sprintf("+%d", landed[t]), &StylePass)
		}
	}
	if q >= 0.97 {
		total := 0
		for _, l := range landed {
			total += l
		}
		c.text(cellX, h-1, strings.TrimSpace(fmt.Sprintf("✔ %d into steering", total)), &StylePass)
	}
	return c.rows()
}
