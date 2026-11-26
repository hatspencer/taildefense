package cli

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestBaseCommitStripsDirtyAndRefusesNonHashes(t *testing.T) {
	for in, want := range map[string]string{
		"abc1234":       "abc1234",
		"ABC1234-dirty": "abc1234",
		" abc1234\n":    "abc1234",
		"dev":           "",
		"abc":           "",
		"":              "",
		"main":          "",
		"zzz1234":       "",
	} {
		if got := baseCommit(in); got != want {
			t.Errorf("baseCommit(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseLogKeepsHashAndSubjectAndSkipsJunk(t *testing.T) {
	out := "def5678\x1ffeat(x): add a thing\n\nnot a log line\nabc1234\x1f fix: tabs\tstay \n"
	got := parseLog(out)
	if len(got) != 2 || got[0] != (change{"def5678", "feat(x): add a thing"}) || got[1] != (change{"abc1234", "fix: tabs stay"}) {
		t.Fatalf("got %#v", got)
	}
}

// A commit subject is anybody's text. One that carries an OSC 52 (set the clipboard) or a CSI
// (move the cursor, clear the screen) comes out of the log as its words alone, in the news
// td update prints and keeps, in the changelog the launcher lists, and from a news file an
// older td wrote without cleaning it.
func TestCommitSubjectsLoseTheirEscapes(t *testing.T) {
	osc52 := "\x1b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\x07"
	csi := "\x1b[2J\x1b[1;1H"
	subject := "fix: a thing" + osc52 + " done" + csi + "\x07"
	clean := "fix: a thing done"
	bad := func(s string) bool { return strings.ContainsAny(s, "\x1b\x07") || strings.Contains(s, "52;c") }

	got := parseLog("def5678" + csi + "\x1f" + subject + "\n")
	if len(got) != 1 || got[0].Hash != "def5678" || got[0].Subject != clean {
		t.Errorf("news: %q", got)
	}
	c := changelogOf("main", "aaa1111\x1f2026-10-13"+osc52+"\x1f"+subject+"\n", "dev")
	if len(c.Commits) != 1 || c.Commits[0].Subject != clean || c.Commits[0].Date != "2026-10-13" || bad(c.Commits[0].Hash) {
		t.Errorf("changelog: %+v", c.Commits)
	}
	path := filepath.Join(t.TempDir(), newsFile)
	writeNews(path, News{To: "def5678", Head: "what's new", Changes: [][2]string{{"def5678" + csi, subject}}})
	n, ok := readNewsFile(path)
	if !ok || n.Changes[0][0] != "def5678" || n.Changes[0][1] != clean {
		t.Errorf("news file: %q", n.Changes)
	}
	if bad(lastLine("remote: x\nfatal: no" + osc52 + csi)) {
		t.Errorf("git's last line kept an escape: %q", lastLine("fatal: no"+osc52))
	}
}

func TestClipShortensLongSubjectsInRunes(t *testing.T) {
	long := strings.Repeat("ä", newsSubjectWidth+10)
	got := clip(long, newsSubjectWidth)
	if !strings.HasSuffix(got, "...") || len([]rune(got)) != newsSubjectWidth {
		t.Errorf("got %d runes: %q", len([]rune(got)), got)
	}
	if clip("short", newsSubjectWidth) != "short" {
		t.Error("a short subject must be left alone")
	}
}

func TestHeadlineSaysWhatTheListIs(t *testing.T) {
	one := []change{{"def5678", "x"}}
	cases := []struct {
		n    updateNews
		want string
	}{
		{updateNews{From: "abc1234", To: "def5678", Found: true, Changes: one}, "what's new  abc1234 → def5678  (1 commit)"},
		{updateNews{From: "abc1234", To: "abc1234", Found: true}, ""},
		{updateNews{From: "abc1234", To: "def5678", Changes: one}, "latest on main  (abc1234 is not in the last 200 commits)"},
		{updateNews{To: "def5678", Changes: one}, "latest on main"},
		{updateNews{From: "abc1234", To: "def5678"}, ""},
		{updateNews{From: "def5678", To: "abc1234", Found: true, Back: true, Changes: []change{{"def5678", "x"}, {"ccc3333", "y"}}}, "went back 2 commits  def5678 → abc1234, taking out"},
	}
	for _, c := range cases {
		if got := c.n.headline("→", "main"); got != c.want {
			t.Errorf("headline(%+v) = %q, want %q", c.n, got, c.want)
		}
	}
}

func TestShownCapsTheListAndCountsTheRest(t *testing.T) {
	n := updateNews{Changes: make([]change, newsShown+4)}
	list, more := n.shown()
	if len(list) != newsShown || more != 4 {
		t.Errorf("got %d shown, %d more", len(list), more)
	}
	n.Changes = n.Changes[:3]
	if list, more := n.shown(); len(list) != 3 || more != 0 {
		t.Errorf("got %d shown, %d more", len(list), more)
	}
}

func TestChangelogMarksThisTd(t *testing.T) {
	log := "aaa1111\x1f2026-10-13\x1fnewest\nbbb2222\x1f2026-10-12\x1fmine\nccc3333\x1f2026-10-11\x1folder\n"
	if c := changelogOf("main", log, "bbb2222c0ffee-dirty"); c.Local != 1 || len(c.Commits) != 3 || c.Commits[1].Subject != "mine" || c.Commits[0].Date != "2026-10-13" {
		t.Errorf("got %+v", c)
	}
	if c := changelogOf("main", log, "dev"); c.Local != -1 {
		t.Errorf("a dev build matched %d", c.Local)
	}
}
