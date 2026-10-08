package ui

import (
	"sync/atomic"

	"github.com/charmbracelet/lipgloss"
)

// Helpers for packages that draw their own effects (internal/fx) and need the palette as
// numbers rather than as styles: to interpolate between two stops, to check a contrast, or
// to know when a cache of styles built from the palette has gone stale.

// paletteVersion counts palette rebuilds. initAnim bumps it, and initAnim runs inside every
// InitColor, so every theme switch and every colour-profile change moves it.
var paletteVersion atomic.Uint64

// PaletteVersion changes whenever the palette or the colour profile does. A cache of styles
// derived from the palette is valid exactly as long as this number is unchanged.
func PaletteVersion() uint64 { return paletteVersion.Load() }

// Motion reports whether a wide, continuous effect may be drawn: AnimEnabled with a slow
// link taken into account. Glyph-sized effects should keep asking AnimEnabled alone.
func Motion() bool { return motion() }

// Hex resolves an adaptive colour to the #rrggbb it renders as against the background in
// force: the theme's own when it paints one, the terminal's otherwise.
func Hex(c lipgloss.AdaptiveColor) string { return adaptiveHex(c) }

// Background is the colour effects are drawn on: the theme's background when it paints one,
// otherwise a typical dark or light terminal. Use it to blend a glow toward nothing.
func Background() string { return candyBackground() }

// Mix blends two #rrggbb colours in sRGB, frac 0 giving a and 1 giving b.
func Mix(a, b string, frac float64) string { return mix(a, b, frac) }

// Contrast is the WCAG contrast ratio between two #rrggbb colours, 1 to 21.
func Contrast(a, b string) float64 { return contrastRatio(a, b) }

// Luminance is the WCAG relative luminance of a #rrggbb colour, 0 for black and 1 for white.
func Luminance(hex string) float64 { return relLuminance(hex) }

// RampRest is the index of the ramp stop that equals the accent: the resting shade every
// animated surface returns to.
func RampRest(n int) int {
	if n <= 1 {
		return 0
	}
	return int(fracRest*float64(n-1) + 0.5)
}
