package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"taildefense/internal/install"
)

func TestParseUpdateArgs(t *testing.T) {
	for _, c := range []struct {
		args      []string
		force     bool
		branch    string
		branchSet bool
		err       bool
	}{
		{args: nil},
		{args: []string{"-f"}, force: true},
		{args: []string{"--force"}, force: true},
		{args: []string{"-b", "f/x"}, branch: "f/x", branchSet: true},
		{args: []string{"--branch=f/y"}, branch: "f/y", branchSet: true},
		{args: []string{"-b", "main"}, branch: "", branchSet: true},
		{args: []string{"-b"}, err: true},
		{args: []string{"-b", "-f"}, err: true},
		{args: []string{"--branch= "}, err: true},
		{args: []string{"full"}, err: true},
	} {
		o, err := ParseUpdateArgs(c.args)
		if (err != nil) != c.err {
			t.Errorf("%v: err = %v, want error %v", c.args, err, c.err)
			continue
		}
		if c.err {
			continue
		}
		if o.Force != c.force || o.Branch != c.branch || o.BranchSet != c.branchSet {
			t.Errorf("%v: got %+v", c.args, o)
		}
	}
}

func TestUpdateTargetFollowsTheRecordUnlessTold(t *testing.T) {
	for _, c := range []struct {
		o        UpdateOptions
		recorded string
		branch   string
		force    bool
	}{
		{UpdateOptions{}, "", "", false},
		{UpdateOptions{}, "f/x", "f/x", false},
		{UpdateOptions{Force: true}, "f/x", "", true},
		{UpdateOptions{Branch: "f/y", BranchSet: true}, "f/x", "f/y", true},
		{UpdateOptions{Branch: "", BranchSet: true}, "f/x", "", true},
	} {
		b, f := updateTarget(c.o, c.recorded)
		if b != c.branch || f != c.force {
			t.Errorf("%+v recorded %q: got (%q, %v), want (%q, %v)", c.o, c.recorded, b, f, c.branch, c.force)
		}
	}
}

func isolate(t *testing.T) *install.Paths {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TAILDEFENSE_PREFIX", filepath.Join(dir, "prefix"))
	t.Setenv("TAILDEFENSE_BIN_DIR", filepath.Join(dir, "bin"))
	t.Setenv("TAILDEFENSE_REPO", "")
	t.Setenv("HOME", dir)
	t.Setenv("PATH", filepath.Join(dir, "bin"))
	p, err := install.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestInstallCopiesLinksAndRecords(t *testing.T) {
	p := isolate(t)
	t.Setenv(install.EnvInstallVersion, "abc1234")
	t.Setenv(install.EnvInstallBranch, "f/x")
	var b bytes.Buffer
	if code := Install(&b, true); code != 0 {
		t.Fatalf("exit %d: %s", code, b.String())
	}
	if _, err := os.Stat(p.BinaryPath()); err != nil {
		t.Fatalf("no binary: %v", err)
	}
	target, err := os.Readlink(p.SymlinkPath())
	if err != nil || target != p.BinaryPath() {
		t.Fatalf("symlink = %q, %v", target, err)
	}
	if v, _ := os.ReadFile(p.VersionFile()); strings.TrimSpace(string(v)) != "abc1234" {
		t.Errorf(".version = %q", v)
	}
	if p.Branch() != "f/x" {
		t.Errorf("branch = %q", p.Branch())
	}

	t.Setenv(install.EnvInstallBranch, "")
	b.Reset()
	if code := Install(&b, true); code != 0 {
		t.Fatalf("second install exit %d: %s", code, b.String())
	}
	if p.Branch() != "" {
		t.Errorf("an install without a branch should return to main, still on %q", p.Branch())
	}
}

func TestInstallReplacesAPlainFileAtTheLink(t *testing.T) {
	p := isolate(t)
	if err := os.MkdirAll(p.BinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.SymlinkPath(), []byte("old copy"), 0o755); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if code := Install(&b, true); code != 0 {
		t.Fatalf("exit %d: %s", code, b.String())
	}
	if fi, err := os.Lstat(p.SymlinkPath()); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected a symlink, got %v %v", fi, err)
	}
}

func TestVersionOfflineJSONNamesTheBranchAndAsksNothing(t *testing.T) {
	p := isolate(t)
	if err := os.MkdirAll(p.Prefix, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := p.RecordBranch("f/x"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TAILDEFENSE_REPO", "git@example.invalid:nowhere.git")
	var b bytes.Buffer
	if code := PrintVersion(&b, VersionOptions{Offline: true, JSON: true}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var res VersionResult
	if err := json.Unmarshal(b.Bytes(), &res); err != nil {
		t.Fatalf("%v: %s", err, b.String())
	}
	if res.Branch != "f/x" || res.Repo != "git@example.invalid:nowhere.git" {
		t.Errorf("got %+v", res)
	}
	if res.UpToDate != nil || res.Remote != "" || res.Error != "" {
		t.Errorf("--offline must not ask the remote: %+v", res)
	}
}

func TestSweepScratchRemovesOnlyDeadRunsClones(t *testing.T) {
	base := t.TempDir()
	mine := filepath.Join(base, scratchPrefix+strconv.Itoa(os.Getpid())+"-1")
	dead := filepath.Join(base, scratchPrefix+"999999999-2")
	oldStyleFresh := filepath.Join(base, scratchPrefix+"12345")
	oldStyleStale := filepath.Join(base, scratchPrefix+"67890")
	other := filepath.Join(base, "something-else")
	for _, d := range []string{mine, dead, oldStyleFresh, oldStyleStale, other} {
		if err := os.MkdirAll(filepath.Join(d, "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Read-only, the way Go writes its caches, so the sweep has to restore permission.
	if err := os.Chmod(filepath.Join(dead, "sub"), 0o555); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-2 * scratchMaxAge)
	if err := os.Chtimes(oldStyleStale, past, past); err != nil {
		t.Fatal(err)
	}

	sweepScratch(base)

	for d, want := range map[string]bool{mine: true, dead: false, oldStyleFresh: true, oldStyleStale: false, other: true} {
		_, err := os.Stat(d)
		if got := err == nil; got != want {
			t.Errorf("%s: exists = %v, want %v", filepath.Base(d), got, want)
		}
	}
}
