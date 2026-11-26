package web

import (
	"strings"
	"testing"

	"taildefense/internal/netplay"
)

// A message that panics in td ends the session with a reason, not td with a stack trace.
func TestAFrameThatPanicsEndsTheSession(t *testing.T) {
	s := &session{net: &netStats{}} // no replica: applying a frame panics
	var logged string
	reason := s.hostSafely(netplay.Msg{Type: netplay.MsgFrame, Payload: []byte{1}}, func(f string, a ...any) { logged = f })
	if reason != "the host sent a frame td could not read" {
		t.Fatalf("reason %q", reason)
	}
	if !strings.Contains(logged, "broke td") {
		t.Fatalf("logged %q", logged)
	}
}
