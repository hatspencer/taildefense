package netplay

import (
	"bufio"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

// What a hostile host says in a probe reply or a refusal comes out as one line of text.
func TestAHostsWordsArePlainText(t *testing.T) {
	const nasty = "evil\x1b]52;c;ZWNobyBoaQ==\x07\x1b[2K\x1b[1Arow\nfake row"
	const clean = "evilrow fake row"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				br := bufio.NewReader(c)
				_, p, err := readMsg(br)
				if err != nil {
					return
				}
				var h Hello
				_ = json.Unmarshal(p, &h)
				fw, _ := flate.NewWriter(c, flate.BestSpeed)
				bw := bufio.NewWriter(fw)
				if h.Probe {
					b, _ := json.Marshal(Info{Proto: Proto, Version: nasty, Host: nasty, Owner: nasty, Players: []string{nasty}, Phase: nasty})
					_ = writeMsg(bw, MsgInfo, b)
				} else {
					_ = writeMsg(bw, MsgReject, []byte(nasty))
				}
				_ = bw.Flush()
				_ = fw.Flush()
				time.Sleep(100 * time.Millisecond)
			}()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	in, err := Probe(ctx, ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{in.Version, in.Host, in.Owner, in.Phase, in.Players[0]} {
		if s != clean {
			t.Errorf("probe reply %q, want %q", s, clean)
		}
	}
	_, _, err = Dial(ctx, ln.Addr().String(), Hello{Name: "ana"})
	var rej *RejectError
	if !errors.As(err, &rej) || rej.Reason != clean || strings.ContainsAny(err.Error(), "\x1b\n\x07") {
		t.Fatalf("refusal %q", err)
	}
}
