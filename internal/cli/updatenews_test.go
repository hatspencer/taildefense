package cli

import (
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
	if len(got) != 2 || got[0] != (change{"def5678", "feat(x): add a thing"}) || got[1] != (change{"abc1234", "fix: tabs\tstay"}) {
		t.Fatalf("got %#v", got)
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
