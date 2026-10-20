package game

import "testing"

func TestTheBreakForetellsTheNextWave(t *testing.T) {
	w := newBare(7)
	for wave := 1; wave <= 30; wave++ {
		w.Wave = wave - 1
		w.forecast()
		a := w.NextAffix
		switch {
		case wave < affixFrom || wave%10 == 0:
			if a != 0 {
				t.Fatalf("wave %d has affixes %v", wave, a)
			}
		case wave >= affixTwo:
			if n := popcount(uint8(a)); n != 2 {
				t.Fatalf("wave %d has %d affixes", wave, n)
			}
		default:
			if n := popcount(uint8(a)); n != 1 {
				t.Fatalf("wave %d has %d affixes", wave, n)
			}
		}
		if w.NextFrom == 0 {
			t.Fatalf("wave %d's sides unsaid on normal", wave)
		}
	}
	w.Wave = 6
	w.forecast()
	want := w.NextAffix
	w.startWave()
	if w.Affix != want || w.NextAffix != 0 {
		t.Fatalf("wave 7 was forecast %v and came %v", want, w.Affix)
	}
}

func popcount(v uint8) int {
	n := 0
	for ; v != 0; v &= v - 1 {
		n++
	}
	return n
}

func TestASapperBlowsUpAgainstTheMaze(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	wallRow(w, cx-14, cx+14, cy-24)
	w.updateFlow()
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-34)
	w.Creeps[0].Aff = AffixSappers
	id := w.Creeps[0].ID
	gone := func() bool {
		for i := range w.Creeps {
			if w.Creeps[i].ID == id {
				return false
			}
		}
		return true
	}
	run(w, TickRate*30, gone)
	if !gone() {
		t.Fatal("the sapper never went off")
	}
	if hurt(w) == 0 {
		t.Fatal("the sapper went off and no wall is hurt")
	}
}

func TestASplitterBurstsIntoSwarmers(t *testing.T) {
	w := mazeWorld(t)
	n := len(w.Creeps)
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-34)
	w.Creeps[n].Aff = AffixSplitters
	w.Creeps[n].HP = 0
	w.reap()
	swarm := 0
	for i := range w.Creeps {
		if w.Creeps[i].Kind == CSwarmer {
			swarm++
		}
	}
	if len(w.Creeps) != n+splitInto || swarm < splitInto {
		t.Fatalf("a splitter left %d creeps of %d, %d swarmers", len(w.Creeps), n, swarm)
	}
}

func TestArmouredCreepsShrugOffMore(t *testing.T) {
	w := mazeWorld(t)
	n := len(w.Creeps)
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-34)
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-36)
	w.Creeps[n+1].Aff = AffixArmoured
	w.damage(int32(n), 10, -1)
	w.damage(int32(n+1), 10, -1)
	if a, b := w.Creeps[n].MaxHP-w.Creeps[n].HP, w.Creeps[n+1].MaxHP-w.Creeps[n+1].HP; b >= a {
		t.Fatalf("armoured took %.1f, plain %.1f", b, a)
	}
}
