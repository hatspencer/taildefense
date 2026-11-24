package ui

// Helpers for packages that draw their own effects (internal/tui) and need the palette as
// numbers rather than as styles, for example to interpolate between two stops.

// Motion reports whether a wide, continuous effect may be drawn: AnimEnabled with a slow
// link taken into account. Glyph-sized effects should keep asking AnimEnabled alone.
func Motion() bool { return motion() }

// Hex resolves an adaptive colour to the #rrggbb it renders as against the background in
// force: the theme's own when it paints one, the terminal's otherwise.
func Hex(c AdaptiveColor) string { return adaptiveHex(c) }

// Background is the colour effects are drawn on: the theme's background when it paints one,
// otherwise a typical dark or light terminal. Use it to blend a glow toward nothing.
func Background() string { return candyBackground() }

// Mix blends two #rrggbb colours in sRGB, frac 0 giving a and 1 giving b.
func Mix(a, b string, frac float64) string { return mix(a, b, frac) }

// RampRest is the index of the ramp stop that equals the accent: the resting shade every
// animated surface returns to.
func RampRest(n int) int {
	if n <= 1 {
		return 0
	}
	return int(fracRest*float64(n-1) + 0.5)
}
