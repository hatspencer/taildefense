// Package install knows where taildefense lives on disk: ~/.taildefense holds the binary and the
// records an update reads, ~/.local/bin holds the symlink into PATH.
package install

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"taildefense/internal/version"
)

// DefaultBranch is what an install follows when no branch is recorded.
const DefaultBranch = "main"

// The updater tells the new binary's installer which commit and branch it cloned. Environment
// rather than flags, so the installer needs no knowledge of how it was reached.
const (
	EnvInstallVersion = "TAILDEFENSE_INSTALL_VERSION"
	EnvInstallBranch  = "TAILDEFENSE_INSTALL_BRANCH"
	EnvRepo           = "TAILDEFENSE_REPO"
)

// Paths are the install locations, overridable so tests never touch the real ones.
type Paths struct {
	Prefix string
	BinDir string
}

// Resolve returns the install paths, honouring TAILDEFENSE_PREFIX and TAILDEFENSE_BIN_DIR.
func Resolve() (*Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return &Paths{
		Prefix: envOr("TAILDEFENSE_PREFIX", filepath.Join(home, ".taildefense")),
		BinDir: envOr("TAILDEFENSE_BIN_DIR", filepath.Join(home, ".local", "bin")),
	}, nil
}

func (p *Paths) BinaryPath() string  { return filepath.Join(p.Prefix, Binary) }
func (p *Paths) SymlinkPath() string { return filepath.Join(p.BinDir, Binary) }
func (p *Paths) RepoFile() string    { return filepath.Join(p.Prefix, ".repo") }
func (p *Paths) BranchFile() string  { return filepath.Join(p.Prefix, ".branch") }
func (p *Paths) VersionFile() string { return filepath.Join(p.Prefix, version.RecordFile) }

// Branch is the branch the install follows, or "" for the default.
func (p *Paths) Branch() string {
	b, err := os.ReadFile(p.BranchFile())
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(string(b))
	if strings.ContainsAny(name, " \t\r\n") {
		return ""
	}
	return name
}

// RecordBranch remembers the branch to follow; empty forgets it, which returns to main.
func (p *Paths) RecordBranch(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || name == DefaultBranch {
		if err := os.Remove(p.BranchFile()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if strings.ContainsAny(name, " \t\r\n") {
		return fmt.Errorf("refusing to record %q as a branch", name)
	}
	return os.WriteFile(p.BranchFile(), []byte(name+"\n"), 0o644)
}

// SourceName names a branch for display: the branch, or main.
func SourceName(branch string) string {
	if branch == "" {
		return DefaultBranch
	}
	return branch
}

// Root is the directory holding the running binary, symlinks resolved.
func Root() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

// IsInstalled reports whether the running binary is the installed copy.
func IsInstalled() bool {
	p, err := Resolve()
	if err != nil {
		return false
	}
	return sameDir(Root(), p.Prefix)
}

func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA == nil && errB == nil {
		return ra == rb
	}
	return a == b
}

// RepoURL is where an update fetches from: TAILDEFENSE_REPO, the recorded .repo, then the origin
// of the checkout the binary sits in. Recording it is what makes a fork update from the fork.
func RepoURL() (string, error) {
	if v := os.Getenv(EnvRepo); v != "" {
		return v, nil
	}
	if p, err := Resolve(); err == nil {
		if b, err := os.ReadFile(p.RepoFile()); err == nil {
			if url := strings.TrimSpace(string(b)); url != "" {
				return url, nil
			}
		}
	}
	if url, err := SourceOrigin(Root()); err == nil && url != "" {
		return url, nil
	}
	return "", fmt.Errorf("no source repository recorded; set %s, or install from a checkout with ./build.sh install", EnvRepo)
}

// IsSourceTree reports whether dir is a taildefense checkout, so an update is never aimed at
// whatever unrelated repository the binary happens to sit in.
func IsSourceTree(dir string) bool {
	if dir == "" {
		return false
	}
	mod, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return false
	}
	return bytes.HasPrefix(mod, []byte("module taildefense\n"))
}

// SourceOrigin is the origin remote of dir, when dir is a taildefense checkout.
func SourceOrigin(dir string) (string, error) {
	if !IsSourceTree(dir) {
		return "", fmt.Errorf("%s is not a taildefense checkout", dir)
	}
	return git(dir, "remote", "get-url", "origin")
}

// SourceHead is the short HEAD of dir, -dirty when tracked files changed, when dir is a
// taildefense checkout.
func SourceHead(dir string) (string, error) {
	if !IsSourceTree(dir) {
		return "", fmt.Errorf("%s is not a taildefense checkout", dir)
	}
	head, err := git(dir, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	if st, err := git(dir, "status", "--porcelain", "--untracked-files=no"); err == nil && st != "" {
		head += "-dirty"
	}
	return head, nil
}

func git(dir string, args ...string) (string, error) {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return "", err
	}
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// CopyBinary copies src to dst through a temporary name and a rename, so an interrupted copy
// never leaves a truncated binary and a running one is replaced rather than overwritten.
func CopyBinary(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// Link points the PATH symlink at the installed binary, replacing whatever was there,
// including a plain file from an older copy-based install.
func (p *Paths) Link() error {
	if err := os.MkdirAll(p.BinDir, 0o755); err != nil {
		return err
	}
	if err := os.Remove(p.SymlinkPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Symlink(p.BinaryPath(), p.SymlinkPath())
}

// InPath reports whether dir is on PATH, by name or by identity.
func InPath(dir string) bool {
	target, targetErr := os.Stat(dir)
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if p == dir {
			return true
		}
		if abs, err := filepath.Abs(p); err == nil && abs == dir {
			return true
		}
		if targetErr != nil || p == "" {
			continue
		}
		if info, err := os.Stat(p); err == nil && os.SameFile(info, target) {
			return true
		}
	}
	return false
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// Binary is the command's name: the file in the prefix, the link on PATH, and what build.sh
// writes. The tool is taildefense; typing it is td.
const Binary = "td"
