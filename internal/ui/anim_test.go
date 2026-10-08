package ui

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/platform"
)

// forceTruecolor puts the package in the state a modern terminal produces: colour on,
// and enough of it to tell the ramp's stops apart.
//
// The profile has to be forced as well as the colour. With colour forced on a pipe,
// InitColor widens the profile to a flat sixteen, and all six stops of a red ramp map to
// the same ANSI red — so the animation is genuinely, correctly static there, and a test
// that asserted motion would be asserting against the degradation rather than the code.
func forceTruecolor(t *testing.T) {
	t.Helper()
	t.Setenv("NO_COLOR", "")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "1")
	t.Setenv(EnvColorProfile, "truecolor")
	// The wide effects also skip over SSH, and a test run from an SSH session would
	// otherwise see still frames where it expects a sweep. See tick.go.
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("SSH_TTY", "")
	t.Setenv(EnvFullAnim, "")
	// Animation gates on a terminal as well as on colour, and a test has no terminal, so
	// without this the busy rule sweep and every other IsTTY-gated frame stay unreachable
	// here — which is exactly the path TestRuleRestsWhenNotBusy needs to see move.
	restoreTTY := platform.SetTTYForTest(true)
	InitColor(false)
	t.Cleanup(func() {
		restoreTTY()
		t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
		t.Setenv(EnvColorProfile, "")
		InitColor(false)
	})
}

// The wordmark sits beside a column of facts positioned by measuring it, so an animation
// that changed its width by a cell would push that column back and forth on every frame.
//
// shimmerAt rather than Shimmer: Shimmer refuses to animate without a terminal, and a
// test has a pipe. This is the frame renderer both the header and the reveal go through.
func TestShimmerNeverChangesTheVisibleWidth(t *testing.T) {
	forceTruecolor(t)

	for _, row := range WordmarkSmall() {
		want := ansi.StringWidth(row)
		// Past both ends of the artwork, so the frames where the band is entering and
		// leaving are covered as well as the ones where it is over a letter.
		for head := -shimmerBand - 2; head < want+shimmerBand+2; head++ {
			got := shimmerAt(row, head)
			if n := ansi.StringWidth(got); n != want {
				t.Fatalf("at head %d the row measures %d cells, want %d", head, n, want)
			}
			if ansi.Strip(got) != row {
				t.Fatalf("at head %d the text changed: %q", head, ansi.Strip(got))
			}
		}
	}
}

// Frames must be a pure function of elapsed time: the shell redraws every animated glyph
// in one frame from one clock, and anything reading a counter of its own drifts out of
// phase with the rest of the frame.
func TestAnimationFramesArePureFunctionsOfTime(t *testing.T) {
	forceTruecolor(t)

	at := 640 * time.Millisecond
	if a, b := pulseAt(at), pulseAt(at); a.Render("x") != b.Render("x") {
		t.Error("Pulse is not deterministic at a fixed elapsed time")
	}

	// And they must actually animate.
	seen := map[string]bool{}
	for head := 0; head < 20; head++ {
		seen[shimmerAt("HIVE", head)] = true
	}
	if len(seen) < 5 {
		t.Errorf("the shimmer produced only %d distinct frames over one pass", len(seen))
	}

	// A long-running session must not index past the end of the ramp hours in.
	pulseAt(9 * time.Hour)
	shimmerAt("HIVE", 9999)
}

// Pulse must stay in the bright half of the ramp. A glyph that dims to the darkest shade
// reads as disabled, which is the opposite of what "still working" should look like.
func TestPulseStaysBright(t *testing.T) {
	forceTruecolor(t)

	dimmest := rampStyles[0].Render("x")
	for ms := 0; ms < 4000; ms += 25 {
		if got := pulseAt(time.Duration(ms) * time.Millisecond).Render("x"); got == dimmest {
			t.Fatalf("at %dms the pulse reached the darkest ramp stop", ms)
		}
	}
}

// Without a terminal there must be no animation and no cursor control, because the
// output is being captured: piped to a file or into a ticket, a reveal would land as one
// complete copy of the artwork per frame.
func TestRevealIsOneStaticFrameWithoutATerminal(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	var buf bytes.Buffer
	rows := WordmarkSmall()
	Reveal(&buf, rows)

	got := buf.String()
	if want := strings.Join(rows, "\n") + "\n"; got != want {
		t.Errorf("Reveal off a terminal produced %q, want the plain artwork", got)
	}
	for _, seq := range []string{"\x1b[?25l", "\x1b[A", "\x1b[K"} {
		if strings.Contains(got, seq) {
			t.Errorf("Reveal emitted %q with no terminal to draw on", seq)
		}
	}
}

// Inside a shell pane the output is captured and cursor control is stripped by
// cmd/shell/sanitize.go, so an animation there is not degraded but multiplied: every
// frame survives as its own copy of the artwork. The session marker is the gate. The
// one way through it, a live region, is pinned in pane_test.go.
func TestAnimationIsOffInsideAShellPane(t *testing.T) {
	forceTruecolor(t)

	t.Setenv("TAILDEFENSE_SHELL", "1")
	if AnimEnabled() {
		t.Error("animation is enabled inside a shell pane")
	}

	// And the opt-out, for a link too slow to draw frames over.
	t.Setenv("TAILDEFENSE_SHELL", "")
	t.Setenv(EnvNoAnim, "1")
	if AnimEnabled() {
		t.Errorf("animation is enabled with %s set", EnvNoAnim)
	}
}

// Every ambient effect has to collapse to the still frame with animation off, because that
// is what a test, a pipe and a shell pane all see. A new effect that forgets the guard
// would not fail visibly, it would leak escape sequences into captured output.
func TestAmbientEffectsFallBackToStillFrames(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	row := WordmarkSmall()[0]
	still := StyleBrand.Render(row)

	cases := map[string]string{
		"WordmarkSweep":      WordmarkSweep(row, 900*time.Millisecond, false),
		"WordmarkSweep busy": WordmarkSweep(row, 900*time.Millisecond, true),
		"Wipe":               Wipe(row, 0.4),
		"BreathText":         BreathText(row, 900*time.Millisecond),
	}
	for name, got := range cases {
		if got != still {
			t.Errorf("%s did not fall back to the still frame: %q", name, got)
		}
	}

	if got, want := Rule(12, time.Second, true), StyleDim.Render("────────────"); got != want {
		t.Errorf("Rule did not fall back: %q", got)
	}
	if got, want := RuleWipe(12, 0.5), StyleDim.Render("────────────"); got != want {
		t.Errorf("RuleWipe did not fall back: %q", got)
	}
	if BadgeBreath(time.Second).Render("x") != StyleBadge.Render("x") {
		t.Error("BadgeBreath did not fall back to StyleBadge")
	}
	if _, live := Decay(0, time.Second); live {
		t.Error("Decay reported a live marker with animation off")
	}
}

// A rule rests as a still dim row unless the session is busy: the moving highlight is an
// activity signal, so an idle prompt must not show it even with colour and animation on.
func TestRuleRestsWhenNotBusy(t *testing.T) {
	forceTruecolor(t)

	still := StyleDim.Render(strings.Repeat("─", 80))
	for ms := 0; ms < 9000; ms += 311 {
		if got := Rule(80, time.Duration(ms)*time.Millisecond, false); got != still {
			t.Fatalf("Rule(busy=false) at %dms animated: %q", ms, got)
		}
	}
	// Busy, it must move: at least one frame differs from the still row.
	moved := false
	for ms := 0; ms < 9000; ms += 311 {
		if Rule(80, time.Duration(ms)*time.Millisecond, true) != still {
			moved = true
			break
		}
	}
	if !moved {
		t.Error("Rule(busy=true) never differed from the still row")
	}
}

// A rule is the one animated surface whose width is load bearing for the frame: it spans
// the terminal, and a rule one cell too long wraps and pushes every row below it down.
func TestRuleIsExactlyTheRequestedWidth(t *testing.T) {
	forceTruecolor(t)

	for _, width := range []int{0, 1, 2, 13, 80, 131} {
		for ms := 0; ms < 9000; ms += 311 {
			got := ruleAt(width, time.Duration(ms)*time.Millisecond)
			if n := ansi.StringWidth(got); n != width {
				t.Fatalf("ruleAt(%d) at %dms is %d cells wide", width, ms, n)
			}
			if want := strings.Repeat("─", width); ansi.Strip(got) != want {
				t.Fatalf("ruleAt(%d) at %dms changed the glyphs: %q", width, ms, ansi.Strip(got))
			}
		}
		for _, f := range []float64{-1, 0, 0.25, 0.5, 1, 2} {
			if n := ansi.StringWidth(RuleWipe(width, f)); n > width {
				t.Fatalf("RuleWipe(%d, %v) is %d cells wide, over the limit", width, f, n)
			}
		}
	}
}

// The opening wipe must never show more artwork than it has, and must end on the settled
// frame. A wipe that overshot would render a fraction of a glyph as its own cell.
func TestWipeStaysWithinTheArtwork(t *testing.T) {
	forceTruecolor(t)

	row := WordmarkSmall()[0]
	full := ansi.StringWidth(row)
	for _, f := range []float64{-1, 0, 0.1, 0.5, 0.99} {
		if n := ansi.StringWidth(Wipe(row, f)); n > full {
			t.Errorf("Wipe(%v) is %d cells, wider than the artwork's %d", f, n, full)
		}
	}
	if got, want := Wipe(row, 1), StyleBrand.Render(row); got != want {
		t.Error("Wipe(1) is not the settled frame")
	}
}

// The ramp positions are fractions so that lengthening the ramp to smooth the gradient
// cannot move every resting colour. This pins the ordering and the clamping; if a future
// ramp length silently collapsed two of these onto one stop, every effect built from them
// would lose its contrast at once.
func TestRampFractionsAreOrderedAndClamped(t *testing.T) {
	forceTruecolor(t)

	rest, calm, breath, hot := rampIdx(fracRest), rampIdx(fracCalm), rampIdx(fracBreath), rampIdx(fracHot)
	if !(rest < calm && calm < breath && breath < hot) {
		t.Errorf("ramp positions are not strictly increasing: rest=%d calm=%d breath=%d hot=%d",
			rest, calm, breath, hot)
	}
	if hot != len(rampStyles)-1 {
		t.Errorf("fracHot is %d, not the last stop %d", hot, len(rampStyles)-1)
	}
	if got := rampIdx(-5); got != 0 {
		t.Errorf("rampIdx(-5) = %d, want 0", got)
	}
	if got := rampIdx(9); got != len(rampStyles)-1 {
		t.Errorf("rampIdx(9) = %d, want the last stop", got)
	}
	// Enough stops that a wide band grades rather than bands. Below this the ambient drift
	// steps visibly, which is the whole reason the ramp was lengthened.
	if len(rampStyles) < 9 {
		t.Errorf("the ramp has only %d stops; the ambient drift needs a finer gradient", len(rampStyles))
	}
}

// The wordmark rests between sweeps, and that is the point of the change: a highlight
// cycling across the largest thing on screen forever is motion that never resolves. Resting
// also has to be the exact still frame, because that is what makes it free — an unchanged
// frame is a frame Bubble Tea does not write.
func TestWordmarkRestsBetweenSweeps(t *testing.T) {
	forceTruecolor(t)

	row := WordmarkSmall()[0]
	still := StyleBrand.Render(row)

	resting, sweeping := 0, 0
	for ms := 0; ms < 30000; ms += 40 {
		if wordmarkSweepAt(row, time.Duration(ms)*time.Millisecond, false) == still {
			resting++
		} else {
			sweeping++
		}
	}
	if sweeping == 0 {
		t.Fatal("the wordmark never sweeps")
	}
	// Over thirty seconds at a five second cycle that is six sweeps of 1.1s: comfortably
	// more resting than moving, which is the property being asserted.
	if resting < sweeping*2 {
		t.Errorf("the wordmark sweeps too much of the time: %d resting frames, %d sweeping", resting, sweeping)
	}
}

// Every row of the artwork is rendered independently from one clock, so a sweep must be a
// pure function of that clock. A generator with state, or anything reading time.Now for
// itself, would give each of the six rows a different direction and a different position.
func TestWordmarkSweepIsDeterministicAcrossRows(t *testing.T) {
	forceTruecolor(t)

	rows := WordmarkSmall()
	for ms := 0; ms < 12000; ms += 37 {
		at := time.Duration(ms) * time.Millisecond
		for _, row := range rows {
			a := wordmarkSweepAt(row, at, false)
			b := wordmarkSweepAt(row, at, false)
			if a != b {
				t.Fatalf("WordmarkSweep is not deterministic at %v", at)
			}
		}
	}
}

// The interval has to be uneven and the direction has to vary, which is what separates this
// from a metronome. Both come out of a hash of the cycle number rather than a random source.
func TestSweepScheduleIsVariedButNeverRepeatsADirection(t *testing.T) {
	forceTruecolor(t)

	delays := map[time.Duration]bool{}
	styles := map[SweepStyle]int{}
	run, longest := 0, 0
	var prev SweepStyle = -1

	for i := int64(0); i < 400; i++ {
		delay, style := sweepSchedule(i, idleSweepCycle)
		if delay < 0 || delay+sweepDuration > idleSweepCycle {
			t.Fatalf("cycle %d: a sweep starting at %v does not fit inside %v", i, delay, idleSweepCycle)
		}
		delays[delay.Round(100*time.Millisecond)] = true
		styles[style]++

		if style == prev {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
		prev = style

		// Every block of four contains all four directions, so a block is a full sweep of
		// the set rather than four independent draws.
		if i%sweepStyles == sweepStyles-1 {
			block := map[SweepStyle]bool{}
			for k := i - sweepStyles + 1; k <= i; k++ {
				_, st := sweepSchedule(k, idleSweepCycle)
				block[st] = true
			}
			if len(block) != sweepStyles {
				t.Fatalf("the block ending at cycle %d used only %d directions", i, len(block))
			}
		}
	}

	// A repeat can only happen across a block boundary, so two in a row is possible and
	// three is not. Three would mean the block shuffle is not shuffling.
	if longest > 2 {
		t.Errorf("the same direction ran %d times in a row", longest)
	}
	if len(styles) != sweepStyles {
		t.Errorf("only %d of %d directions appeared: %v", len(styles), sweepStyles, styles)
	}
	// And the gap between sweeps has to move around. A handful of distinct start offsets
	// would still read as mechanical.
	if len(delays) < 20 {
		t.Errorf("only %d distinct start offsets over 400 cycles", len(delays))
	}
}

// A sweep must cross the whole artwork, whichever direction it takes, and never change the
// visible text or its width on the way.
func TestEverySweepDirectionCoversTheArtwork(t *testing.T) {
	forceTruecolor(t)

	row := WordmarkLarge()[0]
	width := ansi.StringWidth(row)
	still := StyleBrand.Render(row)

	for style := SweepStyle(0); style < sweepStyles; style++ {
		lit := 0
		for step := 0; step <= 40; step++ {
			frame := sweepFrame(row, float64(step)/40, style)
			if ansi.StringWidth(frame) != width {
				t.Fatalf("style %v at step %d is %d cells, want %d", style, step, ansi.StringWidth(frame), width)
			}
			if ansi.Strip(frame) != row {
				t.Fatalf("style %v at step %d changed the text", style, step)
			}
			if frame != still {
				lit++
			}
		}
		if lit < 30 {
			t.Errorf("style %v only lit the artwork in %d of 41 frames", style, lit)
		}
	}
}

// The resting shade of an animated surface has to be the accent itself, on both themes.
//
// This is the one palette relationship that cannot be seen by reading either definition. It
// was #ef2b1f against a #ff3b2f accent on dark themes, close enough to look deliberate and
// far enough that the whole wordmark visibly darkened the instant a sweep started and lifted
// again when it ended — a colour change much louder than the animation it was carrying.
func TestTheRestingRampShadeIsTheAccent(t *testing.T) {
	forceTruecolor(t)
	t.Cleanup(func() {
		lipgloss.SetHasDarkBackground(true)
		_ = SetTheme(DefaultTheme)
	})

	for _, theme := range Themes() {
		if err := SetTheme(theme.Name); err != nil {
			t.Fatal(err)
		}
		for _, dark := range []bool{true, false} {
			lipgloss.SetHasDarkBackground(dark)
			InitColor(false)

			rest := rampStyles[rampIdx(fracRest)].Render("HIVE")
			brand := StyleBrand.Render("HIVE")
			if rest != brand {
				t.Errorf("%s dark=%v: the resting ramp shade is %q, the brand style is %q", theme.Name, dark, rest, brand)
			}
		}
	}
}

// A sweep must therefore start and end without a step: the first and last frames of a pass
// are the still frame, because the highlight is entirely off the artwork at both ends.
func TestASweepBeginsAndEndsOnTheStillFrame(t *testing.T) {
	forceTruecolor(t)

	row := WordmarkSmall()[0]
	still := StyleBrand.Render(row)
	for style := SweepStyle(0); style < sweepStyles; style++ {
		if got := sweepFrame(row, 0, style); style == SweepLeftToRight || style == SweepRightToLeft {
			if got != still {
				t.Errorf("style %v does not start from the still frame", style)
			}
		}
		if got := sweepFrame(row, 1, style); style == SweepLeftToRight || style == SweepRightToLeft {
			if got != still {
				t.Errorf("style %v does not end on the still frame", style)
			}
		}
	}
}

// Decay has to end. A marker that stopped one stop short of cool would sit on screen
// forever beside a line that arrived minutes ago.
func TestDecayCoolsOutAndStopsReportingLive(t *testing.T) {
	forceTruecolor(t)

	const d = 700 * time.Millisecond
	if _, live := decayAt(0, d); !live {
		t.Error("Decay is not live at age zero")
	}
	if _, live := decayAt(d, d); live {
		t.Error("Decay is still live at the end of its window")
	}
	if _, live := decayAt(10*time.Second, d); live {
		t.Error("Decay is still live long past its window")
	}
	// And a zero arrival time, which is what a session that has had no output yet holds,
	// must not read as something that just happened.
	if _, live := decayAt(time.Since(time.Time{}), d); live {
		t.Error("Decay treated a zero timestamp as a fresh arrival")
	}
	// It must also cool monotonically, so the marker never brightens as it ages.
	prev := -1
	for age := time.Duration(0); age < d; age += 20 * time.Millisecond {
		st, _ := decayAt(age, d)
		idx := -1
		for i, s := range rampStyles {
			if s.Render("x") == st.Render("x") {
				idx = i
				break
			}
		}
		if prev >= 0 && idx > prev {
			t.Fatalf("the marker brightened as it aged, at %v", age)
		}
		prev = idx
	}
}

// With animation off, Shimmer has to fall back to the same styled string the still
// wordmark uses. Anything else would make a captured header differ from a drawn one by
// more than the animation.
func TestShimmerFallsBackToTheBrandStyle(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	row := WordmarkSmall()[0]
	if got, want := WordmarkSweep(row, 300*time.Millisecond, false), StyleBrand.Render(row); got != want {
		t.Errorf("WordmarkSweep with animation off gave %q, want %q", got, want)
	}
}

// clipCells drives the wipe, and it counts cells rather than bytes. The artwork is
// box-drawing characters, every one of them multi-byte, so a byte-counting clip would cut
// one in half and print a replacement character mid-letter.
func TestClipCellsCountsCellsNotBytes(t *testing.T) {
	const art = "███╗"
	for n := 0; n <= 4; n++ {
		if got := ansi.StringWidth(clipCells(art, n)); got != n {
			t.Errorf("clipCells(%q, %d) is %d cells wide, want %d", art, n, got, n)
		}
	}
	if got := clipCells(art, 99); got != art {
		t.Errorf("clipCells past the end truncated: %q", got)
	}
}
