package playtest

import (
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
	"strings"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// Bot plays one survivor roughly as a person would: it shops and builds between waves, goes
// out for loot, fights what comes near, revives the fallen and now and then does something
// for the sake of it, a taunt, a sprint, a ping. It thinks a few times a second, never
// reads anything a client could not see, and draws from its own seeded stream, so a game
// of bots plays the same every time.
type Bot struct {
	ID  uint8
	rng *rand.Rand

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

// Act gives this tick's commands, if it is the bot's turn to think.
func (b *Bot) Act(s *Session) {
	w := s.W
	if (w.Tick+uint32(b.ID))%think != 0 || w.Phase == game.PhaseOver || w.Paused >= 0 {
		return
	}
	p := w.Players[b.ID]
	do := func(c netplay.Cmd) { _ = s.Do(b.ID, c) }
	if !p.Alive {
		return
	}
	if p.HP < p.MaxHP*.4 && p.Medkits > 0 && p.Heal == 0 {
		do(netplay.Cmd{Op: netplay.OpMedkit})
	}
	if b.rng.IntN(40) == 0 {
		do(netplay.Cmd{Op: netplay.OpSprint, A: uint8(b.rng.IntN(2))})
	}
	if b.rng.IntN(200) == 0 {
		do(netplay.Cmd{Op: netplay.OpPing, A: uint8(b.rng.IntN(int(game.NumPingKinds))), X: p.X + b.jitter(6), Y: p.Y + b.jitter(6)})
	}
	if b.rng.IntN(300) == 0 {
		do(netplay.Cmd{Op: netplay.OpSelect, A: uint8(b.rng.IntN(int(game.NumWeapons)))})
	}

	// A teammate down nearby comes first, when nothing is about to bite.
	for i, m := range w.Players {
		if i == int(b.ID) || m.Alive || !m.Connected || p.Order.Kind == game.OrderRevive {
			continue
		}
		if d2(p.X, p.Y, m.X, m.Y) < 30*30 && b.nearest(w, p, 4) < 0 {
			do(netplay.Cmd{Op: netplay.OpRevive, T: uint16(i)})
			return
		}
	}

	switch w.Phase {
	case game.PhaseBuild:
		b.between(s, p, do)
	case game.PhaseWave:
		b.fight(s, p, do)
	}
}

// between is a bot's build phase: shop, put a few things up, maybe go looting, and ready up
// near the end, or straight away in an impatient break. Half the breaks it builds before it
// shops, so some gold always goes on the base.
func (b *Bot) between(s *Session, p *game.Player, do func(netplay.Cmd)) {
	w := s.W
	if b.shopped != w.Wave {
		b.shopped, b.builds, b.looting, b.bought = w.Wave, 0, false, false
		b.buildFirst, b.eager = b.rng.IntN(2) == 0, b.rng.IntN(5) == 0
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
		do(netplay.Cmd{Op: netplay.OpRepair, T: uint16(si)})
		return
	}
	if b.rng.IntN(6) == 0 {
		b.upkeep(w, p, do)
	}
	if !b.looting && w.PhaseLeft > 20 && b.rng.IntN(2) == 0 {
		b.looting = true
		if si := b.site(w, p); si >= 0 {
			do(netplay.Cmd{Op: netplay.OpLoot, T: uint16(si)})
			return
		}
	}
	if !p.Ready && (b.eager || w.PhaseLeft < 8) {
		do(netplay.Cmd{Op: netplay.OpReady, A: 1})
	}
}

// build orders something it can afford put up near the generator, and reports whether it did.
func (b *Bot) build(w *game.World, p *game.Player, do func(netplay.Cmd)) bool {
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
	do(netplay.Cmd{Op: netplay.OpBuild, A: uint8(k), X: w.CoreX + float32(r*math.Cos(ang)), Y: w.CoreY + float32(r*math.Sin(ang))})
	return true
}

// goShop walks to the armory and spends there once it arrives.
func (b *Bot) goShop(w *game.World, p *game.Player, do func(netplay.Cmd)) {
	if !w.AtArmory(p) {
		if p.Order.Kind != game.OrderMove {
			a := &w.Structs[w.Armory]
			do(netplay.Cmd{Op: netplay.OpMove, X: a.CX(), Y: a.CY() + float32(a.H)/2 + 1})
		}
		return
	}
	b.shop(p, do)
	b.bought = true
}

// shop spends at the armory, in a random order over everything on sale, keeping a third of
// its gold back for building.
func (b *Bot) shop(p *game.Player, do func(netplay.Cmd)) {
	var buys []netplay.Cmd
	for k := 1; k < int(game.NumWeapons); k++ {
		buys = append(buys, netplay.Cmd{Op: netplay.OpBuyWeapon, A: uint8(k)})
		for t := 0; t < int(game.NumTracks); t++ {
			buys = append(buys, netplay.Cmd{Op: netplay.OpUpgrade, A: uint8(k), B: uint8(t)})
		}
	}
	for t := 0; t < int(game.NumTracks); t++ {
		buys = append(buys, netplay.Cmd{Op: netplay.OpUpgrade, A: uint8(game.WPistol), B: uint8(t)})
	}
	for g := 0; g < int(game.NumGear); g++ {
		buys = append(buys, netplay.Cmd{Op: netplay.OpGear, A: uint8(g)})
	}
	for a := 0; a < game.NumAbilities; a++ {
		buys = append(buys, netplay.Cmd{Op: netplay.OpBuyAbility, A: uint8(a)})
	}
	buys = append(buys, netplay.Cmd{Op: netplay.OpBuyMedkit})
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
			do(netplay.Cmd{Op: netplay.OpSelect, A: uint8(k)})
			break
		}
	}
}

// upkeep upgrades or, once in a while, sells one of the bot's own structures.
func (b *Bot) upkeep(w *game.World, p *game.Player, do func(netplay.Cmd)) {
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
		do(netplay.Cmd{Op: netplay.OpSell, T: uint16(si)})
	} else {
		do(netplay.Cmd{Op: netplay.OpUpgradeStruct, T: uint16(si), A: uint8(b.rng.IntN(int(game.NumTracks)))})
	}
}

// fight is a bot's wave: go for the nearest creep in reach with abilities to hand, else
// hold the ground round the generator.
func (b *Bot) fight(s *Session, p *game.Player, do func(netplay.Cmd)) {
	w := s.W
	ci := b.nearest(w, p, 22)
	if ci < 0 {
		if p.Order.Kind == game.OrderIdle || p.Order.Kind == game.OrderHold || b.rng.IntN(20) == 0 {
			if d2(p.X, p.Y, w.CoreX, w.CoreY) > 14*14 || b.rng.IntN(4) == 0 {
				do(netplay.Cmd{Op: netplay.OpAttackMove, X: w.CoreX + b.jitter(10), Y: w.CoreY + b.jitter(10)})
			}
		}
		if si := b.damaged(w); si >= 0 && b.rng.IntN(10) == 0 {
			do(netplay.Cmd{Op: netplay.OpRepair, T: uint16(si)})
		}
		return
	}
	c := &w.Creeps[ci]
	if p.Order.Kind != game.OrderAttack || b.rng.IntN(6) == 0 {
		do(netplay.Cmd{Op: netplay.OpAttack, T: c.ID})
	}
	for a := 0; a < game.NumAbilities; a++ {
		ready := p.Abil[a].Cool <= 0
		if a == game.AbUltimate {
			ready = p.Ult >= 1 && p.BuffLeft <= 0
		}
		if p.Abil[a].Lv > 0 && ready && b.rng.IntN(3) == 0 {
			do(netplay.Cmd{Op: netplay.OpAbility, A: uint8(a), X: c.X, Y: c.Y})
			break
		}
	}
	if p.TauntCool <= 0 && p.HP > p.MaxHP*.7 && b.rng.IntN(15) == 0 {
		do(netplay.Cmd{Op: netplay.OpTaunt})
	}
	if ws := &p.Weapons[p.Cur]; ws.Ammo == 0 && ws.Reload == 0 {
		do(netplay.Cmd{Op: netplay.OpReload})
	}
	if p.HP < p.MaxHP*.25 && b.rng.IntN(3) == 0 {
		// Fall back to the generator to live.
		do(netplay.Cmd{Op: netplay.OpMove, X: w.CoreX + b.jitter(3), Y: w.CoreY + b.jitter(3)})
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

// Result is what a played game came to.
type Result struct {
	Waves  int // waves fully survived
	Ticks  int
	Kills  uint32
	Over   bool // the generator fell
	Hashes []uint64
}

// Play runs a game of bots for up to maxWave waves or limit ticks, checking every tick. It
// stops at the first broken check, and fails a wave that will not end within stuck seconds.
func Play(s *Session, bots []*Bot, maxWave, limit int) (Result, error) {
	const stuck = 6 * 60
	var res Result
	waveStart := 0
	for i := 0; i < limit; i++ {
		for _, b := range bots {
			b.Act(s)
		}
		wasWave := s.W.Phase == game.PhaseWave
		if err := s.Step(); err != nil {
			return res, err
		}
		res.Ticks++
		res.Hashes = append(res.Hashes, s.W.Hash())
		w := s.W
		if w.Phase == game.PhaseWave && !wasWave {
			waveStart = i
		}
		if w.Phase == game.PhaseWave && i-waveStart > stuck*game.TickRate {
			return res, stuckAt(w)
		}
		if wasWave && w.Phase == game.PhaseBuild {
			res.Waves = w.Wave
		}
		if w.Phase == game.PhaseOver {
			res.Over = true
			break
		}
		if res.Waves >= maxWave {
			break
		}
	}
	res.Kills = s.W.TotalKills
	return res, nil
}

// StuckError is a wave that would not end, with what is left of it.
type StuckError struct {
	Wave, Queued int
	Left         []string // the wave's creeps still alive, a line per kind and what it is doing
}

func stuckAt(w *game.World) *StuckError {
	e := &StuckError{Wave: w.Wave, Queued: len(w.Queue) - w.QueueHead}
	type key struct {
		kind              game.CreepKind
		hunt, siege, slow bool
		far               int
	}
	n := map[key]int{}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Home != 0 || c.Wander {
			continue
		}
		d := math.Sqrt(float64(d2(c.X, c.Y, w.CoreX, w.CoreY)))
		n[key{c.Kind, c.Hunt >= 0, c.Siege >= 0, c.Slow > 0, int(d/10) * 10}]++
	}
	for k, v := range n {
		e.Left = append(e.Left, fmt.Sprintf("%4d %s %d+ tiles from the generator, hunting %v, sieging %v", v, game.Creeps[k.kind].Name, k.far, k.hunt, k.siege))
	}
	sort.Strings(e.Left)
	return e
}

func (e *StuckError) Error() string {
	return fmt.Sprintf("wave %d did not end in 6 minutes, %d still to come, left:\n%s", e.Wave, e.Queued, strings.Join(e.Left, "\n"))
}
