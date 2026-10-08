package ui

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// The default theme is the one in force when nothing has been chosen, and it is taildefense's
// own: terminal-following, violet accent, a ramp that drifts into wisp cyan. Someone who never
// passes --theme sees the tool's own colour, and `default` still names it.
func TestDefaultThemeIsTaildefense(t *testing.T) {
	if got := ActiveTheme().Name; got != DefaultTheme || DefaultTheme != "taildefense" {
		t.Fatalf("active theme at startup is %q, want %q", got, "taildefense")
	}
	if ColorAccent.Light != "#6d28d9" || ColorAccent.Dark != "#a78bfa" {
		t.Errorf("default accent is %+v, want the violet pair", ColorAccent)
	}
	if names := ThemeNames(); names[0] != DefaultTheme {
		t.Errorf("Themes() lists %v; the default must come first", names)
	}
	if th, ok := LookupTheme("Default"); !ok || th.Name != DefaultTheme {
		t.Errorf("`default` resolves to %q, want the default theme", th.Name)
	}
	if ActiveTheme().Full() {
		t.Error("the default theme paints the terminal; it must follow it")
	}
}

// taildefense's own themes exist, and the hive themes they displaced are still there under
// their new names, so nothing a hive user could pick has gone.
func TestTaildefenseThemesAndHiveThemesAreBothAvailable(t *testing.T) {
	for _, name := range []string{"taildefense", "wisp", "ember", "honey", "cinder", "marko", "forest", "regal"} {
		if _, ok := LookupTheme(name); !ok {
			t.Errorf("theme %q is missing", name)
		}
	}
	for _, name := range []string{"wisp", "ember"} {
		if th, _ := LookupTheme(name); !th.Full() {
			t.Errorf("%s must own its background", name)
		}
	}
}

// The ramp of a terminal-following theme is hand written, and a sweep reads as motion only if
// brightness climbs the whole way on a dark terminal. The generated ramps are covered by
// TestGeneratedRampIsMonotonicAndAnchored; this holds the hand-written dark halves to the same.
func TestHandWrittenDarkRampsClimb(t *testing.T) {
	for _, name := range []string{"taildefense"} {
		th, _ := LookupTheme(name)
		for i := 1; i < len(th.Ramp); i++ {
			if luminance(th.Ramp[i].Dark) <= luminance(th.Ramp[i-1].Dark) {
				t.Errorf("%s: dark stop %d (%s) is not brighter than %d (%s)",
					name, i, th.Ramp[i].Dark, i-1, th.Ramp[i-1].Dark)
			}
			if luminance(th.Ramp[i].Light) <= luminance(th.Ramp[i-1].Light) {
				t.Errorf("%s: light stop %d (%s) is not brighter than %d (%s)",
					name, i, th.Ramp[i].Light, i-1, th.Ramp[i-1].Light)
			}
		}
	}
}

// Text on the accent block holds the body ratio on both sides of a terminal-following theme
// too: the badge is the one thing that cannot be read from context, whatever paints the
// background behind it.
func TestOnAccentIsLegibleOnTerminalFollowingThemes(t *testing.T) {
	for _, th := range Themes() {
		if th.Full() {
			continue
		}
		for _, pair := range [][2]string{{th.OnAccent.Light, th.Accent.Light}, {th.OnAccent.Dark, th.Accent.Dark}} {
			if got := contrast(pair[0], pair[1]); got < 4.5 {
				t.Errorf("%s: OnAccent %s on Accent %s is %.2f:1, want 4.5:1", th.Name, pair[0], pair[1], got)
			}
		}
	}
}

// Every theme has to satisfy the same structural rules, because every animation is
// written against them: a ramp of the length the fractions were tuned for, whose resting
// stop is the accent exactly on both backgrounds.
func TestEveryThemeIsWellFormed(t *testing.T) {
	for _, th := range Themes() {
		if th.Name != strings.ToLower(th.Name) || strings.ContainsAny(th.Name, " \t") {
			t.Errorf("%q: a theme name is typed, so it must be one lower-case word", th.Name)
		}
		if th.Summary == "" {
			t.Errorf("%s: no summary", th.Name)
		}
		if len(th.Ramp) != 11 {
			t.Errorf("%s: ramp has %d stops, want 11", th.Name, len(th.Ramp))
			continue
		}
		rest := th.Ramp[int(fracRest*float64(len(th.Ramp)-1)+0.5)]
		if rest != th.Accent {
			t.Errorf("%s: the resting ramp stop is %+v, the accent is %+v", th.Name, rest, th.Accent)
		}
		for _, c := range append([]lipgloss.AdaptiveColor{th.Accent, th.OnAccent, th.Link}, th.Ramp...) {
			for _, hex := range []string{c.Light, c.Dark} {
				if len(hex) != 7 || hex[0] != '#' {
					t.Errorf("%s: %q is not a #rrggbb colour", th.Name, hex)
				}
			}
		}
	}
}

// Switching theme rebuilds the styles, so the wordmark, the badge and the link change
// colour without anything else having to be told. Switching back restores the default
// exactly, which is what lets a test — or a session — flip between the two.
func TestSetThemeRebuildsTheStyles(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() { _ = SetTheme(DefaultTheme) })

	before := StyleBrand.Render("HIVE")
	link := StyleLink.Render("Jump to kafbat")
	badge := StyleBadge.Render(" 1 ")

	if err := SetTheme("Marko"); err != nil {
		t.Fatalf("case-insensitive lookup failed: %v", err)
	}
	if ActiveTheme().Name != "marko" {
		t.Fatalf("active theme is %q after SetTheme", ActiveTheme().Name)
	}
	if got := StyleBrand.Render("HIVE"); got == before {
		t.Error("the brand style did not change with the theme")
	}
	if got := StyleLink.Render("Jump to kafbat"); got == link {
		t.Error("the link style did not change with the theme")
	}
	if got := StyleBadge.Render(" 1 "); got == badge {
		t.Error("the badge style did not change with the theme")
	}
	if AccentRamp[rampIdx(fracRest)] != ColorAccent {
		t.Error("the ramp was not rebuilt from the new theme")
	}

	if err := SetTheme(DefaultTheme); err != nil {
		t.Fatal(err)
	}
	if got := StyleBrand.Render("HIVE"); got != before {
		t.Error("switching back did not restore the default brand style")
	}
}

// An unknown name is an error that lists the choices, and leaves the theme alone: a typo
// in the preferences file must not blank the accent.
func TestUnknownThemeIsRefusedAndNamesTheChoices(t *testing.T) {
	err := SetTheme("neon")
	if err == nil {
		t.Fatal("SetTheme accepted an unknown theme")
	}
	for _, name := range ThemeNames() {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the error %q does not name theme %q", err, name)
		}
	}
	if ActiveTheme().Name != DefaultTheme {
		t.Errorf("a refused SetTheme changed the active theme to %q", ActiveTheme().Name)
	}
}

// The animation preference is the remembered `config animate off`, and it gates every
// effect through the same guard the environment variable does.
func TestAnimatePreferenceGatesEveryEffect(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() { SetAnimate(true) })

	SetAnimate(false)
	if AnimateSetting() {
		t.Fatal("AnimateSetting still reports on")
	}
	if AnimEnabled() {
		t.Fatal("animation is enabled with the preference off")
	}
	// The pulse holds the accent rather than moving through the ramp.
	if a, b := Pulse(0), Pulse(400*1e6); a.Render("x") != b.Render("x") {
		t.Error("Pulse still moves with animation off")
	}
	SetAnimate(true)
	if !AnimateSetting() {
		t.Error("AnimateSetting did not come back on")
	}
}

// Swatch is a preview and must not depend on the active theme: the listing shows every
// theme in its own colours, whichever one is in force.
func TestSwatchShowsEachThemeInItsOwnColours(t *testing.T) {
	forceTruecolor(t)
	seen := map[string]bool{}
	for _, th := range Themes() {
		s := Swatch(th)
		if !strings.Contains(s, th.Name) {
			t.Errorf("the swatch for %s does not carry its name: %q", th.Name, s)
		}
		if seen[s] {
			t.Errorf("two themes render the same swatch: %q", s)
		}
		seen[s] = true
	}
}

// A full theme names every colour. The fallback to the shared palette exists for the two
// terminal-following themes, and it is a trap for a full one: a missing Fg on a near-black
// background silently falls back to an adaptive pair that could resolve either way, so the
// text colour would be decided by the terminal the theme just painted over.
func TestAFullThemeNamesEveryColour(t *testing.T) {
	for _, th := range Themes() {
		if !th.Full() {
			continue
		}
		for name, c := range map[string]lipgloss.AdaptiveColor{
			"Fg": th.Fg, "Dim": th.Dim, "Surface": th.Surface,
			"Pass": th.Pass, "Fail": th.Fail, "Warn": th.Warn, "Info": th.Info, "Step": th.Step,
			"Accent": th.Accent, "OnAccent": th.OnAccent, "Link": th.Link,
		} {
			if c == (lipgloss.AdaptiveColor{}) {
				t.Errorf("%s: %s is unset, so it would fall back to an adaptive pair", th.Name, name)
			}
		}
		// Pinned, not adaptive: the theme owns the background, so there is nothing left to
		// adapt to and a pair with two different sides means one of them is unreachable.
		for name, c := range map[string]lipgloss.AdaptiveColor{
			"Bg": th.Bg, "Fg": th.Fg, "Accent": th.Accent,
		} {
			if c.Light != c.Dark {
				t.Errorf("%s: %s is an adaptive pair (%s/%s) on a theme that owns its background",
					th.Name, name, c.Light, c.Dark)
			}
		}
	}
}

// A terminal-following theme owns no background, and therefore must name no colour that only
// makes sense against one. This is the constraint that used to apply to every theme and now
// applies to two: the moment such a theme named a text colour, it would be guessing what that
// text sits on.
func TestATerminalFollowingThemeNamesNoBackgroundColours(t *testing.T) {
	for _, th := range Themes() {
		if th.Full() {
			continue
		}
		for name, c := range map[string]lipgloss.AdaptiveColor{
			"Fg": th.Fg, "Dim": th.Dim, "Surface": th.Surface,
			"Pass": th.Pass, "Fail": th.Fail, "Warn": th.Warn, "Info": th.Info, "Step": th.Step,
		} {
			if c != (lipgloss.AdaptiveColor{}) {
				t.Errorf("%s follows the terminal but sets %s", th.Name, name)
			}
		}
	}
}

// Everything a full theme draws has to be legible on the background it paints.
//
// This is the test that earns its place: "white and gold" is the obvious thing to want and
// the easiest to get wrong, because the gold every dark theme uses is #fbbf24 and on ivory
// that is a contrast ratio near 1.7 — visible as a shape, unreadable as text. Body text is
// held to the WCAG AA ratio for normal text; the accent, the status colours and the dim shade
// to the large-text ratio, since they are always bold, a glyph, or both.
func TestFullThemeContrastIsLegible(t *testing.T) {
	const (
		body = 4.5
		mark = 3.0
	)
	for _, th := range Themes() {
		if !th.Full() {
			continue
		}
		bg := th.Bg.Dark
		check := func(name, hex string, want float64) {
			if got := contrast(hex, bg); got < want {
				t.Errorf("%s: %s (%s) on %s is %.2f:1, want %.2f:1", th.Name, name, hex, bg, got, want)
			}
		}
		check("Fg", th.Fg.Dark, body)
		check("Dim", th.Dim.Dark, mark)
		check("Accent", th.Accent.Dark, mark)
		check("Link", th.Link.Dark, mark)
		check("Pass", th.Pass.Dark, mark)
		check("Fail", th.Fail.Dark, mark)
		check("Warn", th.Warn.Dark, mark)
		check("Info", th.Info.Dark, mark)
		check("Step", th.Step.Dark, mark)
		// Text on a filled accent block: the badge, the active tab, the brand segment of a
		// bar. Held to the body ratio because a badge is the one thing that cannot be read
		// from context.
		if got := contrast(th.OnAccent.Dark, th.Accent.Dark); got < body {
			t.Errorf("%s: OnAccent on Accent is %.2f:1, want %.2f:1", th.Name, got, body)
		}
		// A surface has to read as a bar without a rule under it, so it must differ from the
		// background — and not so much that it reads as a second background.
		if got := contrast(th.Surface.Dark, bg); got < 1.05 || got > 3.0 {
			t.Errorf("%s: Surface against Bg is %.2f:1, want between 1.05 and 3.00", th.Name, got)
		}
	}
}

// The five status slots have to be five colours, not three and two near-misses. A verdict is
// read at a glance in a scrolling transcript, and INFO and WARN were once both ANSI 3
// differing only by bold, which is the mistake this guards.
//
// Measured as a difference in hue rather than a distance in RGB. RGB distance was the first
// version and it was the wrong metric: it failed Catppuccin's cyan against its blue, which are
// plainly two colours, while a pastel palette can put two genuinely different hues within a
// short RGB hop. Hue is what the eye is actually sorting these by.
func TestStatusSlotsAreDistinguishableWithinATheme(t *testing.T) {
	for _, th := range Themes() {
		if !th.Full() {
			continue
		}
		slots := map[string]string{
			"Pass": th.Pass.Dark, "Fail": th.Fail.Dark, "Warn": th.Warn.Dark,
			"Info": th.Info.Dark, "Step": th.Step.Dark,
		}
		for an, a := range slots {
			for bn, b := range slots {
				if an >= bn {
					continue
				}
				if d := hueGap(a, b); d < 20 {
					t.Errorf("%s: %s (%s) and %s (%s) are %.0f degrees apart, want 20",
						th.Name, an, a, bn, b, d)
				}
			}
		}
	}
}

// The ramp is generated for every full theme, so the resting stop cannot drift from the
// accent — but the generator itself can be wrong, and it is the one piece of arithmetic here.
func TestGeneratedRampIsMonotonicAndAnchored(t *testing.T) {
	r := ramp("#052e1c", "#34d399", "#ecfdf5")
	if len(r) != 11 {
		t.Fatalf("ramp has %d stops, want 11", len(r))
	}
	if r[0].Dark != "#052e1c" || r[10].Dark != "#ecfdf5" {
		t.Errorf("ramp ends are %s and %s, want the two anchors", r[0].Dark, r[10].Dark)
	}
	if r[rampIdx(fracRest)].Dark != "#34d399" {
		t.Errorf("the resting stop is %s, want the accent", r[rampIdx(fracRest)].Dark)
	}
	// Brightness climbing all the way is what makes a sweep read as motion in one direction
	// rather than as a flicker.
	for i := 1; i < len(r); i++ {
		if luminance(r[i].Dark) <= luminance(r[i-1].Dark) {
			t.Errorf("stop %d (%s) is not brighter than stop %d (%s)", i, r[i].Dark, i-1, r[i-1].Dark)
		}
	}
}

// contrast is the WCAG relative-luminance ratio between two #rrggbb colours, 1 for identical
// and 21 for black against white.
func contrast(a, b string) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// luminance is WCAG relative luminance: sRGB channels linearised, then weighted for how
// bright the eye finds each one.
func luminance(hex string) float64 {
	r, g, b := rgb(hex)
	lin := func(v int) float64 {
		c := float64(v) / 255
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
}

// hueGap is the shorter way round the colour wheel between two colours, in degrees.
func hueGap(a, b string) float64 {
	d := math.Abs(hue(a) - hue(b))
	if d > 180 {
		d = 360 - d
	}
	return d
}

// hue is the HSV hue of a #rrggbb colour, in degrees. A grey has no hue and yields 0, which is
// fine here: no status slot in any theme is grey.
func hue(hex string) float64 {
	ri, gi, bi := rgb(hex)
	r, g, b := float64(ri)/255, float64(gi)/255, float64(bi)/255
	maxc := math.Max(r, math.Max(g, b))
	minc := math.Min(r, math.Min(g, b))
	d := maxc - minc
	if d == 0 {
		return 0
	}
	var h float64
	switch maxc {
	case r:
		h = math.Mod((g-b)/d, 6)
	case g:
		h = (b-r)/d + 2
	default:
		h = (r-g)/d + 4
	}
	h *= 60
	if h < 0 {
		h += 360
	}
	return h
}

// A full theme's swatch is one filled row, edge to edge. This is the listing's whole job: the
// background is most of what distinguishes two themes, and a row that only tints a few glyphs
// shows the least important part of the choice.
func TestSwatchOfAFullThemeIsPaintedEdgeToEdge(t *testing.T) {
	forceTruecolor(t)
	// A wide terminal, so the summary is not the thing under test here: at 80 columns the
	// row genuinely runs out of room and clips it, which is the intended trade and has its
	// own test below.
	t.Setenv("COLUMNS", "160")
	for _, th := range Themes() {
		if !th.Full() {
			continue
		}
		s := Swatch(th)
		r, g, b := rgb(th.Bg.Dark)
		want := fmt.Sprintf("48;2;%d;%d;%d", r, g, b)
		if !strings.Contains(s, want) {
			t.Errorf("%s: the swatch never sets the theme background (%s)", th.Name, th.Bg.Dark)
		}
		if got := lipgloss.Width(s); got != swatchWidth() {
			t.Errorf("%s: the swatch is %d cells, want %d", th.Name, got, swatchWidth())
		}
		if !strings.Contains(s, th.Summary) {
			t.Errorf("%s: the summary is not inside the row", th.Name)
		}
	}
}

// On a terminal too narrow for everything, the summary is cut and the row still measures
// exactly one row. Uncut it would wrap, and a wrapped block of background colour reads as two
// broken themes rather than as one that did not fit.
func TestSwatchClipsRatherThanWraps(t *testing.T) {
	forceTruecolor(t)
	th, ok := LookupTheme("regal")
	if !ok {
		t.Fatal("regal is missing")
	}
	for _, cols := range []string{"60", "80", "100", "300"} {
		t.Setenv("COLUMNS", cols)
		s := Swatch(th)
		if got := lipgloss.Width(s); got != swatchWidth() {
			t.Errorf("at COLUMNS=%s the swatch is %d cells, want %d", cols, got, swatchWidth())
		}
		if strings.Contains(s, "\n") {
			t.Errorf("at COLUMNS=%s the swatch wrapped", cols)
		}
	}
}

// A theme that follows the terminal is drawn without a filled row, and the difference is the
// point: nothing outside its accent badge carries a background, so the gap in the listing is
// what tells you it brings none of its own.
func TestSwatchOfATerminalFollowingThemeIsNotFilled(t *testing.T) {
	forceTruecolor(t)
	for _, th := range Themes() {
		if th.Full() {
			continue
		}
		s := Swatch(th)
		if got := lipgloss.Width(s); got > swatchWidth() {
			t.Errorf("%s: the swatch is %d cells, wider than the row", th.Name, got)
		}
		// The badge is the only background: it is a block of the accent. Everything after it
		// must be foreground colour on whatever the terminal already has.
		_, after, ok := strings.Cut(s, "\x1b[0m")
		if !ok {
			t.Fatalf("%s: the swatch has no reset after the badge: %q", th.Name, s)
		}
		if strings.Contains(after, "48;2;") {
			t.Errorf("%s: the swatch paints a background outside its badge", th.Name)
		}
	}
}

// The swatch is a preview and must not depend on the active theme, or the listing would show
// fifteen variations of whichever theme happens to be in force.
//
// Full themes only. A theme that follows the terminal has no colours of its own to preview, so
// its swatch is drawn from the shared adaptive palette against the current background
// assumption — and that assumption is exactly what a full theme changes. Its swatch shifting is
// the same behaviour it would have in use, not a bug in the preview.
func TestSwatchDoesNotDependOnTheActiveTheme(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() { _ = SetTheme(DefaultTheme) })

	before := map[string]string{}
	for _, th := range Themes() {
		if th.Full() {
			before[th.Name] = Swatch(th)
		}
	}
	if err := SetTheme("regal"); err != nil {
		t.Fatal(err)
	}
	for _, th := range Themes() {
		if !th.Full() {
			continue
		}
		if got := Swatch(th); got != before[th.Name] {
			t.Errorf("%s: the swatch changed when the active theme did", th.Name)
		}
	}
}
