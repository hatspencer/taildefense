package game

import "testing"

func guardedSite(t *testing.T, w *World) int {
	t.Helper()
	for i, s := range w.Sites {
		if s.Guards > 0 && s.Kind != SiteHouse {
			return i
		}
	}
	t.Fatal("no guarded site")
	return -1
}

func TestGuardsSleepWakeBlockTheSearchAndGoHome(t *testing.T) {
	w := New(5)
	n := 0
	var lv [4]int
	for _, s := range w.Sites {
		n += int(s.Guards)
		lv[s.Guard]++
	}
	if n < 100 || lv[0] == 0 || lv[3] == 0 {
		t.Fatalf("%d guards, levels %v", n, lv)
	}
	si := guardedSite(t, w)
	s := &w.Sites[si]
	p, _ := w.Join("gil", "gil@example")
	p.HP, p.MaxHP = 1e6, 1e6
	w.Step()
	for i := range w.Creeps {
		if !w.Creeps[i].Asleep {
			t.Fatal("a guard is awake with nobody near")
		}
	}
	if err := w.OrderLoot(p, si); err == nil {
		t.Fatal("searched a guarded site")
	}
	// Walk up: they wake and come for the survivor, who holds fire.
	p.X, p.Y = s.SX+3, s.SY
	p.Order.Kind = OrderHold
	p.Weapons[p.Cur].Ammo, p.Weapons[p.Cur].Reload = 0, 1e9
	w.Step()
	awake := 0
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Home == int16(si+1) && !c.Asleep {
			awake++
		}
	}
	if awake == 0 {
		t.Fatal("no guard woke")
	}
	// Lead them far off: they give up and sleep at home again.
	p.X, p.Y = w.CoreX, w.CoreY+4
	run(w, TickRate*30, func() bool { return false })
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Home == int16(si+1) && !c.Asleep {
			t.Fatalf("guard at %.1f,%.1f still awake, home %.1f,%.1f", c.X, c.Y, c.HX, c.HY)
		}
	}
	// Kill them all and the site opens.
	for i := range w.Creeps {
		if w.Creeps[i].Home == int16(si+1) {
			w.Creeps[i].HP = 0
		}
	}
	w.Step()
	if s.Guards != 0 {
		t.Fatalf("guards %d", s.Guards)
	}
	p.X, p.Y = s.SX, s.SY
	if err := w.OrderLoot(p, si); err != nil {
		t.Fatal(err)
	}
}

func TestAWaveEndsWithGuardsAlive(t *testing.T) {
	w := New(6)
	w.Join("ana", "ana@example")
	w.PhaseLeft = 0
	w.Step()
	w.Queue = w.Queue[:0]
	for i := range w.Creeps {
		if w.Creeps[i].Home == 0 {
			w.Creeps[i].HP = 0
		}
	}
	w.Step()
	w.Step()
	if w.Phase != PhaseBuild {
		t.Fatalf("phase %v with %d guards left", w.Phase, len(w.Creeps))
	}
}

func TestTauntPullsCreepsOntoTheTaunter(t *testing.T) {
	w := newBare(7)
	p, _ := w.Join("ana", "ana@example")
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	x, y := p.X+40, p.Y
	for x < float32(w.W-2) && !CanStand(w, x, y) {
		x++
	}
	p.X, p.Y = x, y
	for i := 0; i < 5; i++ {
		w.SpawnCreep(CWalker, x+8, y+float32(i)*.5)
	}
	w.Step()
	if err := w.Taunt(p); err != nil {
		t.Fatal(err)
	}
	if err := w.Taunt(p); err == nil {
		t.Fatal("taunted twice in a row")
	}
	w.Step()
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Hunt != int8(p.ID) || c.Chase != int8(p.ID) {
			t.Fatalf("creep %d hunts %d, chases %d", i, c.Hunt, c.Chase)
		}
	}
	if p.Emote != 1 {
		t.Error("no taunt emote")
	}
}

func TestADownedSurvivorCanBeRevivedWhereTheyFell(t *testing.T) {
	w := newBare(8)
	a, _ := w.Join("ana", "ana@example")
	b, _ := w.Join("bo", "bo@example")
	w.Step()
	w.hurtPlayer(b, 1e6)
	if b.Alive || b.Respawn != Difficulties[DiffNormal].Revive {
		t.Fatalf("alive %v, respawn %.1f", b.Alive, b.Respawn)
	}
	bx, by := b.X, b.Y
	if err := w.OrderRevive(a, int(b.ID)); err != nil {
		t.Fatal(err)
	}
	if !run(w, TickRate*6, func() bool { return b.Alive }) {
		t.Fatalf("not revived; order %v channel %.2f", a.Order.Kind, a.Search)
	}
	if b.X != bx || b.Y != by || b.HP > b.MaxHP*(reviveHP+.05) {
		t.Errorf("revived at %.1f,%.1f with %.0f hp", b.X, b.Y, b.HP)
	}
	if err := w.OrderRevive(a, int(b.ID)); err == nil {
		t.Error("revived someone standing")
	}
	// Left alone, a downed survivor is back at the base when the window closes.
	w.hurtPlayer(b, 1e6)
	run(w, int(TickRate*(Difficulties[DiffNormal].Revive+.5)), func() bool { return false })
	if !b.Alive || b.HP != b.MaxHP {
		t.Error("did not respawn at the base")
	}
}

func TestWeatherComesAndGoesAndFogShortensRange(t *testing.T) {
	w := newBare(9)
	p, _ := w.Join("ana", "ana@example")
	clear := w.playerStats(p).Range
	w.weatherNext = WFog
	run(w, TickRate*(weatherFade+1), func() bool { return false })
	if w.Weather != WFog || w.WeatherAmt < .99 {
		t.Fatalf("weather %v %.2f", w.Weather, w.WeatherAmt)
	}
	if got := w.playerStats(p).Range; got >= clear*.8 {
		t.Errorf("range %.1f in fog, %.1f clear", got, clear)
	}
	w.weatherNext = WClear
	run(w, TickRate*(weatherFade+1), func() bool { return false })
	if w.Weather != WClear || w.WeatherAmt != 0 {
		t.Fatalf("weather %v %.2f", w.Weather, w.WeatherAmt)
	}
}

func TestDifficultyScalesCreepsAndParses(t *testing.T) {
	easy, brutal := NewGame(1, DiffEasy), NewGame(1, DiffBrutal)
	easy.SpawnCreep(CWalker, 10, 10)
	brutal.SpawnCreep(CWalker, 10, 10)
	if e, b := easy.Creeps[len(easy.Creeps)-1].HP, brutal.Creeps[len(brutal.Creeps)-1].HP; e >= b {
		t.Errorf("easy %.0f hp, brutal %.0f", e, b)
	}
	if len(easy.plan(5, 1)) >= len(brutal.plan(5, 1)) {
		t.Error("brutal waves are no bigger")
	}
	for _, s := range []string{"", "normal", "HARD", "3"} {
		if _, err := ParseDifficulty(s); err != nil {
			t.Error(err)
		}
	}
	if _, err := ParseDifficulty("nightmare"); err == nil {
		t.Error("parsed nonsense")
	}
}
