package game

import "testing"

// A survivor's hit stops a creep for a moment, its windup held; a second hit straight after
// does not, and a turret's never does.
func TestHitsStunCreepsForAMoment(t *testing.T) {
	w := New(5)
	w.PhaseLeft = 1e6
	w.Creeps, w.freeIDs = w.Creeps[:0], append(w.freeIDs[:0], 1)
	w.SpawnCreep(CWalker, w.CoreX+40, w.CoreY)
	c := &w.Creeps[0]
	c.HP = 1e6
	w.Step()
	x, y := c.X, c.Y
	c.Cool = .3
	w.damage(0, 5, 0)
	stopped := 0
	for i := 0; i < TickRate; i++ {
		w.Step()
		if c.X == x && c.Y == y {
			stopped++
		}
		x, y = c.X, c.Y
		if i == 0 && c.Cool != .3 {
			t.Fatal("a stunned creep's attack kept coming")
		}
		if i == 1 {
			w.damage(0, 5, 0) // too soon to stun again
		}
	}
	if want := int(stunFor * TickRate); stopped < want-1 || stopped > want+1 {
		t.Fatalf("stopped for %d ticks, want about %d", stopped, want)
	}
	w.turretFire = true
	w.damage(0, 5, 0)
	w.turretFire = false
	if c.stunLeft > 0 {
		t.Fatal("a turret stunned a creep")
	}
	w.damage(0, 5, -1)
	if c.stunLeft > 0 {
		t.Fatal("a hit from nobody stunned a creep")
	}
	w.damage(0, 5, 0)
	if c.stunLeft <= 0 {
		t.Fatal("no stun once the last had worn off")
	}
}

// A shotgun's load stops a creep longer than any other gun's hit.
func TestTheShotgunStunsLonger(t *testing.T) {
	w := New(5)
	w.Creeps, w.freeIDs = w.Creeps[:0], append(w.freeIDs[:0], 1)
	w.SpawnCreep(CWalker, w.CoreX+40, w.CoreY)
	c := &w.Creeps[0]
	w.damage(0, 5, 0)
	plain := c.stunLeft
	c.stunLeft, c.stunCool = 0, 0
	w.slug = true
	w.damage(0, 5, 0)
	w.slug = false
	if c.stunLeft < plain*2 {
		t.Fatalf("a shotgun stunned for %.2fs, another gun %.2fs", c.stunLeft, plain)
	}
}

// A creep's blow stops a survivor where they stand for a moment, a brute's for longer; a
// second blow straight after does not.
func TestBlowsSlowSurvivors(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	// walked is how far a survivor holding a key gets in a second after a blow from k.
	walked := func(k CreepKind, hit bool) float32 {
		p.X, p.Y, p.HP = w.CoreX+.5, w.CoreY+6, p.MaxHP
		p.slowLeft, p.slowCool = 0, 0
		if hit {
			p.slow(playerSlow[k])
		}
		x0 := p.X
		for i := 0; i < TickRate; i++ {
			w.Steer(p, 0, true) // the key held down
			w.stepPlayers()
			if i == 1 && hit {
				p.slow(playerSlow[k]) // too soon to slow again
			}
		}
		return p.X - x0
	}
	free, walker, brute := walked(CWalker, false), walked(CWalker, true), walked(CBrute, true)
	if walker <= 0 || walker >= free*.95 {
		t.Fatalf("after a walker's blow a survivor walked %.2f, unhurt %.2f", walker, free)
	}
	if brute <= 0 || brute >= walker {
		t.Fatalf("after a brute's blow a survivor walked %.2f, after a walker's %.2f", brute, walker)
	}
}

func TestSlamsStunSurvivorsTheBossLongest(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	p.MaxHP = 1000
	// stopped is how many ticks a survivor holding a key stands still after a slam of kind k.
	stopped := func(k CreepKind) int {
		p.X, p.Y, p.HP, p.stunLeft = w.CoreX+.5, w.CoreY+6, p.MaxHP, 0
		w.slamLands(&Effect{Kind: EffSlam, X: p.X - 1, Y: p.Y, R: slams[k].radius, Damage: slams[k].hurt})
		if p.HP > p.MaxHP-slams[k].hurt*.5 {
			t.Fatalf("%v's slam hurt only %.0f", k, p.MaxHP-p.HP)
		}
		n := 0
		for i := 0; i < TickRate*4; i++ {
			x0 := p.X
			w.Steer(p, 0, true)
			w.stepPlayers()
			if p.X != x0 {
				break
			}
			n++
		}
		return n
	}
	brute, boss := stopped(CBrute), stopped(CBoss)
	if brute < TickRate || boss <= brute {
		t.Fatalf("stopped %d ticks by a brute's slam, %d by the abomination's", brute, boss)
	}
	p.stun(1)
	if err := w.Cast(p, 0, p.X+3, p.Y); err == nil {
		t.Fatal("cast while stunned")
	}
}

func TestAHurlerSlowsFromFarOff(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	p.MaxHP, p.HP = 1000, 1000
	// Out on open ground, a hurler eleven tiles off: far past a spitter's reach.
	x, y := float32(0), float32(0)
	for ty := 4; ty < w.H-4 && x == 0; ty += 3 {
		for tx := 4; tx < w.W-16; tx++ {
			if w.clearShot(float32(tx)+.5, float32(ty)+.5, float32(tx)+11.5, float32(ty)+.5) && !w.At(tx, ty).Solid() && !w.At(tx+11, ty).Solid() &&
				abs(tx-int(w.CoreX)) > 40 {
				x, y = float32(tx)+.5, float32(ty)+.5
				break
			}
		}
	}
	p.X, p.Y = x+11, y
	if !w.SpawnCreep(CHurler, x, y) {
		t.Fatal("no hurler")
	}
	// Tough enough to outlast the survivor's return fire.
	c := &w.Creeps[len(w.Creeps)-1]
	c.HP, c.MaxHP = 1e6, 1e6
	shard := false
	for i := 0; i < TickRate*8 && p.slowLeft <= 0; i++ {
		p.X, p.Y = x+11, y
		w.Step()
		for _, tr := range w.Tracers {
			shard = shard || tr.Kind == TracerShard
		}
	}
	if p.slowLeft < 1 || p.HP >= p.MaxHP || !shard {
		t.Fatalf("after a hurler's throw: slowed %.2fs, hp %.0f, shard drawn %v", p.slowLeft, p.HP, shard)
	}
}
