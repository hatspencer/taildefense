package game

import (
	"testing"
)

func TestEverySpawnPointReachesTheGenerator(t *testing.T) {
	for seed := uint64(1); seed <= 20; seed++ {
		w := newBare(seed)
		if len(w.SpawnPts) < 4 {
			t.Errorf("seed %d: only %d spawn points reach the generator", seed, len(w.SpawnPts))
		}
	}
}

func TestTheBaseIsWalledWithGatesAndTheGeneratorIsReachable(t *testing.T) {
	w := newBare(7)
	gates, walls := 0, 0
	for _, s := range w.Structs {
		switch s.Kind {
		case SGate:
			gates++
		case SWall:
			walls++
		}
	}
	if gates != 12 || walls < 70 {
		t.Errorf("gates %d walls %d", gates, walls)
	}
	// From the map edge the field must lead into the generator, through a structure or not.
	sp := w.SpawnPts[0]
	i := int32(int(sp[1])*w.W + int(sp[0]))
	for steps := 0; steps < 2000; steps++ {
		n := w.flow.next[i]
		if n < 0 {
			if w.structAt[i] < 0 || int(w.structAt[i]) != w.Core {
				t.Fatalf("the field ends at tile %d, not the generator", i)
			}
			return
		}
		i = n
	}
	t.Fatal("the field never reached the generator")
}

func TestSpatialGridFindsEveryCreepOnce(t *testing.T) {
	w := newBare(3)
	for i := 0; i < 3000; i++ {
		w.SpawnCreep(CWalker, float32(5+i%300), float32(5+(i*7)%190))
	}
	w.grid.build(w.Creeps)
	seen := make([]int, len(w.Creeps))
	w.grid.each(float32(w.W)/2, float32(w.H)/2, float32(w.W), func(i int32) bool {
		seen[i]++
		return true
	})
	for i, n := range seen {
		if n != 1 {
			t.Fatalf("creep %d seen %d times", i, n)
		}
	}
}

func TestAWaveIsPlayedThroughAndPaysOut(t *testing.T) {
	w := newBare(11)
	p, err := w.Join("ana", "ana@example")
	if err != nil {
		t.Fatal(err)
	}
	w.PhaseLeft = Dt
	w.Step()
	if w.Phase != PhaseWave || w.Wave != 1 {
		t.Fatalf("phase %v wave %d", w.Phase, w.Wave)
	}
	gold := p.Gold
	for i := 0; i < TickRate*240 && w.Phase == PhaseWave; i++ {
		w.Step()
	}
	if w.Phase != PhaseBuild {
		t.Fatalf("wave 1 did not end in 4 minutes: %d creeps left, phase %v", len(w.Creeps), w.Phase)
	}
	if p.Gold <= gold {
		t.Errorf("no gold earned: %d -> %d", gold, p.Gold)
	}
	if w.TotalKills == 0 {
		t.Error("nothing was killed")
	}
}

func TestShopAndBuild(t *testing.T) {
	w := newBare(5)
	p, _ := w.Join("bo", "bo@example")
	p.Gold = 100000
	if err := w.BuyWeapon(p, WShotgun); err == nil {
		t.Fatal("bought away from the armory")
	}
	a := &w.Structs[w.Armory]
	p.X, p.Y = a.CX(), a.CY()+2
	if err := w.BuyWeapon(p, WShotgun); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxLevel; i++ {
		if err := w.Upgrade(p, WShotgun, TrackSpecial); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Upgrade(p, WShotgun, TrackSpecial); err == nil {
		t.Fatal("upgraded past the maximum")
	}
	if got := WeaponStats(WShotgun, p.Weapons[WShotgun].Lv).Pellets; got != 17 {
		t.Errorf("pellets %d", got)
	}
	x, y := int(p.X)+1, int(p.Y)+2
	if err := w.Build(p, STurretTesla, x, y); err != nil {
		t.Fatal(err)
	}
	if w.StructKindAt(x, y) != STurretTesla {
		t.Fatal("no tesla coil")
	}
	si := w.StructAt(x, y)
	if err := w.UpgradeStruct(p, si); err != nil || w.Structs[si].Level != 2 {
		t.Fatalf("upgrade: %v", err)
	}
	if _, err := w.Sell(p, si); err != nil || w.StructAt(x, y) >= 0 {
		t.Fatalf("sell: %v", err)
	}
}

func TestPlayersCannotWalkThroughWallsButThroughGates(t *testing.T) {
	w := newBare(9)
	var wall, gate *Structure
	for i := range w.Structs {
		s := &w.Structs[i]
		if s.Kind == SWall && wall == nil {
			wall = s
		}
		if s.Kind == SGate && gate == nil {
			gate = s
		}
	}
	if CanStand(w, wall.CX(), wall.CY()) {
		t.Error("stood inside a wall")
	}
	if !CanStand(w, gate.CX(), gate.CY()) {
		t.Error("could not stand in a gate")
	}
}

// The scale the game is built for: thousands of creeps converging on the base.
func benchCreeps(b *testing.B, n int) {
	w := newBare(42)
	for i := 0; i < 4; i++ {
		w.Join("p", string(rune('a'+i)))
	}
	w.Phase = PhaseWave
	w.Wave = 12
	w.Queue = []Spawn{{At: 1e9}}
	for i := 0; i < n; i++ {
		sp := w.SpawnPts[i%len(w.SpawnPts)]
		w.SpawnCreep(CreepKind(i%3), sp[0]+float32(i%7)-3, sp[1]+float32(i%5)-2)
	}
	for i := 0; i < 100; i++ {
		w.Step()
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		w.Step()
	}
	b.ReportMetric(float64(len(w.Creeps)), "creeps")
}

func BenchmarkStep1000(b *testing.B) { benchCreeps(b, 1000) }
func BenchmarkStep5000(b *testing.B) { benchCreeps(b, 5000) }
