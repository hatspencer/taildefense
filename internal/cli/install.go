package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"taildefense/internal/install"
	"taildefense/internal/platform"
	"taildefense/internal/ui"
	"taildefense/internal/version"
)

// Install is `td install`: copy this binary to ~/.taildefense, link it into PATH, and
// record the commit, branch and origin an update needs.
func Install(w io.Writer, force bool) int {
	p := ui.New(w)
	paths, err := install.Resolve()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	self, err := os.Executable()
	if err != nil {
		p.Fail("cannot locate the running binary: %v", err)
		return 1
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	tree := filepath.Dir(self)
	source := sourceVersion(tree)

	if !ui.BannerSuppressed() {
		p.Step("install")
	}
	p.Info("version %s on %s (%s)", source, platform.OS(), platform.Arch())
	if self == paths.BinaryPath() && !force {
		p.OK("already installed at %s", tilde(paths.BinaryPath()))
		p.Note("reinstall with: td install -f")
		return 0
	}
	if err := os.MkdirAll(paths.Prefix, 0o755); err != nil {
		p.Fail("%v", err)
		return 1
	}
	if self != paths.BinaryPath() {
		if err := install.CopyBinary(self, paths.BinaryPath()); err != nil {
			p.Fail("copy %s: %v", tilde(paths.BinaryPath()), err)
			return 1
		}
	}
	p.OK("installed %s", tilde(paths.BinaryPath()))
	if err := os.WriteFile(paths.VersionFile(), []byte(source+"\n"), 0o644); err != nil {
		p.Fail("%v", err)
		return 1
	}
	branch := strings.TrimSpace(os.Getenv(install.EnvInstallBranch))
	if err := paths.RecordBranch(branch); err != nil {
		p.Fail("%v", err)
		return 1
	}
	if branch != "" && branch != install.DefaultBranch {
		p.OK("following branch %s", branch)
	}
	if err := paths.Link(); err != nil {
		p.Fail("link %s: %v", tilde(paths.SymlinkPath()), err)
		return 1
	}
	p.OK("linked %s", tilde(paths.SymlinkPath()))

	// The origin of the tree the binary was built in, never the working directory: an update
	// runs the new binary's install from its clone, and the clone is what should be recorded.
	if origin, err := install.SourceOrigin(tree); err == nil && origin != "" {
		if err := os.WriteFile(paths.RepoFile(), []byte(origin+"\n"), 0o644); err == nil {
			p.OK("update source %s", origin)
		}
	} else if _, err := os.Stat(paths.RepoFile()); err != nil {
		p.Note("no git origin recorded: td update will need %s", install.EnvRepo)
	}

	if install.InPath(paths.BinDir) {
		p.OK("run taildefense from anywhere; td doctor checks the rest")
		return 0
	}
	p.Warn("%s is not on your PATH; add this to your shell profile:", tilde(paths.BinDir))
	p.Plain("    export PATH=\"%s:$PATH\"", paths.BinDir)
	return 0
}

// sourceVersion is who knows best which commit this is: the updater, then the checkout the
// binary sits in, then the stamp.
func sourceVersion(tree string) string {
	if v := strings.TrimSpace(os.Getenv(install.EnvInstallVersion)); v != "" {
		return v
	}
	if head, err := install.SourceHead(tree); err == nil {
		return head
	}
	return version.Stamped()
}

// VersionOptions are the flags of `td version`.
type VersionOptions struct {
	Offline bool
	JSON    bool
}

// VersionResult is the JSON document `td version --json` prints.
type VersionResult struct {
	Version   string `json:"version"`
	Stamped   string `json:"stamped"`
	Date      string `json:"date,omitempty"`
	Installed bool   `json:"installed"`
	Prefix    string `json:"prefix,omitempty"`
	Repo      string `json:"repo,omitempty"`
	Branch    string `json:"branch"`
	Head      string `json:"head,omitempty"`
	Remote    string `json:"remote,omitempty"`
	UpToDate  *bool  `json:"upToDate,omitempty"`
	Error     string `json:"error,omitempty"`
}

// PrintVersion is `td version`: this build, where it is installed, what it follows, and
// unless --offline whether that branch has moved on.
func PrintVersion(w io.Writer, o VersionOptions) int {
	res := VersionResult{
		Version:   version.Current(),
		Stamped:   version.Stamped(),
		Date:      version.Date(),
		Installed: install.IsInstalled(),
		Branch:    install.DefaultBranch,
	}
	if paths, err := install.Resolve(); err == nil {
		res.Prefix = paths.Prefix
		if b := paths.Branch(); b != "" {
			res.Branch = b
		}
	}
	if url, err := install.RepoURL(); err == nil {
		res.Repo = url
	}
	if head, err := install.SourceHead(install.Root()); err == nil {
		res.Head = head
	}
	if !o.Offline {
		if remote, err := remoteHead(res.Repo, res.Branch); err != nil {
			res.Error = err.Error()
		} else {
			res.Remote = remote
			up := version.MatchesVersion(res.Version, remote)
			res.UpToDate = &up
		}
	}

	if o.JSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		if err := enc.Encode(res); err != nil {
			return 1
		}
		return 0
	}
	p := ui.New(w)
	p.Step("taildefense")
	rows := [][2]string{{"version", res.Version}}
	if res.Stamped != res.Version {
		rows = append(rows, [2]string{"stamped", res.Stamped})
	}
	if res.Date != "" {
		rows = append(rows, [2]string{"committed", res.Date})
	}
	if res.Installed {
		rows = append(rows, [2]string{"installed", tilde(res.Prefix)})
	} else {
		rows = append(rows, [2]string{"installed", "no, running from " + tilde(install.Root())})
	}
	if res.Head != "" {
		rows = append(rows, [2]string{"tree HEAD", res.Head})
	}
	rows = append(rows, [2]string{"branch", res.Branch})
	if res.Repo != "" {
		rows = append(rows, [2]string{"source", res.Repo})
	}
	p.Fields(rows)
	switch {
	case o.Offline:
		p.Note("--offline: the remote was not asked")
	case res.UpToDate == nil:
		p.Warn("could not ask the remote: %s", res.Error)
	case *res.UpToDate:
		p.Pass("up to date with %s", res.Branch)
	case version.MatchesVersion(strings.TrimSuffix(res.Version, "-dirty"), res.Remote):
		p.Warn("built from %s with uncommitted changes on top", short(res.Remote))
		p.Detail("replace it with the clean build: td update")
	default:
		p.Warn("a newer commit is on %s: %s", res.Branch, short(res.Remote))
		p.Detail("update with: td update")
	}
	return 0
}

// remoteHead asks for one branch tip with ls-remote: one hash, no clone, no local side effect,
// bounded so an off-VPN laptop is not left waiting.
func remoteHead(repo, branch string) (string, error) {
	if repo == "" {
		return "", fmt.Errorf("no source repository recorded")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "ls-remote", repo, "refs/heads/"+branch)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("%s did not answer within 5s", repo)
		}
		return "", fmt.Errorf("git ls-remote %s: %v", repo, err)
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return "", fmt.Errorf("%s has no branch %s", repo, branch)
	}
	return fields[0], nil
}

func short(hash string) string {
	if len(hash) > 7 {
		return hash[:7]
	}
	return hash
}
