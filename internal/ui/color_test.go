package ui

import (
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
)

// forceProfile turns colour on with the parent's profile p ("truecolor", "256" or "16") on a
// dark background, the way a captured child or `td frame` gets it.
func forceProfile(t *testing.T, p string) {
	t.Helper()
	t.Setenv("NO_COLOR", "")
	t.Setenv(EnvForceColor, "1")
	t.Setenv(EnvColorProfile, p)
	t.Setenv(EnvDarkBackground, "1")
	InitColor(false)
	t.Cleanup(func() {
		t.Setenv(EnvForceColor, "")
		t.Setenv(EnvColorProfile, "")
		t.Setenv(EnvDarkBackground, "")
		InitColor(false)
	})
}

// The picks on lesser terminals are the ones td made before Lip Gloss v2, whose own table
// turns the bright cyan into blue among others. Each pair here was read off the old binary's
// output.
func TestColourPicksPerProfile(t *testing.T) {
	for _, c := range []struct {
		hex     string
		ansi16  int
		ansi256 int
	}{
		{"#4ade80", 10, 78},  // green
		{"#f87171", 9, 203},  // red
		{"#fb923c", 9, 209},  // orange, the warning
		{"#22d3ee", 14, 45},  // cyan
		{"#60a5fa", 12, 75},  // blue
		{"#9ca3af", 7, 145},  // grey
		{"#f9fafb", 15, 231}, // text
		{"#a78bfa", 13, 141}, // the default accent
		{"#fbbf24", 11, 0},   // honey's amber, yellow and not red
	} {
		if got := convert(colorprofile.ANSI, c.hex); got != ansi.BasicColor(c.ansi16) {
			t.Errorf("%s on 16 colours: %v, want %d", c.hex, got, c.ansi16)
		}
		if c.ansi256 != 0 {
			if got := convert(colorprofile.ANSI256, c.hex); got != ansi.IndexedColor(c.ansi256) {
				t.Errorf("%s on 256 colours: %v, want %d", c.hex, got, c.ansi256)
			}
		}
		if got := convert(colorprofile.TrueColor, c.hex); got != lipgloss.Color(c.hex) {
			t.Errorf("%s on truecolor: %v", c.hex, got)
		}
	}
}

// The bytes a style writes under each profile.
func TestStylesRenderPerProfile(t *testing.T) {
	for _, c := range []struct{ profile, want string }{
		{"truecolor", "\x1b[38;2;34;211;238mINFO\x1b[m"},
		{"256", "\x1b[38;5;45mINFO\x1b[m"},
		{"16", "\x1b[96mINFO\x1b[m"},
	} {
		t.Run(c.profile, func(t *testing.T) {
			forceProfile(t, c.profile)
			if got := StyleInfo.Render("INFO"); got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

// With colour off there are no escapes at all, not even bold or reverse video, so a
// transcript piped anywhere is plain text exactly as before.
func TestColourOffIsPlainText(t *testing.T) {
	t.Setenv(EnvForceColor, "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	for name, s := range map[string]string{
		"pass": StylePass.Render("x"), "bold": StyleBold.Render("x"), "selected": StyleSelected.Render("x"),
		"badge": StyleBadge.Render("x"), "brand": StyleBrand.Render("x"), "surface": StyleSurfaceBold.Render("x"),
		"ramp": rampStyles[0].Render("x"), "colour": newStyle().Foreground(Color("#ff0000")).Render("x"),
	} {
		if s != "x" {
			t.Errorf("%s renders %q with colour off", name, s)
		}
	}
	if c := Color("#ff0000"); c != (lipgloss.NoColor{}) {
		t.Errorf("Color with colour off is %v", c)
	}
}

// The launcher renders with the profile every line outside it was printed with, and with
// colour off with one that would strip colour too, should a style carry any.
func TestProfile(t *testing.T) {
	for p, want := range map[string]colorprofile.Profile{
		"truecolor": colorprofile.TrueColor, "256": colorprofile.ANSI256, "16": colorprofile.ANSI,
	} {
		t.Run(p, func(t *testing.T) {
			forceProfile(t, p)
			if got := Profile(); got != want {
				t.Errorf("Profile() = %v, want %v", got, want)
			}
		})
	}
	t.Setenv(EnvForceColor, "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })
	if got := Profile(); got != colorprofile.ASCII {
		t.Errorf("colour off: Profile() = %v, want ASCII", got)
	}
}

func TestBackgroundFallbacks(t *testing.T) {
	for v, dark := range map[string]bool{"15;0": true, "0;15": false, "0;default;7": false, "default;default": true, "": true} {
		if got := isDark(colorFGBG(v)); got != dark {
			t.Errorf("COLORFGBG=%q: dark %v, want %v", v, got, dark)
		}
	}
}
