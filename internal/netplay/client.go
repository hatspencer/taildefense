package netplay

import (
	"bufio"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/tailnet"
)

// Msg is one message from the host, or the error that ended the connection (Type 0).
type Msg struct {
	Type    byte
	Payload []byte
	Err     error
}

// Welcome is what a host says when a player is let in.
type Welcome struct {
	Proto   int
	Version string
	You     uint8
	W, H    int
	Seed    uint64
	Diff    game.Difficulty
	Fog     bool // fog of war
	Mode    game.Mode
	// LastWave is the wave that ends the game with the evac, 0 for an endless game; PadX,
	// PadY the helipad's middle.
	LastWave   int
	PadX, PadY float32
	Terrain    []game.Tile
	Sites      []game.Site
}

// DecodeWelcome reads a welcome payload.
func DecodeWelcome(p []byte) (Welcome, error) {
	d := &dec{b: p}
	w := Welcome{Proto: int(d.u8()), Version: d.str(), You: d.u8(), W: int(d.u16()), H: int(d.u16())}
	lo, hi := d.u32(), d.u32()
	w.Seed = uint64(hi)<<32 | uint64(lo)
	w.Diff = game.Difficulty(d.u8())
	w.Fog = d.u8() != 0
	w.Mode = game.Mode(d.u8())
	w.LastWave = int(d.u8())
	w.PadX, w.PadY = unq(d.u16()), unq(d.u16())
	t := d.bytes()
	if d.err != nil {
		return w, d.err
	}
	if len(t) != w.W*w.H {
		return w, fmt.Errorf("welcome: terrain is %d tiles, want %dx%d", len(t), w.W, w.H)
	}
	w.Terrain = make([]game.Tile, len(t))
	for i, v := range t {
		w.Terrain[i] = game.Tile(v)
	}
	n := int(d.uv())
	for i := 0; i < n && d.err == nil && i < 4096; i++ {
		s := game.Site{Kind: game.SiteKind(d.u8()), X: int16(d.u16()), Y: int16(d.u16()), W: d.u8(), H: d.u8()}
		s.SX, s.SY, s.Tier, s.Guard = unq(d.u16()), unq(d.u16()), d.u8(), d.u8()
		s.Yaw = float32(d.u8()) / 256 * 2 * math.Pi
		w.Sites = append(w.Sites, s)
	}
	return w, d.err
}

// Client is a connection to a host.
type Client struct {
	conn net.Conn
	wmu  sync.Mutex // the TCP writer is shared by Send, Echo and the client's own messages
	bw   *bufio.Writer
	msgs chan Msg
	ev   chan event // from the TCP and UDP readers to dispatch, which owns what follows
	done chan struct{}
	once sync.Once

	// The UDP path. Only dispatch touches these, but for udp, which Close closes too.
	udpVia   string
	mu       sync.Mutex
	closed   bool
	udp      *net.UDPConn
	udpUp    atomic.Bool // the host answered the hello
	viaUDP   atomic.Bool // the last frame handed on came as a datagram
	token    uint64
	seqMode  bool // the host offered UDP, so frames are numbered on both paths
	flow     frameFlow
	parts    reassembler
	newest   uint32 // the newest unit seq received over UDP
	askedKey time.Time
}

// event is a message read from TCP or a datagram from UDP.
type event struct {
	m  Msg
	dg *datagram
}

// RejectError is a host's refusal, worded by the host.
type RejectError struct{ Reason string }

func (e *RejectError) Error() string { return e.Reason }

// SameVersion is the rule for who plays together: a host and its players run the same td.
// Builds that agree on the protocol can still differ in the simulation, so the commit decides.
func SameVersion(host, player string) bool {
	return strings.EqualFold(strings.TrimSpace(host), strings.TrimSpace(player))
}

// versionRefusal is the refusal for a player whose td is not the host's.
func versionRefusal(host, player string) string {
	return fmt.Sprintf("host and players must run the same td: the host runs %s and you run %s; run td update on both machines, then join again", host, player)
}

// IsVersionMismatch reports whether err is a refusal because the two td versions differ.
func IsVersionMismatch(err error) bool {
	return err != nil && strings.Contains(err.Error(), "must run the same td")
}

// WithPort adds the default port to an address that has none.
func WithPort(addr string) string {
	if _, _, err := net.SplitHostPort(addr); err == nil {
		return addr
	}
	return net.JoinHostPort(strings.Trim(addr, "[]"), strconv.Itoa(DefaultPort))
}

func dial(ctx context.Context, addr string, h Hello) (net.Conn, *bufio.Reader, *bufio.Writer, error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "tcp", WithPort(addr))
	if err != nil {
		return nil, nil, nil, err
	}
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	bw := bufio.NewWriter(c)
	b, _ := json.Marshal(h)
	if err := writeMsg(bw, MsgHello, b); err != nil {
		c.Close()
		return nil, nil, nil, err
	}
	if err := bw.Flush(); err != nil {
		c.Close()
		return nil, nil, nil, err
	}
	return c, bufio.NewReaderSize(flate.NewReader(bufio.NewReaderSize(c, 64<<10)), 64<<10), bw, nil
}

// Dial joins a game. It returns once the host has answered with a welcome or a refusal.
func Dial(ctx context.Context, addr string, h Hello) (*Client, Welcome, error) {
	h.Proto = Proto
	if udpDisabled() {
		h.UDP = false
	}
	c, br, bw, err := dial(ctx, addr, h)
	if err != nil {
		return nil, Welcome{}, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetReadDeadline(dl)
	} else {
		_ = c.SetReadDeadline(time.Now().Add(15 * time.Second))
	}
	typ, p, err := readMsg(br)
	if err != nil {
		c.Close()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, Welcome{}, errors.New("the host closed the connection")
		}
		return nil, Welcome{}, err
	}
	switch typ {
	case MsgReject:
		c.Close()
		return nil, Welcome{}, &RejectError{string(p)}
	case MsgWelcome:
	default:
		c.Close()
		return nil, Welcome{}, fmt.Errorf("unexpected message %d from the host", typ)
	}
	wel, err := DecodeWelcome(p)
	if err != nil {
		c.Close()
		return nil, Welcome{}, err
	}
	// A host from before the rule lets anyone in; refuse it here instead.
	if !SameVersion(wel.Version, h.Version) {
		c.Close()
		return nil, Welcome{}, &RejectError{versionRefusal(wel.Version, h.Version)}
	}
	_ = c.SetReadDeadline(time.Time{})
	cl := &Client{conn: c, bw: bw, msgs: make(chan Msg, 256), ev: make(chan event, 256), done: make(chan struct{}),
		udpVia: h.UDPVia}
	go cl.read(br)
	go cl.dispatch()
	return cl, wel, nil
}

func (c *Client) read(br *bufio.Reader) {
	for {
		typ, p, err := readMsg(br)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
				err = errors.New("the host ended the game or went away")
			}
			select {
			case c.ev <- event{m: Msg{Err: err}}:
			case <-c.done:
			}
			return
		}
		select {
		case c.ev <- event{m: Msg{Type: typ, Payload: p}}:
		case <-c.done:
			return
		}
	}
}

// dispatch puts what both paths bring into the one ordered stream of Msgs. Over TCP alone it
// passes everything on as it comes; once the host has offered UDP, frames and acks go through
// the client's frameFlow.
func (c *Client) dispatch() {
	defer close(c.msgs)
	for {
		var e event
		select {
		case e = <-c.ev:
		case <-c.done:
			return
		}
		f := &c.flow
		if e.dg != nil {
			c.datagram(*e.dg)
		} else {
			m := e.m
			switch {
			case m.Err != nil:
				f.out = append(f.out, m)
			case m.Type == MsgUDP:
				if o, err := decodeOffer(m.Payload); err == nil && !c.seqMode {
					c.seqMode = true
					f.epoch = o.Epoch
					c.startUDP(o)
				}
			case m.Type == MsgSeqFrame:
				if sf, err := decodeSeqFrame(m.Payload); err == nil {
					f.frame(sf.seq, sf.p, false)
				}
			case m.Type == MsgAck && c.seqMode:
				f.ack(m)
			case m.Type == MsgWelcome && c.seqMode:
				f.welcome(m)
				c.parts.forget(true, 0)
				c.newest = 0
			default:
				f.out = append(f.out, m)
			}
		}
		if c.seqMode {
			c.askKey()
		}
		for _, m := range f.out {
			if m.Type == MsgFrame {
				c.viaUDP.Store(f.viaUDP)
			}
			select {
			case c.msgs <- m:
			case <-c.done:
				return
			}
			if m.Err != nil {
				return
			}
		}
		f.out = f.out[:0]
	}
}

// Transport is how frames are coming from the host: "udp" or "tcp".
func (c *Client) Transport() string {
	if c.viaUDP.Load() {
		return "udp"
	}
	return "tcp"
}

func (c *Client) writeTCP(typ byte, p []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := writeMsg(c.bw, typ, p); err != nil {
		return err
	}
	return c.bw.Flush()
}

// Msgs delivers everything the host sends, in order; closed after the final error.
func (c *Client) Msgs() <-chan Msg { return c.msgs }

// Send sends a command.
func (c *Client) Send(cmd Cmd) error { return c.writeTCP(MsgCmd, cmd.encode()) }

// Echo sends p to the host, which sends it straight back as a MsgEcho.
func (c *Client) Echo(p []byte) error { return c.writeTCP(MsgEcho, p) }

// Close hangs up.
func (c *Client) Close() {
	c.once.Do(func() {
		close(c.done)
		c.conn.Close()
		c.mu.Lock()
		c.closed = true
		if c.udp != nil {
			c.udp.Close()
		}
		c.mu.Unlock()
	})
}

// DecodeToast reads a toast payload.
func DecodeToast(p []byte) (uint8, string) {
	d := &dec{b: p}
	return d.u8(), d.str()
}

// Probe asks a host what game it is running without joining.
func Probe(ctx context.Context, addr string) (Info, error) {
	c, br, _, err := dial(ctx, addr, Hello{Proto: Proto, Probe: true})
	if err != nil {
		return Info{}, err
	}
	defer c.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	typ, p, err := readMsg(br)
	if err != nil {
		return Info{}, err
	}
	if typ != MsgInfo {
		return Info{}, fmt.Errorf("unexpected message %d", typ)
	}
	var in Info
	return in, json.Unmarshal(p, &in)
}

// Found is a game discovered on the tailnet.
type Found struct {
	Info
	Addr string        `json:"addr"`
	Peer string        `json:"peer"`
	RTT  time.Duration `json:"rttNs"`
}

// Discover probes every online peer, and this machine, for a game on port.
func Discover(ctx context.Context, self tailnet.Self, peers []tailnet.Peer, port int) []Found {
	type target struct{ addr, name string }
	targets := []target{{net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), self.Host + " (this machine)"}}
	for _, p := range peers {
		if p.Online && p.Addr() != "" {
			targets = append(targets, target{net.JoinHostPort(p.Addr(), strconv.Itoa(port)), p.Host})
		}
	}
	var mu sync.Mutex
	var out []Found
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	for _, t := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			pctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
			defer cancel()
			start := time.Now()
			in, err := Probe(pctx, t.addr)
			if err != nil {
				return
			}
			mu.Lock()
			out = append(out, Found{Info: in, Addr: t.addr, Peer: t.name, RTT: time.Since(start)})
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Peer < out[j].Peer })
	return out
}
