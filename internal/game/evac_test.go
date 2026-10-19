package game

import (
	"math"
	"testing"
)

// clearLastWave puts w at the end of its last wave, with nothing of it left, and steps once.
func clearLastWave(w *World) {
	w.Phase, w.Wave, w.WaveTime = PhaseWave, w.LastWave, 60
	w.Queue, w.QueueHead, w.rushAt = nil, 0, 0
	w.Step()
}

// untilEvac steps w until the evac reaches stage s, or gives up after secs seconds.
func untilEvac(t *testing.T, w *World, s EvacStage, secs int) {
	t.Helper()
	for i := 0; i < secs*TickRate && w.Evac.Stage != s && w.Phase != PhaseOver; i++ {
		keepSafe(w)
		w.Step()
	}
	if w.Evac.Stage != s {
		t.Fatalf("evac at stage %d in phase %s, want stage %d", w.Evac.Stage, w.Phase, s)
	}
}

// keepSafe keeps the survivors from harm while the dead are about.
func keepSafe(w *World) {
	for _, p := range w.Players {
		p.Shield = 1
	}
}

func TestTheLastWaveCallsTheEvacAndEveryoneAboardEndsTheGame(t *testing.T) {
	w := newBare(5)
	w.LastWave = 20
	a, b := mustJoin(t, w, "ana"), mustJoin(t, w, "bo")
	clearLastWave(w)
	if w.Phase != PhaseEvac || w.Evac.Stage != EvacInbound {
		t.Fatalf("phase %s evac %d after the last wave", w.Phase, w.Evac.Stage)
	}
	if len(w.Queue) == 0 {
		t.Error("nobody comes for the pad")
	}
	if err := w.OrderBoard(a); err == nil {
		t.Error("boarded a Huey still in the air")
	}
	for i := 0; i < (evacInbound+1)*TickRate && w.Evac.Stage == EvacInbound; i++ {
		keepSafe(w)
		w.Step()
	}
	if w.Evac.Stage != EvacLanded || w.Evac.X != w.PadX || w.Evac.Y != w.PadY || w.Evac.Alt != 0 {
		t.Fatalf("evac %+v, want landed on the pad at %v,%v", w.Evac, w.PadX, w.PadY)
	}
	w.Queue, w.QueueHead = nil, 0
	w.dropStragglers()
	for _, p := range []*Player{a, b} {
		w.Touch(p)
		if err := w.OrderBoard(p); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 60*TickRate && w.Evac.Stage == EvacLanded; i++ {
		keepSafe(w)
		w.Step()
	}
	if !a.Aboard || !b.Aboard || a.Alive {
		t.Fatalf("aboard %v %v, alive %v", a.Aboard, b.Aboard, a.Alive)
	}
	if w.Evac.Stage != EvacDeparting {
		t.Fatalf("evac stage %d with everyone aboard", w.Evac.Stage)
	}
	untilEvac(t, w, EvacGone, evacDepart+1)
	if w.Phase != PhaseOver || w.Best != 20 {
		t.Errorf("phase %s best %d after the Huey left", w.Phase, w.Best)
	}
	if err := w.Check(); err != nil {
		t.Error(err)
	}
}

func TestTheHueyWaitsOnlySoLongOnceSomeoneIsAboard(t *testing.T) {
	w := newBare(6)
	w.LastWave = 30
	a, b := mustJoin(t, w, "ana"), mustJoin(t, w, "bo")
	clearLastWave(w)
	untilEvac(t, w, EvacLanded, evacInbound+1)
	w.Touch(a)
	if err := w.OrderBoard(a); err != nil {
		t.Fatal(err)
	}
	waited := 0
	for ; waited < (evacWait+5)*TickRate && w.Evac.Stage == EvacLanded; waited++ {
		keepSafe(w)
		w.Touch(b) // still playing, but never comes
		w.Step()
	}
	if w.Evac.Stage != EvacDeparting || !a.Aboard || b.Aboard {
		t.Fatalf("evac stage %d, aboard %v %v", w.Evac.Stage, a.Aboard, b.Aboard)
	}
	if secs := float32(waited) / TickRate; secs > evacLast+boardTime+8 {
		t.Errorf("the Huey waited %.0fs with someone aboard", secs)
	}
}

func TestTheHueyLeavesEmptyWhenNobodyComes(t *testing.T) {
	w := newBare(8)
	w.LastWave = 20
	a := mustJoin(t, w, "ana")
	clearLastWave(w)
	untilEvac(t, w, EvacLanded, evacInbound+1)
	for i := 0; i < (evacWait+1)*TickRate && w.Evac.Stage == EvacLanded; i++ {
		keepSafe(w)
		w.Touch(a)
		w.Step()
	}
	untilEvac(t, w, EvacGone, evacDepart+1)
	if a.Aboard || w.Phase != PhaseOver {
		t.Errorf("aboard %v phase %s", a.Aboard, w.Phase)
	}
}

func TestTheGeneratorHoldsWhileTheHueyIsComing(t *testing.T) {
	w := newBare(9)
	w.LastWave = 20
	mustJoin(t, w, "ana")
	clearLastWave(w)
	w.Structs[w.Core].HP = -50
	w.Step()
	if w.Phase != PhaseEvac || !w.Structs[w.Core].Alive {
		t.Fatalf("phase %s, generator alive %v", w.Phase, w.Structs[w.Core].Alive)
	}
}

func TestAnEndlessGameGoesOnPastEveryLastWave(t *testing.T) {
	w := newBare(10)
	w.LastWave = 0
	mustJoin(t, w, "ana")
	w.LastWave, w.Wave = 0, DefaultLastWave
	w.Phase, w.WaveTime = PhaseWave, 60
	w.Queue, w.QueueHead, w.rushAt = nil, 0, 0
	w.Step()
	if w.Phase != PhaseBuild || w.Evac.Stage != EvacNone {
		t.Fatalf("phase %s evac %d after wave %d of an endless game", w.Phase, w.Evac.Stage, w.Wave)
	}
	if w.onPad(int(w.PadX), int(w.PadY)) {
		t.Error("an endless game keeps a helipad clear")
	}
}

func TestEveryMapHasAClearHelipadFurtherOutTheHarderTheGame(t *testing.T) {
	for seed := uint64(1); seed <= 40; seed++ {
		diff := Difficulty(seed % uint64(NumDifficulties))
		w := NewGame(seed, diff)
		d := math.Hypot(float64(w.PadX-w.CoreX), float64(w.PadY-w.CoreY))
		if want := float64(Difficulties[diff].Pad); d < baseRadius+4 || math.Abs(d-want) > padSpread+1 {
			t.Errorf("seed %d, %s: the pad is %.1f tiles from the generator, want %.0f", seed, diff, d, want)
		}
		if !w.padClear(w.PadX, w.PadY) {
			t.Errorf("seed %d: the pad at %v,%v is not on open ground", seed, w.PadX, w.PadY)
		}
		p := mustJoin(t, w, "ana")
		p.Gold = 1000
		if err := w.canBuild(p, SWall, int(w.PadX), int(w.PadY), false); err == nil {
			t.Errorf("seed %d: a wall can go up on the pad", seed)
		}
	}
}

func TestAtNightTheHelipadHasToBeFound(t *testing.T) {
	w := NewGame(11, DiffHard)
	p := mustJoin(t, w, "ana")
	w.discover()
	if w.PadKnown() {
		t.Fatal("the helipad is known before anyone has been out to it")
	}
	p.X, p.Y = w.PadX+padHalf+2, w.PadY
	w.discover()
	if !w.PadKnown() {
		t.Error("standing beside the helipad did not find it")
	}
	if day := NewGame(11, DiffNormal); !day.PadKnown() {
		t.Error("by day the helipad has to be found")
	}
}
