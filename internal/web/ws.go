package web

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// A WebSocket server, the part of RFC 6455 a browser on this machine needs: the upgrade,
// text and binary messages, fragmentation, ping and close. Small enough to keep here rather
// than add a module for it.

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opCont   = 0
	opText   = 1
	opBinary = 2
	opClose  = 8
	opPing   = 9
	opPong   = 10
)

// maxWSMessage bounds what the browser may make us buffer; commands are tiny.
const maxWSMessage = 1 << 20

type wsConn struct {
	c  net.Conn
	br *bufio.Reader
	mu sync.Mutex // writes: the frame writer and the pong from the reader
	bw *bufio.Writer
	// closing is set once td has sent its close frame (refuse): from then on nothing more is
	// sent, neither a pong nor a second close in answer to the browser's.
	closing bool
}

func headerHas(h http.Header, key, token string) bool {
	for _, v := range h.Values(key) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

// upgrade answers a WebSocket handshake and takes the connection over.
func upgrade(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if r.Method != http.MethodGet || !headerHas(r.Header, "Connection", "upgrade") || !headerHas(r.Header, "Upgrade", "websocket") {
		http.Error(w, "websocket only", http.StatusBadRequest)
		return nil, errors.New("not a websocket handshake")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(w, "unsupported websocket version", http.StatusUpgradeRequired)
		return nil, errors.New("websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing key", http.StatusBadRequest)
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	c, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Time{})
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
		base64.StdEncoding.EncodeToString(sum[:]))
	if err := rw.Flush(); err != nil {
		c.Close()
		return nil, err
	}
	return &wsConn{c: c, br: rw.Reader, bw: bufio.NewWriterSize(c, 64<<10)}, nil
}

// read returns the next whole text or binary message, answering pings on the way.
func (ws *wsConn) read() (op byte, msg []byte, err error) {
	var buf []byte
	first := byte(0)
	for {
		var h [2]byte
		if _, err := io.ReadFull(ws.br, h[:]); err != nil {
			return 0, nil, err
		}
		fin, opcode := h[0]&0x80 != 0, h[0]&0x0f
		masked := h[1]&0x80 != 0
		n := uint64(h[1] & 0x7f)
		switch n {
		case 126:
			var e [2]byte
			if _, err := io.ReadFull(ws.br, e[:]); err != nil {
				return 0, nil, err
			}
			n = uint64(binary.BigEndian.Uint16(e[:]))
		case 127:
			var e [8]byte
			if _, err := io.ReadFull(ws.br, e[:]); err != nil {
				return 0, nil, err
			}
			n = binary.BigEndian.Uint64(e[:])
		}
		if !masked {
			return 0, nil, errors.New("websocket: unmasked frame from the browser")
		}
		if n > maxWSMessage || uint64(len(buf))+n > maxWSMessage {
			return 0, nil, errors.New("websocket: message too large")
		}
		var mask [4]byte
		if _, err := io.ReadFull(ws.br, mask[:]); err != nil {
			return 0, nil, err
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(ws.br, p); err != nil {
			return 0, nil, err
		}
		for i := range p {
			p[i] ^= mask[i&3]
		}
		switch opcode {
		case opPing:
			if ws.closing {
				continue
			}
			if err := ws.write(opPong, p); err != nil {
				return 0, nil, err
			}
			continue
		case opPong:
			continue
		case opClose:
			if !ws.closing {
				_ = ws.write(opClose, nil)
			}
			return 0, nil, io.EOF
		case opText, opBinary:
			if first != 0 {
				return 0, nil, errors.New("websocket: new message inside a fragmented one")
			}
			first = opcode
		case opCont:
			if first == 0 {
				return 0, nil, errors.New("websocket: continuation with nothing to continue")
			}
		default:
			return 0, nil, fmt.Errorf("websocket: unknown opcode %d", opcode)
		}
		buf = append(buf, p...)
		if fin {
			return first, buf, nil
		}
	}
}

// write sends one unfragmented message.
func (ws *wsConn) write(op byte, p []byte) error {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	_ = ws.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	var h [10]byte
	h[0] = 0x80 | op
	n := len(p)
	hl := 2
	switch {
	case n < 126:
		h[1] = byte(n)
	case n <= 0xffff:
		h[1] = 126
		binary.BigEndian.PutUint16(h[2:], uint16(n))
		hl = 4
	default:
		h[1] = 127
		binary.BigEndian.PutUint64(h[2:], uint64(n))
		hl = 10
	}
	if _, err := ws.bw.Write(h[:hl]); err != nil {
		return err
	}
	if _, err := ws.bw.Write(p); err != nil {
		return err
	}
	return ws.bw.Flush()
}

func (ws *wsConn) close() { ws.c.Close() }

// refuse ends a socket that was never let in: one close frame with code and reason, then
// anything the browser sends is thrown away until its own close frame comes back (or two
// seconds have passed) and the connection is closed. Waiting for it keeps the close frame
// from being lost to a reset, and the browser reports the close once td hangs up.
func (ws *wsConn) refuse(code uint16, reason string) {
	defer ws.close()
	if len(reason) > 123 {
		reason = reason[:123]
	}
	p := binary.BigEndian.AppendUint16(nil, code)
	if ws.write(opClose, append(p, reason...)) != nil {
		return
	}
	ws.closing = true
	_ = ws.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := ws.read(); err != nil {
			return
		}
	}
}
