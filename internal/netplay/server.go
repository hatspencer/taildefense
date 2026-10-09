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
	Phase   string   `json:"phase"`
	Creeps  int      `json:"creeps"`
	Started int64    `json:"started"`
}

// ServerConfig is how a host runs.
type ServerConfig struct {
	Addrs      []string // listen addresses, host:port
	Seed       uint64
	Difficulty game.Difficulty
	Version    string
	Host       string // this machine's name, for the join list
	Owner      string // the hosting login
	// Local identity for loopback connections: the host's own player.
	LocalLogin, LocalName string
	// Whois names a tailnet connection; nil accepts the name a client gives (tests, LAN).
	Whois func(ctx context.Context, addr string) (tailnet.Identity, error)
	// Log receives one line per event worth knowing on a dedicated server; nil discards.
	Log func(format string, a ...any)
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
	peers   []*peer
	info    atomic.Pointer[Info]
	done    chan struct{}
	wg      sync.WaitGroup
	started time.Time
	once    sync.Once
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
	s := &Server{
		cfg:     cfg,
		world:   game.NewGame(cfg.Seed, cfg.Difficulty),
		joinCh:  make(chan *peer),
		leaveCh: make(chan *peer, 16),
		cmdCh:   make(chan cmdMsg, 256),
		done:    make(chan struct{}),
		started: time.Now(),
	}
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
	w, pl := s.world, p.player
	w.Touch(pl)
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
			s.toast(p, 1, "%s → level %d", game.Abilities[c.A].Name, pl.Abil[c.A].Lv)
		}
	case OpBuyWeapon:
		if err = w.BuyWeapon(pl, game.WeaponKind(c.A)); err == nil {
			s.toast(p, 1, "bought the %s", game.Weapons[c.A].Name)
		}
	case OpUpgrade:
		if err = w.Upgrade(pl, game.WeaponKind(c.A), game.Track(c.B)); err == nil {
			s.toast(p, 1, "%s %s → level %d", game.Weapons[c.A].Name, game.TrackNames[c.B], pl.Weapons[c.A].Lv[c.B])
		}
	case OpGear:
		if err = w.BuyGear(pl, game.Gear(c.A)); err == nil {
			s.toast(p, 1, "%s → level %d", game.GearNames[c.A], pl.Gear[c.A])
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
			s.toast(p, 1, "bought a medkit · %d carried", pl.Medkits)
		}
	case OpRevive:
		err = w.OrderRevive(pl, int(c.T))
	case OpUpgradeStruct:
		si := int(c.T)
		if err = w.UpgradeStruct(pl, si); err == nil {
			st := &w.Structs[si]
			s.toast(p, 1, "%s → level %d", game.Structs[st.Kind].Name, st.Level)
		}
	case OpSell:
		var g int32
		if g, err = w.Sell(pl, int(c.T)); err == nil {
			s.toast(p, 1, "sold for %d gold", g)
		}
	case OpRestart:
		if w.Phase != game.PhaseOver {
			err = errors.New("the game is still running")
			break
		}
		s.restart()
	case OpChat:
		if t := strings.TrimSpace(c.Text); t != "" {
			w.Notes = append(w.Notes, game.Note{Text: pl.Name + ": " + t, Level: game.NoteChat})
		}
	}
	if err != nil {
		s.toast(p, 2, "%v", err)
	}
}

func (s *Server) restart() {
	nw := s.world.Restart(uint64(time.Now().UnixNano()))
	s.world = nw
	for _, p := range s.peers {
		p.player = nw.Players[p.player.ID]
		p.needKey = true
		select {
		case p.out <- s.welcome(p):
		default:
			p.conn.Close()
		}
	}
	s.cfg.Log("restarted on a new map")
}

func (s *Server) tick() {
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
	var shared, key []byte
	for _, p := range s.peers {
		var m outMsg
		if p.needKey {
			if key == nil {
				key = append([]byte(nil), s.enc.Key(w, w.AtArmory)...)
			}
			m = outMsg{MsgFrame, key}
		} else {
			if shared == nil {
				shared = append([]byte(nil), delta...)
			}
			m = outMsg{MsgFrame, shared}
		}
		select {
		case p.out <- m:
			p.needKey = false
		default:
			// The client is behind: drop frames until its queue drains, then resync.
			p.needKey = true
		}
	}
	if w.Tick%game.TickRate == 0 {
		s.publishInfo()
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
		Max: game.MaxPlayers, Wave: w.Wave, Diff: w.Diff.String(), Phase: w.Phase.String(), Creeps: len(w.Creeps), Started: s.started.Unix()})
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
)

// Cmd is a discrete request from a player. X and Y are tiles, sent to 1/8; T names a creep
// or a structure.
type Cmd struct {
	Op, A, B uint8
	X, Y     float32
	T        uint16
	Text     string
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
	return b.b
}

func decodeCmd(p []byte) (Cmd, error) {
	d := &dec{b: p}
	c := Cmd{Op: d.u8(), A: d.u8(), B: d.u8(), X: unq(d.u16()), Y: unq(d.u16()), T: d.u16(), Text: d.str()}
	return c, d.err
}
