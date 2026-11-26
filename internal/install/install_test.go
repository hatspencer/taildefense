package install

import (
	"os"
	"strings"
	"testing"
)

func TestPinRoundTrip(t *testing.T) {
	p := &Paths{Prefix: t.TempDir(), BinDir: t.TempDir()}
	if p.Pin() != "" {
		t.Fatal("a fresh install is not pinned")
	}
	full := "451fa65d0e1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a"
	if err := p.RecordPin(" " + strings.ToUpper(full) + "\n"); err != nil {
		t.Fatal(err)
	}
	if got := p.Pin(); got != full {
		t.Errorf("pin = %q, want %q", got, full)
	}
	for _, bad := range []string{"main", "451fa6", "zzzzzzz", full + "0"} {
		if err := p.RecordPin(bad); err == nil {
			t.Errorf("recorded %q as a pin", bad)
		}
	}
	if p.Pin() != full {
		t.Errorf("a refused pin replaced the record: %q", p.Pin())
	}
	if err := os.WriteFile(p.PinFile(), []byte("not a hash\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if p.Pin() != "" {
		t.Error("a pin file that holds no hash pins nothing")
	}
	if err := p.RecordPin(""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.PinFile()); !os.IsNotExist(err) {
		t.Errorf("an empty pin should remove the record: %v", err)
	}
	if err := p.RecordPin(""); err != nil {
		t.Errorf("forgetting no pin: %v", err)
	}
}

func TestReplacedSeesAHandMadeCopyOverTheInstall(t *testing.T) {
	p := &Paths{Prefix: t.TempDir(), BinDir: t.TempDir()}
	if p.Replaced() {
		t.Fatal("nothing installed, nothing replaced")
	}
	if err := os.WriteFile(p.BinaryPath(), []byte("one"), 0o755); err != nil {
		t.Fatal(err)
	}
	if p.Replaced() {
		t.Fatal("an install from before the record has nothing to compare with")
	}
	if err := p.RecordSum(); err != nil {
		t.Fatal(err)
	}
	if p.Replaced() {
		t.Fatal("the recorded binary is not a replaced one")
	}
	if err := os.WriteFile(p.BinaryPath(), []byte("two"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !p.Replaced() {
		t.Fatal("a different binary went unnoticed")
	}
}
