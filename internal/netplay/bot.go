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

	shopped    int             // the wave whose break it is in, from the bot's side
	builds     int             // builds tried this break
	exploring  bool            // out exploring: off to a loot site or new ground
	scout      [2]float32      // the new ground it is walking to, if that
	bought     bool            // has been to the armory this break
	buildFirst bool            // builds before it shops this break
	eager      bool            // readies up as soon as it is done
	gun        uint16          // the weapon on the ground it last went for
	noGun      map[uint16]bool // weapons on the ground it could not get to
}

// NewBot is a bot for player id.
func NewBot(id uint8, seed uint64) *Bot {
	return &Bot{ID: id, rng: rand.New(rand.NewPCG(seed, uint64(id)+1)), shopped: -1}
}

// think is how many times a second a bot looks around. Its odds are per look, so it plays
// the same in seconds at any tick rate.
const think = 4

// thinks reports whether tick is one a bot of id thinks on: the first tick of each of think
// slots a second, staggered a tick a bot so they do not all think at once. At 20 Hz that is
// every fifth tick; at 30 it is every seventh or eighth, still four a second.
func thinks(tick uint32, id uint8) bool {
	return (tick+uint32(id))*think%game.TickRate < think
}

// Act gives this tick's commands, if it is the bot's turn to think. do carries one out at
// once, as the host would a client's, so what the bot reads next sees it done.
func (b *Bot) Act(w *game.World, do func(Cmd)) {
	if !thinks(w.Tick, b.ID) || w.Phase == game.PhaseOver || w.Paused >= 0 {
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
	// A revive under way is all the bot does until it is done: any other order, or the revive
	// asked for again, would start its count over and nobody would ever get up. Only being
	// near death itself breaks it off.
	if p.Order.Kind == game.OrderRevive && p.HP > p.MaxHP*.3 {
		return
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

	// A teammate down nearby comes first, when nothing is about to bite: one survivor revives
	// each, and a bot that finds the revive already taken stands guard over it instead.
	if b.mates(w, p, do) {
		return
	}

	// A weapon lying about is the bot's if nothing is about to bite, and it sees the pickup
	// through rather than let shopping, building or fighting call it off.
	if b.pickup(w, p, do) {
		return
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
		b.shopped, b.builds, b.bought = w.Wave, 0, false
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
	// Gold for the next tower is kept back from upgrades while there is building left to do.
	var keep int32
	if b.builds < 4+w.Wave/2 {
		if b.build(w, p, do) {
			return
		}
		if k, ok := b.want(w, p); ok {
			keep = game.Structs[k].Price
		}
	}
	if !b.bought {
		b.goShop(w, p, do)
		return
	}
	if si := b.damaged(w); si >= 0 && b.rng.IntN(3) == 0 {
		do(Cmd{Op: OpRepair, T: uint16(si)})
		return
	}
	if b.upkeep(w, p, keep, do) {
		return
	}
	// Free time: out exploring while the break has time in it, back to the generator before
	// the wave comes.
	if w.PhaseLeft > exploreUntil {
		if b.explore(w, p, do) {
			return
		}
	} else if b.exploring && d2(p.X, p.Y, w.CoreX, w.CoreY) > 20*20 && p.Order.Kind != game.OrderMove {
		b.exploring = false
		do(Cmd{Op: OpMove, X: w.CoreX + b.jitter(6), Y: w.CoreY + b.jitter(6)})
		return
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

// The bot's defence is frost and rockets: frost towers beside the way the creeps walk in, to
// hold them under fire, and missile batteries behind them, nearer the generator, whose
// salvos land on the slowed crowd. It builds no walls: a wall dropped at random inside the
// base blocks the survivors and turns the creeps into the turrets' blind side. A gun turret
// only starts a base that has no turret at all and no gold yet for anything better.

// Where on the way in each goes, in tiles from the generator's centre: frost just inside the
// starting walls (14 out), where the creeps that break through bunch up, the batteries
// further in, their 14 of reach still over the walls.
const (
	frostFrom, frostTo     = 8, 13
	missileFrom, missileTo = 4, 9
)

// want is the tower the team's base needs next and whether the bot could ever build it now
// (the generator's tier allows it): a frost tower for every missile battery, frost first.
func (b *Bot) want(w *game.World, p *game.Player) (game.StructKind, bool) {
	frost, missile, turrets := 0, 0, 0
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || !game.Structs[s.Kind].Turret {
			continue
		}
		turrets++
		switch s.Kind {
		case game.STurretFrost:
			frost++
		case game.STurretMissile:
			missile++
		}
	}
	k := game.STurretMissile
	if frost <= missile {
		k = game.STurretFrost
	}
	switch {
	case p.Gold >= game.Structs[k].Price:
	case k == game.STurretMissile && frost < missile+2 && p.Gold >= game.Structs[game.STurretFrost].Price:
		// A battery is out of reach this break, a second frost tower is not.
		k = game.STurretFrost
	case turrets == 0 && p.Gold < game.Structs[game.STurretFrost].Price:
		k = game.STurretGun
	}
	return k, game.Structs[k].Tier <= w.Tier
}

// build orders the tower the base needs put up on the creeps' way in, if the bot can afford
// it and finds ground for it, and reports whether it did.
func (b *Bot) build(w *game.World, p *game.Player, do func(Cmd)) bool {
	k, ok := b.want(w, p)
	if !ok || p.Gold < game.Structs[k].Price {
		return false
	}
	x, y, ok := b.ground(w, p, k)
	if !ok {
		return false
	}
	b.builds++
	do(Cmd{Op: OpBuild, A: uint8(k), X: float32(x), Y: float32(y)})
	return true
}

// ground finds a tile for k beside a way in: the path the creeps take from a spawn point to
// the generator (lane). Frost goes right beside it, further out, a
// battery two or three tiles off it nearer in; never on it, which would only send the creeps
// round, and not crowded on a tower of the same kind. ok is false when there is none.
func (b *Bot) ground(w *game.World, p *game.Player, k game.StructKind) (x, y int, ok bool) {
	from, to, off, spread := float32(frostFrom), float32(frostTo), []int{1}, float32(4)
	switch k {
	case game.STurretMissile:
		from, to, off, spread = missileFrom, missileTo, []int{2, 3}, 2
	case game.STurretGun:
		from, to, off, spread = 5, 12, []int{1, 2}, 2
	}
	n := len(w.SpawnPts)
	if n == 0 {
		return 0, 0, false
	}
	first := b.rng.IntN(n)
	for s := range n {
		sp := w.SpawnPts[(first+s)%n]
		lane := b.lane(w, int(sp[0]), int(sp[1]))
		on := make(map[[2]int]bool, len(lane))
		var spots [][2]int
		for _, t := range lane {
			on[t] = true
			if d := d2(float32(t[0])+.5, float32(t[1])+.5, w.CoreX, w.CoreY); d >= from*from && d <= to*to {
				spots = append(spots, t)
			}
		}
		if len(spots) == 0 {
			continue
		}
		start := b.rng.IntN(len(spots))
		for i := range spots {
			t := spots[(start+i)%len(spots)]
			for _, o := range off {
				for _, dir := range [...][2]int{{o, 0}, {-o, 0}, {0, o}, {0, -o}, {o, o}, {-o, o}, {o, -o}, {-o, -o}} {
					cx, cy := t[0]+dir[0], t[1]+dir[1]
					if on[[2]int{cx, cy}] || b.crowded(w, k, cx, cy, spread) || w.CanBuildFrom(p, k, cx, cy) != nil {
						continue
					}
					return cx, cy, true
				}
			}
		}
	}
	return 0, 0, false
}

// lane is the way a creep from x, y walks to the generator, breaking in where the creeps
// would: tile by tile along the host's own field, until the generator.
func (b *Bot) lane(w *game.World, x, y int) [][2]int {
	var path [][2]int
	for range 2 * (w.W + w.H) {
		path = append(path, [2]int{x, y})
		nx, ny, ok := w.StepIn(x, y)
		if !ok {
			break
		}
		x, y = nx, ny
	}
	return path
}

// crowded reports whether a tower of kind k already stands within r of tile x, y.
func (b *Bot) crowded(w *game.World, k game.StructKind, x, y int, r float32) bool {
	for i := range w.Structs {
		s := &w.Structs[i]
		if s.Alive && s.Kind == k && d2(s.CX(), s.CY(), float32(x)+.5, float32(y)+.5) < r*r {
			return true
		}
	}
	return false
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

// upkeep spends what is over keep on the bot's own turrets, and reports whether it ordered
// anything: an evolution when one is due (napalm for a battery, cryo for frost), else the
// cheapest next level of the track that does most for a turret's job, frost and rockets
// before anything else it owns. It never sells: a tower sold is half its gold thrown away.
func (b *Bot) upkeep(w *game.World, p *game.Player, keep int32, do func(Cmd)) bool {
	spare := p.Gold - keep
	best, bt, bc := -1, game.Track(0), int32(math.MaxInt32)
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || s.Owner != int8(p.ID) || !game.Structs[s.Kind].Turret {
			continue
		}
		if br := evolveInto(s.Kind); s.Evo == 0 && br > 0 && w.Tier >= game.EvolveTier && game.TrackSum(s) >= game.EvolveAt && game.Structs[s.Kind].Price <= spare {
			do(Cmd{Op: OpEvolve, T: uint16(i), A: br})
			return true
		}
		t, ok := nextTrack(s)
		if !ok {
			continue
		}
		c := game.TurretUpgradeCost(s.Kind, s.Lv[t])
		rank := c
		if s.Kind != game.STurretFrost && s.Kind != game.STurretMissile {
			rank *= 2
		}
		if c <= spare && rank < bc {
			best, bt, bc = i, t, rank
		}
	}
	if best < 0 {
		return false
	}
	do(Cmd{Op: OpUpgradeStruct, T: uint16(best), A: uint8(bt)})
	return true
}

// tracks is, per turret, the order its tracks are worth raising in: a battery's extra
// missile and its blast's damage, a frost tower's deeper cold and wider reach (its damage
// is a token three, never worth gold).
func tracks(k game.StructKind) []game.Track {
	switch k {
	case game.STurretMissile:
		return []game.Track{game.TrackSpecial, game.TrackDamage, game.TrackRate, game.TrackRange}
	case game.STurretFrost:
		return []game.Track{game.TrackSpecial, game.TrackRange, game.TrackRate}
	}
	return []game.Track{game.TrackDamage, game.TrackRate, game.TrackRange, game.TrackSpecial}
}

// nextTrack is the track of s to raise next: the lowest, the earlier in tracks on a tie, so
// they go up together with the ones that matter a step ahead.
func nextTrack(s *game.Structure) (game.Track, bool) {
	ts := tracks(s.Kind)
	best, bs := game.Track(0), math.MaxInt
	for i, t := range ts {
		if s.Lv[t] >= game.MaxLevel {
			continue
		}
		if score := int(s.Lv[t])*len(ts) + i; score < bs {
			best, bs = t, score
		}
	}
	return best, bs != math.MaxInt
}

// evolveInto is the evolution a bot picks for a turret of kind k, or 0 for none.
func evolveInto(k game.StructKind) uint8 {
	switch k {
	case game.STurretMissile:
		return 2 // napalm: the slowed crowd burns under it
	case game.STurretFrost:
		return 1 // cryo: every third pulse freezes the crowd solid
	}
	return 1
}

// fight is a bot's wave: go for the nearest creep in reach with abilities to hand, else
// hold the ground round the generator.
func (b *Bot) fight(w *game.World, p *game.Player, do func(Cmd)) {
	ci := b.nearest(w, p, 22)
	if ci < 0 && w.Phase == game.PhaseWave && w.CreepsLeft < exploreFew && p.HP > p.MaxHP*.5 {
		// The wave is down to its last few and none is near: the turrets have them, and the
		// bot goes exploring rather than stand about.
		if b.explore(w, p, do) {
			return
		}
	}
	if ci < 0 {
		b.exploring = false
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

// Exploring: a break with more than exploreUntil seconds left is free time, and a wave with
// fewer than exploreFew creeps left is the turrets' to finish.
const (
	exploreUntil = 15
	exploreFew   = 5
)

// explore sends the bot out, or keeps it going, and reports whether it is out: to the
// nearest unsearched loot site it dares, else to ground the team has not seen yet, else to
// somewhere out past the towers. It goes there fighting what it meets.
func (b *Bot) explore(w *game.World, p *game.Player, do func(Cmd)) bool {
	if b.exploring {
		switch p.Order.Kind {
		case game.OrderLoot:
			return true
		case game.OrderAttackMove, game.OrderAttack:
			if d2(p.X, p.Y, b.scout[0], b.scout[1]) > 3*3 {
				return true
			}
		}
	}
	if si := b.site(w, p); si >= 0 {
		b.exploring = true
		do(Cmd{Op: OpLoot, T: uint16(si)})
		return true
	}
	x, y, ok := b.unseen(w)
	if !ok {
		return false
	}
	b.exploring, b.scout = true, [2]float32{x, y}
	do(Cmd{Op: OpAttackMove, X: x, Y: y})
	return true
}

// Picking up weapons on the ground: in a break the bot walks a long way for one, in a wave
// only a short way and only with no creep near.
const (
	gunWalkBreak = 40 // tiles
	gunWalkWave  = 14
	gunSafe      = 8 // tiles: no creep this near while it goes for a weapon in a wave
)

// pickup sends the bot for the nearest weapon on the ground it has a hand free for, or keeps
// it at a pickup under way, and reports whether that is what it is doing. Nobody else's
// pickup is cut in on, and the evac, once the Huey is down, comes before any weapon.
func (b *Bot) pickup(w *game.World, p *game.Player, do func(Cmd)) bool {
	if len(w.Guns) == 0 || w.Phase == game.PhaseEvac && w.Evac.Stage == game.EvacLanded {
		return false
	}
	walk, safe := float32(gunWalkBreak), float32(4)
	if w.Phase != game.PhaseBuild {
		walk, safe = gunWalkWave, gunSafe
	}
	if b.nearest(w, p, safe) >= 0 || p.HP < p.MaxHP*.4 {
		return false
	}
	if p.Order.Kind == game.OrderPickup {
		return true
	}
	if b.gun != 0 {
		// The last pickup ended with the weapon still there and the bot standing idle: it
		// could not get to it, and does not try again.
		if p.Order.Kind == game.OrderIdle && b.lying(w, b.gun) {
			if b.noGun == nil {
				b.noGun = map[uint16]bool{}
			}
			b.noGun[b.gun] = true
		}
		b.gun = 0
	}
	best, bi := walk*walk, -1
	for i := range w.Guns {
		g := &w.Guns[i]
		if b.noGun[g.ID] || !w.CanTake(p, g.Kind) || b.claimed(w, p, g.ID) {
			continue
		}
		if d := d2(p.X, p.Y, g.X, g.Y); d < best {
			best, bi = d, i
		}
	}
	if bi < 0 {
		return false
	}
	do(Cmd{Op: OpPickup, T: w.Guns[bi].ID})
	if p.Order.Kind != game.OrderPickup {
		return false
	}
	b.gun = w.Guns[bi].ID
	return true
}

// lying reports whether weapon id is still on the ground.
func (b *Bot) lying(w *game.World, id uint16) bool {
	for i := range w.Guns {
		if w.Guns[i].ID == id {
			return true
		}
	}
	return false
}

// claimed reports whether another survivor is already on the way to pick up weapon id.
func (b *Bot) claimed(w *game.World, p *game.Player, id uint16) bool {
	for _, o := range w.Players {
		if o != p && o.Alive && o.Order.Kind == game.OrderPickup && o.Order.Gun == id {
			return true
		}
	}
	return false
}

// Downed teammates: a bot revives one nobody is reviving yet within reviveWalk, and guards
// one somebody is, keeping the creeps within guardR of it off the reviver.
const (
	reviveWalk = 30 // tiles
	guardR     = 14
)

// mates sends the bot to revive a downed teammate or to guard one being revived, and reports
// whether it did either. Bots think on different ticks and a revive is ordered at once, so
// the first to look takes the revive and the next sees it taken.
func (b *Bot) mates(w *game.World, p *game.Player, do func(Cmd)) bool {
	if p.Order.Kind == game.OrderRevive {
		return false // its own revive, broken off near death
	}
	guard := -1
	for i, m := range w.Players {
		if i == int(b.ID) || m.Alive || m.Aboard || !m.Connected || d2(p.X, p.Y, m.X, m.Y) >= reviveWalk*reviveWalk {
			continue
		}
		if b.reviver(w, p, i) {
			if guard < 0 {
				guard = i
			}
			continue
		}
		if b.nearest(w, p, 4) < 0 {
			do(Cmd{Op: OpRevive, T: uint16(i)})
			return true
		}
	}
	if guard < 0 {
		return false
	}
	m := w.Players[guard]
	if b.nearest(w, p, 6) >= 0 {
		// Something is on the bot itself: fight it off where it stands.
		b.fight(w, p, do)
		return true
	}
	if ci := b.nearestTo(w, m.X, m.Y, guardR); ci >= 0 {
		if c := &w.Creeps[ci]; p.Order.Kind != game.OrderAttack || p.Order.Target != c.ID {
			do(Cmd{Op: OpAttack, T: c.ID})
		}
		return true
	}
	if d2(p.X, p.Y, m.X, m.Y) > 5*5 && p.Order.Kind != game.OrderAttackMove {
		do(Cmd{Op: OpAttackMove, X: m.X + b.jitter(3), Y: m.Y + b.jitter(3)})
	}
	return true
}

// reviver reports whether another survivor is reviving player mate.
func (b *Bot) reviver(w *game.World, p *game.Player, mate int) bool {
	for _, o := range w.Players {
		if o != p && o.Alive && o.Order.Kind == game.OrderRevive && o.Order.Mate == mate {
			return true
		}
	}
	return false
}

// unseen is a spot to scout: ground the team has not seen yet, at night, within reach of the
// base; by day, when the whole map is in sight, a spot out past the towers. ok is false when
// none turned up in a few tries.
func (b *Bot) unseen(w *game.World) (x, y float32, ok bool) {
	for range 40 {
		ang := b.rng.Float64() * 2 * math.Pi
		r := 18 + b.rng.Float64()*40
		tx, ty := int(w.CoreX+float32(r*math.Cos(ang))), int(w.CoreY+float32(r*math.Sin(ang)))
		if tx < 1 || ty < 1 || tx >= w.W-1 || ty >= w.H-1 || w.At(tx, ty).Solid() {
			continue
		}
		if _, _, in := w.StepIn(tx, ty); !in {
			continue // shut off from the base: no way there either
		}
		if w.Seen != nil && w.Seen.Has(ty*w.W+tx) {
			continue
		}
		return float32(tx) + .5, float32(ty) + .5, true
	}
	return 0, 0, false
}
func (b *Bot) nearest(w *game.World, p *game.Player, r float32) int {
	return b.nearestTo(w, p.X, p.Y, r)
}

// nearestTo is the nearest creep awake within r of x, y, or -1.
func (b *Bot) nearestTo(w *game.World, x, y, r float32) int {
	best, bi := r*r, -1
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Asleep {
			continue
		}
		if d := d2(x, y, c.X, c.Y); d < best {
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

// taken is how much further off a site someone else is already on the way to search counts:
// a second bot takes another site only when one is nearly as close, else goes along.
const taken = 20 // tiles

// site is the nearest loot site not yet searched within a long walk that the bot dares: a
// lair or a garrison with its guards still up only once the waves have hardened it, and one
// someone else is on the way to counted taken tiles further. -1 when there is none.
func (b *Bot) site(w *game.World, p *game.Player) int {
	claimed := map[int]bool{}
	for _, o := range w.Players {
		if o != p && o.Alive && o.Order.Kind == game.OrderLoot {
			claimed[o.Order.Site] = true
		}
	}
	best, bi := float64(70), -1
	for i, st := range w.Sites {
		if st.Searched || !st.Kind.Lootable() || (st.Guards > 0 && int(st.Guard) >= 3 && w.Wave < 8) {
			continue
		}
		d := math.Sqrt(float64(d2(p.X, p.Y, st.SX, st.SY)))
		if d >= 70 {
			continue
		}
		if claimed[i] {
			d += taken
		}
		if d < best {
			best, bi = d, i
		}
	}
	return bi
}

func (b *Bot) jitter(r float32) float32 { return (b.rng.Float32()*2 - 1) * r }

func d2(ax, ay, bx, by float32) float32 { return (ax-bx)*(ax-bx) + (ay-by)*(ay-by) }
