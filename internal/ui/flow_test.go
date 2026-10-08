package ui

import (
	"strings"
	"testing"
	"time"

	"taildefense/internal/platform"
)

// The invariant worth a test here is anim.go's fourth rule: a bar or a rail never changes
// its visible width. Everything on these surfaces sits in a column sized once, so a frame
// that measured one cell wider would push the column beside it back and forth as it
// animated, and that is not a defect anyone would attribute to a bar.

func TestBarsHoldTheirWidth(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	InitColor(false)

	for _, width := range []int{1, 2, 8, 14, 40, 137} {
		for _, at := range []time.Duration{0, 37 * time.Millisecond, 550 * time.Millisecond, 1099 * time.Millisecond, 4 * time.Second} {
			if got := visibleWidth(SweepBar(width, at)); got != width {
				t.Errorf("SweepBar(%d, %s) is %d cells wide", width, at, got)
			}
		}
		for _, frac := range []float64{-1, 0, 0.001, 0.5, 0.999, 1, 2} {
			if got := visibleWidth(Meter(width, frac, StyleGreen)); got != width {
				t.Errorf("Meter(%d, %v) is %d cells wide", width, frac, got)
			}
		}
		if got := visibleWidth(Gauge(width, 8, []GaugeSeg{{Count: 3, Style: StyleGreen}, {Count: 1, Style: StyleRed}})); got != width {
			t.Errorf("Gauge(%d) is %d cells wide", width, got)
		}
	}
}

// A gauge against a total larger than its segments must not fill. Summing the segments
// instead was the original bug and it is invisible by inspection: a full bar reading "3 of
// 8" looks like a gauge that works.
func TestGaugeCountsAgainstTheTotal(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	InitColor(false)

	got := Gauge(8, 8, []GaugeSeg{{Count: 4, Style: StyleGreen}})
	if filled := strings.Count(got, "█"); filled != 4 {
		t.Errorf("4 of 8 filled %d cells of 8, want 4", filled)
	}
	if empty := strings.Count(got, "░"); empty != 4 {
		t.Errorf("4 of 8 left %d cells empty, want 4", empty)
	}
}

// Segments that are the whole total fill the whole track. A dim cell at the end of a bar of
// "8 block, 5 ask" out of 13 reads as a fourteenth trap that is neither.
func TestGaugeWhoseSegmentsMakeTheTotalIsFull(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	InitColor(false)

	// 8 and 5 of 13 over 30 cells round down to 18 and 11: a dim cell would claim a part that
	// is not there.
	got := Gauge(30, 13, []GaugeSeg{{Count: 8, Style: StyleRed}, {Count: 5, Style: StyleYellow}})
	if empty := strings.Count(got, "░"); empty != 0 {
		t.Errorf("segments summing to the total left %d cells empty", empty)
	}
	if filled := strings.Count(got, "█"); filled != 30 {
		t.Errorf("filled %d cells of 30", filled)
	}
	// Against a larger total the remainder stays dim, which is the point of passing one.
	if empty := strings.Count(Gauge(30, 20, []GaugeSeg{{Count: 8, Style: StyleRed}, {Count: 5, Style: StyleYellow}}), "░"); empty == 0 {
		t.Error("segments short of the total filled the bar")
	}
}

// More non-zero segments than cells must not spin in the trim loop. Reachable with a
// narrow terminal and a batch of eight, which is a plausible pair rather than a contrived
// one.
func TestGaugeSurvivesMoreSegmentsThanCells(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	InitColor(false)

	segs := make([]GaugeSeg, 6)
	for i := range segs {
		segs[i] = GaugeSeg{Count: 1, Style: StyleGreen}
	}
	done := make(chan string, 1)
	go func() { done <- Gauge(3, 6, segs) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Gauge did not return: the overflow trim looped")
	}
}

// A pipe is one cell per row, at every frame, and the packet stays inside it. A packet
// drawn past the last row is a rail with a hot cell that never appears, which reads as an
// animation that has stopped.
func TestPipeRowsAreOneCell(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	InitColor(false)

	for _, rows := range []int{1, 3, 7, 15} {
		for _, at := range []time.Duration{0, 200 * time.Millisecond, 1399 * time.Millisecond, 3 * time.Second} {
			pipe := Pipe(rows, at, true)
			if len(pipe) != rows {
				t.Fatalf("Pipe(%d, %s) returned %d rows", rows, at, len(pipe))
			}
			for i, cell := range pipe {
				if got := visibleWidth(cell); got != 1 {
					t.Errorf("Pipe(%d, %s) row %d is %d cells wide", rows, at, i, got)
				}
			}
		}
	}
}

// Not flowing is a plain rail, which is what a stage nothing has reached yet must look
// like. A packet descending into a stage that has not started says data is there when it
// is not.
func TestPipeRestsWhenNotFlowing(t *testing.T) {
	restore := platform.SetTTYForTest(true)
	defer restore()
	InitColor(false)

	still := Pipe(4, 0, false)
	for at := time.Duration(0); at < 3*time.Second; at += 137 * time.Millisecond {
		if got := Pipe(4, at, false); !equal(got, still) {
			t.Fatalf("a resting pipe changed at %s", at)
		}
	}
}

func TestFlowSettingHonoursTheEnvironment(t *testing.T) {
	t.Cleanup(func() { SetFlow(true) })

	SetFlow(true)
	if !FlowSetting() {
		t.Error("the flow view should be on when the preference is on")
	}
	t.Setenv(EnvNoFlow, "1")
	if FlowSetting() {
		t.Errorf("$%s must turn the flow view off for the process", EnvNoFlow)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
