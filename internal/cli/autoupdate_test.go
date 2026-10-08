package cli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeUpdater is an updater over a scratch directory with every outside call replaced.
func fakeUpdater(t *testing.T, installed, remote string) (*AutoUpdater, *time.Time, *int) {
	t.Helper()
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	asked := 0
	ver := installed
	u := &AutoUpdater{
		Dir:       t.TempDir(),
		Enabled:   true,
		now:       func() time.Time { return now },
		installed: func() string { return ver },
		branch:    func() string { return "" },
		remote: func(string) (string, error) {
			asked++
			return remote, nil
		},
		start: func(string) error {
			ver = remote[:7]
			return nil
		},
	}
	return u, &now, &asked
}

func TestCheckCachesForAnHour(t *testing.T) {
	u, now, asked := fakeUpdater(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
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

func TestCurrentAndUnreachable(t *testing.T) {
	u, _, _ := fakeUpdater(t, "abcdef1", "abcdef1234567")
	if s := u.Check(); s.State != UpdateCurrent || s.Text() != "" {
		t.Errorf("got %+v %q", s, s.Text())
	}
	u2, _, _ := fakeUpdater(t, "abcdef1", "")
	u2.remote = func(string) (string, error) { return "", errors.New("no network") }
	if s := u2.Check(); s.State != UpdateUnknown || s.Error == "" {
		t.Errorf("got %+v", s)
	}
}

func TestABranchIsNeverUpdated(t *testing.T) {
	u, _, _ := fakeUpdater(t, "aaaaaaa", "bbbbbbbbbb")
	u.branch = func() string { return "f/x" }
	s := u.Check()
	if s.State != UpdateFollowing || u.ShouldStart(s) {
		t.Errorf("got %+v", s)
	}
}

func TestStartBacksOffAndHonoursThePreference(t *testing.T) {
	u, now, _ := fakeUpdater(t, "aaaaaaa", "bbbbbbbbbb")
	s := u.Check()
	u.Enabled = false
	if u.ShouldStart(s) {
		t.Error("started with autoupdate off")
	}
	u.Enabled = true
	if !u.ShouldStart(s) {
		t.Fatal("did not start when behind")
	}
	if u.ShouldStart(s) {
		t.Error("started twice within the backoff")
	}
	*now = now.Add(7 * time.Hour)
	if !u.ShouldStart(s) {
		t.Error("never retried after the backoff")
	}
}

func TestRunUpdatesUnderTheLock(t *testing.T) {
	u, _, _ := fakeUpdater(t, "aaaaaaa", "bbbbbbbbbb")
	s := u.Check()
	unlock, err := u.lock()
	if err != nil {
		t.Fatal(err)
	}
	if r := u.Run(s); r.State != UpdateFailed || r.Error != ErrUpdateRunning.Error() {
		t.Errorf("ran while locked: %+v", r)
	}
	unlock()
	r := u.Run(s)
	if r.State != UpdateUpdated || r.After != "bbbbbbb" {
		t.Fatalf("got %+v", r)
	}
	if r.Text() != "updated aaaaaaa → bbbbbbb" {
		t.Errorf("text %q", r.Text())
	}
	if _, err := os.Stat(filepath.Join(u.Dir, lockFile)); !os.IsNotExist(err) {
		t.Errorf("lock left behind: %v", err)
	}
	if s := u.Check(); s.State != UpdateCurrent {
		t.Errorf("after an update the cache should say current: %+v", s)
	}
}

func TestRunThatInstallsNothingFails(t *testing.T) {
	u, _, _ := fakeUpdater(t, "aaaaaaa", "bbbbbbbbbb")
	u.start = func(string) error { return nil }
	if r := u.Run(u.Check()); r.State != UpdateFailed {
		t.Errorf("got %+v", r)
	}
}

func TestOutdatedSaysHowToUpdate(t *testing.T) {
	u, _, _ := fakeUpdater(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	if news, how := u.outdated(time.Second); news == "" || how != "update with: td update" {
		t.Fatalf("behind: %q %q", news, how)
	}
	u, _, _ = fakeUpdater(t, "bbbbbbb", "bbbbbbbbbbbbbbbb")
	if news, _ := u.outdated(time.Second); news != "" {
		t.Fatalf("current: %q", news)
	}
	u, _, _ = fakeUpdater(t, "aaaaaaa", "bbbbbbbbbbbbbbbb")
	u.remote = func(string) (string, error) { time.Sleep(time.Second); return "b", nil }
	if news, _ := u.outdated(10 * time.Millisecond); news != "" {
		t.Fatalf("slow remote: %q", news)
	}
}
