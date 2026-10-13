package game

import "testing"

func TestChasersOutrunASurvivorAndSprintersOutrunASprint(t *testing.T) {
	w := New(5)
	n, sprinters := 0, 0
	for i := 0; i < 2000; i++ {
		w.Creeps, w.freeIDs = w.Creeps[:0], append(w.freeIDs[:0], 1)
		w.SpawnCreep(CRunner, 5, 5)
		n++
		if w.Creeps[0].Sprinter {
			sprinters++
		}
	}
	if sprinters < n/5 || sprinters > n/2 {
		t.Fatalf("%d of %d runners sprint", sprinters, n)
	}
	var p Player
	c := &Creep{Kind: CRunner, Sprinter: true, sprint: sprintFor, Chase: 1}
	base := Creeps[CRunner].Speed
	fast := 0
	for i := 0; i < int(sprintFor*TickRate)+5; i++ {
		c.rest()
		if c.sprintSpeed(base) > p.Speed()*sprintMul {
			fast++
		}
	}
	if fast < int(sprintFor*TickRate)-1 || fast > int(sprintFor*TickRate)+1 {
		t.Fatalf("faster than a sprinting survivor for %d ticks", fast)
	}
	if v := c.sprintSpeed(base); v != chaseSpeed || v <= p.Speed() {
		t.Fatalf("a winded sprinter chases at %v", v)
	}
	for i := 0; i < int(sprintRest*TickRate)+1; i++ {
		c.rest()
	}
	if c.sprintSpeed(base) <= p.Speed() {
		t.Fatal("no new burst after a rest")
	}
	// Every creep on a chase outruns a walking survivor, but only a sprinter a sprinting one.
	sprinting := p.Speed() * sprintMul
	if v := (&Creep{Kind: CWalker}).sprintSpeed(1.7); v <= p.Speed() || v >= sprinting {
		t.Fatalf("a plain walker chases at %v", v)
	}
	if v := (&Creep{Kind: CRunner, Sprinter: true, sprint: 1}).sprintSpeed(base); v <= sprinting {
		t.Fatalf("a sprinter's burst is %v, a sprinting survivor %v", v, sprinting)
	}
}

func TestAHitPullsACreepFromAfarWithoutAJumpToARun(t *testing.T) {
	for _, wander := range []bool{false, true} {
		w := newBare(4)
		w.Phase = PhaseWave
		w.Queue = []Spawn{{At: 1e9}}
		p, _ := w.Join("ana", "ana@example")
		p.MaxHP, p.HP = 1e6, 1e6
		// Out on open ground, the survivor twelve tiles off: past a walker's sight.
		x, y := float32(0), float32(0)
		for ty := 4; ty < w.H-4 && x == 0; ty += 3 {
			for tx := 4; tx < w.W-16; tx++ {
				if w.clearShot(float32(tx)+.5, float32(ty)+.5, float32(tx)+12.5, float32(ty)+.5) && !w.At(tx, ty).Solid() &&
					abs(tx-int(w.CoreX)) > 40 {
					x, y = float32(tx)+.5, float32(ty)+.5
					break
				}
			}
		}
		if !w.SpawnCreep(CWalker, x, y) {
			t.Fatal("no walker")
		}
		c := &w.Creeps[len(w.Creeps)-1]
		c.HP, c.MaxHP, c.Sprinter, c.Wander = 1e6, 1e6, false, wander
		c.HX, c.HY = x-20, y
		// Shot by the survivor, and set on them whatever the dice say.
		w.shooter = int8(p.ID)
		w.damage(int32(len(w.Creeps)-1), 5, int8(p.ID))
		w.shooter = -1
		c.Hunt, c.HuntLeft = int8(p.ID), 6
		fastest := float32(0)
		for i := 0; i < TickRate*2; i++ {
			p.X, p.Y = x+12, y
			p.Weapons[p.Cur].Cool = 1
			x0, y0 := c.X, c.Y
			w.Step()
			if dx, dy := c.X-x0, c.Y-y0; c.X-p.X < -Creeps[CWalker].Aggro-1 {
				fastest = max(fastest, sqrt32(dx*dx+dy*dy)*TickRate)
			}
		}
		if fastest > Creeps[CWalker].Speed*pullPace*1.3 || fastest < Creeps[CWalker].Speed {
			t.Fatalf("wander %v: a walker shot from afar comes on at up to %.2f tiles/s", wander, fastest)
		}
	}
}
