package game

import (
	"fmt"
	"strings"
	"testing"
)

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

func TestGuardsSleepWakeAndGoHome(t *testing.T) {
	w := New(5)
	n := 0
	var lv [5]int
	for _, s := range w.Sites {
		n += int(s.Guards)
		lv[s.Guard]++
	}
	if n < 100 || lv[0] == 0 || lv[3] == 0 || lv[4] == 0 {
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
	// Guards don't forbid a search; they only make it dangerous.
	if err := w.OrderLoot(p, si); err != nil {
		t.Fatalf("a guarded site refused a search: %v", err)
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
	// Kill them all and none are left.
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

func TestAStuckStragglerDoesNotHoldTheWave(t *testing.T) {
	w := New(7)
	w.Join("ana", "ana@example")
	w.startWave()
	w.Queue, w.QueueHead = nil, 0
	for i := 0; i < len(w.Creeps); {
		if w.Creeps[i].Home == 0 {
			w.Creeps = append(w.Creeps[:i], w.Creeps[i+1:]...)
			continue
		}
		i++
	}
	// A creep in water at the far corner of the map: nothing reaches it, and it reaches nothing.
	if !w.SpawnCreep(CWalker, 2, 2) {
		t.Fatal("no spawn")
	}
	c := &w.Creeps[len(w.Creeps)-1]
	c.HP, c.MaxHP = 1e9, 1e9
	for i := 0; i < int(TickRate*(stallLimit-5)) && w.Phase == PhaseWave; i++ {
		w.Step()
	}
	if w.Phase != PhaseWave {
		t.Fatal("the wave ended before the stall limit")
	}
	for i := 0; i < int(TickRate*10) && w.Phase == PhaseWave; i++ {
		w.Step()
	}
	if w.Phase != PhaseBuild || w.waveCreeps() != 0 {
		t.Fatalf("phase %v with %d creeps of the wave", w.Phase, w.waveCreeps())
	}
}

func TestShotsWakeGuardsInEarshot(t *testing.T) {
	w := New(5)
	si := guardedSite(t, w)
	s := &w.Sites[si]
	p, _ := w.Join("gil", "gil@example")
	p.HP, p.MaxHP = 1e6, 1e6
	// Out of sight of the guards but well within a rifle's earshot.
	p.X, p.Y = s.SX+12, s.SY
	p.Cur = WRifle
	w.Step()
	w.noise(p)
	awake := 0
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Home == int16(si+1) && !c.Asleep && c.Hunt == int8(p.ID) {
			awake++
		}
	}
	if awake == 0 {
		t.Fatal("no guard heard the shot")
	}
}

func TestSprintRunsOutAndComesBack(t *testing.T) {
	p := &Player{Alive: true, Stamina: 1, Sprint: true, Moving: true}
	n := 0
	for ; p.Sprinting() && n < 1000; n++ {
		p.stepStamina()
	}
	if secs := float32(n) * Dt; secs < 5 || secs > 7 || !p.Winded {
		t.Fatalf("sprinted %.1fs, winded %v", secs, p.Winded)
	}
	p.Moving = false
	for i := 0; i < int(TickRate*3); i++ {
		p.stepStamina()
	}
	if !p.Sprinting() {
		t.Fatalf("still winded with %.2f stamina", p.Stamina)
	}
}

func TestOutpostsAreBigGarrisonedAndSpringAmbushes(t *testing.T) {
	w := New(5)
	si := -1
	for i, s := range w.Sites {
		if s.Kind == SiteOutpost {
			si = i
			if s.W < 20 || s.H < 16 || s.Guard != 4 {
				t.Fatalf("outpost %+v", s)
			}
		}
	}
	if si < 0 {
		t.Fatal("no outpost on the map")
	}
	s := &w.Sites[si]
	boss := false
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Home == int16(si+1) && c.Kind == CBoss {
			boss = true
		}
	}
	if !boss {
		t.Fatal("no warlord in the outpost")
	}
	p, _ := w.Join("gil", "gil@example")
	p.HP, p.MaxHP = 1e9, 1e9
	before := len(w.Creeps)
	p.X, p.Y = float32(s.X)+3, float32(s.Y)+float32(s.H)/2
	p.Order.Kind = OrderHold
	w.Step()
	if s.Sprung != 1 || len(w.Creeps) <= before {
		t.Fatalf("walking in sprang %d ambushes, creeps %d -> %d", s.Sprung, before, len(w.Creeps))
	}
	// Searching it, guards and all, springs the second and pays out several finds.
	p.X, p.Y = s.SX, s.SY
	gold := p.Gold
	if err := w.OrderLoot(p, si); err != nil {
		t.Fatal(err)
	}
	w.Step()
	if s.Sprung != 2 {
		t.Fatalf("searching sprang %d", s.Sprung)
	}
	p.Search = SiteDefs[SiteOutpost].Search
	p.Hurt = 0
	w.search(p, si)
	if !s.Searched || (p.Gold == gold && w.Notes[len(w.Notes)-1].Level != 1) {
		t.Fatalf("searched %v, gold %d -> %d", s.Searched, gold, p.Gold)
	}
}

func TestQuietSitesGiveSmallFinds(t *testing.T) {
	w := New(8)
	var got [5][NumRarities]int
	for g := uint8(0); g < 5; g++ {
		s := &Site{Guard: g}
		for i := 0; i < 4000; i++ {
			got[g][w.ceil(s, RollRarity(w.rng.Float64(), 12))]++
		}
	}
	if got[0][Rare]+got[0][Jackpot] > 0 || got[1][Jackpot] > 0 {
		t.Fatalf("quiet sites gave strong finds: %v", got)
	}
	if got[0][Good] == 0 || got[0][Good] > 4000/8 {
		t.Fatalf("an unguarded house should only now and then give a good find: %v", got[0])
	}
	if got[4][Jackpot] == 0 {
		t.Fatalf("an outpost should still hold the best: %v", got[4])
	}
}

func TestAnyPlayerCanPauseAndResume(t *testing.T) {
	w := New(9)
	p, _ := w.Join("ana", "ana@example")
	w.Step()
	w.TogglePause(p)
	tick, left := w.Tick, w.PhaseLeft
	w.Step()
	if len(w.Notes) != 1 || w.Notes[0].Text != "ana paused the game" {
		t.Fatalf("the pause note should go out with the next tick: %v", w.Notes)
	}
	for i := 0; i < 40; i++ {
		w.Step()
	}
	if w.Tick != tick || w.PhaseLeft != left || len(w.Notes) != 0 {
		t.Fatalf("time moved while paused: tick %d→%d, %v", tick, w.Tick, w.Notes)
	}
	w.TogglePause(p)
	w.Step()
	if w.Tick != tick+1 || w.Paused != -1 {
		t.Fatalf("resume did not start the game again")
	}
}

func TestWavesGrowWithTheGameAndThePlayers(t *testing.T) {
	for wave := 2; wave < 40; wave++ {
		if wave%5 != 0 && (wave-1)%5 != 0 && Budget(wave, 1) <= Budget(wave-1, 1) {
			t.Fatalf("wave %d is no bigger than wave %d", wave, wave-1)
		}
		if Budget(wave, 3) <= Budget(wave, 2) || Budget(wave, 2) <= Budget(wave, 1) {
			t.Fatalf("wave %d does not grow with the players", wave)
		}
	}
	if Budget(20, 1) < 2*Budget(19, 1) {
		t.Fatalf("a late swarm should be at least twice its neighbour")
	}
}

func TestIdlePlayersDoNotSwellTheWaves(t *testing.T) {
	w := New(10)
	a, _ := w.Join("ana", "ana@example")
	w.Join("bo", "bo@example")
	if w.active() != 2 {
		t.Fatalf("both just joined: %d", w.active())
	}
	for i := 0; i < idleAfter; i++ {
		w.Tick++
	}
	w.Touch(a)
	if w.active() != 1 {
		t.Fatalf("bo has been idle: %d", w.active())
	}
}

func TestAHordeWaveHitsAsOne(t *testing.T) {
	w := New(11)
	w.Join("ana", "ana@example")
	q := w.plan(20, 1)
	early := 0
	for _, s := range q {
		if s.At < 16 {
			early++
		}
	}
	if len(q) < 1500 || early < len(q)/3 {
		t.Fatalf("wave 20 should be a horde: %d creeps, %d in the first seconds", len(q), early)
	}
}

func TestEveryoneGetsTheirOwnLook(t *testing.T) {
	w := New(12)
	seen := map[uint32]bool{}
	for i := 0; i < MaxPlayers; i++ {
		p, err := w.Join(fmt.Sprint("p", i), fmt.Sprint("p", i, "@example"))
		if err != nil {
			t.Fatal(err)
		}
		a := p.Look & 15
		if seen[a] && len(seen) < Archetypes {
			t.Fatalf("player %d got a repeat outfit while others were free", i)
		}
		seen[a] = true
	}
	p := w.Players[0]
	look := p.Look
	w.Leave(p)
	if q, _ := w.Join("p0", "p0@example"); q.Look != look {
		t.Fatal("a returning player should keep their look")
	}
}

func TestEveryFifthWaveBringsALongBreak(t *testing.T) {
	w := New(8)
	w.Join("ana", "ana@example")
	d := w.diff()
	for wave := 1; wave <= 10; wave++ {
		w.Phase, w.Wave = PhaseWave, wave
		w.endWave(0)
		want := d.Build
		if wave%5 == 0 {
			want = d.Rest
		}
		if w.PhaseLeft != want {
			t.Fatalf("after wave %d: a %.0fs break, want %.0fs", wave, w.PhaseLeft, want)
		}
	}
	if d := Difficulties[DiffNormal]; d.Build != 15 || d.Rest != 60 {
		t.Fatalf("normal breaks %v and %v", d.Build, d.Rest)
	}
	// Ten seconds before the long break ends, the team is called home.
	w.Notes = w.Notes[:0]
	w.PhaseLeft = callBack + Dt/2
	w.Step()
	called := false
	for _, n := range w.Notes {
		called = called || strings.Contains(n.Text, "head back")
	}
	if !called {
		t.Fatalf("no call home: %+v", w.Notes)
	}
}
