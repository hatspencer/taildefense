package ui

import (
	"encoding/base64"
	"testing"

	"taildefense/internal/platform"
)

// The placement copy is gated the way the notification is: a terminal, the switch, and
// the environment variable. The selection copy is not, but that is the shell's to test.
func TestCopyValueIsGatedLikeANotification(t *testing.T) {
	t.Setenv(EnvNoClipboard, "")
	SetClipboard(true)
	t.Cleanup(func() { SetClipboard(true) })

	restore := platform.SetTTYForTest(false)
	if ClipboardEnabled() {
		t.Error("the copy is enabled with no terminal")
	}
	restore()

	restore = platform.SetTTYForTest(true)
	defer restore()
	if !ClipboardEnabled() {
		t.Fatal("the copy is disabled on a terminal with nothing turning it off")
	}
	SetClipboard(false)
	if ClipboardEnabled() || CopyValue("~/work/.kiro/steering/tag-index.md") {
		t.Error("`td config clipboard off` did not stop the copy")
	}
	SetClipboard(true)
	t.Setenv(EnvNoClipboard, "1")
	if ClipboardEnabled() || CopyValue("~/work/.kiro/steering/tag-index.md") {
		t.Errorf("$%s did not stop the copy", EnvNoClipboard)
	}
	t.Setenv(EnvNoClipboard, "")
	if CopyValue("") {
		t.Error("an empty value was copied")
	}
}

// The shell finds a child's clipboard writes in the output it is about to sanitise, the
// same way it finds notifications, which is what lets a placement in a tab reach the
// clipboard over ssh.
func TestIsClipboardSequenceMeasuresOSC52AndNothingElse(t *testing.T) {
	seq := ClipboardSequence("10014861650")
	want := "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte("10014861650")) + "\a"
	if seq != want {
		t.Fatalf("sequence = %q, want %q", seq, want)
	}
	if n, ok := IsClipboardSequence(seq + "tail"); !ok || n != len(seq) {
		t.Errorf("not measured correctly: n=%d ok=%v", n, ok)
	}
	if n, ok := IsClipboardSequence("\x1b]52;c;MTIz\x1b\\tail"); !ok || n != len("\x1b]52;c;MTIz\x1b\\") {
		t.Errorf("an ST-terminated sequence was not measured correctly: n=%d ok=%v", n, ok)
	}
	for _, s := range []string{NotifySequence("t", "b"), "\x1b]8;;https://x\x1b\\label", "\x1b[31mred", "plain", "\x1b]52;c;unterminated"} {
		if _, ok := IsClipboardSequence(s); ok {
			t.Errorf("%q was taken for a clipboard write", s)
		}
	}
}
