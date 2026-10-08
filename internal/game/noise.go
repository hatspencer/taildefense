package game

// Noise: gunfire carries. A survivor firing is heard around them, louder guns further, and
// rain and storms muffle it. Sleeping guards that hear it wake and come for the shooter; a
// creep of the waves that hears it may turn from the generator towards the noise.

const (
	noiseEvery = .5 // seconds between the noises a firing survivor makes
	noiseTurn  = .4 // chance a creep of the waves that hears it goes for the shooter
	noiseHunt  = 5  // seconds it keeps after them
)

// loudness is how far each weapon's shots are heard, in tiles.
var loudness = [NumWeapons]float32{WPistol: 11, WShotgun: 15, WSMG: 13, WRifle: 17, WFlamer: 7, WMinigun: 18, WLauncher: 16}

// noiseRange is how far p's current weapon is heard now.
func (w *World) noiseRange(p *Player) float32 {
	return loudness[p.Cur] * (1 - .3*max(w.amt(WRain), w.amt(WStorm)))
}

// noise is p's gunfire reaching the creeps around them.
func (w *World) noise(p *Player) {
	r := w.noiseRange(p)
	woke := false
	w.grid.each(p.X, p.Y, r, func(i int32) bool {
		c := &w.Creeps[i]
		dx, dy := c.X-p.X, c.Y-p.Y
		if c.HP <= 0 || dx*dx+dy*dy > r*r || c.Hunt == int8(p.ID) {
			return true
		}
		if c.Home > 0 {
			if c.Asleep {
				w.wakeSite(c)
				woke = true
			}
			c.Hunt, c.HuntLeft, c.Returning = int8(p.ID), 6, false
			return true
		}
		if c.Hunt < 0 && w.rng.Float32() < noiseTurn {
			c.Hunt, c.HuntLeft, c.Siege = int8(p.ID), noiseHunt, -1
		}
		return true
	})
	if woke {
		w.toast(p, 0, "the shooting woke the guards nearby")
	}
}

// Sprinting: holding it makes a survivor run faster until their stamina is spent; then they
// are winded and cannot sprint again until they have got their breath back.
const (
	sprintMul    = 1.6
	sprintDrain  = 1. / 6 // a full bar lasts six seconds
	staminaRegen = 1. / 8 // and refills in eight
	windedUntil  = .35    // the bar a winded survivor needs back before sprinting again
)

// SprintInfo is sprinting's numbers, for the client.
func SprintInfo() (mul, seconds, regen float32) { return sprintMul, 1 / sprintDrain, 1 / staminaRegen }

// Sprinting reports whether p runs at sprint speed now.
func (p *Player) Sprinting() bool { return p.Sprint && !p.Winded && p.Alive }

// SetSprint is the survivor pressing or letting go of sprint.
func (w *World) SetSprint(p *Player, on bool) { p.Sprint = on }

// stepStamina spends stamina on a sprint that moved this tick and recovers it otherwise.
func (p *Player) stepStamina() {
	if p.Sprinting() && p.Moving {
		p.Stamina -= sprintDrain * Dt
		if p.Stamina <= 0 {
			p.Stamina, p.Winded = 0, true
		}
		return
	}
	p.Stamina = min(1, p.Stamina+staminaRegen*Dt)
	if p.Winded && p.Stamina >= windedUntil {
		p.Winded = false
	}
}
