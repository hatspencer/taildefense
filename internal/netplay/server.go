package netplay

import (
	"bufio"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/tailnet"
)

// Hello is the first message a client sends.
type Hello struct {
	Proto   int    `json:"proto"`
	Version string `json:"version"`
	Name    string `json:"name"`
	Probe   bool   `json:"probe,omitempty"`
}

// Info answers a probe: what a game is, for the join list.
type Info struct {
	Proto   int      `json:"proto"`
	Version string   `json:"version"`
	Host    string   `json:"host"`
	Owner   string   `json:"owner"`
	Players []string `json:"players"`
	Max     int      `json:"max"`
	Wave    int      `json:"wave"`
	Diff    string   `json:"difficulty,omitempty"`
	Mode    string   `json:"mode,omitempty"`
	Phase   string   `json:"phase"`
	Creeps  int      `json:"creeps"`
	Started int64    `json:"started"`
}

// ServerConfig is how a host runs.
type ServerConfig struct {
	Addrs      []string // listen addresses, host:port
	Seed       uint64
	Difficulty game.Difficulty
	FogOfWar   bool
	Mode       game.Mode // standard, or blades: no guns
	LastWave   int       // the wave that ends the game with the evac; 0 endless
	Version    string
	Host       string // this machine's name, for the join list
	Owner      string // the hosting login
	// Local identity for loopback connections: the host's own player.
	LocalLogin, LocalName string
	// Whois names a tailnet connection; nil accepts the name a client gives (tests, LAN).
	Whois func(ctx context.Context, addr string) (tailnet.Identity, error)
	// Log receives one line per event worth knowing on a dedicated server; nil discards.
	Log func(format string, a ...any)
	// Bots is how many survivors the host plays itself, 0 to MaxBots. They join after the
	// first person does, so the host keeps the first player's colour, and play every tick.
	Bots int
}

// Server is a running host.
type Server struct {
	cfg     ServerConfig
	world   *game.World
	enc     Encoder
	lns     []net.Listener
	joinCh  chan *peer
	leaveCh chan *peer
	cmdCh   chan cmdMsg
	echoCh  chan cmdMsg // Cmd.Text is the echo's payload
	peers   []*peer
	bots    []*Bot // in the game once someone has joined
	info    atomic.Pointer[Info]
	done    chan struct{}
	wg      sync.WaitGroup
	started time.Time
	once    sync.Once
	// When the last tick ran, the time between ticks, and when the players were last sent
	// their stats.
	lastTick, lastStats time.Time
	tickGap             Window
}

type outMsg struct {
	typ     byte
	payload []byte
}

type peer struct {
	conn    net.Conn
	id      tailnet.Identity
	name    string
	player  *game.Player
	out     chan outMsg
	needKey bool
	gone    bool       // left; its out channel is closed
	result  chan error // the join's answer
	// The last command applied and whether it is yet to be acked.
	seq      uint16
	seqDirty bool
	// For the player's stats: frames dropped and keyframes sent to catch up after them, a drop
	// still to be made good, and the deepest the out queue got since the last stats.
	dropped, resyncs uint32
	dropKey          bool
	qMax             int
}

type cmdMsg struct {
	p   *peer
	cmd Cmd
}

// Listen starts a host on every configured address.
func Listen(cfg ServerConfig) (*Server, error) {
	if cfg.Log == nil {
		cfg.Log = func(string, ...any) {}
	}
	if cfg.Bots < 0 || cfg.Bots > MaxBots {
		return nil, fmt.Errorf("bots: 0 to %d, not %d", MaxBots, cfg.Bots)
	}
	s := &Server{
		cfg:     cfg,
		world:   game.NewGame(cfg.Seed, cfg.Difficulty),
		joinCh:  make(chan *peer),
		leaveCh: make(chan *peer, 16),
		cmdCh:   make(chan cmdMsg, 256),
		echoCh:  make(chan cmdMsg, 16),
		done:    make(chan struct{}),
		started: time.Now(),
		tickGap: Window{Span: 10 * time.Second},
	}
	s.world.FogOfWar = cfg.FogOfWar
	s.lastStats = s.started // the first stats once there are 2 s of ticks to tell of
	s.world.Mode = cfg.Mode
	s.world.LastWave = cfg.LastWave
	for _, a := range cfg.Addrs {
		ln, err := net.Listen("tcp", a)
		if err != nil {
			for _, l := range s.lns {
				l.Close()
			}
			return nil, fmt.Errorf("listen on %s: %w", a, err)
		}
		s.lns = append(s.lns, ln)
	}
	if len(s.lns) == 0 {
		return nil, errors.New("no address to listen on")
	}
	s.publishInfo()
	for _, ln := range s.lns {
		s.wg.Add(1)
		go s.acceptLoop(ln)
	}
	s.wg.Add(1)
	go s.tickLoop()
	return s, nil
}

// Addrs are the bound addresses.
func (s *Server) Addrs() []string {
	var out []string
	for _, l := range s.lns {
		out = append(out, l.Addr().String())
	}
	return out
}

// Info is the latest probe answer.
func (s *Server) Info() Info { return *s.info.Load() }

// Close stops the host and disconnects everyone.
func (s *Server) Close() {
	s.once.Do(func() {
		close(s.done)
		for _, l := range s.lns {
			l.Close()
		}
	})
	s.wg.Wait()
}

func (s *Server) acceptLoop(ln net.Listener) {
	defer s.wg.Done()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go s.handshake(c)
	}
}

func isLoopback(addr net.Addr) bool {
	if ta, ok := addr.(*net.TCPAddr); ok {
		return ta.IP.IsLoopback()
	}
	return false
}

// handshake reads the hello, answers a probe, or identifies the player and hands them to the
// tick loop.
func (s *Server) handshake(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(c)
	bw := bufio.NewWriterSize(c, 64<<10)
	zw, _ := flate.NewWriter(bw, flate.BestSpeed)
	send := func(typ byte, p []byte) error {
		if err := writeMsg(zw, typ, p); err != nil {
			return err
		}
		if err := zw.Flush(); err != nil {
			return err
		}
		return bw.Flush()
	}
	reject := func(format string, a ...any) {
		_ = send(MsgReject, []byte(fmt.Sprintf(format, a...)))
		c.Close()
	}
	typ, p, err := readMsg(br)
	if err != nil || typ != MsgHello {
		c.Close()
		return
	}
	var h Hello
	if err := json.Unmarshal(p, &h); err != nil {
		reject("bad hello: %v", err)
		return
	}
	if h.Probe {
		b, _ := json.Marshal(s.Info())
		_ = send(MsgInfo, b)
		c.Close()
		return
	}
	if h.Proto != Proto {
		reject("this host runs game protocol %d (td %s) and you run %d (td %s); whoever is older: td update",
			Proto, s.cfg.Version, h.Proto, h.Version)
		return
	}
	if !SameVersion(s.cfg.Version, h.Version) {
		reject("%s", versionRefusal(s.cfg.Version, h.Version))
		return
	}
	var id tailnet.Identity
	switch {
	case isLoopback(c.RemoteAddr()):
		id = tailnet.Identity{Login: s.cfg.LocalLogin, Name: s.cfg.LocalName, Host: s.cfg.Host}
	case s.cfg.Whois != nil:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		id, err = s.cfg.Whois(ctx, c.RemoteAddr().String())
		cancel()
		if err != nil {
			reject("the host could not tell who you are on the tailnet: %v", err)
			return
		}
	default:
		id = tailnet.Identity{Login: "guest:" + h.Name + "@" + c.RemoteAddr().String(), Name: h.Name}
	}
	name := cleanName(h.Name)
	if name == "" {
		name = cleanName(id.Name)
	}
	if name == "" {
		name = "survivor"
	}
	pr := &peer{conn: c, id: id, name: name, out: make(chan outMsg, 24), result: make(chan error, 1)}
	select {
	case s.joinCh <- pr:
	case <-s.done:
		c.Close()
		return
	}
	if err := <-pr.result; err != nil {
		reject("%v", err)
		return
	}
	_ = c.SetDeadline(time.Time{})
	s.cfg.Log("%s (%s) joined from %s", name, id.Login, c.RemoteAddr())
	go s.writer(pr, zw, bw)
	go s.reader(pr, br)
}

// cleanName keeps a display name printable and short.
func cleanName(n string) string {
	n = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, strings.TrimSpace(n))
	if f := strings.Fields(n); len(f) > 0 {
		n = f[0]
	}
	if r := []rune(n); len(r) > 14 {
		n = string(r[:14])
	}
	return n
}

func (s *Server) writer(p *peer, zw *flate.Writer, bw *bufio.Writer) {
	defer p.conn.Close()
	for m := range p.out {
		_ = p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := writeMsg(zw, m.typ, m.payload); err != nil {
			return
		}
		// Flush only once the queue is empty: several queued frames go out in one write.
		if len(p.out) == 0 {
			if err := zw.Flush(); err != nil {
				return
			}
			if err := bw.Flush(); err != nil {
				return
			}
		}
	}
}

func (s *Server) reader(p *peer, br *bufio.Reader) {
	defer func() {
		select {
		case s.leaveCh <- p:
		case <-s.done:
		}
	}()
	for {
		typ, b, err := readMsg(br)
		if err != nil {
			return
		}
		switch typ {
		case MsgCmd:
			cmd, err := decodeCmd(b)
			if err != nil {
				return
			}
			select {
			case s.cmdCh <- cmdMsg{p, cmd}:
			case <-s.done:
				return
			}
		case MsgEcho:
			// Answered from the tick loop, behind the frames already queued, as a command would be.
			select {
			case s.echoCh <- cmdMsg{p, Cmd{Text: string(b)}}:
			case <-s.done:
				return
			}
		}
	}
}

func (s *Server) tickLoop() {
	defer s.wg.Done()
	t := time.NewTicker(time.Second / game.TickRate)
	defer t.Stop()
	defer func() {
		for _, p := range s.peers {
			close(p.out)
		}
	}()
	for {
		select {
		case <-s.done:
			return
		case p := <-s.joinCh:
			s.join(p)
		case p := <-s.leaveCh:
			s.leave(p)
		case m := <-s.cmdCh:
			s.command(m.p, m.cmd)
		case m := <-s.echoCh:
			if !m.p.gone {
				select {
				case m.p.out <- outMsg{MsgEcho, []byte(m.cmd.Text)}:
				default:
				}
			}
		case <-t.C:
			s.tick()
		}
	}
}

func (s *Server) welcome(p *peer) outMsg {
	w := s.world
	var b enc
	b.u8(Proto)
	b.str(s.cfg.Version)
	b.u8(p.player.ID)
	b.u16(uint16(w.W))
	b.u16(uint16(w.H))
	b.u32(uint32(w.Seed))
	b.u32(uint32(w.Seed >> 32))
	b.u8(uint8(w.Diff))
	b.flag(w.FogOfWar)
	b.u8(uint8(w.Mode))
	b.u8(uint8(w.LastWave))
	b.u16(qpos(w.PadX))
	b.u16(qpos(w.PadY))
	t := make([]byte, len(w.Terrain))
	for i, v := range w.Terrain {
		t[i] = byte(v)
	}
	b.bytes(t)
	b.uv(uint64(len(w.Sites)))
	for _, st := range w.Sites {
		b.u8(uint8(st.Kind))
		b.u16(uint16(st.X))
		b.u16(uint16(st.Y))
		b.u8(st.W)
		b.u8(st.H)
		b.u16(qpos(st.SX))
		b.u16(qpos(st.SY))
		b.u8(st.Tier)
		b.u8(st.Guard)
		b.u8(uint8(int(math.Round(float64(st.Yaw)/(2*math.Pi)*256)) & 255))
	}
	return outMsg{MsgWelcome, b.b}
}

func (s *Server) join(p *peer) {
	pl, err := s.world.Join(p.name, p.id.Login)
	if err != nil {
		p.result <- err
		return
	}
	p.player = pl
	p.needKey = true
	p.out <- s.welcome(p)
	s.peers = append(s.peers, p)
	p.result <- nil
	if len(s.bots) < s.cfg.Bots {
		s.addBots()
		s.publishInfo()
	}
}

// addBots brings the configured bots into the game, each a survivor with a login no person
// has, so nobody joining can take one over.
func (s *Server) addBots() {
	for i := len(s.bots); i < s.cfg.Bots; i++ {
		name := fmt.Sprintf("bot-%d", i+1)
		pl, err := s.world.Join(name, name+"@bots.taildefense")
		if err != nil {
			s.cfg.Log("%s could not join: %v", name, err)
			return
		}
		s.bots = append(s.bots, s.newBot(pl.ID))
		s.cfg.Log("%s joined", name)
	}
}

func (s *Server) newBot(id uint8) *Bot {
	b := NewBot(id, s.world.Seed)
	b.Live = true
	return b
}

// playBots lets every bot think, before the tick, as a client's commands come in before it.
// A bot goes the way a client's command does, but for what only a person should do: pause,
// restart and the difficulty. Nobody is told of a bot's refusals.
func (s *Server) playBots() {
	w := s.world
	for _, b := range s.bots {
		pl := w.Players[b.ID]
		b.Act(w, func(c Cmd) {
			switch c.Op {
			case OpPause, OpRestart, OpDifficulty, OpChat:
				return
			}
			w.Touch(pl)
			_, _ = Exec(w, pl, c)
		})
	}
}

func (s *Server) leave(p *peer) {
	for i, q := range s.peers {
		if q == p {
			s.peers = append(s.peers[:i], s.peers[i+1:]...)
			s.world.Leave(p.player)
			p.gone = true
			close(p.out)
			s.cfg.Log("%s left", p.name)
			return
		}
	}
}

func (s *Server) toast(p *peer, level uint8, format string, a ...any) {
	var b enc
	b.u8(level)
	b.str(fmt.Sprintf(format, a...))
	select {
	case p.out <- outMsg{MsgToast, b.b}:
	default:
	}
}

func (s *Server) command(p *peer, c Cmd) {
	if p.gone {
		return
	}
	// Applied, refused or not: either way the next frame is the answer to it.
	p.seq, p.seqDirty = c.Seq, true
	w, pl := s.world, p.player
	w.Touch(pl)
	var msg string
	var err error
	switch c.Op {
	case OpRestart:
		if w.Phase != game.PhaseOver {
			err = errors.New("the game is still running")
			break
		}
		s.restart()
	case OpDifficulty:
		if s.cfg.Owner == "" || p.id.Login != s.cfg.Owner {
			err = errors.New("only the host can change the difficulty")
			break
		}
		if err = w.SetDifficulty(pl, game.Difficulty(c.A)); err == nil {
			for _, q := range s.peers {
				if q.gone {
					continue
				}
				select {
				case q.out <- outMsg{MsgDiff, []byte{uint8(w.Diff)}}:
				default:
				}
			}
		}
	default:
		msg, err = Exec(w, pl, c)
	}
	if msg != "" {
		s.toast(p, 1, "%s", msg)
	}
	if err != nil {
		s.toast(p, 2, "%v", err)
	}
}

// Exec carries out a player's command on the world, all but a restart and a change of
// difficulty, which need the server. It returns what to tell the player on success. The
// playtests drive the world through it, so bots and fuzzers take the path a client does.
func Exec(w *game.World, pl *game.Player, c Cmd) (string, error) {
	var msg string
	var err error
	switch c.Op {
	case OpMove, OpAttackMove:
		if pl.Alive {
			w.MoveTo(pl, c.X, c.Y, c.Op == OpAttackMove)
		}
	case OpAttack:
		if pl.Alive {
			err = w.AttackCreep(pl, c.T)
		}
	case OpStop, OpHold:
		w.Stop(pl, c.Op == OpHold)
	case OpAbility:
		err = w.Cast(pl, int(c.A), c.X, c.Y)
	case OpBuyAbility:
		if err = w.BuyAbility(pl, int(c.A)); err == nil {
			msg = fmt.Sprintf("%s → level %d", game.Abilities[c.A].Name, pl.Abil[c.A].Lv)
		}
	case OpBuyWeapon:
		if err = w.BuyWeapon(pl, game.WeaponKind(c.A)); err == nil {
			msg = fmt.Sprintf("bought the %s", game.Weapons[c.A].Name)
		}
	case OpUpgrade:
		if err = w.Upgrade(pl, game.WeaponKind(c.A), game.Track(c.B)); err == nil {
			msg = fmt.Sprintf("%s %s → level %d", game.Weapons[c.A].Name, game.TrackNames[c.B], pl.Weapons[c.A].Lv[c.B])
		}
	case OpGear:
		if err = w.BuyGear(pl, game.Gear(c.A)); err == nil {
			msg = fmt.Sprintf("%s → level %d", game.GearNames[c.A], pl.Gear[c.A])
		}
	case OpSelect:
		err = w.Select(pl, game.WeaponKind(c.A))
	case OpReload:
		w.Reload(pl)
	case OpReady:
		w.SetReady(pl, c.A == 1)
	case OpBuild:
		if !pl.Alive {
			err = errors.New("you are down")
		} else {
			err = w.OrderBuild(pl, game.StructKind(c.A), int(c.X), int(c.Y))
		}
	case OpRepair:
		if pl.Alive {
			err = w.OrderRepair(pl, int(c.T))
		}
	case OpFixAll:
		var rebuilt, mended int
		if rebuilt, mended, err = w.FixAll(pl); err == nil {
			msg = fixed(rebuilt, mended)
		}
	case OpLoot:
		if pl.Alive {
			err = w.OrderLoot(pl, int(c.T))
		}
	case OpTaunt:
		err = w.Taunt(pl)
	case OpSprint:
		w.SetSprint(pl, c.A == 1)
	case OpPause:
		w.TogglePause(pl)
	case OpPing:
		err = w.Ping(pl, c.X, c.Y, game.PingKind(c.A))
	case OpSteer:
		if pl.Alive {
			w.Steer(pl, float32(c.A)*(2*math.Pi/256), c.B == 1)
		}
	case OpMedkit:
		err = w.UseMedkit(pl)
	case OpBuyMedkit:
		if err = w.BuyMedkit(pl); err == nil {
			msg = fmt.Sprintf("bought a medkit · %d carried", pl.Medkits)
		}
	case OpBuyGoggles:
		if err = w.BuyGoggles(pl); err == nil {
			msg = "night vision goggles on: you see by night as by day"
		}
	case OpRevive:
		err = w.OrderRevive(pl, int(c.T))
	case OpBoard:
		err = w.OrderBoard(pl)
	case OpGate:
		if pl.Alive {
			err = w.OrderGate(pl, int(c.T))
		}
	case OpPayIn:
		err = w.PayIn(pl)
	case OpEvolve:
		err = w.Evolve(pl, int(c.T), c.A)
	case OpOverload:
		err = w.Overload(pl)
	case OpEvolveWeapon:
		err = w.EvolveWeapon(pl, game.WeaponKind(c.A), c.B)
	case OpPickBlade:
		err = w.PickBlade(pl, game.WeaponKind(c.A))
	case OpDropWeapon:
		err = w.DropWeapon(pl, game.WeaponKind(c.A))
	case OpPickup:
		if pl.Alive {
			err = w.OrderPickup(pl, c.T)
		}
	case OpUpgradeStruct:
		si := int(c.T)
		if err = w.UpgradeStruct(pl, si, game.Track(c.A)); err == nil {
			st := &w.Structs[si]
			if game.Structs[st.Kind].Turret {
				msg = fmt.Sprintf("%s: %s → %d", game.Structs[st.Kind].Name, game.TurretTrackNames[c.A], st.Lv[c.A])
			} else {
				msg = fmt.Sprintf("%s → level %d", game.Structs[st.Kind].Name, st.Level)
			}
		}
	case OpSell:
		var g int32
		if g, err = w.Sell(pl, int(c.T)); err == nil {
			msg = fmt.Sprintf("sold for %d gold", g)
		}
	case OpGive:
		if err = w.Give(pl, int(c.A), int32(c.T)); err == nil {
			msg = fmt.Sprintf("gave %s %d gold", w.Players[c.A].Name, c.T)
		}
	case OpChat:
		if t := strings.TrimSpace(c.Text); t != "" {
			w.Notes = append(w.Notes, game.Note{Text: pl.Name + ": " + t, Level: game.NoteChat})
		}
	}
	return msg, err
}

func (s *Server) restart() {
	nw := s.world.Restart(uint64(time.Now().UnixNano()))
	s.world = nw
	// Nothing sent about the old map is a base for the new one: every peer gets a key frame.
	s.enc = Encoder{}
	for _, p := range s.peers {
		p.player = nw.Players[p.player.ID]
		p.needKey = true
		p.dropKey = false // the keyframe now is for the new map, not a catch-up
		select {
		case p.out <- s.welcome(p):
		default:
			p.conn.Close()
		}
	}
	// The bots keep their survivors and start the new game fresh.
	for i, b := range s.bots {
		s.bots[i] = s.newBot(b.ID)
	}
	s.cfg.Log("restarted on a new map")
}

func (s *Server) tick() {
	now := time.Now()
	if !s.lastTick.IsZero() {
		s.tickGap.Add(now, float64(now.Sub(s.lastTick))/float64(time.Millisecond))
	}
	s.lastTick = now
	s.playBots()
	w := s.world
	w.Step()
	for _, n := range w.Notes {
		s.cfg.Log("%s", n.Text)
	}
	for _, t := range w.Toasts {
		for _, p := range s.peers {
			if p.player.ID == t.Player {
				s.toast(p, t.Level, "%s", t.Text)
			}
		}
	}
	delta := s.enc.Delta(w, w.AtArmory)
	var shared, keyFrame []byte
	for _, p := range s.peers {
		var m outMsg
		key := p.needKey
		if key {
			if keyFrame == nil {
				keyFrame = append([]byte(nil), s.enc.Key(w, w.AtArmory)...)
			}
			m = outMsg{MsgFrame, keyFrame}
		} else {
			if shared == nil {
				shared = append([]byte(nil), delta...)
			}
			m = outMsg{MsgFrame, shared}
		}
		select {
		case p.out <- m:
			p.needKey = false
			if key && p.dropKey {
				p.resyncs++
				p.dropKey = false
			}
			// Behind its frame, so the ack never reaches the client before what it acks.
			if p.seqDirty {
				select {
				case p.out <- outMsg{MsgAck, Ack{Seq: p.seq, Tick: uint32(w.Tick)}.encode()}:
					p.seqDirty = false
				default:
				}
			}
		default:
			// The client is behind: drop frames until its queue drains, then resync. An ack
			// waits for a frame that gets through.
			p.needKey = true
			p.dropKey = true
			p.dropped++
		}
		p.qMax = max(p.qMax, len(p.out))
	}
	if now.Sub(s.lastStats) >= 2*time.Second {
		s.sendStats(now)
	}
	if w.Tick%game.TickRate == 0 {
		s.publishInfo()
	}
}

// sendStats tells each player how the host's link to them is doing; see Stats.
func (s *Server) sendStats(now time.Time) {
	s.lastStats = now
	q, _ := s.tickGap.Quantiles(now, 0.5, 0.99, 1)
	tenths := func(ms float64) uint16 { return uint16(min(max(math.Round(ms*10), 0), 65535)) }
	for _, p := range s.peers {
		st := Stats{Dropped: p.dropped, Resyncs: p.resyncs, QMax: uint8(min(p.qMax, 255)), QCap: uint8(min(cap(p.out), 255)),
			TickP50: tenths(q[0]), TickP99: tenths(q[1]), TickMax: tenths(q[2])}
		select {
		case p.out <- outMsg{MsgStats, st.encode()}:
			p.qMax = 0
		default:
		}
	}
}

func (s *Server) publishInfo() {
	w := s.world
	var names []string
	for _, p := range w.Players {
		if p.Connected {
			names = append(names, p.Name)
		}
	}
	s.info.Store(&Info{Proto: Proto, Version: s.cfg.Version, Host: s.cfg.Host, Owner: s.cfg.Owner, Players: names,
		Max: game.MaxPlayers, Wave: w.Wave, Diff: w.Diff.String(), Mode: w.Mode.String(), Phase: w.Phase.String(), Creeps: len(w.Creeps), Started: s.started.Unix()})
}

// Ops a client can ask for.
const (
	OpBuyWeapon uint8 = iota + 1
	OpUpgrade
	OpGear
	OpSelect
	OpReload
	OpReady
	OpBuild // A kind, X Y tile
	OpUpgradeStruct
	OpSell
	OpRestart
	OpChat
	OpMove       // X Y
	OpAttackMove // X Y
	OpAttack     // T creep id
	OpStop
	OpHold
	OpRepair     // T structure index
	OpAbility    // A slot, X Y
	OpBuyAbility // A slot
	OpLoot       // T site index
	OpTaunt
	OpRevive // T player id
	OpSprint // A 1 held, 0 let go
	OpPause  // toggles
	OpPing   // A kind, X Y
	OpSteer  // A angle in 256ths of a turn, B 1 walking, 0 let go
	OpMedkit // use one
	OpBuyMedkit
	OpDifficulty // A difficulty; the host only
	OpDropWeapon // A weapon kind
	OpPickup     // T the weapon on the ground's id
	OpBuyGoggles
	OpFixAll // rebuild every ghost and repair everything, between waves
	OpBoard  // get aboard the evac Huey on the pad
	OpGive   // A player id, T gold
	OpGate   // T structure index: walk to the gate and open or shut it
	OpPayIn  // put 100 gold into the generator's next tier
	OpEvolve // T structure index, A branch 1 or 2
	OpOverload
	OpEvolveWeapon // A a legendary's weapon kind, B branch 1 or 2
	OpPickBlade    // A the weapon kind a blades game's survivor starts with
)

// Cmd is a discrete request from a player. X and Y are tiles, sent to 1/8; T names a creep
// or a structure. Seq counts a client's commands, wrapping; the host acks the last one it
// applied (MsgAck), so a client can tell which of its orders a frame already shows.
type Cmd struct {
	Op, A, B uint8
	X, Y     float32
	T        uint16
	Text     string
	Seq      uint16
}

func (c Cmd) encode() []byte {
	var b enc
	b.u8(c.Op)
	b.u8(c.A)
	b.u8(c.B)
	b.u16(qpos(c.X))
	b.u16(qpos(c.Y))
	b.u16(c.T)
	b.str(c.Text)
	b.u16(c.Seq)
	return b.b
}

func decodeCmd(p []byte) (Cmd, error) {
	d := &dec{b: p}
	c := Cmd{Op: d.u8(), A: d.u8(), B: d.u8(), X: unq(d.u16()), Y: unq(d.u16()), T: d.u16(), Text: d.str(), Seq: d.u16()}
	return c, d.err
}

// fixed says what a FixAll did.
func fixed(rebuilt, mended int) string {
	var parts []string
	if rebuilt > 0 {
		parts = append(parts, fmt.Sprintf("rebuilt %d", rebuilt))
	}
	if mended > 0 {
		parts = append(parts, fmt.Sprintf("repaired %d", mended))
	}
	return strings.Join(parts, " · ")
}
