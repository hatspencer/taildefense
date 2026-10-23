package game

import (
	"errors"
	"math"
	"math/rand/v2"
)

// Extraction, "get to the choppa": a game is won by holding out to the last wave. When it is cleared a Huey is
// called to the helipad out past the walls, further out the harder the game, the last of the dead come for the pad, and
// whoever gets aboard flies out with it. Then the game is over and the field report says who
// made it. The host picks the last wave, 20, 30 or 40 on every difficulty, or none: an endless
// game has no pad and no evac, and goes on until the generator falls.

// LastWaves are the game lengths a host can pick: the wave whose end calls the evac Huey, 0
// for an endless game.
var LastWaves = [...]int{20, 30, 40, 0}

// DefaultLastWave is the game length unless the host picks another.
const DefaultLastWave = 40

// ValidLastWave reports whether n is one of LastWaves.
func ValidLastWave(n int) bool {
	for _, v := range LastWaves {
		if v == n {
			return true
		}
	}
	return false
}

// Endless reports whether the game has no last wave.
func (w *World) Endless() bool { return w.LastWave == 0 }

const (
	evacInbound = 60  // seconds from the call to the Huey on the pad
	evacFlight  = 16  // of those, the last seconds it is in sight, flying in from the edge
	evacSettle  = 3   // of those, the last seconds it comes down onto the pad
	evacWait    = 90  // seconds it waits on the pad at most
	evacLast    = 30  // seconds it waits at most once someone is aboard
	evacDepart  = 10  // seconds from lifting off to off the map
	evacClimb   = 2.5 // of those, the first, climbing over the pad and turning for home
	boardReach  = 4   // tiles from the pad's centre a survivor boards from
	boardTime   = 1   // seconds of climbing in, unhurt
	padHalf     = 3   // the pad is 2*padHalf tiles square, centred on PadX, PadY
	padSpread   = 4   // tiles either side of the difficulty's Pad distance it may lie
)

// EvacInfo is the extraction's timing, for the client: the Huey's flight in, how long it
// waits and how long boarding takes, how far from the pad's centre one boards from, and the
// pad's half width.
func EvacInfo() (inbound, flight, settle, wait, last, depart, climb, reach, board, half float32) {
	return evacInbound, evacFlight, evacSettle, evacWait, evacLast, evacDepart, evacClimb, boardReach, boardTime, padHalf
}

// EvacStage is where the extraction is.
type EvacStage uint8

const (
	EvacNone      EvacStage = iota // not called: the waves go on
	EvacInbound                    // called: Left seconds until it sets down on the pad
	EvacLanded                     // on the pad: Left seconds until it lifts off, whoever is aboard
	EvacDeparting                  // lifting off and flying out with whoever is aboard
	EvacGone                       // off the map: the game is over
)

// Evac is the evac Huey: where it is over the ground and how high (0 on the pad, 1 at its
// cruising height), which way it faces (radians, +x towards +y), and the edge of the map it
// comes in from and leaves by.
type Evac struct {
	Stage        EvacStage
	Left         float32
	X, Y, Alt    float32
	Heading      float32
	FromX, FromY float32
	gun          float32 // the door gunner's cooldown
}

// placePad picks the helipad: open ground the difficulty's Pad distance from the generator,
// give or take padSpread, that a survivor can walk to from the generator: inside the build
// ring on easy and normal, out at its edge on hard, past it on brutal, where it can't be
// fortified. It is placed when the map is dealt, so a difficulty changed mid-game leaves it
// where it is. It draws on its own stream so the map's other randomness is the same with or
// without it.
func (w *World) placePad(seed uint64) {
	rng := rand.New(rand.NewPCG(seed, 0x6865_6c69_7061_64))
	core := &w.Structs[w.Core]
	for try := 0; try < 400; try++ {
		a := rng.Float64() * 2 * math.Pi
		r := float64(w.diff().Pad) + (rng.Float64()*2-1)*padSpread
		x := float32(math.Round(float64(w.CoreX) + math.Cos(a)*r))
		y := float32(math.Round(float64(w.CoreY) + math.Sin(a)*r))
		if !w.padClear(x, y) {
			continue
		}
		pts := w.paths.find(w, core.CX(), core.CY()+float32(core.H)/2+1.5, x, y, nil)
		if n := len(pts); n == 0 || absf(pts[n-1][0]-x)+absf(pts[n-1][1]-y) > 1.5 {
			continue
		}
		w.PadX, w.PadY = x, y
		return
	}
	// Nowhere clear: south of the base, cleared of trees and rock.
	w.PadX, w.PadY = w.CoreX, w.CoreY+w.diff().Pad
	for ty := int(w.PadY) - padHalf - 1; ty < int(w.PadY)+padHalf+1; ty++ {
		for tx := int(w.PadX) - padHalf - 1; tx < int(w.PadX)+padHalf+1; tx++ {
			if i := ty*w.W + tx; w.Terrain[i].Solid() {
				w.Terrain[i] = TGrass
			}
		}
	}
}

// PadKnown reports whether the survivors know where the helipad is: always by day; at night
// (hard and brutal, where it lies out past the generator's lights) once someone has seen it
// or the Huey has come down on it. Until then the page doesn't show it.
func (w *World) PadKnown() bool { return !w.Endless() && (w.diff().Dark <= 0 || w.PadFound) }

// findPad marks the helipad found once any of it has been seen.
func (w *World) findPad() {
	if w.PadFound || w.Endless() {
		return
	}
	for ty := int(w.PadY) - padHalf; ty < int(w.PadY)+padHalf; ty++ {
		for tx := int(w.PadX) - padHalf; tx < int(w.PadX)+padHalf; tx++ {
			if w.Seen.Has(ty*w.W + tx) {
				w.PadFound = true
				w.note(1, "the helipad is found, %s  ·  the evac Huey lands there after wave %d", w.where(w.PadX, w.PadY), w.LastWave)
				return
			}
		}
	}
}

// padClear reports whether a pad centred on x, y would stand on open ground, with a tile to
// spare all round.
func (w *World) padClear(x, y float32) bool {
	for ty := int(y) - padHalf - 1; ty < int(y)+padHalf+1; ty++ {
		for tx := int(x) - padHalf - 1; tx < int(x)+padHalf+1; tx++ {
			if tx < 1 || ty < 1 || tx >= w.W-1 || ty >= w.H-1 || w.At(tx, ty).Solid() || w.StructAt(tx, ty) >= 0 {
				return false
			}
		}
	}
	return true
}

// onPad reports whether tile x, y is kept clear for the Huey: the pad and a tile round it.
func (w *World) onPad(x, y int) bool {
	if w.Endless() {
		return false
	}
	return abs32(float32(x)+.5-w.PadX) < padHalf+1 && abs32(float32(y)+.5-w.PadY) < padHalf+1
}

// lastWave reports whether the wave just cleared is the one that ends the game.
func (w *World) lastWave() bool { return !w.Endless() && w.Wave >= w.LastWave }

// startEvac calls the Huey in, with the last of the dead after it.
func (w *World) startEvac() {
	w.Phase = PhaseEvac
	w.WaveTime = 0
	w.Queue = w.plan(w.Wave+1, w.active())
	w.QueueHead = 0
	w.stall, w.aliveLast = 0, 0
	for _, p := range w.Players {
		p.Ready = false
	}
	// In from the edge of the map beyond the pad, along the line from the generator.
	dx, dy := w.PadX-w.CoreX, w.PadY-w.CoreY
	d := sqrt32(dx*dx+dy*dy) + 1e-6
	fx, fy := w.PadX, w.PadY
	for nx, ny := fx+dx/d, fy+dy/d; nx > 2 && ny > 2 && nx < float32(w.W-2) && ny < float32(w.H-2); nx, ny = fx+dx/d, fy+dy/d {
		fx, fy = fx+dx/d, fy+dy/d
	}
	w.Evac = Evac{Stage: EvacInbound, Left: evacInbound, X: fx, Y: fy, Alt: 1, FromX: fx, FromY: fy,
		Heading: float32(math.Atan2(float64(w.PadY-fy), float64(w.PadX-fx)))}
	w.flowDirt = true // the pad is a goal for the dead now
	w.note(1, "wave %d cleared  ·  the evac Huey is on its way to the helipad %s  ·  it lands in %ds", w.Wave, w.where(w.PadX, w.PadY), evacInbound)
	w.note(2, "the last of the dead are coming for the pad  ·  hold it, and get aboard when the Huey is down")
}

// stepEvac flies the Huey for one tick: in to the pad, waiting there while the team boards,
// and off the map with whoever got aboard.
func (w *World) stepEvac() {
	e := &w.Evac
	if w.Phase != PhaseEvac {
		return
	}
	e.Left -= Dt
	switch e.Stage {
	case EvacInbound:
		k := min(max((evacFlight-e.Left)/(evacFlight-evacSettle), 0), 1)
		k = 1 - (1-k)*(1-k) // slows into the hover
		e.X, e.Y = e.FromX+(w.PadX-e.FromX)*k, e.FromY+(w.PadY-e.FromY)*k
		e.Alt = min(max(e.Left/evacSettle, 0), 1)
		if e.Left <= evacFlight {
			w.doorGunner(e)
		}
		if e.Left <= 0 {
			e.Stage, e.Left, e.X, e.Y, e.Alt = EvacLanded, evacWait, w.PadX, w.PadY, 0
			w.PadFound = true // its landing lights show the way
			w.Blasts = append(w.Blasts, Blast{w.PadX, w.PadY, padHalf + 1, BlastLanded})
			w.note(1, "GET TO THE CHOPPA!  ·  the Huey is down on the pad: press E by it to get aboard  ·  it leaves in %ds", evacWait)
		}
	case EvacLanded:
		w.doorGunner(e)
		aboard, waiting := w.aboard()
		if aboard > 0 && waiting == 0 || e.Left <= 0 {
			e.Stage, e.Left = EvacDeparting, evacDepart
			if aboard == 0 {
				w.note(2, "the Huey could wait no longer and lifts off with nobody aboard")
			} else {
				w.note(1, "the Huey lifts off with %d aboard", aboard)
			}
		}
	case EvacDeparting:
		s := evacDepart - e.Left
		home := float32(math.Atan2(float64(e.FromY-w.PadY), float64(e.FromX-w.PadX)))
		if s < evacClimb {
			k := s / evacClimb
			e.Alt = k * k * (3 - 2*k)
			e.Heading = turnTo(e.Heading, home, 2*Dt)
		} else {
			k := (s - evacClimb) / (evacDepart - evacClimb)
			k *= k
			e.Alt, e.Heading = 1, home
			e.X, e.Y = w.PadX+(e.FromX-w.PadX)*k, w.PadY+(e.FromY-w.PadY)*k
		}
		if s < evacClimb+2 {
			w.doorGunner(e)
		}
		if e.Left <= 0 {
			e.Stage = EvacGone
			w.Phase = PhaseOver
			w.Best = w.Wave
			aboard, _ := w.aboard()
			if aboard == 0 {
				w.note(2, "the Huey is gone  ·  you held out %d waves, and nobody got out", w.Best)
			} else {
				w.note(1, "the Huey is away with %d aboard  ·  you held out all %d waves", aboard, w.Best)
			}
		}
	}
	for _, p := range w.Players {
		if p.Aboard {
			p.X, p.Y = e.X, e.Y
		}
	}
}

// turnTo turns angle a towards b by at most step radians.
func turnTo(a, b, step float32) float32 {
	d := float32(math.Remainder(float64(b-a), 2*math.Pi))
	return a + min(max(d, -step), step)
}

// aboard counts the survivors aboard, and those the Huey still waits for: everyone connected
// and playing who is not aboard. One who has given no command for a while is not waited for,
// as the waves do not count them.
func (w *World) aboard() (aboard, waiting int) {
	for _, p := range w.Players {
		switch {
		case p.Aboard:
			aboard++
		case p.Connected && w.Tick-p.lastAct < idleAfter:
			waiting++
		}
	}
	return
}

// doorGunner works the minigun from the evac Huey, covering the survivors (heliGun).
func (w *World) doorGunner(e *Evac) { w.heliGun(e.X, e.Y, &e.gun) }

// OrderBoard sends the player to the Huey on the pad to get aboard.
func (w *World) OrderBoard(p *Player) error {
	switch {
	case w.Phase == PhaseOver:
		return errOver
	case p.Aboard:
		return errors.New("you are aboard")
	case !p.Alive:
		return errors.New("you are down")
	case w.Phase != PhaseEvac || w.Evac.Stage == EvacInbound:
		return errors.New("the Huey is not down on the pad yet")
	case w.Evac.Stage != EvacLanded:
		return errors.New("the Huey has gone")
	}
	w.order(p, Order{Kind: OrderBoard, X: w.PadX, Y: w.PadY + 1.5})
	return nil
}

// actBoard carries out a boarding order for one tick; false when the order is over.
func (w *World) actBoard(p *Player, walk func() bool) bool {
	if w.Phase != PhaseEvac || w.Evac.Stage != EvacLanded {
		w.toast(p, 2, "the Huey has gone")
		return false
	}
	if dx, dy := w.PadX-p.X, w.PadY-p.Y; dx*dx+dy*dy <= boardReach*boardReach {
		// Climbing in is all a survivor does, and a hit starts it over.
		if p.Hurt > 0 {
			p.Search = 0
			return true
		}
		if p.Search += Dt; p.Search >= boardTime {
			p.Search = 0
			w.board(p)
			return false
		}
		return true
	}
	if !walk() {
		// Thrown off the way by a slam or pushed past the pad: a survivor making for the way
		// out keeps at it, and stops only when there is no way there at all.
		if w.route(p, w.PadX, w.PadY+1.5); p.walk.done() {
			w.toast(p, 2, "cannot get to the Huey")
			return false
		}
	}
	return true
}

// board puts p aboard: out of the fight for good, riding out with the Huey.
func (w *World) board(p *Player) {
	p.Aboard = true
	p.Alive = false
	p.Respawn, p.Revived = 0, 0
	p.Firing, p.Moving = false, false
	p.Order = Order{}
	p.BuffLeft, p.Heal = 0, 0
	p.walk.reset()
	p.X, p.Y = w.Evac.X, w.Evac.Y
	aboard, waiting := w.aboard()
	if aboard == 1 && waiting > 0 && w.Evac.Left > evacLast {
		w.Evac.Left = evacLast
		w.note(1, "%s is aboard  ·  the pilot lifts off in %ds, with or without the rest", p.Name, evacLast)
		return
	}
	w.note(1, "%s is aboard  ·  %d of %d", p.Name, aboard, aboard+waiting)
}
