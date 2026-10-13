package cli

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"taildefense/internal/install"
	"taildefense/internal/version"
)

// The launcher's changelog: the latest commits on the branch td follows, read from the
// recorded origin, with the one this td was built from picked out. A bare, blobless clone a
// few dozen commits deep is all it takes, commit messages being all it reads, and it goes
// in a temporary directory that is gone again as soon as the log is read.
const ChangelogDepth = 40

// Commit is one line of the changelog.
type Commit struct {
	Hash    string
	Date    string // YYYY-MM-DD
	Subject string
}

// Changelog is what the launcher lists.
type Changelog struct {
	Source  string // the branch read
	Commits []Commit
	// Local is the index in Commits of the commit this td was built from, or -1 when it is not
	// among them: older than all of them, or a build of something else.
	Local int
}

// ReadChangelog fetches the latest ChangelogDepth commits of the branch the install follows.
func ReadChangelog(ctx context.Context) (Changelog, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return Changelog{}, errors.New("git is not installed; the changelog is read with it")
	}
	repo, err := install.RepoURL()
	if err != nil {
		return Changelog{}, err
	}
	branch := ""
	if paths, err := install.Resolve(); err == nil {
		branch = paths.Branch()
	}
	tmp, err := os.MkdirTemp("", "taildefense-changelog-*")
	if err != nil {
		return Changelog{}, err
	}
	defer os.RemoveAll(tmp)

	args := []string{"clone", "--quiet", "--bare", "--filter=blob:none", "--single-branch",
		"--depth", strconv.Itoa(ChangelogDepth)}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	clone := exec.CommandContext(ctx, "git", append(args, repo, tmp)...)
	clone.Env = gitEnv()
	var stderr strings.Builder
	clone.Stderr = &stderr
	if err := clone.Run(); err != nil {
		if d := strings.TrimSpace(stderr.String()); d != "" {
			return Changelog{}, errors.New(lastLine(d))
		}
		return Changelog{}, err
	}
	log := exec.CommandContext(ctx, "git", "-C", tmp, "log", "--no-merges", "--format=%h%x1f%cs%x1f%s")
	log.Env = gitEnv()
	out, err := log.Output()
	if err != nil {
		return Changelog{}, err
	}
	return changelogOf(install.SourceName(branch), string(out), version.Current()), nil
}

func changelogOf(source, log, local string) Changelog {
	c := Changelog{Source: source, Local: -1}
	for _, line := range strings.Split(log, "\n") {
		f := strings.SplitN(strings.TrimSpace(line), "\x1f", 3)
		if len(f) != 3 || f[0] == "" {
			continue
		}
		if c.Local < 0 && SameCommit(f[0], local) {
			c.Local = len(c.Commits)
		}
		c.Commits = append(c.Commits, Commit{Hash: f[0], Date: f[1], Subject: strings.TrimSpace(f[2])})
	}
	return c
}

func gitEnv() []string {
	return append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_SSH_COMMAND=ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
	)
}

// lastLine is git's last word on a failure, which is the one that says why.
func lastLine(s string) string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimPrefix(strings.TrimSpace(s), "fatal: ")
}
