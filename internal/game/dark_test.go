package game

import "testing"

// At night the whole base is in sight, a survivor sees a small pool round them (twice as far
// with a rifle), and a turret out on its own sees a little past what it shoots.
func TestWhatIsInSightAtNight(t *testing.T) {
	w := NewGame(5, DiffHard)
	p, _ := w.Join("ana", "ana@example")
	p.X, p.Y = w.CoreX+60, w.CoreY
	var tur *Structure
	for i := range w.Structs {
		if Structs[w.Structs[i].Kind].Turret {
			tur = &w.Structs[i]
			break
		}
	}
	tur.X, tur.Y = int16(w.CoreX)-80, int16(w.CoreY)
	rng := TurretStats(tur.Kind, tur.Lv).Range
	w.Weather, w.WeatherAmt = WClear, 0
	w.discover()
	lit := func(x, y float32) bool {
		c := Creep{X: x, Y: y}
		return !w.hidden(&c)
	}
	dark := w.diff().Dark
	for _, c := range []struct {
		x, y float32
		want bool
		what string
	}{
		{w.CoreX + BuildRadius - 1, w.CoreY, true, "the edge of the base"},
		{w.CoreX, w.CoreY - BuildRadius + 1, true, "the far side of the base"},
		{w.CoreX + BuildRadius + 3, w.CoreY + 8, false, "just outside the base"},
		{p.X + dark - 1, p.Y, true, "next to the survivor"},
		{p.X + dark + 1, p.Y, false, "past the survivor's sight"},
		{tur.CX() + rng + 1, tur.CY(), true, "just past the turret's range"},
		{tur.CX() + rng + 3, tur.CY(), false, "well past the turret's range"},
	} {
		if lit(c.x, c.y) != c.want {
			t.Fatalf("%s: in sight %v", c.what, !c.want)
		}
	}
	p.Cur = WRifle
	w.discover()
	if !lit(p.X+2*dark-1, p.Y) {
		t.Fatal("the rifle's scope sees no further")
	}
}

// Brutal's night: a small pool round the survivor and a flashlight's beam down their aim,
// twice as long with a rifle's scope, and nothing behind them past the pool.
func TestBrutalFlashlight(t *testing.T) {
	w := NewGame(5, DiffBrutal)
	p, _ := w.Join("ana", "ana@example")
	p.X, p.Y, p.Aim = w.CoreX+60.5, w.CoreY+.5, 0
	w.Weather, w.WeatherAmt = WClear, 0
	lit := func(x, y float32) bool {
		c := Creep{X: x, Y: y}
		return !w.hidden(&c)
	}
	d := w.diff()
	w.discover()
	for _, c := range []struct {
		x, y float32
		want bool
		what string
	}{
		{p.X - d.Dark + 1, p.Y, true, "just behind the survivor"},
		{p.X - d.Dark - 1, p.Y, false, "behind, past the pool"},
		{p.X, p.Y + d.Dark + 1, false, "to the side, past the pool"},
		{p.X + d.Cone - 1, p.Y, true, "down the beam"},
		{p.X + d.Cone + 1, p.Y, false, "past the beam's reach"},
		{p.X + d.Cone - 1, p.Y + d.Cone/2, false, "outside the beam"},
	} {
		if lit(c.x, c.y) != c.want {
			t.Fatalf("%s: in sight %v", c.what, !c.want)
		}
	}
	p.Cur = WRifle
	w.discover()
	if !lit(p.X+2*d.Cone-1, p.Y) || lit(p.X-d.Dark-1, p.Y) {
		t.Fatal("the rifle's scope should lengthen the beam, not the pool")
	}
}

// Night vision goggles cost a fortune, are sold only where there is a night, and give back
// daytime sight all round in place of brutal's flashlight.
func TestNightVisionGoggles(t *testing.T) {
	day := NewGame(5, DiffNormal)
	q, _ := day.Join("bo", "bo@example")
	q.X, q.Y, q.Gold = day.CoreX, day.CoreY, 1e6
	if day.atArmory(q) && day.BuyGoggles(q) == nil {
		t.Fatal("goggles sold where there is no night")
	}

	w := NewGame(5, DiffBrutal)
	p, _ := w.Join("ana", "ana@example")
	for i := range w.Structs {
		if w.Structs[i].Kind == SArmory {
			p.X, p.Y = w.Structs[i].CX(), w.Structs[i].CY()
		}
	}
	p.Gold = gogglesCost - 1
	if w.BuyGoggles(p) == nil {
		t.Fatal("goggles sold for less than they cost")
	}
	p.Gold = gogglesCost
	if err := w.BuyGoggles(p); err != nil || !p.Goggles || p.Gold != 0 {
		t.Fatalf("buying goggles: %v, worn %v, gold left %d", err, p.Goggles, p.Gold)
	}
	if w.BuyGoggles(p) == nil {
		t.Fatal("a second pair sold")
	}
	p.X, p.Y, p.Aim = w.CoreX+60.5, w.CoreY+.5, 0
	w.Weather, w.WeatherAmt = WClear, 0
	w.discover()
	lit := func(x, y float32) bool {
		c := Creep{X: x, Y: y}
		return !w.hidden(&c)
	}
	if !lit(p.X-daySight+1, p.Y) || !lit(p.X, p.Y+daySight-1) || lit(p.X+daySight+1, p.Y) {
		t.Fatal("goggles should see daytime sight all round and no beam past it")
	}
}

// At night a survivor's bullet goes through what nobody can see: a rifle shot down a line
// misses the creep out in the dark and hits the one in sight, and by day it hits both.
func TestNightShotsOnlyFindWhatIsSeen(t *testing.T) {
	for _, d := range []Difficulty{DiffNormal, DiffHard} {
		w := NewGame(5, d)
		w.PhaseLeft = 1e6
		for _, c := range w.Creeps {
			w.freeIDs = append(w.freeIDs, c.ID)
		}
		w.Creeps = w.Creeps[:0]
		p, _ := w.Join("ana", "ana@example")
		p.X, p.Y = w.CoreX+40, w.CoreY
		for x := p.X - 1; x < p.X+20; x++ {
			w.Terrain[int(p.Y)*w.W+int(x)] = TGrass
		}
		w.SpawnCreep(CWalker, p.X+3, p.Y)
		w.SpawnCreep(CWalker, p.X+15, p.Y)
		for i := range w.Creeps {
			w.Creeps[i].HP, w.Creeps[i].MaxHP, w.Creeps[i].Asleep = 1e6, 1e6, true
		}
		w.discover()
		w.grid.build(w.Creeps)
		w.hitscan(int8(p.ID), p.X, p.Y, 0, 28, 10, 5, 0, 0, plainShot)
		near, far := w.Creeps[0].HP < 1e6, w.Creeps[1].HP < 1e6
		if !near {
			t.Fatalf("%s: the creep in sight was missed", d)
		}
		if night := w.diff().Dark > 0; far == night {
			t.Fatalf("%s: the creep out in the dark hit: %v", d, far)
		}
		// With only the one in the dark left, a gun at night has nothing to aim at.
		w.Creeps[0].X = p.X - 30
		w.grid.build(w.Creeps)
		if got := w.nearestSeen(p.X, p.Y, 28); (got < 0) != (w.diff().Dark > 0) {
			t.Fatalf("%s: picked target %d", d, got)
		}
	}
}
