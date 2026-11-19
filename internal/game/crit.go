package game

// Critical hits: a swing of the crowbar, the katana or the greatsword, and their arts, may
// land critical, hitting the creep critMul times as hard and stunning it critStun times as
// long. The chance and the multiplier grow with every level bought on the blade, its
// evolution and a second katana, so a blade taken far crits often and hard. Guns, turrets and
// damage over time never crit.

const (
	critBase     = .05  // the chance on a blade just found
	critLevel    = .012 // the chance each track level adds (all four tracks full: +.24)
	critEvo      = .06  // the chance its evolution adds
	critDual     = .05  // the chance a second katana adds
	critMulBase  = 1.8  // a critical hit's damage on a blade just found
	critMulLevel = .035 // what each track level adds to it (all full: 2.5)
	critStun     = 2    // times as long a critical hit stuns
)

// crit is the chance a hit of melee weapon k, as ws holds it, lands critical, and its damage
// multiplier then.
func (ws *WeaponState) crit(k WeaponKind) (chance, mul float32) {
	n := 0
	for _, l := range ws.Lv {
		n += int(l)
	}
	chance = critBase + critLevel*float32(n)
	if ws.Evo != 0 {
		chance += critEvo
	}
	if ws.Dual && k == WKatana {
		chance += critDual
	}
	return chance, critMulBase + critMulLevel*float32(n)
}

// flinch is a blow from a survivor landing on c: a grabber puts its next reach off a moment.
func (c *Creep) flinch() {
	if grabs[c.Kind].reach > 0 && c.lunge <= 0 && c.grip == 0 {
		c.grab = max(c.grab, grabFlinch)
	}
}
