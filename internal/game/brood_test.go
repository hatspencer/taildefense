package game

import "testing"

// openRow finds open ground far from the base with a clear run of n tiles east of it.
func openRow(w *World, n int) (float32, float32) {
	for ty := 4; ty < w.H-4; ty += 3 {
		for tx := 4; tx < w.W-n-4; tx++ {
			if abs(tx-int(w.CoreX)) > 40 && w.clearShot(float32(tx)+.5, float32(ty)+.5, float32(tx+n)+.5, float32(ty)+.5) &&
				!w.At(tx, ty).Solid() && !w.At(tx+n, ty).Solid() {
				return float32(tx) + .5, float32(ty) + .5
			}
		}
	}
	return 0, 0
}

func TestTheBroodmotherLobsBileThatBurnsAndHatches(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	p.MaxHP, p.HP = 1e4, 1e4
	p.Weapons[p.Cur].Ammo, p.Weapons[p.Cur].Reload = 0, 1e9
	x, y := openRow(w, 10)
	if x == 0 {
		t.Fatal("no open ground")
	}
	if !w.SpawnCreep(CMother, x, y) {
		t.Fatal("no broodmother")
	}
	sx, sy := x+10, y
	lobbed, acid := false, false
	swarm := 0
	for i := 0; i < TickRate*5; i++ {
		p.X, p.Y = sx, sy
		w.Step()
		for _, e := range w.Effects {
			lobbed = lobbed || e.Kind == EffBile && e.X == sx && e.Y == sy
			acid = acid || e.Kind == EffAcid
		}
		n := 0
		for j := range w.Creeps {
			if w.Creeps[j].Kind == CSwarmer {
				n++
			}
		}
		swarm = max(swarm, n)
	}
	if !lobbed || !acid || swarm < bileHatch || p.HP > p.MaxHP-bileHurt*.5 {
		t.Fatalf("lobbed %v, acid %v, %d swarmers, hp lost %.0f", lobbed, acid, swarm, p.MaxHP-p.HP)
	}
	// A survivor who keeps moving is clear of it.
	w.Effects = w.Effects[:0]
	w.Effects = append(w.Effects, Effect{Kind: EffBile, X: sx, Y: sy, R: bileR, Left: Dt, Total: 1, Damage: bileHurt, Owner: -1})
	p.X, p.HP = sx+bileR+1, p.MaxHP
	w.stepEffects()
	if p.HP != p.MaxHP {
		t.Fatal("hurt outside the splash")
	}
}

func TestTheBroodmotherSplitsOpenEachQuarter(t *testing.T) {
	w := newBare(4)
	x, y := openRow(w, 4)
	w.SpawnCreep(CMother, x, y)
	m := len(w.Creeps) - 1
	count := func() int {
		n := 0
		for j := range w.Creeps {
			if w.Creeps[j].Kind == CSwarmer {
				n++
			}
		}
		return n
	}
	w.Creeps[m].HP = w.Creeps[m].MaxHP * .8
	w.stepBrood()
	if count() != 0 {
		t.Fatal("split before a quarter was lost")
	}
	w.Creeps[m].HP = w.Creeps[m].MaxHP * .45
	w.stepBrood()
	w.stepBrood()
	if count() != 2*broodBurst {
		t.Fatalf("%d swarmers at under half her life", count())
	}
}

func TestBossWavesTakeTurns(t *testing.T) {
	w := newBare(4)
	bosses := func(wave int) (abom, mother int) {
		for _, s := range w.plan(wave, 1) {
			switch s.Kind {
			case CBoss:
				abom++
			case CMother:
				mother++
			}
		}
		return
	}
	if a, m := bosses(10); a != 1 || m != 0 {
		t.Fatalf("wave 10: %d abominations, %d broodmothers", a, m)
	}
	if a, m := bosses(20); a != 1 || m != 1 {
		t.Fatalf("wave 20: %d abominations, %d broodmothers", a, m)
	}
	if a, m := bosses(9); a+m != 0 {
		t.Fatal("a boss on wave 9")
	}
}
