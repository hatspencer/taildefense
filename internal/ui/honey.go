package ui

import (
	"math"
	"strings"
	"time"
)

// Honey flowing in the progress line.
//
// An operation with no total gets a short pool of honey beside its spinner: eight cells of
// rising and falling level, a slow wave running through them, and one drop falling from the
// front. It is drawn only where animation is on, so the plain progress line is unchanged.

const honeyFlowWidth = 8

// honeyLevels are the bar heights, lowest first.
var honeyLevels = []rune("▁▂▃▄▅▆▇█")

// HoneyFlow is the indeterminate honey bar at elapsed, or "" with animation off.
func HoneyFlow(elapsed time.Duration) string {
	if !AnimEnabled() {
		return ""
	}
	return honeyFlowAt(elapsed)
}

// honeyFlowAt is HoneyFlow without the gate. Exactly honeyFlowWidth cells, always: the label
// after it must not move.
func honeyFlowAt(elapsed time.Duration) string {
	styles, _ := candyRamp()
	hot := len(styles) - 1
	t := elapsed.Seconds()
	var b strings.Builder
	for i := 0; i < honeyFlowWidth; i++ {
		lvl := (math.Sin(float64(i)*0.85-t*5.5) + 1) / 2
		lvl = 0.25 + 0.75*lvl
		g := honeyLevels[min(len(honeyLevels)-1, int(lvl*float64(len(honeyLevels))))]
		b.WriteString(styles[round(lvl*float64(hot))].Render(string(g)))
	}
	return b.String()
}
