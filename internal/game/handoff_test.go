package game

import "testing"

func TestADroppedWeaponGoesToATeammateUpgradesAndAll(t *testing.T) {
	w := newBare(7)
	a, _ := w.Join("ana", "ana@example")
	b, _ := w.Join("bo", "bo@example")
	lv := [NumTracks]uint8{3, 1, 0, 2}
	a.Weapons[WRifle] = WeaponState{Owned: true, Lv: lv, Ammo: 4}
	a.Cur = WRifle
	if err := w.DropWeapon(a, WRifle); err != nil {
		t.Fatal(err)
	}
	if a.Weapons[WRifle].Owned || a.Cur == WRifle || len(w.Guns) != 1 {
		t.Fatalf("after the drop: rifle owned %v, in hand %d, %d on the ground", a.Weapons[WRifle].Owned, a.Cur, len(w.Guns))
	}
	if err := w.DropWeapon(a, a.Cur); err == nil {
		t.Fatal("dropped the last weapon")
	}
	g := w.Guns[0]
	b.X, b.Y = w.standNear(g.X+2, g.Y)
	if err := w.OrderPickup(b, g.ID); err != nil {
		t.Fatal(err)
	}
	// Walking over takes a moment; the pickup itself a fifth of a second.
	if !run(w, TickRate*3, func() bool { return len(w.Guns) == 0 }) {
		t.Fatalf("never picked up: order %d at %.1f,%.1f, the rifle at %.1f,%.1f", b.Order.Kind, b.X, b.Y, g.X, g.Y)
	}
	ws := b.Weapons[WRifle]
	if !ws.Owned || ws.Lv != lv || ws.Ammo != 4 || b.Cur != WRifle {
		t.Fatalf("picked up %+v, in hand %d", ws, b.Cur)
	}
	if err := w.OrderPickup(a, g.ID); err == nil {
		t.Fatal("picked up a weapon already taken")
	}
}

func TestPickingUpTakesAFifthOfASecond(t *testing.T) {
	w := newBare(8)
	a, _ := w.Join("ana", "ana@example")
	b, _ := w.Join("bo", "bo@example")
	a.Weapons[WSMG] = WeaponState{Owned: true, Ammo: 10}
	if err := w.DropWeapon(a, WSMG); err != nil {
		t.Fatal(err)
	}
	g := w.Guns[0]
	b.X, b.Y = g.X, g.Y
	if err := w.OrderPickup(b, g.ID); err != nil {
		t.Fatal(err)
	}
	ticks := 0
	for len(w.Guns) > 0 && ticks < TickRate {
		w.Step()
		ticks++
	}
	if want := int(gunPickup * TickRate); ticks < want || ticks > want+1 {
		t.Fatalf("the pickup took %d ticks, want about %d", ticks, want)
	}
	if !b.Weapons[WSMG].Owned || b.Cur != WSMG {
		t.Fatal("the pickup did not put the SMG in bo's hands")
	}
	if err := w.OrderPickup(b, g.ID); err == nil {
		t.Fatal("the same weapon twice")
	}
}
