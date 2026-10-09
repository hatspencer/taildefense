package game

import (
	"math"
	"testing"
)

func TestTheGasStationIsOutByTheEdgeAndHeldHard(t *testing.T) {
	for seed := uint64(1); seed <= 40; seed++ {
		w := New(seed)
		si := w.station()
		if si < 0 {
			t.Fatalf("seed %d: no gas station", seed)
		}
		s := &w.Sites[si]
		edge := min(s.SX, s.SY, float32(w.W)-s.SX, float32(w.H)-s.SY)
		if edge > 45 || s.Tier == 0 {
			t.Errorf("seed %d: the station is %.0f tiles in from the edge, tier %d", seed, edge, s.Tier)
		}
		if s.Guard != 4 || s.Guards < 8 {
			t.Errorf("seed %d: station guard %d with %d guards", seed, s.Guard, s.Guards)
		}
		for i := range w.Creeps {
			if c := &w.Creeps[i]; c.Home == int16(si+1) && c.Kind == CBoss {
				t.Errorf("seed %d: the warlord guards the station", seed)
			}
		}
		if w.Sites[w.pumps()[0]].Guard != 0 {
			t.Errorf("seed %d: a pump is guarded", seed)
		}
	}
}

func TestShootingAPumpBlowsItAndTheOnesBesideIt(t *testing.T) {
	w := newBare(5)
	p, _ := w.Join("ana", "ana@example")
	pumps := w.pumps()
	pu := &w.Sites[pumps[0]]
	// A creep by the pump, the survivor shooting at it from a few tiles off.
	if !w.SpawnCreep(CWalker, pu.SX+.8, pu.SY+.6) {
		t.Fatal("no creep")
	}
	c := w.Creeps[len(w.Creeps)-1].ID
	p.X, p.Y = pu.SX-3, pu.SY
	hp := p.HP
	w.hitscan(int8(p.ID), p.X, p.Y, 0, 10, 10, 0, 0, 0)
	if !run(w, TickRate*2, func() bool {
		for _, i := range pumps {
			if !w.Sites[i].Searched {
				return false
			}
		}
		return true
	}) {
		t.Fatal("the pumps did not all go up")
	}
	if p.HP >= hp {
		t.Error("the blast did not hurt the survivor beside it")
	}
	for i := range w.Creeps {
		if w.Creeps[i].ID == c {
			t.Error("the creep by the pump lived")
		}
	}
	if err := w.OrderLoot(p, pumps[0]); err == nil {
		t.Error("a pump can be searched")
	}
	// A blown pump is wreckage, not a wall.
	if !CanStand(w, pu.SX, pu.SY) {
		t.Error("a blown pump still blocks")
	}
}

func TestTheStationAlwaysGivesAGun(t *testing.T) {
	for k := 0; k < 30; k++ {
		w := newBare(uint64(k + 1))
		p, _ := w.Join("bo", "bo@example")
		s := &w.Sites[w.station()]
		owned := 0
		for i := range p.Weapons {
			if p.Weapons[i].Owned {
				owned++
			}
		}
		w.searchStation(p, s)
		n := 0
		for i := range p.Weapons {
			if p.Weapons[i].Owned {
				n++
			}
		}
		if n <= owned {
			t.Fatalf("run %d: %d weapons before the search, %d after", k, owned, n)
		}
	}
}

func TestStepOntoTheForecourtSpringsTheAmbush(t *testing.T) {
	w := New(7)
	p, _ := w.Join("cy", "cy@example")
	p.HP, p.MaxHP = 1e6, 1e6
	si := w.station()
	x, y := w.forecourt()
	before := len(w.Creeps)
	p.X, p.Y = x, y+float32(onLot)-.5
	for !CanStand(w, p.X, p.Y) {
		p.X += .5
	}
	w.Step()
	if w.Sites[si].Sprung != 1 || len(w.Creeps) <= before {
		t.Fatalf("no ambush: sprung %d, %d creeps from %d", w.Sites[si].Sprung, len(w.Creeps), before)
	}
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Home == int16(si+1) && c.Asleep {
			t.Fatal("a station guard slept through the ambush")
		}
	}
}

func TestTheWarlordSlams(t *testing.T) {
	w := New(3)
	p, _ := w.Join("di", "di@example")
	p.HP, p.MaxHP = 1e6, 1e6
	var boss *Creep
	for i := range w.Creeps {
		if w.Creeps[i].Kind == CBoss && w.Creeps[i].Home > 0 {
			boss = &w.Creeps[i]
		}
	}
	if boss == nil {
		t.Fatal("no warlord")
	}
	p.X, p.Y = boss.X+3, boss.Y
	for !CanStand(w, p.X, p.Y) {
		p.X += .25
	}
	p.Order.Kind = OrderHold
	p.Weapons[p.Cur].Ammo, p.Weapons[p.Cur].Reload = 0, 1e9
	slams := 0
	run(w, TickRate*12, func() bool {
		for _, e := range w.Effects {
			if e.Kind == EffSlam && math.Abs(float64(e.Left-e.Total)) < 1e-4 {
				slams++
			}
		}
		return false
	})
	if slams < 1 {
		t.Fatal("the warlord never slammed")
	}
}
