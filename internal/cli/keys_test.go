package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/ui"
)

// The keys table keeps its shape: no empty cell, a group's rows together, no key twice in a
// group, and every line of it inside an 80-column terminal.
func TestGameKeysTable(t *testing.T) {
	seen := map[string]bool{}   // group + keys
	closed := map[string]bool{} // groups already left behind
	last := ""
	for i, k := range GameKeys {
		if strings.TrimSpace(k.Group) == "" || strings.TrimSpace(k.Keys) == "" || strings.TrimSpace(k.Does) == "" {
			t.Errorf("row %d has an empty cell: %+v", i, k)
		}
		if k.Group != last {
			if closed[k.Group] {
				t.Errorf("row %d: group %q comes back after another group", i, k.Group)
			}
			if last != "" {
				closed[last] = true
			}
			last = k.Group
		}
		if seen[k.Group+"\x00"+k.Keys] {
			t.Errorf("row %d: %q is in group %q twice", i, k.Keys, k.Group)
		}
		seen[k.Group+"\x00"+k.Keys] = true
	}
	for _, l := range strings.Split(strings.TrimRight(ui.Table(GameKeyRows(), "  "), "\n"), "\n") {
		if w := ansi.StringWidth(l); w > 80 {
			t.Errorf("%d wide, over 80: %q", w, ansi.Strip(l))
		}
	}
}

// td keys prints every row, each key beside what it does.
func TestKeysPrintsEveryRow(t *testing.T) {
	var b bytes.Buffer
	if code := Keys(&b); code != 0 {
		t.Fatalf("exit %d", code)
	}
	out := ansi.Strip(b.String())
	lines := strings.Split(out, "\n")
	for _, k := range GameKeys {
		found := false
		for _, l := range lines {
			if i := strings.Index(l, k.Keys); i >= 0 && strings.Contains(l[i:], k.Does) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("td keys lacks %q  %q:\n%s", k.Keys, k.Does, out)
		}
	}
}
