// Package web is the game as a player sees it: a page in the browser, served by td on this
// machine, talking to td over a WebSocket. td relays to the host over the tailnet, so the
// host still sees a tailnet peer it can whois, and the browser never leaves localhost.
//
//	browser ──WebSocket, localhost──▶ td ──TCP, deltas, tailnet──▶ host
//
// The page is the client in web/, built into dist/ and embedded here.
package web

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

//go:embed all:dist
var dist embed.FS

// EnvListen is where the page is served, host:port; the default is a free port on loopback.
// Only loopback is accepted: the page is the player's own, nobody else's.
const EnvListen = "TAILDEFENSE_WEB"

// Options are how a player joins a game in the browser.
type Options struct {
	Addr    string // the host, host:port; netplay.DefaultPort is added when missing
	Name    string // display name; the host may shorten it
	Version string // this build, sent in the hello
	Host    string // what to call the host in the page
	Hosting bool   // this td is the host: leaving ends the game for everyone
	Hint    string // how friends join, for the page
	// Status is an optional line for the page, such as who is connected, asked every 2 s.
	Status func() string
	// Browser is the BROWSER setting to open the page with; "" opens nothing.
	Browser string
	// Ready is called once the page is served and the browser started, before anything
	// waits on a browser. The caller says where the game is.
	Ready func(Page)
	// Notice is shown in the page once it is up, such as that td is out of date.
	Notice string
	// Listen overrides where the page is served, for tests.
	Listen string
}

// Page is where the game is being served, for the terminal to say.
type Page struct {
	URL     string // the game, for any browser
	Opened  string // where Browser opened it, such as "Google Chrome, full screen"; "" for nowhere
	OpenErr error  // why it was not opened, nil when it was or nothing was asked
	Links   []Link // one per installed browser: following it starts the game there
}

// Link starts the game in one browser when followed, in whatever browser follows it: a
// terminal hyperlink opens the system's browser, which asks td to start this one.
type Link struct {
	Browser Browser
	URL     string
}

// Result is how a session ended.
type Result struct {
	Wave   int    // the wave reached
	Best   int    // waves survived, when the game was lost
	Kills  uint64 // this player's kills
	Reason string // why the session ended: "left", or the host's last word
}

// browser is one page's connection; only the newest is kept.
type browser struct {
	ws    *wsConn
	out   chan []byte // binary frames; the newest wins when the page is slow
	text  chan []byte
	gone  chan struct{}
	ready bool // welcome and terrain sent
}

type inbound struct {
	b   *browser
	msg []byte
	err error // the page went away
}

// Run joins the game and serves it to the browser until the player leaves, the host goes
// away, or ctx ends.
func Run(ctx context.Context, o Options) (Result, error) {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	cl, wel, err := netplay.Dial(dctx, o.Addr, netplay.Hello{Name: o.Name, Version: o.Version})
	cancel()
	if err != nil {
		return Result{}, err
	}
	defer cl.Close()

	listen := o.Listen
	if listen == "" {
		listen = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return Result{}, fmt.Errorf("serve the game page: %w", err)
	}
	if ta, ok := ln.Addr().(*net.TCPAddr); !ok || !ta.IP.IsLoopback() {
		ln.Close()
		return Result{}, fmt.Errorf("the game page must be served on loopback, not %s", ln.Addr())
	}
	token := newToken()
	port := ln.Addr().(*net.TCPAddr).Port
	conns := make(chan *browser)
	in := make(chan inbound, 64)
	done := make(chan struct{})
	defer close(done)
	url := fmt.Sprintf("http://127.0.0.1:%d/#%s", port, token)
	var browsers launcher
	srv := &http.Server{Handler: handler(token, port, conns, in, done, &browsers, url), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	defer browsers.closeSoon(1500 * time.Millisecond)

	page := Page{URL: url}
	if o.Browser != "" {
		page.Opened, page.OpenErr = browsers.open(o.Browser, url)
	}
	for _, b := range Browsers() {
		page.Links = append(page.Links, Link{b, fmt.Sprintf("http://127.0.0.1:%d/launch/%s?token=%s", port, b.ID, token)})
	}
	if o.Ready != nil {
		o.Ready(page)
	}

	s := &session{o: o, cl: cl}
	s.reset(wel)
	status := time.NewTicker(2 * time.Second)
	defer status.Stop()
	defer func() {
		if s.b != nil {
			close(s.b.out)
		}
	}()
	for {
		select {
		case <-ctx.Done():
			s.end("td was stopped in the terminal")
			return s.result("left"), nil
		case b := <-conns:
			if s.b != nil {
				s.text(s.b, map[string]any{"t": "end", "reason": "the game was opened in another tab"})
				close(s.b.out)
			}
			s.b = b
			s.greet()
		case m := <-in:
			if m.b != s.b {
				continue
			}
			if m.err != nil {
				close(s.b.out)
				s.b = nil
				continue
			}
			if s.command(m.msg) {
				s.end("you left the game")
				return s.result("left"), nil
			}
		case m, ok := <-cl.Msgs():
			if !ok || m.Err != nil {
				reason := "the host ended the game or went away"
				if ok && m.Err != nil {
					reason = m.Err.Error()
				}
				s.end(reason)
				return s.result(reason), nil
			}
			s.host(m)
		case <-status.C:
			if o.Status != nil && s.b != nil {
				s.text(s.b, map[string]any{"t": "status", "text": o.Status()})
			}
		}
	}
}

type session struct {
	o    Options
	cl   *netplay.Client
	wel  netplay.Welcome
	r    *netplay.Replica
	b    *browser
	enc  viewEncoder
	core point
}

func (s *session) reset(wel netplay.Welcome) {
	s.wel = wel
	s.r = netplay.NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	if s.b != nil {
		s.b.ready = false
	}
}

// host takes one message from the host.
func (s *session) host(m netplay.Msg) {
	switch m.Type {
	case netplay.MsgWelcome:
		// The host restarted on a new map.
		if wel, err := netplay.DecodeWelcome(m.Payload); err == nil {
			s.reset(wel)
		}
	case netplay.MsgFrame:
		if err := s.r.Apply(m.Payload); err != nil || !s.r.Synced {
			return
		}
		if s.b == nil {
			s.r.Drain()
			return
		}
		if !s.b.ready {
			s.greet()
		}
		frame := s.enc.frame(s.r)
		select {
		case s.b.out <- append([]byte(nil), frame...):
		default:
			// The page is behind; this frame is dropped, the next one is whole anyway.
		}
	case netplay.MsgToast:
		level, text := netplay.DecodeToast(m.Payload)
		if s.b != nil {
			s.text(s.b, map[string]any{"t": "toast", "level": level, "text": text})
		}
	}
}

// greet sends a page the welcome and the terrain, once the replica has a keyframe to say
// where the generator is.
func (s *session) greet() {
	b := s.b
	if b == nil || b.ready || !s.r.Synced {
		return
	}
	for _, st := range s.r.Structs {
		if st.Alive && st.Kind == game.SCore {
			s.core = point{float32(st.X) + float32(st.W)/2, float32(st.Y) + float32(st.H)/2}
		}
	}
	s.text(b, welcome(s.wel, s.core, s.o.Host, s.o.Hint, s.o.Hosting))
	s.send(b, terrainMsg(s.wel.Terrain))
	b.ready = true
	if s.o.Notice != "" {
		s.text(b, map[string]any{"t": "toast", "level": 2, "text": s.o.Notice})
	}
}

func (s *session) text(b *browser, v any) {
	p, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case b.text <- p:
	default:
	}
}

// send queues a binary message that must not be dropped, such as the terrain.
func (s *session) send(b *browser, p []byte) {
	select {
	case b.text <- append([]byte{0}, p...):
	default:
	}
}

func (s *session) end(reason string) {
	if s.b == nil {
		return
	}
	s.text(s.b, map[string]any{"t": "end", "reason": reason})
	// Give the writer a moment to deliver it before the socket goes.
	select {
	case <-s.b.gone:
	case <-time.After(300 * time.Millisecond):
	}
}

func (s *session) result(reason string) Result {
	res := Result{Wave: s.r.Wave, Best: s.r.Best, Reason: reason}
	if me := s.r.Me(); me != nil {
		res.Kills = me.Kills
	}
	return res
}

// cmd is a command from the page; see web/PROTOCOL.md.
type cmd struct {
	Op    string  `json:"op"`
	X     float32 `json:"x"`
	Y     float32 `json:"y"`
	TX    int     `json:"tx"`
	TY    int     `json:"ty"`
	ID    int     `json:"id"`
	S     int     `json:"s"`
	Site  int     `json:"site"`
	P     int     `json:"p"`
	Slot  int     `json:"slot"`
	Kind  int     `json:"kind"`
	W     int     `json:"w"`
	Track int     `json:"track"`
	G     int     `json:"g"`
	On    bool    `json:"on"`
	Text  string  `json:"text"`
}

func u8(v int) uint8   { return uint8(min(max(v, 0), 255)) }
func u16(v int) uint16 { return uint16(min(max(v, 0), 65535)) }

// command relays one command from the page to the host. It reports whether the player left.
func (s *session) command(p []byte) bool {
	var c cmd
	if err := json.Unmarshal(p, &c); err != nil {
		return false
	}
	var nc netplay.Cmd
	switch c.Op {
	case "leave":
		return true
	case "move":
		nc = netplay.Cmd{Op: netplay.OpMove, X: c.X, Y: c.Y}
	case "amove":
		nc = netplay.Cmd{Op: netplay.OpAttackMove, X: c.X, Y: c.Y}
	case "attack":
		nc = netplay.Cmd{Op: netplay.OpAttack, T: u16(c.ID)}
	case "stop":
		nc = netplay.Cmd{Op: netplay.OpStop}
	case "hold":
		nc = netplay.Cmd{Op: netplay.OpHold}
	case "ability":
		nc = netplay.Cmd{Op: netplay.OpAbility, A: u8(c.Slot), X: c.X, Y: c.Y}
	case "build":
		nc = netplay.Cmd{Op: netplay.OpBuild, A: u8(c.Kind), X: float32(c.TX), Y: float32(c.TY)}
	case "repair":
		nc = netplay.Cmd{Op: netplay.OpRepair, T: u16(c.S)}
	case "loot":
		nc = netplay.Cmd{Op: netplay.OpLoot, T: u16(c.Site)}
	case "upgradeStruct":
		nc = netplay.Cmd{Op: netplay.OpUpgradeStruct, T: u16(c.S)}
	case "sell":
		nc = netplay.Cmd{Op: netplay.OpSell, T: u16(c.S)}
	case "buyWeapon":
		nc = netplay.Cmd{Op: netplay.OpBuyWeapon, A: u8(c.W)}
	case "upgrade":
		nc = netplay.Cmd{Op: netplay.OpUpgrade, A: u8(c.W), B: u8(c.Track)}
	case "gear":
		nc = netplay.Cmd{Op: netplay.OpGear, A: u8(c.G)}
	case "buyAbility":
		nc = netplay.Cmd{Op: netplay.OpBuyAbility, A: u8(c.Slot)}
	case "select":
		nc = netplay.Cmd{Op: netplay.OpSelect, A: u8(c.W)}
	case "reload":
		nc = netplay.Cmd{Op: netplay.OpReload}
	case "taunt":
		nc = netplay.Cmd{Op: netplay.OpTaunt}
	case "ping":
		nc = netplay.Cmd{Op: netplay.OpPing, A: u8(c.Kind), X: c.X, Y: c.Y}
	case "pause":
		nc = netplay.Cmd{Op: netplay.OpPause}
	case "sprint":
		nc = netplay.Cmd{Op: netplay.OpSprint}
		if c.On {
			nc.A = 1
		}
	case "revive":
		nc = netplay.Cmd{Op: netplay.OpRevive, T: u16(c.P)}
	case "ready":
		nc = netplay.Cmd{Op: netplay.OpReady}
		if c.On {
			nc.A = 1
		}
	case "restart":
		nc = netplay.Cmd{Op: netplay.OpRestart}
	case "chat":
		t := strings.TrimSpace(c.Text)
		if t == "" {
			return false
		}
		if len(t) > 200 {
			t = t[:200]
		}
		nc = netplay.Cmd{Op: netplay.OpChat, Text: t}
	default:
		return false
	}
	_ = s.cl.Send(nc)
	return false
}

func newToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// handler serves the page and the socket. The socket wants the token from the page's URL
// and an Origin of this server: any other page open in the browser could otherwise drive
// the game, or read it.
func handler(token string, port int, conns chan<- *browser, in chan<- inbound, done <-chan struct{}, browsers *launcher, url string) http.Handler {
	mux := http.NewServeMux()
	// A launch link from the terminal: start the game in that browser, full screen. It needs
	// the token too, or any page could start browsers.
	mux.HandleFunc("/launch/{id}", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(token)) != 1 {
			http.Error(w, "wrong token", http.StatusForbidden)
			return
		}
		b, ok := FindBrowser(r.PathValue("id"))
		if !ok {
			http.Error(w, "no such browser here", http.StatusNotFound)
			return
		}
		msg := "Opening the game in " + describe(b) + ". This tab can go."
		if err := browsers.launch(b, url); err != nil {
			msg = "Could not start " + b.Name + ": " + err.Error()
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, launchPage, html.EscapeString(msg))
	})
	origins := map[string]bool{
		"http://127.0.0.1:" + strconv.Itoa(port): true,
		"http://localhost:" + strconv.Itoa(port): true,
	}
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		got := r.URL.Query().Get("token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "wrong token", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !origins[o] {
			http.Error(w, "foreign origin", http.StatusForbidden)
			return
		}
		ws, err := upgrade(w, r)
		if err != nil {
			return
		}
		b := &browser{ws: ws, out: make(chan []byte, 4), text: make(chan []byte, 64), gone: make(chan struct{})}
		go b.writer()
		select {
		case conns <- b:
		case <-done:
			ws.close()
			return
		}
		go func() {
			for {
				op, msg, err := ws.read()
				if op != opText && err == nil {
					continue
				}
				select {
				case in <- inbound{b: b, msg: msg, err: err}:
				case <-done:
					ws.close()
					return
				}
				if err != nil {
					return
				}
			}
		}()
	})
	files, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	static := http.FileServerFS(files)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(files, "index.html"); err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "This td was built without its browser client. Build it with ./build.sh build.")
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		static.ServeHTTP(w, r)
	})
	return mux
}

// writer sends the page its messages: text (and must-arrive binary, marked by a leading 0)
// first, then the newest frame.
func (b *browser) writer() {
	defer close(b.gone)
	defer b.ws.close()
	for {
		select {
		case p := <-b.text:
			if err := b.writeQueued(p); err != nil {
				return
			}
			continue
		default:
		}
		select {
		case p := <-b.text:
			if err := b.writeQueued(p); err != nil {
				return
			}
		case f, ok := <-b.out:
			if !ok {
				// Flush what is left, such as the end message, then hang up.
				for {
					select {
					case p := <-b.text:
						if b.writeQueued(p) != nil {
							return
						}
					default:
						_ = b.ws.write(opClose, nil)
						return
					}
				}
			}
			if err := b.ws.write(opBinary, f); err != nil {
				return
			}
		}
	}
}

func (b *browser) writeQueued(p []byte) error {
	if len(p) > 0 && p[0] == 0 {
		return b.ws.write(opBinary, p[1:])
	}
	return b.ws.write(opText, p)
}

// launchPage is what the tab a launch link opened shows, briefly: it closes itself where the
// browser lets it.
const launchPage = `<!doctype html><meta charset="utf-8"><title>taildefense</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#16140f;color:#d8cfb4;font:16px monospace">
<p>%s</p><script>setTimeout(() => window.close(), 1200)</script>`
