package game

import "testing"

func TestGoldCanBeGivenToATeammate(t *testing.T) {
	w := newBare(5)
	bo, _ := w.Join("bo", "bo@example")
	cy, _ := w.Join("cy", "cy@example")
	bo.Gold, cy.Gold = 300, 10
	if err := w.Give(bo, int(cy.ID), 250); err != nil || bo.Gold != 50 || cy.Gold != 260 {
		t.Fatalf("give: %v, bo %d, cy %d", err, bo.Gold, cy.Gold)
	}
	if n := w.Notes[len(w.Notes)-1]; n.Text != "bo gave cy 250 gold" || n.Level != NoteBrief {
		t.Errorf("note %q at %d", n.Text, n.Level)
	}
	if ts := w.Toasts[len(w.Toasts)-1]; ts.Player != cy.ID || ts.Text != "bo gave you 250 gold" {
		t.Errorf("toast %+v", ts)
	}
	for _, c := range []struct {
		to   int
		gold int32
	}{{int(cy.ID), 51}, {int(cy.ID), 0}, {int(cy.ID), -5}, {int(bo.ID), 10}, {7, 10}} {
		if err := w.Give(bo, c.to, c.gold); err == nil {
			t.Errorf("gave %d to %d", c.gold, c.to)
		}
	}
	cy.Connected = false
	if err := w.Give(bo, int(cy.ID), 10); err == nil {
		t.Error("gave gold to someone away")
	}
	if bo.Gold != 50 {
		t.Errorf("refused gifts cost gold: %d left", bo.Gold)
	}
}

// kill finishes a fresh walker by p, as a turret's shot if turret, and pays its bounty.
func kill(t *testing.T, w *World, p *Player, turret bool) {
	t.Helper()
	c := spawnAt(t, w, CWalker, w.CoreX+8, w.CoreY+8)
	w.turretFire = turret
	w.damage(int32(len(w.Creeps)-1), c.HP+100, int8(p.ID))
	w.turretFire = false
	w.reap()
}

// What a survivor's turret kills pays everyone in the game alike, what does not divide carried
// to the next, so no gold is made or lost; what they kill by hand is theirs.
func TestATurretsKillsPayTheTeam(t *testing.T) {
	w := newBare(5)
	bo, _ := w.Join("bo", "bo@example")
	cy, _ := w.Join("cy", "cy@example")
	dee, _ := w.Join("dee", "dee@example")
	dee.Connected = false
	bounty := int32(float32(Creeps[CWalker].Bounty) * (1 + .04*float32(w.Wave)) * w.diff().Gold)
	start := bo.Gold
	for i := 1; i <= 5; i++ {
		kill(t, w, bo, true)
		if bo.Gold != cy.Gold || (bo.Gold-start)*2+w.pot != bounty*int32(i) || dee.Gold != start {
			t.Fatalf("after %d turret kills: bo %d, cy %d, dee %d, %d carried; a bounty is %d", i, bo.Gold, cy.Gold, dee.Gold, w.pot, bounty)
		}
	}
	b, c := bo.Gold, cy.Gold
	kill(t, w, bo, false)
	if bo.Gold != b+bounty || cy.Gold != c {
		t.Errorf("a kill by hand: bo %d to %d, cy %d to %d", b, bo.Gold, c, cy.Gold)
	}
}

// A creep a survivor blows up with a fuel pump pays the team too.
func TestAPumpsKillsPayTheTeam(t *testing.T) {
	w := newBare(5)
	bo, _ := w.Join("bo", "bo@example")
	cy, _ := w.Join("cy", "cy@example")
	pu := &w.Sites[w.pumps()[0]]
	c := spawnAt(t, w, CWalker, pu.SX+.8, pu.SY+.6)
	c.HP = 1
	b, g := bo.Gold, cy.Gold
	pu.by = int8(bo.ID)
	w.grid.build(w.Creeps)
	w.blowPump(w.pumps()[0])
	w.reap()
	if len(w.Creeps) != 0 || cy.Gold == g || bo.Gold-b != cy.Gold-g {
		t.Fatalf("%d creeps left; bo %d to %d, cy %d to %d", len(w.Creeps), b, bo.Gold, g, cy.Gold)
	}
	if w.trap {
		t.Error("the pump left trap set")
	}
}
