package ui

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"taildefense/internal/platform"
)

// Themes.
//
// A theme is the whole palette, not an accent: the background the terminal is painted, the
// text drawn on it, the surface the bars sit on, the dim shade that separates supporting
// detail from findings, the five status colours, the accent, and the ramp the animations
// move through.
//
// Two kinds of theme live here and the difference matters.
//
// "taildefense", "honey" and "marko" follow the terminal. They set no background, and every colour they
// do set is an adaptive light/dark pair, so they inherit whatever scheme the person already
// had open. That was the only kind of theme this file had, and it is why the palette was an
// accent and nothing else: a theme that does not own the background cannot safely name a
// text colour, because it does not know what the text will sit on.
//
// Every other theme owns its background. It paints the terminal through OSC 11 (see
// background.go), pins every colour to one value rather than a pair, and declares Dark so
// that adaptive colours elsewhere in the program resolve against the theme's background
// instead of the terminal's. Owning the background is what makes a real theme possible: once
// the background is known, the text colour, the surfaces and the status shades can all be
// tuned to it.
//
// The status vocabulary keeps its meaning in every theme: PASS is the success slot, FAIL the
// failure slot, and so on, always in that role, always behind the same glyph. What a theme
// may change is the shade, so that a green on a near-black forest background is not the same
// green as on white paper. It may not change which slot means what. A transcript pasted into
// a ticket therefore still reads correctly for whoever opens it, and the glyph carries it on
// a sixteen-colour terminal and under NO_COLOR where the shade is gone anyway.
//
// One consequence of a theme owning its accent hue: in a green theme the accent and PASS are
// both green, and in a red theme the accent and FAIL are both red. That is inherent to
// wanting a green theme rather than an oversight. The glyphs are what distinguish them, which
// is the same thing that makes the palette survive a terminal with no colour at all.

// Theme is one colour scheme.
//
// A zero-valued colour means "not set by this theme": the shared palette value is used
// instead. That is how the two terminal-following themes get a full palette without naming
// a background they do not own.
type Theme struct {
	// Name is what the user types: lower case, one word.
	Name string
	// Summary is the one-line description in `taildefense themes`.
	Summary string

	// Bg is the terminal background. Zero for a theme that follows the terminal's own,
	// and the flag that tells everything else which kind of theme this is: Full reports it.
	Bg lipgloss.AdaptiveColor
	// Dark is whether Bg is a dark background. Only meaningful when Bg is set, and it is
	// what InitColor hands to lipgloss.SetHasDarkBackground so that every adaptive colour
	// in the rest of the program resolves against the theme rather than the terminal.
	Dark bool
	// Fg is body text, Dim is supporting detail, Surface is the background of the bars
	// that frame a full-screen view.
	Fg      lipgloss.AdaptiveColor
	Dim     lipgloss.AdaptiveColor
	Surface lipgloss.AdaptiveColor

	// The status slots. Their meaning is fixed; only the shade belongs to the theme.
	Pass lipgloss.AdaptiveColor
	Fail lipgloss.AdaptiveColor
	Warn lipgloss.AdaptiveColor
	Info lipgloss.AdaptiveColor
	Step lipgloss.AdaptiveColor

	// Accent is the brand colour: the wordmark, the prompt, the active tab, the
	// selected row.
	Accent lipgloss.AdaptiveColor
	// OnAccent is text drawn on top of Accent.
	OnAccent lipgloss.AdaptiveColor
	// Link is the colour of a hyperlink's label, always underlined.
	Link lipgloss.AdaptiveColor
	// Ramp is Accent from its darkest shade to white-hot: what the animations move
	// through. Eleven stops, and the one at fracRest must be Accent exactly on both
	// backgrounds — it is the shade every cell outside a moving highlight is painted in,
	// and a stop that merely resembles the accent makes the whole wordmark change colour
	// the instant a sweep begins. A test pins every theme to that.
	//
	// The two terminal-following themes have hand-tuned ramps. Every other theme builds
	// one with ramp(), which interpolates and therefore cannot get the resting stop wrong.
	Ramp []lipgloss.AdaptiveColor
}

// Full reports whether the theme owns its background, and therefore whether it paints the
// terminal and pins its colours rather than adapting to what is already there.
func (t Theme) Full() bool { return t.Bg != (lipgloss.AdaptiveColor{}) }

// fixed is one colour, the same on any background: what a theme that owns its background
// uses, since there is no longer anything to adapt to.
func fixed(hex string) lipgloss.AdaptiveColor {
	return lipgloss.AdaptiveColor{Light: hex, Dark: hex}
}

// ramp builds the eleven animation stops by interpolating dark to accent over the first
// five and accent to hot over the last seven, sharing the accent stop.
//
// Generated rather than written out, because eleven hand-picked stops per theme is a wall
// of hex in which the one stop that has to be exactly the accent is the easiest to get
// wrong, and getting it wrong makes the whole wordmark change colour when a sweep starts.
// Here that stop is the input, so it cannot drift.
func ramp(dark, accent, hot string) []lipgloss.AdaptiveColor {
	const rest = 4
	out := make([]lipgloss.AdaptiveColor, 11)
	for i := range out {
		switch {
		case i < rest:
			out[i] = fixed(mix(dark, accent, float64(i)/rest))
		case i == rest:
			out[i] = fixed(accent)
		default:
			out[i] = fixed(mix(accent, hot, float64(i-rest)/float64(len(out)-1-rest)))
		}
	}
	return out
}

// mix blends two #rrggbb colours, frac 0 giving a and 1 giving b.
//
// Blended per channel in sRGB rather than in linear light. Linear is the physically correct
// way to mix two colours, and it is the wrong one here: these stops are steps along a
// gradient a terminal will draw, and sRGB steps look evenly spaced to the eye, which is the
// only property that matters for an animation.
func mix(a, b string, frac float64) string {
	ar, ag, ab := rgb(a)
	br, bg, bb := rgb(b)
	blend := func(x, y int) int {
		v := float64(x) + (float64(y)-float64(x))*frac
		switch {
		case v < 0:
			return 0
		case v > 255:
			return 255
		}
		return int(v + 0.5)
	}
	return fmt.Sprintf("#%02x%02x%02x", blend(ar, br), blend(ag, bg), blend(ab, bb))
}

// rgb splits #rrggbb. A malformed value yields black, which is visible in the swatch
// listing rather than silent, and a test renders every theme's ramp.
func rgb(hex string) (int, int, int) {
	if len(hex) != 7 || hex[0] != '#' {
		return 0, 0, 0
	}
	v, err := strconv.ParseInt(hex[1:], 16, 64)
	if err != nil {
		return 0, 0, 0
	}
	return int(v >> 16 & 0xff), int(v >> 8 & 0xff), int(v & 0xff)
}

// DefaultTheme is the theme in force when nothing has been chosen.
const DefaultTheme = "taildefense"

// defaultAlias is accepted by LookupTheme for the default theme, so a remembered
// TAILDEFENSE_THEME=default keeps meaning "whatever the default is".
const defaultAlias = "default"

// themes is every theme by name. A map for lookup; Themes() gives the display order.
var themes = map[string]Theme{
	DefaultTheme: {
		Name:    DefaultTheme,
		Summary: "follows your terminal, violet accent that drifts to wisp cyan",
		// Terminal-following, so it names no text or status colour. Violet rather than cyan
		// for the accent: cyan is INFO, the idle colour on the dashboard, and an accent that
		// matched it would make every selected row read as idle. The ramp is where the cyan
		// lives: it travels violet, periwinkle, sky, cyan, mint-white, so a sweep or a
		// breathing orb drifts into the will-o'-the-wisp glow and back.
		//
		// Violet-700 on light, violet-400 on dark, the same weights the honey theme uses
		// for its amber.
		Accent:   lipgloss.AdaptiveColor{Light: "#6d28d9", Dark: "#a78bfa"},
		OnAccent: lipgloss.AdaptiveColor{Light: "#faf5ff", Dark: "#1e1b4b"},
		// Sky, not the accent: a lavender label next to a lavender selection is not a link.
		Link: lipgloss.AdaptiveColor{Light: "#0369a1", Dark: "#7dd3fc"},
		// The light half climbs through indigo and blue to cyan-600 before it washes out,
		// so on paper the four stops above the accent still hold 3:1 and a sweep reads as
		// colour travelling rather than as ink fading.
		Ramp: []lipgloss.AdaptiveColor{
			{Light: "#1e0b4b", Dark: "#2e1065"},
			{Light: "#2e1065", Dark: "#4c1d95"},
			{Light: "#4c1d95", Dark: "#6d28d9"},
			{Light: "#5b21b6", Dark: "#8b5cf6"},
			{Light: "#6d28d9", Dark: "#a78bfa"}, // fracRest, and Accent exactly
			{Light: "#4f46e5", Dark: "#a5b4fc"},
			{Light: "#2563eb", Dark: "#93c5fd"},
			{Light: "#0284c7", Dark: "#7dd3fc"},
			{Light: "#0891b2", Dark: "#67e8f9"},
			{Light: "#22d3ee", Dark: "#a5f3fc"},
			{Light: "#cffafe", Dark: "#ecfeff"},
		},
	},
	"wisp": {
		Name:    "wisp",
		Summary: "ghostly mint glow on night indigo, the taildefense dark theme",
		Bg:      fixed("#070a18"), Dark: true,
		Fg: fixed("#d7e3f4"), Dim: fixed("#6878a6"), Surface: fixed("#121733"),
		// The accent takes mint, so the status colours step around it: PASS goes to lime
		// rather than green, INFO to sky and STEP to periwinkle, which keeps every verdict a
		// different hue from the glow the whole screen is drawn in.
		Pass: fixed("#a3e635"), Fail: fixed("#fb7185"), Warn: fixed("#fbbf24"),
		Info: fixed("#7dd3fc"), Step: fixed("#a5b4fc"),
		Accent: fixed("#5eead4"), OnAccent: fixed("#032521"), Link: fixed("#c4b5fd"),
		// Anchored in indigo at the cold end, so the dim stops the ambient wisps are drawn
		// in are blue-violet smoke and only the bright half is mint.
		Ramp: ramp("#1b2a6b", "#5eead4", "#f0fdfa"),
	},
	"ember": {
		Name:    "ember",
		Summary: "orange-gold embers on warm charcoal",
		Bg:      fixed("#16110d"), Dark: true,
		Fg: fixed("#f2e6d8"), Dim: fixed("#9a8a78"), Surface: fixed("#251d17"),
		// The accent is orange, so WARN moves up to a clear yellow: waiting is the one state
		// the dashboard must never let blend into the working glow beside it.
		Pass: fixed("#86efac"), Fail: fixed("#fb7185"), Warn: fixed("#fde047"),
		Info: fixed("#67e8f9"), Step: fixed("#a5b4fc"),
		Accent: fixed("#f7a046"), OnAccent: fixed("#1f1006"), Link: fixed("#7dd3fc"),
		Ramp: ramp("#5a2a0c", "#f7a046", "#fff7e6"),
	},
	"honey": {
		Name:    "honey",
		Summary: "follows your terminal, honey amber accent",
		// No background and no text colour: this theme inherits the terminal's scheme and
		// changes the accent, the links and one status shade. A tool that repaints the
		// terminal by default would be the wrong default, so the yellow arrives as an
		// accent rather than as a background — `config theme gold` is the same hue with
		// the background owned.
		//
		// Amber-700 on light, amber-400 on dark. Amber-500 would be the obvious dark
		// pairing and is unreadable on white, which is what the light half is for.
		Accent: lipgloss.AdaptiveColor{Light: "#b45309", Dark: "#fbbf24"},
		// Near-white on the deep amber a light terminal gets, near-black on the pale
		// amber a dark one gets.
		OnAccent: lipgloss.AdaptiveColor{Light: "#fffbeb", Dark: "#1a1408"},
		// Links are blue here, not the accent. Yellow underlined next to an orange WARN
		// is two warm colours one shade apart, which is not two colours; blue is the one
		// hue no status slot and not the accent claims.
		Link: lipgloss.AdaptiveColor{Light: "#1d4ed8", Dark: "#7dd3fc"},
		Ramp: []lipgloss.AdaptiveColor{
			{Light: "#451a03", Dark: "#78350f"},
			{Light: "#6b2c06", Dark: "#92400e"},
			{Light: "#8a3f07", Dark: "#b45309"},
			{Light: "#9c4a08", Dark: "#d97706"},
			{Light: "#b45309", Dark: "#fbbf24"}, // fracRest, and Accent exactly
			{Light: "#d97706", Dark: "#fcd34d"},
			{Light: "#f59e0b", Dark: "#fde68a"},
			{Light: "#fbbf24", Dark: "#fef3c7"},
			{Light: "#fcd34d", Dark: "#fef9e7"},
			{Light: "#fde68a", Dark: "#fffbeb"},
			{Light: "#fffbeb", Dark: "#ffffff"},
		},
	},
	"marko": {
		Name:    "marko",
		Summary: "follows your terminal, scarlet accent, blue links",
		// A vivid scarlet, and the one accent that knowingly sits close to a status
		// colour. Three things keep it apart from FAIL: hue — FAIL is red-600/red-400
		// (#dc2626/#f87171), a duller, pinker red than this; shape — nearly every use of
		// the accent is a filled block while FAIL is foreground text behind a ✘; and the
		// glyph carries the meaning anyway, which is what makes the status vocabulary
		// survive a 16-colour terminal and NO_COLOR.
		Accent: lipgloss.AdaptiveColor{Light: "#e10600", Dark: "#ff3b2f"},
		// Both shades are saturated enough to need help: white on the deep scarlet,
		// near-black on the brighter one a dark theme gets.
		OnAccent: lipgloss.AdaptiveColor{Light: "#ffffff", Dark: "#2a0603"},
		// Blue, not accent. A "Jump to kafbat" label in scarlet three lines above a
		// green PASS read as an error rather than as a link; blue underlined is the
		// convention every reader already has, and STEP is the one status meaning that
		// cannot be confused with a verdict.
		Link: baseBlue,
		// The top stop is deliberately not pure white: a true #ffffff highlight on a red
		// ramp reads as a blown-out pixel rather than as the hot end of the same colour.
		Ramp: []lipgloss.AdaptiveColor{
			{Light: "#7f1d1d", Dark: "#7f1d1d"},
			{Light: "#9c1c1c", Dark: "#9c1c1c"},
			{Light: "#b91c1c", Dark: "#b91c1c"},
			{Light: "#cd110e", Dark: "#dc2b25"},
			{Light: "#e10600", Dark: "#ff3b2f"}, // fracRest, and Accent exactly
			{Light: "#ea2217", Dark: "#ff4a3c"},
			{Light: "#f43f2e", Dark: "#ff5a4a"},
			{Light: "#f75d48", Dark: "#ff7666"},
			{Light: "#fb7c62", Dark: "#ff9382"},
			{Light: "#fdaa98", Dark: "#ffbbaf"},
			{Light: "#ffd9cf", Dark: "#ffe4dc"},
		},
	},

	// The full themes. Each paints its own background, so each names every colour.

	"forest": {
		Name:    "forest",
		Summary: "deep green on near-black bark, emerald accent",
		Bg:      fixed("#071512"), Dark: true,
		Fg: fixed("#d8e9df"), Dim: fixed("#6d9081"), Surface: fixed("#0e2a22"),
		// PASS is a lighter, yellower green than the accent's emerald. They are the same
		// hue family and that is unavoidable in a green theme; the ✔ is what separates
		// them, and STEP moves to indigo so that the one status colour left in the blue
		// half of the wheel does not sit next to the accent either.
		Pass: fixed("#5eeb9b"), Fail: fixed("#f87171"), Warn: fixed("#fbbf24"),
		Info: fixed("#22d3ee"), Step: fixed("#a5b4fc"),
		Accent: fixed("#34d399"), OnAccent: fixed("#042318"), Link: fixed("#7dd3fc"),
		Ramp: ramp("#052e1c", "#34d399", "#ecfdf5"),
	},
	"ocean": {
		Name:    "ocean",
		Summary: "cold blue on deep water, sky accent",
		Bg:      fixed("#061426"), Dark: true,
		Fg: fixed("#d6e6f7"), Dim: fixed("#6d88a6"), Surface: fixed("#0e2942"),
		// INFO stays cyan and STEP moves to indigo, which puts three distinguishable
		// colours in the blue half of the wheel: the accent's blue, cyan, and indigo.
		// Links are the accent here, because on this background a blue link is the accent.
		Pass: fixed("#4ade80"), Fail: fixed("#fb7185"), Warn: fixed("#fbbf24"),
		Info: fixed("#22d3ee"), Step: fixed("#a5b4fc"),
		Accent: fixed("#60a5fa"), OnAccent: fixed("#04162b"), Link: fixed("#60a5fa"),
		Ramp: ramp("#0c2f5e", "#60a5fa", "#eff6ff"),
	},
	"cinder": {
		Name:    "cinder",
		Summary: "hot coal on charred black, red accent",
		Bg:      fixed("#170907"), Dark: true,
		Fg: fixed("#f6ddd6"), Dim: fixed("#9d766c"), Surface: fixed("#2c1410"),
		// The accent and FAIL are both red, which is what a red theme means. FAIL is
		// pushed to rose, pinker and lighter than the accent's true red, and the ✘ is what
		// actually carries it.
		Pass: fixed("#4ade80"), Fail: fixed("#fb7185"), Warn: fixed("#fbbf24"),
		Info: fixed("#67e8f9"), Step: fixed("#c4b5fd"),
		Accent: fixed("#ef4444"), OnAccent: fixed("#1a0605"), Link: fixed("#67e8f9"),
		Ramp: ramp("#7f1d1d", "#ef4444", "#fff1f2"),
	},
	"midnight": {
		Name:    "midnight",
		Summary: "the darkest theme here, cool blue accent, low glare",
		Bg:      fixed("#0b0e14"), Dark: true,
		Fg: fixed("#c8d0e0"), Dim: fixed("#68718a"), Surface: fixed("#161b26"),
		// The one theme whose whole palette is chosen for a dark room rather than for a
		// hue: nothing here is fully saturated, so no single line glares out of the page.
		// That is also why PASS is a muted olive-green rather than a bright one.
		Pass: fixed("#9ece6a"), Fail: fixed("#f7768e"), Warn: fixed("#e0af68"),
		Info: fixed("#7dcfff"), Step: fixed("#bb9af7"),
		Accent: fixed("#7aa2f7"), OnAccent: fixed("#0b0e14"), Link: fixed("#7dcfff"),
		Ramp: ramp("#1f2a44", "#7aa2f7", "#eaf0ff"),
	},
	"paper": {
		Name:    "paper",
		Summary: "black ink on off-white paper, the light theme",
		Bg:      fixed("#fbfaf7"), Dark: false,
		Fg: fixed("#22272e"), Dim: fixed("#6b7280"), Surface: fixed("#ecebe5"),
		// Every colour here is a 700-weight rather than a 400: on a near-white background
		// the bright shades every dark theme uses have almost no contrast, which is the
		// single most common way a "light mode" ends up unreadable.
		Pass: fixed("#15803d"), Fail: fixed("#b91c1c"), Warn: fixed("#a16207"),
		Info: fixed("#0e7490"), Step: fixed("#4338ca"),
		Accent: fixed("#1d4ed8"), OnAccent: fixed("#fbfaf7"), Link: fixed("#1d4ed8"),
		Ramp: ramp("#172554", "#1d4ed8", "#eff6ff"),
	},
	"regal": {
		Name:    "regal",
		Summary: "white and gold: deep gold on warm ivory",
		Bg:      fixed("#fffdf6"), Dark: false,
		Fg: fixed("#2b2417"), Dim: fixed("#8a7a5c"), Surface: fixed("#f4ead2"),
		// Gold on white only works at a dark weight. #fbbf24, the gold every dark theme
		// uses, is invisible on ivory — a contrast ratio near 1.7, a shape rather than
		// text — so the accent is yellow-700 and the ramp climbs to champagne rather than
		// starting there. WARN moves to a burnt orange so the one warm status colour is not
		// the accent's own shade, and FAIL to a deep crimson, which is both further from
		// that orange and the better colour beside gold.
		Pass: fixed("#15803d"), Fail: fixed("#9f1239"), Warn: fixed("#b45309"),
		Info: fixed("#0f766e"), Step: fixed("#1e3a8a"),
		Accent: fixed("#a16207"), OnAccent: fixed("#fffdf6"),
		// Navy, not gold. An underlined gold label on ivory is the one combination here
		// with too little contrast to read as a link.
		Link: fixed("#1e3a8a"),
		Ramp: ramp("#4a2f05", "#a16207", "#fdf3d3"),
	},
	"gold": {
		Name:    "gold",
		Summary: "warm gold on dark bronze, the dark half of regal",
		Bg:      fixed("#141009"), Dark: true,
		Fg: fixed("#efe4c8"), Dim: fixed("#93835f"), Surface: fixed("#241d11"),
		// WARN is orange rather than amber here for the same reason regal's is burnt: the
		// accent has taken the gold, and two warm yellows one shade apart are not two
		// colours.
		Pass: fixed("#86efac"), Fail: fixed("#f87171"), Warn: fixed("#fb923c"),
		Info: fixed("#7dd3fc"), Step: fixed("#c4b5fd"),
		Accent: fixed("#e8c25a"), OnAccent: fixed("#1a1408"), Link: fixed("#7dd3fc"),
		Ramp: ramp("#4a3a12", "#e8c25a", "#fffbeb"),
	},
	"fuchsia": {
		Name:    "fuchsia",
		Summary: "magenta on plum black, the one hue no status colour claims",
		Bg:      fixed("#150818"), Dark: true,
		Fg: fixed("#f0dcf3"), Dim: fixed("#9a7ba0"), Surface: fixed("#26102a"),
		// The only accent in the file that cannot be read as any status colour at any
		// lightness, which is why this theme leaves all five of them at their usual hues.
		Pass: fixed("#4ade80"), Fail: fixed("#f87171"), Warn: fixed("#fbbf24"),
		Info: fixed("#22d3ee"), Step: fixed("#a5b4fc"),
		Accent: fixed("#e879f9"), OnAccent: fixed("#2a0630"), Link: fixed("#7dd3fc"),
		Ramp: ramp("#701a75", "#e879f9", "#fdf4ff"),
	},
	"iridescent": {
		Name:    "iridescent",
		Summary: "violet on ink, ramp travels through magenta while it moves",
		Bg:      fixed("#0e0b1a"), Dark: true,
		Fg: fixed("#ddd8f0"), Dim: fixed("#7e77a0"), Surface: fixed("#1b1533"),
		Pass: fixed("#4ade80"), Fail: fixed("#fb7185"), Warn: fixed("#fbbf24"),
		Info: fixed("#22d3ee"), Step: fixed("#a5b4fc"),
		Accent: fixed("#a78bfa"), OnAccent: fixed("#1e1b4b"), Link: fixed("#a78bfa"),
		// The one hand-written ramp among the full themes, and the whole point of this
		// theme. Every other ramp moves in lightness at a fixed hue, so a shimmer reads as
		// a brightness wave; this one travels indigo, violet, fuchsia, pink, so the same
		// animation reads as an oil slick. Only the stop at fracRest is pinned, which is
		// what makes travelling legal. Still, it is identical to a plain violet theme:
		// the cost is paid only while something moves.
		Ramp: []lipgloss.AdaptiveColor{
			fixed("#312e81"), fixed("#4338ca"), fixed("#6d28d9"), fixed("#8b5cf6"),
			fixed("#a78bfa"), // fracRest, and Accent exactly
			fixed("#c084fc"), fixed("#e879f9"), fixed("#f472b6"), fixed("#f9a8d4"),
			fixed("#fbcfe8"), fixed("#fdf4ff"),
		},
	},
	"dracula": {
		Name:    "dracula",
		Summary: "the Dracula palette, upstream values",
		// The upstream background, foreground, comment, purple, pink, green, red, yellow
		// and cyan, mapped onto the slots this tool has. Nothing is adjusted, which was
		// impossible before a theme could own its background: on the previous model only
		// the accent transferred and the rest of Dracula was left on the floor.
		Bg: fixed("#282a36"), Dark: true,
		Fg: fixed("#f8f8f2"), Dim: fixed("#6272a4"), Surface: fixed("#343746"),
		Pass: fixed("#50fa7b"), Fail: fixed("#ff5555"), Warn: fixed("#f1fa8c"),
		Info: fixed("#8be9fd"), Step: fixed("#bd93f9"),
		Accent: fixed("#bd93f9"), OnAccent: fixed("#282a36"), Link: fixed("#ff79c6"),
		Ramp: ramp("#44475a", "#bd93f9", "#f8f8f2"),
	},
	"catppuccin": {
		Name:    "catppuccin",
		Summary: "Catppuccin Mocha, upstream values",
		// Mocha only. Latte, the light variant, was what the accent-pair version of this
		// theme used for its light side, and a theme that owns its background has to pick
		// one: paper and regal are the light themes here.
		Bg: fixed("#1e1e2e"), Dark: true,
		Fg: fixed("#cdd6f4"), Dim: fixed("#6c7086"), Surface: fixed("#313244"),
		Pass: fixed("#a6e3a1"), Fail: fixed("#f38ba8"), Warn: fixed("#f9e2af"),
		Info: fixed("#94e2d5"), Step: fixed("#89b4fa"),
		Accent: fixed("#cba6f7"), OnAccent: fixed("#1e1e2e"), Link: fixed("#89b4fa"),
		Ramp: ramp("#45355e", "#cba6f7", "#f5e0dc"),
	},
	"tokyo-night": {
		Name:    "tokyo-night",
		Summary: "Tokyo Night, upstream values",
		// The upstream palette, mapped onto the slots this tool has. Tokyo Night's own
		// accent is the blue, not the purple, so the purple takes Step and the two cyans
		// split: the darker one reads as INFO, the lighter one as a link.
		Bg: fixed("#1a1b26"), Dark: true,
		// Dim is upstream's blue7 rather than its comment colour. The comment colour is
		// #565f89, which is 2.76:1 on this background and fails the legibility floor the
		// theme test enforces: in an editor it marks text meant to recede, while here Dim
		// carries paths and notes someone has to read.
		Fg: fixed("#c0caf5"), Dim: fixed("#737aa2"), Surface: fixed("#24283b"),
		Pass: fixed("#9ece6a"), Fail: fixed("#f7768e"), Warn: fixed("#e0af68"),
		Info: fixed("#2ac3de"), Step: fixed("#bb9af7"),
		Accent: fixed("#7aa2f7"), OnAccent: fixed("#1a1b26"), Link: fixed("#7dcfff"),
		// Anchored on upstream's own blue0 at the cold end, so the ramp stays inside the
		// palette instead of arriving at a blue this theme does not contain.
		Ramp: ramp("#3d59a1", "#7aa2f7", "#c0caf5"),
	},
	"mono": {
		Name:    "mono",
		Summary: "greyscale chrome on charcoal, only meaning is coloured",
		Bg:      fixed("#101317"), Dark: true,
		Fg: fixed("#d5dae1"), Dim: fixed("#6b7480"), Surface: fixed("#1b2027"),
		// The status colours are the only hues in the theme, and they are left at their
		// usual shades on purpose: with grey chrome there is nothing for them to clash
		// with, so this is the theme in which a verdict is hardest to miss.
		Pass: fixed("#4ade80"), Fail: fixed("#f87171"), Warn: fixed("#fbbf24"),
		Info: fixed("#22d3ee"), Step: fixed("#60a5fa"),
		Accent: fixed("#94a3b8"), OnAccent: fixed("#0b0e12"), Link: fixed("#60a5fa"),
		// A grey ramp is also the only one that survives a sixteen-colour terminal: every
		// hue ramp collapses to one flat ANSI colour there and stops animating, while grey
		// still has black, two greys and white to move through.
		Ramp: ramp("#334155", "#94a3b8", "#f8fafc"),
	},
	"oled": {
		Name:    "oled",
		Summary: "true black, maximum contrast, nothing wasted on chrome",
		// A real #000000, not a near-black: on an OLED panel an unlit pixel costs no light
		// at all, which is the entire reason to want this.
		Bg: fixed("#000000"), Dark: true,
		Fg: fixed("#f8fafc"), Dim: fixed("#71717a"), Surface: fixed("#111111"),
		Pass: fixed("#22c55e"), Fail: fixed("#ef4444"), Warn: fixed("#eab308"),
		Info: fixed("#06b6d4"), Step: fixed("#3b82f6"),
		// The accent is the brightest thing the terminal has rather than a colour, so
		// badges come out as white blocks with black text.
		Accent: fixed("#f8fafc"), OnAccent: fixed("#000000"), Link: fixed("#3b82f6"),
		// The hot half of this ramp is nearly flat, and it has to be: the accent is
		// already white, so there is nowhere hotter to go. The shimmer here is faint by
		// construction, which is the honest outcome rather than a gap to fill.
		Ramp: ramp("#3f3f46", "#f8fafc", "#ffffff"),
	},
}

// active is the theme in force. Set before InitColor builds the styles.
var active = themes[DefaultTheme]

// Themes lists every theme, the default first and the rest by name.
func Themes() []Theme {
	out := make([]Theme, 0, len(themes))
	for _, t := range themes {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Name == DefaultTheme) != (out[j].Name == DefaultTheme) {
			return out[i].Name == DefaultTheme
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// ThemeNames is the names in Themes order, for completion and error messages.
func ThemeNames() []string {
	all := Themes()
	out := make([]string, len(all))
	for i, t := range all {
		out[i] = t.Name
	}
	return out
}

// LookupTheme finds a theme by name, case-insensitively, so `Marko` works as well as
// `marko`.
func LookupTheme(name string) (Theme, bool) {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == defaultAlias {
		key = DefaultTheme
	}
	t, ok := themes[key]
	return t, ok
}

// ActiveTheme is the theme the styles were last built from.
func ActiveTheme() Theme { return active }

// SetTheme makes a theme current and rebuilds every style from it.
//
// It rebuilds rather than waiting for the next InitColor because the two are called
// from different places: the dispatcher sets the theme once at startup, and the shell
// sets it again when a `config theme` run inside the session changes the file. Either
// way the styles in force must be the theme's, so the rebuild belongs here.
//
// It also repaints the terminal, because a full theme's background is part of the theme
// and applying half of one would leave dark text on a light terminal.
func SetTheme(name string) error {
	t, ok := LookupTheme(name)
	if !ok {
		return fmt.Errorf("unknown theme %q. Themes: %s", name, strings.Join(ThemeNames(), ", "))
	}
	active = t
	InitColor(lastNoColor)
	PaintTerminal()
	return nil
}

// applyTheme copies the active theme into the palette. Called from InitColor before
// the styles are built, so a style always reflects the theme in force.
//
// A colour the theme leaves zero keeps the shared value, which is how the two
// terminal-following themes get a full palette without naming a background.
func applyTheme() {
	ColorAccent = active.Accent
	ColorOnAccent = active.OnAccent
	ColorLink = active.Link
	AccentRamp = active.Ramp

	ColorGreen = or(active.Pass, baseGreen)
	ColorRed = or(active.Fail, baseRed)
	ColorYellow = or(active.Warn, baseYellow)
	ColorCyan = or(active.Info, baseCyan)
	ColorBlue = or(active.Step, baseBlue)
	ColorText = or(active.Fg, baseText)
	ColorGray = or(active.Dim, baseGray)
	ColorSurface = or(active.Surface, baseSurface)
	ColorBg = active.Bg
}

// or is the theme's colour when it set one, the shared palette's otherwise.
func or(themed, base lipgloss.AdaptiveColor) lipgloss.AdaptiveColor {
	if themed == (lipgloss.AdaptiveColor{}) {
		return base
	}
	return themed
}

// Swatch renders a theme as one row for the theme listing: its name on a block of its accent,
// then its background, filled edge to edge, carrying the ramp, the five status glyphs in their
// own shades, a link label, body and dim text, and the summary.
//
// Painted as one continuous block rather than as coloured fragments on the terminal's own
// background, because the background is most of what a theme is. A listing that showed only
// accents was the reason this model was rebuilt: a light theme and a dark theme with the same
// accent produced the same swatch, so the one thing worth choosing between was the one thing
// not shown.
//
// A theme that follows the terminal is deliberately drawn without a filled row. That is the
// truth about it: it has no background of its own, and the gap in the listing is what says so.
//
// The badge is padded to the longest theme name, so a listing of several lines up as a column
// and the rows sit under each other, which is what makes them comparable.
func Swatch(t Theme) string { return SwatchReserving(t, 0) }

// SwatchReserving is Swatch narrowed by the columns a caller has already spent on the same row.
//
// A caller that prefixes a swatch with anything of its own — the marker `config theme` puts
// in front of the theme in force — has to say so, or every such row comes out that much wider
// than the budget: the rows wrap on an eighty-column terminal and the summaries are cut for no
// reason on a wide one.
func SwatchReserving(t Theme, reserve int) string {
	nameWidth := 0
	for _, name := range ThemeNames() {
		nameWidth = max(nameWidth, len(name))
	}
	badge := lipgloss.NewStyle().Foreground(t.OnAccent).Background(t.Accent).Bold(true).
		Render(" " + t.Name + strings.Repeat(" ", nameWidth-len(t.Name)) + " ")

	// Every segment carries the background itself rather than relying on an outer style: an
	// inner style ends with a full reset, which would cut an outer background short at the
	// first coloured cell. Same reason StyleSurface exists.
	seg := func(fg lipgloss.AdaptiveColor) lipgloss.Style {
		s := lipgloss.NewStyle()
		if fg != (lipgloss.AdaptiveColor{}) {
			s = s.Foreground(fg)
		}
		if t.Full() {
			s = s.Background(t.Bg)
		}
		return s
	}

	var b strings.Builder
	b.WriteString(seg(lipgloss.AdaptiveColor{}).Render("  "))
	for _, c := range t.Ramp {
		b.WriteString(seg(c).Render("█"))
	}
	b.WriteString(seg(lipgloss.AdaptiveColor{}).Render("  "))
	// The five slots in the order they appear in a transcript, each behind the glyph that
	// carries the meaning when there is no colour at all.
	for _, s := range []struct {
		glyph string
		color lipgloss.AdaptiveColor
	}{
		{"✔", or(t.Pass, baseGreen)},
		{"✘", or(t.Fail, baseRed)},
		{"▲", or(t.Warn, baseYellow)},
		{"·", or(t.Info, baseCyan)},
		{"▸", or(t.Step, baseBlue)},
	} {
		b.WriteString(seg(s.color).Render(s.glyph + " "))
	}
	// Not underlined, unlike a real link. lipgloss styles an underlined string one character
	// at a time to control where the line stops, so "link" would come out as four separate
	// escape sequences instead of one, x15 rows, for a cue the label already gives.
	b.WriteString(seg(t.Link).Render("link"))
	b.WriteString(seg(or(t.Fg, baseText)).Render("  Aa"))
	b.WriteString(seg(or(t.Dim, baseGray)).Render(" aa  "))

	// The summary is cut to what is left of the row rather than allowed to run past it.
	// Uncut, a long summary wraps, and a wrapped row of background colour reads as two
	// broken themes rather than as one that did not fit.
	room := swatchWidth() - reserve - lipgloss.Width(badge) - lipgloss.Width(b.String())
	b.WriteString(seg(or(t.Dim, baseGray)).Render(clip(t.Summary, room)))

	// Filled to the width so the row reads as the theme rather than as a stripe with a
	// ragged end. Measured rather than counted: the row is escape sequences and multi-byte
	// glyphs, and len() on that is not a column count.
	if t.Full() {
		if pad := swatchWidth() - reserve - lipgloss.Width(badge) - lipgloss.Width(b.String()); pad > 0 {
			b.WriteString(seg(lipgloss.AdaptiveColor{}).Render(strings.Repeat(" ", pad)))
		}
	}
	return badge + b.String()
}

// clip cuts a string to at most n columns, marking a cut with an ellipsis.
//
// Counted in runes rather than bytes: every summary here is ASCII, but the ellipsis is not,
// and a byte slice through a multi-byte character produces the replacement glyph rather than
// a short string.
func clip(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	return string(r[:n-1]) + "…"
}

// swatchWidth is how wide a swatch row is drawn.
//
// Four columns short of the terminal, which is the two-space indent the listing adds on the
// left plus the same again on the right so the rows do not touch the edge. Clamped at the
// bottom because a very narrow terminal should get a short row rather than a negative one, and
// at the top because a full-width row on a 300-column window is a wall of colour.
func swatchWidth() int {
	w := platform.TermCols() - 4
	switch {
	case w < 60:
		return 60
	case w > 120:
		return 120
	}
	return w
}
