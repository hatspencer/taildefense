package version

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMatchesVersion(t *testing.T) {
	for _, c := range []struct {
		local, remote string
		want          bool
	}{
		{"abc1234", "abc1234def0123456789", true},
		{"ABC1234", "abc1234", true},
		{"abc1234", "abc1235", false},
		{"abc1234-dirty", "abc1234", false},
		{"dev", "abc1234", false},
		{"abc1234", "", false},
		{"abc", "abc", false},
	} {
		if got := MatchesVersion(c.local, c.remote); got != c.want {
			t.Errorf("MatchesVersion(%q, %q) = %v, want %v", c.local, c.remote, got, c.want)
		}
	}
}

func TestReadRecordIgnoresAnythingButOneToken(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) {
		if err := os.WriteFile(filepath.Join(dir, RecordFile), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("abc1234\n")
	if got := ReadRecord(dir); got != "abc1234" {
		t.Errorf("got %q", got)
	}
	write("two words\n")
	if got := ReadRecord(dir); got != "" {
		t.Errorf("prose should be ignored, got %q", got)
	}
}

func TestStampedDecorates(t *testing.T) {
	defer func(c, d string) { Commit, Dirty = c, d }(Commit, Dirty)
	Commit, Dirty = "abc1234def", "false"
	if got := Stamped(); got != "abc1234" {
		t.Errorf("got %q", got)
	}
	Dirty = "true"
	if got := Stamped(); got != "abc1234-dirty" {
		t.Errorf("got %q", got)
	}
}

func TestSameCommitIgnoresDirtyAndLength(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"abc1234", "abc1234def0123456789", true},
		{"abc1234-dirty", "abc1234", true},
		{"abc1234", "abc1235", false},
		{"dev", "dev", false},
	} {
		if got := sameCommit(c.a, c.b); got != c.want {
			t.Errorf("sameCommit(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
