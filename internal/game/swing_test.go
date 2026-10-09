package game

import "testing"

// A creep coming into reach winds up before its first blow lands, so the client has the
// windup to show it: Windup seconds of SwingWindup, then one tick of SwingStrike with the hit.
func TestBlowsAreWoundUpFirst(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	p.MaxHP, p.HP = 1000, 1000
	if !w.SpawnCreep(CWalker, p.X+.6, p.Y) {
		t.Fatal("no room for the creep")
	}
	c := &w.Creeps[0]
	c.Cool = -5 // long ready: it would hit at once if nothing held it back
	wound, hp := 0, p.HP
	for i := 0; i < TickRate*2; i++ {
		w.Step()
		c = &w.Creeps[0]
		switch c.Swing {
		case SwingWindup:
			wound++
			if p.HP != hp {
				t.Fatalf("tick %d: hurt while still winding up", i)
			}
		case SwingStrike:
			if p.HP >= hp {
				t.Fatalf("tick %d: struck without a hit", i)
			}
			if want := int(Creeps[CWalker].Windup*TickRate) - 1; wound < want {
				t.Fatalf("struck after %d ticks of windup, want at least %d", wound, want)
			}
			return
		}
	}
	t.Fatalf("never struck; swing %d, %d ticks wound up", c.Swing, wound)
}
