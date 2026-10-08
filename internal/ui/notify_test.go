package ui

import (
	"strings"
	"testing"

	"taildefense/internal/platform"
)

// A notification is a few bytes on stdout that draw nothing. Off a terminal they would
// be garbage in a transcript, so nothing is sent there.
func TestNotifyIsSilentOffATerminalAndSpeaksOnOne(t *testing.T) {
	t.Setenv(EnvNoNotify, "")
	SetNotify(true)
	t.Cleanup(func() { SetNotify(true) })

	restore := platform.SetTTYForTest(false)
	if NotifyEnabled() {
		t.Error("notifications are enabled with no terminal")
	}
	restore()

	restore = platform.SetTTYForTest(true)
	defer restore()
	if !NotifyEnabled() {
		t.Fatal("notifications are disabled on a terminal with nothing turning them off")
	}

	seq := NotifySequence("hive daily", "12 rules promoted")
	if !strings.HasPrefix(seq, "\x1b]9;hive daily: 12 rules promoted\a") {
		t.Errorf("no OSC 9 at the front: %q", seq)
	}
	if !strings.Contains(seq, "\x1b]777;notify;hive daily;12 rules promoted\a") {
		t.Errorf("no OSC 777 after it: %q", seq)
	}

	// The two switches, one per process and one remembered.
	t.Setenv(EnvNoNotify, "1")
	if NotifyEnabled() {
		t.Errorf("%s=1 did not silence notifications", EnvNoNotify)
	}
	t.Setenv(EnvNoNotify, "")
	SetNotify(false)
	if NotifyEnabled() {
		t.Error("config notify off did not silence notifications")
	}
	if NotifySetting() {
		t.Error("NotifySetting does not report the remembered choice")
	}
}

// A newline or a BEL inside the string ends the sequence early and puts the rest on
// screen as output, and a semicolon is a field separator in OSC 777.
func TestNotifySequenceFlattensWhatWouldBreakIt(t *testing.T) {
	seq := NotifySequence("a;b", "line one\nline two\a")
	if strings.Count(seq, "\a") != 2 {
		t.Errorf("a BEL in the body survived: %q", seq)
	}
	if strings.Contains(seq, "\n") {
		t.Errorf("a newline survived: %q", seq)
	}
	if strings.Contains(seq, "\x1b]777;notify;a;b;") {
		t.Errorf("a semicolon in the title shifted the 777 fields: %q", seq)
	}
	if NotifySequence("", "") != "" {
		t.Error("an empty notification produced bytes")
	}
}

// The shell finds a child's notifications in the output it is about to sanitise, which
// is what lets a `taildefense watch` in a tab reach the desktop.
func TestIsNotifySequenceFindsBothFormsAndNothingElse(t *testing.T) {
	seq := NotifySequence("t", "b")
	n, ok := IsNotifySequence(seq)
	if !ok || n == 0 {
		t.Fatalf("the OSC 9 form was not recognised in %q", seq)
	}
	rest := seq[n:]
	n2, ok := IsNotifySequence(rest)
	if !ok || n2 != len(rest) {
		t.Errorf("the OSC 777 form was not recognised as the remainder: %q", rest)
	}

	for _, s := range []string{"\x1b]8;;https://x\x1b\\label", "\x1b[31mred", "plain", "\x1b]9;unterminated"} {
		if _, ok := IsNotifySequence(s); ok {
			t.Errorf("%q was taken for a notification", s)
		}
	}
	// ST as a terminator as well as BEL.
	if n, ok := IsNotifySequence("\x1b]9;hi\x1b\\tail"); !ok || n != len("\x1b]9;hi\x1b\\") {
		t.Errorf("an ST-terminated sequence was not measured correctly: n=%d ok=%v", n, ok)
	}
}
