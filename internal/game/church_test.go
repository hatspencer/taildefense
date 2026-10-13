package game

import "testing"

func TestEveryMapHasAChurchOutOnTheOutskirts(t *testing.T) {
	for seed := uint64(1); seed <= 12; seed++ {
		w := New(seed)
		n := 0
		for i := range w.Sites {
			s := &w.Sites[i]
			if s.Kind != SiteChurch {
				continue
			}
			n++
			if dx, dy := s.SX-w.CoreX, s.SY-w.CoreY; dx*dx+dy*dy < tierMid*tierMid {
				t.Errorf("seed %d: the church is %.0f tiles from the generator", seed, sqrt32(dx*dx+dy*dy))
			}
			if !CanStand(w, s.SX, s.SY) || w.flow.dist[int(s.SY)*w.W+int(s.SX)] >= unreachable {
				t.Errorf("seed %d: the bell rope can't be got to", seed)
			}
		}
		if n != 1 {
			t.Errorf("seed %d: %d churches", seed, n)
		}
	}
}

func TestTheBellDrawsEverythingToTheChurch(t *testing.T) {
	w := New(3)
	w.PhaseLeft = 1e6
	ci := -1
	for i := range w.Sites {
		if w.Sites[i].Kind == SiteChurch {
			ci = i
		}
	}
	if ci < 0 {
		t.Fatal("no church")
	}
	ch := &w.Sites[ci]
	if ch.Guard != 0 {
		t.Fatalf("the church is guarded (%d)", ch.Guard)
	}
	p, _ := w.Join("ana", "ana@example")
	p.MaxHP, p.HP = 1e6, 1e6
	far := func(c *Creep) float32 { return sqrt32((c.X-ch.SX)*(c.X-ch.SX) + (c.Y-ch.SY)*(c.Y-ch.SY)) }
	// Nothing wandering through the churchyard to set the ringer back.
	for i := range w.Creeps {
		if far(&w.Creeps[i]) < 25 {
			w.Creeps[i].HP = 0
		}
	}
	w.reap()
	// A sleeping guard of another site, a wanderer, and a creep of the waves.
	ids := map[string]uint16{}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		switch {
		case c.Home > 0 && c.Asleep && ids["guard"] == 0 && far(c) > 40:
			ids["guard"] = c.ID
		case c.Wander && ids["wanderer"] == 0 && far(c) > 40:
			ids["wanderer"] = c.ID
		}
	}
	// Out on its way in, not inside the walls breaking out.
	sp := w.SpawnPts[0]
	for _, q := range w.SpawnPts {
		if dx, dy := q[0]-ch.SX, q[1]-ch.SY; dx*dx+dy*dy > 60*60 && dx*dx+dy*dy < 200*200 {
			sp = q
		}
	}
	if !w.SpawnCreep(CWalker, sp[0], sp[1]) {
		t.Fatal("no walker")
	}
	ids["walker"] = w.Creeps[len(w.Creeps)-1].ID
	byID := func(id uint16) *Creep {
		for i := range w.Creeps {
			if w.Creeps[i].ID == id {
				return &w.Creeps[i]
			}
		}
		return nil
	}
	before := map[string]float32{}
	for k, id := range ids {
		if id == 0 {
			t.Fatalf("no %s to try it on", k)
		}
		c := byID(id)
		c.HP, c.MaxHP = 1e6, 1e6
		before[k] = far(c)
	}
	p.X, p.Y = ch.SX, ch.SY
	if err := w.OrderLoot(p, ci); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < TickRate*4 && w.bell.left <= 0; i++ {
		w.Step()
	}
	if w.bell.left <= 0 || !ch.Searched {
		t.Fatal("pulling the rope didn't ring the bell")
	}
	if err := w.OrderLoot(p, ci); err == nil {
		t.Fatal("the bell rang again while still swinging")
	}
	// The ringer goes home, out of the way.
	p.X, p.Y = w.CoreX, w.CoreY+6
	p.Order = Order{}
	for i := 0; i < TickRate*20; i++ {
		w.Step()
	}
	for k, id := range ids {
		c := byID(id)
		if c == nil {
			t.Fatalf("the %s is gone", k)
		}
		if got := far(c); got > before[k]-20 {
			t.Errorf("the %s came from %.0f to only %.0f tiles off the church", k, before[k], got)
		}
	}
	for i := 0; i < TickRate*bellRest; i++ {
		w.Step()
	}
	if ch.Searched || byID(ids["walker"]) != nil && byID(ids["walker"]).lured {
		t.Fatal("the bell never settled")
	}
}
