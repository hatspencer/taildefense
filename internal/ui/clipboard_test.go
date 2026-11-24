package ui

import (
	"encoding/base64"
	"testing"
)

// The launcher's copy is an OSC 52 write of the base64 text.
func TestClipboardSequenceIsOSC52(t *testing.T) {
	seq := ClipboardSequence("10014861650")
	want := "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte("10014861650")) + "\a"
	if seq != want {
		t.Fatalf("sequence = %q, want %q", seq, want)
	}
}
