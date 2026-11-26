package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeChecker is a checker over a scratch directory with every outside call replaced.
func fakeChecker(t *testing.T, installed, remote string) (*UpdateChecker, *time.Time, *int) {
	t.Helper()
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	asked := 0
	u := &UpdateChecker{
		Dir:       t.TempDir(),
		now:       func() time.Time { return now },
		installed: func() string { return installed },
		branch:    func() string { return "" },
		remote: func(string) (string, error) {
			asked++
			return remote, nil
		},
	}
	return u, &now, &asked
}

func TestCheckCachesForAnHour(t *testing.T) {
	u, now, asked := fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	if s := u.Check(); s.State != UpdateBehind || s.Remote != "bbbbbbbbbbbbbbbb" {
		t.Fatalf("got %+v", s)
	}
	*now = now.Add(30 * time.Minute)
	u.Check()
	if *asked != 1 {
		t.Errorf("asked the remote %d times within the hour", *asked)
	}
	*now = now.Add(31 * time.Minute)
	u.Check()
	if *asked != 2 {
		t.Errorf("a stale answer was not refreshed: asked %d", *asked)
	}
}

func TestBehindSaysANewerTdIsOutAndHowToGetIt(t *testing.T) {
	u, _, _ := fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	s := u.Check()
	if want := "a newer td is out: aaaaaaa → bbbbbbb · td update installs it"; s.Text() != want {
		t.Errorf("text %q, want %q", s.Text(), want)
	}
}

// The check only tells: nothing is left behind but its cache, no lock, no log, no update.
func TestCheckOnlyTells(t *testing.T) {
	u, _, _ := fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	u.Check()
	entries, err := os.ReadDir(u.Dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != selfcheckFile {
			t.Errorf("the check left %s behind", e.Name())
		}
	}
}

// A cache an older td wrote, from when it updated in the background, still reads.
func TestAnOlderCacheStillReads(t *testing.T) {
	u, _, asked := fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	old := `{"checkedAt":"2026-10-07T11:30:00Z","attemptedAt":"2026-10-07T11:30:00Z",` +
		`"status":{"state":"behind","version":"aaaaaaa","remote":"bbbbbbbbbbbbbbbb","log":"/x/update.log"}}`
	if err := os.WriteFile(filepath.Join(u.Dir, selfcheckFile), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	if s := u.Check(); s.State != UpdateBehind || *asked != 0 {
		t.Errorf("got %+v, asked %d", s, *asked)
	}
}

func TestCurrentAndUnreachable(t *testing.T) {
	u, _, _ := fakeChecker(t, "abcdef1", "abcdef1234567")
	if s := u.Check(); s.State != UpdateCurrent || s.Text() != "" {
		t.Errorf("got %+v %q", s, s.Text())
	}
	u2, _, _ := fakeChecker(t, "abcdef1", "")
	u2.remote = func(string) (string, error) { return "", errors.New("no network") }
	if s := u2.Check(); s.State != UpdateUnknown || s.Error == "" || s.Text() != "" {
		t.Errorf("an unreachable remote is silent: %+v %q", s, s.Text())
	}
}

func TestABranchHearsOfItsBranchNotMain(t *testing.T) {
	u, _, _ := fakeChecker(t, "aaaaaaa", "bbbbbbbbbb")
	u.branch = func() string { return "f/x" }
	s := u.Check()
	if s.State != UpdateFollowing || strings.Contains(s.Text(), "main") || !strings.Contains(s.Text(), "f/x") {
		t.Errorf("got %+v %q", s, s.Text())
	}
}

func TestAPinnedInstallIsNeverToldNorAskedAbout(t *testing.T) {
	u, _, asked := fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	// A launcher that checked before the pin cached "behind" for this version.
	if s := u.Check(); s.State != UpdateBehind {
		t.Fatalf("got %+v", s)
	}
	pin := "aaaaaaa111111111111111111111111111111111"
	u.pin = func() string { return pin }
	s := u.Check()
	if s.State != UpdatePinned || s.Pin != pin || s.Text() != "pinned to aaaaaaa" {
		t.Errorf("got %+v %q", s, s.Text())
	}
	if *asked != 1 {
		t.Errorf("a pinned install asked the remote: %d", *asked)
	}
	if news, how := u.outdated(time.Second); news != "" || how != "" {
		t.Errorf("a pinned td is not out of date: %q %q", news, how)
	}
	u.pin = func() string { return "" }
	if s := u.Check(); s.State != UpdateBehind {
		t.Errorf("unpinned, the install is behind again: %+v", s)
	}
}

func TestUpdatedSeesTheInstallRecordChange(t *testing.T) {
	u, _, _ := fakeChecker(t, "aaaaaaa", "bbbbbbbbbb")
	before := u.Check()
	if s := u.Updated(before); s != before {
		t.Errorf("nothing installed, yet %+v", s)
	}
	u.installed = func() string { return "bbbbbbb" }
	s := u.Updated(before)
	if s.State != UpdateUpdated || s.Text() != "updated aaaaaaa → bbbbbbb" {
		t.Errorf("got %+v %q", s, s.Text())
	}
}

func TestOutdatedSaysHowToUpdate(t *testing.T) {
	u, _, _ := fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	if news, how := u.outdated(time.Second); news == "" || how != "update with: td update" {
		t.Fatalf("behind: %q %q", news, how)
	}
	u, _, _ = fakeChecker(t, "bbbbbbb", "bbbbbbbbbbbbbbbb")
	if news, _ := u.outdated(time.Second); news != "" {
		t.Fatalf("current: %q", news)
	}
	u, _, _ = fakeChecker(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	u.remote = func(string) (string, error) { time.Sleep(time.Second); return "b", nil }
	if news, _ := u.outdated(10 * time.Millisecond); news != "" {
		t.Fatalf("slow remote: %q", news)
	}
}
