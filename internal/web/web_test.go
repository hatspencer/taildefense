package web

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// testWS is the browser's half of a WebSocket, enough to test the server half.
type testWS struct {
	c  net.Conn
	br *bufio.Reader
}

func dialWS(t *testing.T, addr, path, origin string) (*testWS, int) {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: %s\r\n\r\n", path, addr, origin)
	br := bufio.NewReader(c)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode == http.StatusSwitchingProtocols && res.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept %q", res.Header.Get("Sec-WebSocket-Accept"))
	}
	return &testWS{c, br}, res.StatusCode
}

func (w *testWS) send(op byte, p []byte) error {
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	h := []byte{0x80 | op}
	switch n := len(p); {
	case n < 126:
		h = append(h, 0x80|byte(n))
	default:
		h = append(h, 0x80|126)
		h = binary.BigEndian.AppendUint16(h, uint16(n))
	}
	h = append(h, mask[:]...)
	m := make([]byte, len(p))
	for i := range p {
		m[i] = p[i] ^ mask[i&3]
	}
	_, err := w.c.Write(append(h, m...))
	return err
}

func (w *testWS) recv() (byte, []byte, error) {
	_ = w.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var h [2]byte
	if _, err := io.ReadFull(w.br, h[:]); err != nil {
		return 0, nil, err
	}
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var e [2]byte
		io.ReadFull(w.br, e[:])
		n = uint64(binary.BigEndian.Uint16(e[:]))
	case 127:
		var e [8]byte
		io.ReadFull(w.br, e[:])
		n = binary.BigEndian.Uint64(e[:])
	}
	p := make([]byte, n)
	_, err := io.ReadFull(w.br, p)
	return h[0] & 0x0f, p, err
}

func TestTheBrowserPlaysThroughTheBridge(t *testing.T) {
	srv, err := netplay.Listen(netplay.ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box", LocalLogin: "me", LocalName: "me"})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	urls := make(chan string, 1)
	type ended struct {
		res Result
		err error
	}
	done := make(chan ended, 1)
	go func() {
		res, err := Run(context.Background(), Options{Addr: srv.Addrs()[0], Name: "ana", Version: "test", Host: "box",
			Hosting: true, Ready: func(p Page) { urls <- p.URL }})
		done <- ended{res, err}
	}()
	var url string
	select {
	case url = <-urls:
	case e := <-done:
		t.Fatalf("Run ended early: %v", e.err)
	}
	addr := strings.TrimPrefix(url, "http://")
	addr, token, _ := strings.Cut(addr, "/#")
	origin := "http://" + addr

	if _, code := dialWS(t, addr, "/ws?token=nope", origin); code != http.StatusForbidden {
		t.Errorf("a wrong token got %d", code)
	}
	if _, code := dialWS(t, addr, "/ws?token="+token, "https://evil.example"); code != http.StatusForbidden {
		t.Errorf("a foreign origin got %d", code)
	}
	ws, code := dialWS(t, addr, "/ws?token="+token, origin)
	if code != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %d", code)
	}

	// The welcome, the terrain, then frames.
	op, p, err := ws.recv()
	if err != nil || op != opText {
		t.Fatalf("first message: op %d err %v", op, err)
	}
	var wel welcomeMsg
	if err := json.Unmarshal(p, &wel); err != nil || wel.T != "welcome" || wel.W != 320 || !wel.Hosting {
		t.Fatalf("welcome: %v %+v", err, wel)
	}
	if len(wel.Weapons) != int(game.NumWeapons) || len(wel.Abilities) != game.NumAbilities || wel.Core.X == 0 {
		t.Fatalf("welcome defs: %d weapons, %d abilities, core %+v", len(wel.Weapons), len(wel.Abilities), wel.Core)
	}
	op, p, err = ws.recv()
	if err != nil || op != opBinary || p[0] != viewTerrain || len(p) != 1+320*200 {
		t.Fatalf("terrain: op %d len %d err %v", op, len(p), err)
	}
	var x0 float32
	moved := false
	for i := 0; i < 80 && !moved; i++ {
		op, p, err = ws.recv()
		if err != nil {
			t.Fatal(err)
		}
		if op != opBinary {
			continue
		}
		f := parseFrame(t, p)
		if f.sites != len(wel.Sites) || len(wel.Sites) == 0 || len(wel.SiteKinds) != int(game.NumSiteKinds) {
			t.Fatalf("frame has %d sites, welcome %d", f.sites, len(wel.Sites))
		}
		if i == 0 {
			x0 = f.x
			_ = ws.send(opText, []byte(fmt.Sprintf(`{"op":"move","x":%f,"y":%f}`, f.x+3, f.y)))
		} else if f.x > x0+1 {
			moved = true
		}
	}
	if !moved {
		t.Fatal("the hero never walked")
	}
	_ = ws.send(opText, []byte(`{"op":"leave"}`))
	select {
	case e := <-done:
		if e.err != nil || e.res.Reason != "left" {
			t.Fatalf("ended with %+v %v", e.res, e.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("leave did not end the session")
	}
}

type frameSummary struct {
	tick    uint32
	x, y    float32
	structs int
	sites   int
}

// parseFrame walks a whole frame as PROTOCOL.md lays it out, so a layout change on one side
// only is caught.
func parseFrame(t *testing.T, p []byte) frameSummary {
	t.Helper()
	i := 0
	need := func(n int) {
		if i+n > len(p) {
			t.Fatalf("frame truncated at %d+%d of %d", i, n, len(p))
		}
	}
	u8 := func() int { need(1); i++; return int(p[i-1]) }
	u16 := func() int { need(2); i += 2; return int(binary.LittleEndian.Uint16(p[i-2:])) }
	u32 := func() uint32 { need(4); i += 4; return binary.LittleEndian.Uint32(p[i-4:]) }
	skip := func(n int) { need(n); i += n }
	var f frameSummary
	if u8() != viewFrame {
		t.Fatal("not a frame")
	}
	f.tick = u32()
	skip(1 + 2 + 2 + 4 + 4 + 2 + 2 + 1)
	np := u8()
	for k := 0; k < np; k++ {
		skip(2)
		x, y := u16(), u16()
		if k == 0 {
			f.x, f.y = float32(x)/8, float32(y)/8
		}
		skip(2 + 4 + 1 + 4 + 1 + 1 + 12 + 1 + 28 + 4 + 1 + 1 + 1 + 1 + 1 + 2 + 2 + 1 + 1 + 4 + 4*3 + 3 + 5*2 + 4 + 4)
		skip(u8())
	}
	f.sites = u16()
	skip(f.sites)
	skip(u8() * 5)
	f.structs = u16()
	skip(f.structs * 14)
	skip(u16() * 10)
	skip(u16() * 9)
	skip(u16() * 6)
	skip(u16() * 5)
	skip(u16() * 12)
	nn := u8()
	for k := 0; k < nn; k++ {
		skip(1)
		skip(u16())
	}
	skip(u8() * 6)
	if i != len(p) {
		t.Fatalf("frame has %d bytes left over", len(p)-i)
	}
	return f
}
