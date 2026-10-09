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
	Terrain []game.Tile
	Sites   []game.Site
}

// DecodeWelcome reads a welcome payload.
func DecodeWelcome(p []byte) (Welcome, error) {
	d := &dec{b: p}
	w := Welcome{Proto: int(d.u8()), Version: d.str(), You: d.u8(), W: int(d.u16()), H: int(d.u16())}
	lo, hi := d.u32(), d.u32()
	w.Seed = uint64(hi)<<32 | uint64(lo)
	w.Diff = game.Difficulty(d.u8())
	w.Fog = d.u8() != 0
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
	bw   *bufio.Writer
	msgs chan Msg
	done chan struct{}
	once sync.Once
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
	cl := &Client{conn: c, bw: bw, msgs: make(chan Msg, 256), done: make(chan struct{})}
	go cl.read(br)
	return cl, wel, nil
}

func (c *Client) read(br *bufio.Reader) {
	defer close(c.msgs)
	for {
		typ, p, err := readMsg(br)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
				err = errors.New("the host ended the game or went away")
			}
			select {
			case c.msgs <- Msg{Err: err}:
			case <-c.done:
			}
			return
		}
		select {
		case c.msgs <- Msg{Type: typ, Payload: p}:
		case <-c.done:
			return
		}
	}
}

// Msgs delivers everything the host sends, in order; closed after the final error.
func (c *Client) Msgs() <-chan Msg { return c.msgs }

// Send sends a command.
func (c *Client) Send(cmd Cmd) error {
	if err := writeMsg(c.bw, MsgCmd, cmd.encode()); err != nil {
		return err
	}
	return c.bw.Flush()
}

// Close hangs up.
func (c *Client) Close() {
	c.once.Do(func() {
		close(c.done)
		c.conn.Close()
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
