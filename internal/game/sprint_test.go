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
