package game

import "testing"

func TestBrutalStartsWithOnlyACrowbar(t *testing.T) {
	w := NewGame(5, DiffBrutal)
	w.PhaseLeft = 1e6
	w.Creeps, w.freeIDs = w.Creeps[:0], w.freeIDs[:0]
	for i := MaxCreeps - 1; i >= 0; i-- {
		w.freeIDs = append(w.freeIDs, uint16(i))
	}
	p, _ := w.Join("ana", "ana@example")
	if p.Cur != WCrowbar || p.Weapons[WPistol].Owned || !p.Weapons[WCrowbar].Owned {
		t.Fatalf("a brutal survivor starts with %s", Weapons[p.Cur].Name)
	}
	if p.Gold != 0 || w.Restart(6).Players[0].Gold != 0 {
		t.Fatalf("a brutal survivor starts with %d gold", p.Gold)
	}
	if w.BuyWeapon(p, WCrowbar) == nil {
		t.Fatal("a crowbar for sale")
	}
	if q, _ := NewGame(5, DiffNormal).Join("bo", "bo@example"); q.Cur != WPistol || q.Weapons[WCrowbar].Owned || q.Gold != 150 {
		t.Fatal("a normal survivor without the pistol and 150 gold")
	}
	// It hits what is in reach, never what is not, and never runs dry.
	p.HP, p.MaxHP = 1e6, 1e6
	p.X, p.Y = w.CoreX+40, w.CoreY // clear of the base's turrets
	for !w.openWalk(p.X, p.Y, p.X+6, p.Y) || !CanStand(w, p.X, p.Y) {
		p.Y++
	}
	w.SpawnCreep(CWalker, p.X+5, p.Y)
	hp := w.Creeps[0].HP
	w.Step()
	if w.Creeps[0].HP < hp {
		t.Fatal("a crowbar reached five tiles")
	}
	kills := p.Kills
	for k := 0; k < 4; k++ {
		w.SpawnCreep(CWalker, p.X+1, p.Y)
	}
	run(w, TickRate*15, func() bool { return p.Kills >= kills+4 })
	if p.Kills < kills+4 {
		t.Fatalf("%d kills with the crowbar", p.Kills-kills)
	}
	if ws := p.Weapons[WCrowbar]; ws.Reload > 0 || ws.Ammo <= 0 {
		t.Fatal("the crowbar ran out")
	}
}
