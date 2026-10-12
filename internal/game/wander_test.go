package game

import "testing"

func TestWanderersRoamComeBackAndRushTheTenthWave(t *testing.T) {
	w := New(7)
	w.PhaseLeft = 1e6
	n := w.wanderers()
	if n > w.wanderCap() || n < w.wanderCap()-packLo || n == 0 {
		t.Fatalf("%d wanderers, want %d", n, w.wanderCap())
	}
	// They come in packs: nearly every one has another close by.
	alone := 0
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if !c.Wander {
			continue
		}
		near := false
		for j := range w.Creeps {
			o := &w.Creeps[j]
			if dx, dy := o.X-c.X, o.Y-c.Y; j != i && o.Wander && dx*dx+dy*dy < 4*4 {
				near = true
			}
		}
		if !near {
			alone++
		}
	}
	if alone > n/8 {
		t.Fatalf("%d of %d wanderers are on their own", alone, n)
	}
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Wander {
			if dx, dy := c.X-w.CoreX, c.Y-w.CoreY; dx*dx+dy*dy < wanderSpawn*wanderSpawn {
				t.Fatalf("a wanderer at %.0f,%.0f, too near the generator", c.X, c.Y)
			}
		}
	}
	// Left alone they keep away from the base.
	run(w, TickRate*20, func() bool { return false })
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Wander {
			if dx, dy := c.X-w.CoreX, c.Y-w.CoreY; dx*dx+dy*dy < (wanderKeep-2)*(wanderKeep-2) {
				t.Fatalf("a wanderer strayed to %.0f,%.0f", c.X, c.Y)
			}
		}
	}
	// Killed, they come back with time.
	for i := range w.Creeps {
		if w.Creeps[i].Wander {
			w.Creeps[i].HP = 0
		}
	}
	w.Step()
	if w.wanderers() != 0 {
		t.Fatal("dead wanderers still about")
	}
	run(w, TickRate*wanderEvery*3, func() bool { return false })
	if n := w.wanderers(); n < 2 {
		t.Fatalf("%d wanderers came back", n)
	}

	// A wave other than a tenth leaves them be, and they don't hold it open.
	if w.waveCreeps() != 0 {
		t.Fatal("wanderers count as the wave")
	}
	w.Phase, w.Wave, w.PhaseLeft = PhaseBuild, 9, Dt
	w.Creeps = w.Creeps[:0]
	w.freeIDs = w.freeIDs[:0]
	for i := MaxCreeps - 1; i >= 0; i-- {
		w.freeIDs = append(w.freeIDs, uint16(i))
	}
	w.fillWanderers()
	n = w.wanderers()
	w.Step()
	if w.Wave != 10 || w.rushAt < rushFrom {
		t.Fatalf("wave %d rushes at %.1f", w.Wave, w.rushAt)
	}
	// The tenth wave: partway in, every wanderer goes for the generator as a creep of the wave.
	run(w, TickRate*(rushFrom+rushSpread+1), func() bool { return w.rushAt == 0 })
	if w.rushAt != 0 || w.wanderers() != 0 {
		t.Fatalf("no rush: %d wanderers, rush at %.1f", w.wanderers(), w.rushAt)
	}
	if w.waveCreeps() < n {
		t.Fatalf("%d creeps of the wave, %d wanderers rushed", w.waveCreeps(), n)
	}
	if w.Phase != PhaseWave {
		t.Fatal("the wave ended under the rush")
	}
}
