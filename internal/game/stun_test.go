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
func TestBlowsStunSurvivors(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	stopped := func(k CreepKind) int {
		p.X, p.Y, p.HP = w.CoreX+.5, w.CoreY+6, p.MaxHP
		p.stunLeft, p.stunCool = 0, 0
		p.stun(playerStun[k])
		n := 0
		for i := 0; i < TickRate; i++ {
			w.Steer(p, 0, true) // the key held down
			x := p.X
			w.stepPlayers()
			if i == 1 {
				p.stun(playerStun[k]) // too soon to stun again
			}
			if p.X == x {
				n++
			}
		}
		return n
	}
	walker, brute := stopped(CWalker), stopped(CBrute)
	if want := int(playerStun[CWalker] * TickRate); walker < want-1 || walker > want+1 {
		t.Fatalf("a walker's blow stopped a survivor for %d ticks, want about %d", walker, want)
	}
	if brute < walker*2 {
		t.Fatalf("a brute's blow stopped a survivor %d ticks, a walker's %d", brute, walker)
	}
}
