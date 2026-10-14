package install

import (
	"os"
	"testing"
)

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
