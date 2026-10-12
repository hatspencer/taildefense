package game

import "testing"

func TestSprintersOutrunASurvivorInBursts(t *testing.T) {
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
		if c.sprintSpeed(base) > p.Speed() {
			fast++
		}
	}
	if fast < int(sprintFor*TickRate)-1 || fast > int(sprintFor*TickRate)+1 {
		t.Fatalf("faster than a survivor for %d ticks", fast)
	}
	if c.sprintSpeed(base) != base {
		t.Fatal("no rest after a burst")
	}
	for i := 0; i < int(sprintRest*TickRate)+1; i++ {
		c.rest()
	}
	if c.sprintSpeed(base) <= p.Speed() {
		t.Fatal("no new burst after a rest")
	}
	if (&Creep{Kind: CWalker}).sprintSpeed(1.7) != 1.7 {
		t.Fatal("a plain walker sprints")
	}
}
