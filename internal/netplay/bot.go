package netplay

import (
	"math"
	"math/rand/v2"

	"taildefense/internal/game"
)

// MaxBots is how many bots a host may bring into its game.
const MaxBots = 3

// Bot plays one survivor roughly as a person would: it shops and builds between waves, goes
// out for loot, fights what comes near, revives the fallen and now and then does something
// for the sake of it, a taunt, a sprint, a ping. It thinks a few times a second and draws
// from its own seeded stream, so a game of bots plays the same every time. The playtests
// play whole games with it; a host plays it beside people (ServerConfig.Bots).
type Bot struct {
	ID uint8
	// Live is a bot in a game with people: it leaves pings to them, and readies up as soon as
	// everyone else has, so it never holds back a team that wants the next wave now.
	Live bool
	rng  *rand.Rand

	shopped    int // the wave whose break it is in, from the bot's side
	builds     int // builds tried this break
	looting    bool
	bought     bool // has been to the armory this break
	buildFirst bool // builds before it shops this break
	eager      bool // readies up as soon as it is done
}

// NewBot is a bot for player id.
func NewBot(id uint8, seed uint64) *Bot {
	return &Bot{ID: id, rng: rand.New(rand.NewPCG(seed, uint64(id)+1)), shopped: -1}
}

// think is how often a bot looks around, in ticks.
const think = 5

// Act gives this tick's commands, if it is the bot's turn to think. do carries one out at
// once, as the host would a client's, so what the bot reads next sees it done.
func (b *Bot) Act(w *game.World, do func(Cmd)) {
	if (w.Tick+uint32(b.ID))%think != 0 || w.Phase == game.PhaseOver || w.Paused >= 0 {
		return
	}
	p := w.Players[b.ID]
	if !p.Alive {
		return
	}
	if p.Picking {
		// A blades game: pick a blade, as a person does on joining.
		do(Cmd{Op: OpPickBlade, A: uint8(game.StartBlades[b.rng.IntN(len(game.StartBlades))])})
	}
	if p.HP < p.MaxHP*.4 && p.Medkits > 0 && p.Heal == 0 {
		do(Cmd{Op: OpMedkit})
	}
	if b.rng.IntN(40) == 0 {
		do(Cmd{Op: OpSprint, A: uint8(b.rng.IntN(2))})
	}
	if b.rng.IntN(200) == 0 {
		c := Cmd{Op: OpPing, A: uint8(b.rng.IntN(int(game.NumPingKinds))), X: p.X + b.jitter(6), Y: p.Y + b.jitter(6)}
		if !b.Live {
			do(c)
		}
	}
	if b.rng.IntN(300) == 0 {
		do(Cmd{Op: OpSelect, A: uint8(b.rng.IntN(int(game.NumWeapons)))})
	}

	// A teammate down nearby comes first, when nothing is about to bite.
	for i, m := range w.Players {
		if i == int(b.ID) || m.Alive || m.Aboard || !m.Connected || p.Order.Kind == game.OrderRevive {
			continue
		}
		if d2(p.X, p.Y, m.X, m.Y) < 30*30 && b.nearest(w, p, 4) < 0 {
			do(Cmd{Op: OpRevive, T: uint16(i)})
			return
		}
	}

	switch w.Phase {
	case game.PhaseBuild:
		b.between(w, p, do)
	case game.PhaseWave:
		b.fight(w, p, do)
	case game.PhaseEvac:
		// Get to the choppa once it is down; fight for the pad until then.
		if w.Evac.Stage == game.EvacLanded {
			if p.Order.Kind != game.OrderBoard {
				do(Cmd{Op: OpBoard})
			}
			return
		}
		b.fight(w, p, do)
	}
}

// between is a bot's build phase: shop, put a few things up, maybe go looting, and ready up
// near the end, or straight away in an impatient break. Half the breaks it builds before it
// shops, so some gold always goes on the base.
func (b *Bot) between(w *game.World, p *game.Player, do func(Cmd)) {
	if b.shopped != w.Wave {
		b.shopped, b.builds, b.looting, b.bought = w.Wave, 0, false, false
		b.buildFirst, b.eager = b.rng.IntN(2) == 0, b.rng.IntN(5) == 0
	}
	if b.Live && !p.Ready && othersReady(w, p) {
		do(Cmd{Op: OpReady, A: 1})
	}
	switch p.Order.Kind {
	case game.OrderBuild, game.OrderLoot, game.OrderRepair, game.OrderRevive:
		return
	}
	if !b.buildFirst && !b.bought {
		b.goShop(w, p, do)
		return
	}
	if b.builds < 4+w.Wave/2 && b.build(w, p, do) {
		return
	}
	if !b.bought {
		b.goShop(w, p, do)
		return
	}
	if si := b.damaged(w); si >= 0 && b.rng.IntN(3) == 0 {
		do(Cmd{Op: OpRepair, T: uint16(si)})
		return
	}
	if b.rng.IntN(6) == 0 {
		b.upkeep(w, p, do)
	}
	if !b.looting && w.PhaseLeft > 20 && b.rng.IntN(2) == 0 {
		b.looting = true
		if si := b.site(w, p); si >= 0 {
			do(Cmd{Op: OpLoot, T: uint16(si)})
			return
		}
	}
	if !p.Ready && (b.eager || w.PhaseLeft < 8) {
		do(Cmd{Op: OpReady, A: 1})
	}
}

// othersReady reports whether every other survivor in the game is ready, and there is one.
func othersReady(w *game.World, p *game.Player) bool {
	n := 0
	for _, o := range w.Players {
		if o == p || !o.Connected {
			continue
		}
		if !o.Ready {
			return false
		}
		n++
	}
	return n > 0
}

// build orders something it can afford put up near the generator, and reports whether it did.
func (b *Bot) build(w *game.World, p *game.Player, do func(Cmd)) bool {
	kinds := []game.StructKind{game.STurretGun, game.STurretGun, game.STurretCannon, game.STurretFrost, game.STurretTesla, game.STurretSniper, game.STurretMissile, game.SWall, game.SGate}
	k := kinds[b.rng.IntN(len(kinds))]
	if p.Gold < game.Structs[k].Price {
		k = game.SWall
		if p.Gold < game.Structs[k].Price {
			return false
		}
	}
	b.builds++
	ang := b.rng.Float64() * 2 * math.Pi
	r := 5 + b.rng.Float64()*9
	do(Cmd{Op: OpBuild, A: uint8(k), X: w.CoreX + float32(r*math.Cos(ang)), Y: w.CoreY + float32(r*math.Sin(ang))})
	return true
}

// goShop walks to the armory and spends there once it arrives.
func (b *Bot) goShop(w *game.World, p *game.Player, do func(Cmd)) {
	if !w.AtArmory(p) {
		if p.Order.Kind != game.OrderMove {
			a := &w.Structs[w.Armory]
			do(Cmd{Op: OpMove, X: a.CX(), Y: a.CY() + float32(a.H)/2 + 1})
		}
		return
	}
	b.shop(p, do)
	b.bought = true
}

// shop spends at the armory, in a random order over everything on sale, keeping a third of
// its gold back for building.
func (b *Bot) shop(p *game.Player, do func(Cmd)) {
	var buys []Cmd
	for k := 1; k < int(game.NumWeapons); k++ {
		buys = append(buys, Cmd{Op: OpBuyWeapon, A: uint8(k)})
		for t := 0; t < int(game.NumTracks); t++ {
			buys = append(buys, Cmd{Op: OpUpgrade, A: uint8(k), B: uint8(t)})
		}
	}
	for t := 0; t < int(game.NumTracks); t++ {
		buys = append(buys, Cmd{Op: OpUpgrade, A: uint8(game.WPistol), B: uint8(t)})
	}
	for g := 0; g < int(game.NumGear); g++ {
		buys = append(buys, Cmd{Op: OpGear, A: uint8(g)})
	}
	for a := 0; a < game.NumAbilities; a++ {
		buys = append(buys, Cmd{Op: OpBuyAbility, A: uint8(a)})
	}
	buys = append(buys, Cmd{Op: OpBuyMedkit})
	b.rng.Shuffle(len(buys), func(i, j int) { buys[i], buys[j] = buys[j], buys[i] })
	keep := p.Gold / 3
	for _, c := range buys[:len(buys)/2] {
		if p.Gold <= keep {
			break
		}
		do(c)
	}
	// The best weapon owned goes in hand.
	for k := int(game.NumWeapons) - 1; k >= 0; k-- {
		if p.Weapons[k].Owned {
			do(Cmd{Op: OpSelect, A: uint8(k)})
			break
		}
	}
}

// upkeep upgrades or, once in a while, sells one of the bot's own structures.
func (b *Bot) upkeep(w *game.World, p *game.Player, do func(Cmd)) {
	var own []int
	for i := range w.Structs {
		if st := &w.Structs[i]; st.Alive && st.Owner == int8(p.ID) {
			own = append(own, i)
		}
	}
	if len(own) == 0 {
		return
	}
	si := own[b.rng.IntN(len(own))]
	if b.rng.IntN(8) == 0 {
		do(Cmd{Op: OpSell, T: uint16(si)})
	} else {
		do(Cmd{Op: OpUpgradeStruct, T: uint16(si), A: uint8(b.rng.IntN(int(game.NumTracks)))})
	}
}

// fight is a bot's wave: go for the nearest creep in reach with abilities to hand, else
// hold the ground round the generator.
func (b *Bot) fight(w *game.World, p *game.Player, do func(Cmd)) {
	ci := b.nearest(w, p, 22)
	if ci < 0 {
		if p.Order.Kind == game.OrderIdle || p.Order.Kind == game.OrderHold || b.rng.IntN(20) == 0 {
			if d2(p.X, p.Y, w.CoreX, w.CoreY) > 14*14 || b.rng.IntN(4) == 0 {
				do(Cmd{Op: OpAttackMove, X: w.CoreX + b.jitter(10), Y: w.CoreY + b.jitter(10)})
			}
		}
		if si := b.damaged(w); si >= 0 && b.rng.IntN(10) == 0 {
			do(Cmd{Op: OpRepair, T: uint16(si)})
		}
		return
	}
	c := &w.Creeps[ci]
	if p.Order.Kind != game.OrderAttack || b.rng.IntN(6) == 0 {
		do(Cmd{Op: OpAttack, T: c.ID})
	}
	for a := 0; a < game.NumAbilities; a++ {
		ready := p.Abil[a].Cool <= 0
		if a == game.AbUltimate {
			ready = p.Ult >= 1 && p.BuffLeft <= 0
		}
		if p.Abil[a].Lv > 0 && ready && b.rng.IntN(3) == 0 {
			do(Cmd{Op: OpAbility, A: uint8(a), X: c.X, Y: c.Y})
			break
		}
	}
	if p.TauntCool <= 0 && p.HP > p.MaxHP*.7 && b.rng.IntN(15) == 0 {
		do(Cmd{Op: OpTaunt})
	}
	if ws := &p.Weapons[p.Cur]; ws.Ammo == 0 && ws.Reload == 0 {
		do(Cmd{Op: OpReload})
	}
	if p.HP < p.MaxHP*.25 && b.rng.IntN(3) == 0 {
		// Fall back to the generator to live.
		do(Cmd{Op: OpMove, X: w.CoreX + b.jitter(3), Y: w.CoreY + b.jitter(3)})
	}
}

// nearest is the index of the closest awake creep within r, or -1.
func (b *Bot) nearest(w *game.World, p *game.Player, r float32) int {
	best, bi := r*r, -1
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Asleep {
			continue
		}
		if d := d2(p.X, p.Y, c.X, c.Y); d < best {
			best, bi = d, i
		}
	}
	return bi
}

// damaged is a structure below two thirds, or -1.
func (b *Bot) damaged(w *game.World) int {
	for i := range w.Structs {
		if st := &w.Structs[i]; st.Alive && st.HP < st.MaxHP*.66 {
			return i
		}
	}
	return -1
}

// site is a loot site not yet searched within a walk, picked at random, or -1.
func (b *Bot) site(w *game.World, p *game.Player) int {
	var near []int
	for i, st := range w.Sites {
		if !st.Searched && st.Kind.Lootable() && d2(p.X, p.Y, st.SX, st.SY) < 45*45 {
			near = append(near, i)
		}
	}
	if len(near) == 0 {
		return -1
	}
	return near[b.rng.IntN(len(near))]
}

func (b *Bot) jitter(r float32) float32 { return (b.rng.Float32()*2 - 1) * r }

func d2(ax, ay, bx, by float32) float32 { return (ax-bx)*(ax-bx) + (ay-by)*(ay-by) }
