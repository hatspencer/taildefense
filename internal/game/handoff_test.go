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

// A second pistol, found or picked up, goes in the other hand: the pair is as upgraded as
// the first, with twice the rounds a second and twice the magazine. Dropping one leaves one.
func TestASecondPistolMakesAPair(t *testing.T) {
	w := newBare(9)
	a, _ := w.Join("ana", "ana@example")
	b, _ := w.Join("bo", "bo@example")
	lv := [NumTracks]uint8{2, 1, 0, 1}
	a.Weapons[WPistol] = WeaponState{Owned: true, Lv: lv, Ammo: 3}
	one := a.Weapons[WPistol].Stats(WPistol)
	if s, ok := w.giveWeapon(a, w.unowned(a, 0), 0); !ok {
		t.Fatalf("no second pistol: %q", s)
	}
	ws := a.Weapons[WPistol]
	two := ws.Stats(WPistol)
	if !ws.Dual || ws.Lv != lv || a.Cur != WPistol {
		t.Fatalf("after the find: %+v, in hand %d", ws, a.Cur)
	}
	if two.Damage != one.Damage || two.Pierce != one.Pierce || two.Rate != 2*one.Rate || two.Mag != 2*one.Mag || ws.Ammo != two.Mag {
		t.Fatalf("one pistol %+v, the pair %+v, %d rounds in them", one, two, ws.Ammo)
	}
	if k := w.unowned(a, 0); k == WPistol {
		t.Fatal("a third pistol on offer")
	}
	// Dropping one of the pair: the other stays in hand, the dropped one pairs with bo's.
	if err := w.DropWeapon(a, WPistol); err != nil {
		t.Fatal(err)
	}
	if ws := a.Weapons[WPistol]; !ws.Owned || ws.Dual || a.Cur != WPistol || len(w.Guns) != 1 {
		t.Fatalf("after the drop: %+v, in hand %d, %d on the ground", ws, a.Cur, len(w.Guns))
	}
	g := w.Guns[0]
	b.X, b.Y = g.X, g.Y
	if err := w.OrderPickup(b, g.ID); err != nil {
		t.Fatal(err)
	}
	if !run(w, TickRate, func() bool { return len(w.Guns) == 0 }) {
		t.Fatal("bo never picked it up")
	}
	if ws := b.Weapons[WPistol]; !ws.Dual || ws.Lv != ([NumTracks]uint8{}) {
		t.Fatalf("bo's pair %+v: their own upgrades, not the dropped one's", ws)
	}
	if err := w.OrderPickup(a, g.ID); err == nil {
		t.Fatal("picked up a weapon already taken")
	}
}
