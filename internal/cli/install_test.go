package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
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
		commit    string
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
		{args: []string{"-c", "451fa65"}, commit: "451fa65"},
		{args: []string{"--commit", "451FA65D0E"}, commit: "451fa65d0e"},
		{args: []string{"--commit=" + full40}, commit: full40},
		{args: []string{"-c", "451fa65", "-f"}, commit: "451fa65", force: true},
		{args: []string{"-c"}, err: true},
		{args: []string{"-c", "-f"}, err: true},
		{args: []string{"-c", "451fa6"}, err: true},
		{args: []string{"-c", full40 + "a"}, err: true},
		{args: []string{"-c", "main"}, err: true},
		{args: []string{"-c", "451fa65~1"}, err: true},
		{args: []string{"--commit="}, err: true},
		{args: []string{"-c", "451fa65", "-b", "f/x"}, err: true},
		{args: []string{"-b", "main", "--commit=451fa65"}, err: true},
	} {
		o, err := ParseUpdateArgs(c.args)
		if (err != nil) != c.err {
			t.Errorf("%v: err = %v, want error %v", c.args, err, c.err)
			continue
		}
		if c.err {
			continue
		}
		if o.Force != c.force || o.Branch != c.branch || o.BranchSet != c.branchSet || o.Commit != c.commit {
			t.Errorf("%v: got %+v", c.args, o)
		}
	}
}

const full40 = "451fa65d0e1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a"

func TestUpdateTargetFollowsTheRecordUnlessTold(t *testing.T) {
	for _, c := range []struct {
		o        UpdateOptions
		recorded string
		pinned   string
		want     target
	}{
		{UpdateOptions{}, "", "", target{}},
		{UpdateOptions{}, "f/x", "", target{Branch: "f/x"}},
		{UpdateOptions{Force: true}, "f/x", "", target{Force: true}},
		{UpdateOptions{Branch: "f/y", BranchSet: true}, "f/x", "", target{Branch: "f/y", Force: true}},
		{UpdateOptions{Branch: "", BranchSet: true}, "f/x", "", target{Force: true}},
		// -c always reinstalls, forgets a followed branch, and moves a pin.
		{UpdateOptions{Commit: "451fa65"}, "f/x", "", target{Commit: "451fa65", Force: true}},
		{UpdateOptions{Commit: "451fa65", Force: true}, "", "", target{Commit: "451fa65", Force: true}},
		{UpdateOptions{Commit: "abcdef1"}, "", full40, target{Commit: "abcdef1", Force: true}},
		// A plain update stays on the pin; any other flag leaves it.
		{UpdateOptions{}, "", full40, target{Commit: full40}},
		{UpdateOptions{Force: true}, "", full40, target{Force: true}},
		{UpdateOptions{Branch: "f/y", BranchSet: true}, "", full40, target{Branch: "f/y", Force: true}},
	} {
		if got := updateTarget(c.o, c.recorded, c.pinned); got != c.want {
			t.Errorf("%+v recorded %q pinned %q: got %+v, want %+v", c.o, c.recorded, c.pinned, got, c.want)
		}
	}
}

func TestAPlainUpdateOnThePinnedCommitStaysWithoutAsking(t *testing.T) {
	pinned := updateTarget(UpdateOptions{}, "", full40)
	if !pinHolds(pinned, "451fa65") {
		t.Error("the pinned commit is installed: nothing to do")
	}
	if pinHolds(pinned, "abcdef1") || pinHolds(pinned, "451fa65-dirty") {
		t.Error("an install that is not the pinned commit should be rebuilt at it")
	}
	if pinHolds(updateTarget(UpdateOptions{Commit: "451fa65"}, "", full40), "451fa65") {
		t.Error("-c always reinstalls")
	}
	if pinHolds(updateTarget(UpdateOptions{}, "", ""), "451fa65") {
		t.Error("an install that is not pinned has no pin to hold")
	}
}

// fakeGit answers resolveCommit's two questions the way git does in a clone of main.
func fakeGit(known map[string]string, onMain map[string]bool, ambiguous string) func(args ...string) (string, error) {
	return func(args ...string) (string, error) {
		switch args[0] {
		case "rev-parse":
			given := strings.TrimSuffix(args[len(args)-1], "^{commit}")
			if given == ambiguous {
				return "", &gitError{code: 128, stderr: "error: short object ID " + given + " is ambiguous\nfatal: Needed a single revision"}
			}
			if full, ok := known[given]; ok {
				return full, nil
			}
			return "", &gitError{code: 128, stderr: "fatal: Needed a single revision"}
		case "merge-base":
			if onMain[args[2]] {
				return "", nil
			}
			return "", &gitError{code: 1}
		}
		return "", fmt.Errorf("unexpected git %v", args)
	}
}

func TestResolveCommitTakesOnlyCommitsOfMain(t *testing.T) {
	other := "abcdef1234567890abcdef1234567890abcdef12"
	git := fakeGit(map[string]string{"451fa65": full40, full40: full40, "abcdef1": other},
		map[string]bool{full40: true}, "1234567")
	if got, err := resolveCommit(git, "451fa65"); err != nil || got != full40 {
		t.Errorf("a short hash of main: %q, %v", got, err)
	}
	if got, err := resolveCommit(git, full40); err != nil || got != full40 {
		t.Errorf("a full hash of main: %q, %v", got, err)
	}
	for commit, want := range map[string]string{
		"abcdef1": "is not a commit on main",
		"7777777": "is not a commit on main",
		"1234567": "is ambiguous",
	} {
		if _, err := resolveCommit(git, commit); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want %q", commit, err, want)
		}
	}
	broken := func(args ...string) (string, error) {
		if args[0] == "merge-base" {
			return "", &gitError{code: 128, stderr: "fatal: bad object"}
		}
		return full40, nil
	}
	if _, err := resolveCommit(broken, "451fa65"); err == nil || strings.Contains(err.Error(), "not a commit on main") {
		t.Errorf("a git that fails is not an answer: %v", err)
	}
}

func TestKnowsPinsReadsTheClonesInstaller(t *testing.T) {
	dir := t.TempDir()
	if knowsPins(dir) {
		t.Error("an empty tree knows nothing")
	}
	src := filepath.Join(dir, "internal", "install")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "install.go"), []byte(`EnvInstallBranch = "TAILDEFENSE_INSTALL_BRANCH"`), 0o644); err != nil {
		t.Fatal(err)
	}
	if knowsPins(dir) {
		t.Error("an installer from before pins")
	}
	if err := os.WriteFile(filepath.Join(src, "install.go"), []byte(`EnvInstallPin = "TAILDEFENSE_INSTALL_PIN"`), 0o644); err != nil {
		t.Fatal(err)
	}
	if !knowsPins(dir) {
		t.Error("an installer that reads the pin")
	}
}

func TestInstallPinsOnlyWhenTheUpdaterSaysSo(t *testing.T) {
	p := isolate(t)
	if err := os.MkdirAll(p.Prefix, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := p.RecordBranch("f/x"); err != nil {
		t.Fatal(err)
	}
	t.Setenv(install.EnvInstallVersion, "451fa65")
	t.Setenv(install.EnvInstallBranch, "")
	t.Setenv(install.EnvInstallPin, full40)
	var b bytes.Buffer
	if code := Install(&b, true); code != 0 {
		t.Fatalf("exit %d: %s", code, b.String())
	}
	if p.Pin() != full40 || p.Branch() != "" {
		t.Errorf("pin %q branch %q: a pin forgets the branch", p.Pin(), p.Branch())
	}
	if !strings.Contains(b.String(), "pinned to 451fa65") {
		t.Errorf("the install does not say it pinned: %s", b.String())
	}

	t.Setenv(install.EnvInstallPin, "")
	b.Reset()
	if code := Install(&b, true); code != 0 {
		t.Fatalf("second install exit %d: %s", code, b.String())
	}
	if p.Pin() != "" {
		t.Errorf("an install without a pin should leave it, still on %q", p.Pin())
	}
}

func TestVersionShowsThePin(t *testing.T) {
	p := isolate(t)
	if err := os.MkdirAll(p.Prefix, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := p.RecordPin(full40); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if code := PrintVersion(&b, VersionOptions{Offline: true, JSON: true}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var res VersionResult
	if err := json.Unmarshal(b.Bytes(), &res); err != nil {
		t.Fatalf("%v: %s", err, b.String())
	}
	if res.Pin != full40 || res.Branch != "main" {
		t.Errorf("got %+v", res)
	}
	b.Reset()
	if code := PrintVersion(&b, VersionOptions{Offline: true}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(b.String(), "pinned to 451fa65") || !strings.Contains(b.String(), "td update -f") {
		t.Errorf("td version does not say it is pinned and how to leave: %s", b.String())
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
