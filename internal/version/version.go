// Package version reports which build this is: a short commit hash, stamped at build time and
// overridden by the record an install writes beside the binary.
package version

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
)

// Commit and Dirty are stamped by build.sh with -ldflags -X.
var (
	Commit string
	Dirty  string
)

// RecordFile is written by the installer beside the binary, holding the commit the install
// came from. The updater knows which commit it cloned and hands it to the installer, so the
// record is right even when the binary's own stamp is not.
const RecordFile = ".version"

var (
	once    sync.Once
	current string
)

// Current is the installed record when there is one, otherwise the stamp.
func Current() string {
	once.Do(func() {
		current = recorded()
		if current == "" {
			current = Stamped()
		}
	})
	return current
}

// Stamped is the version compiled into this binary, or "dev" when it carries none.
func Stamped() string {
	if Commit != "" {
		return decorate(Commit, Dirty == "true")
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		var revision string
		var modified bool
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				revision = s.Value
			case "vcs.modified":
				modified = s.Value == "true"
			}
		}
		if revision != "" {
			return decorate(revision, modified)
		}
	}
	return "dev"
}

func recorded() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return ReadRecord(filepath.Dir(exe))
}

// ReadRecord returns the version recorded in dir, or "" when there is none or it is not a
// single token.
func ReadRecord(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, RecordFile))
	if err != nil {
		return ""
	}
	v := strings.TrimSpace(string(b))
	if v == "" || len(v) > 64 || strings.ContainsAny(v, " \t\r\n") {
		return ""
	}
	return v
}

func decorate(commit string, dirty bool) string {
	if len(commit) > 7 {
		commit = commit[:7]
	}
	if dirty {
		return commit + "-dirty"
	}
	return commit
}

// Matches reports whether a remote commit hash is the one this binary is, comparing on the
// shorter of the two, since ls-remote returns a full hash.
func Matches(remote string) bool {
	return MatchesVersion(Current(), remote)
}

// MatchesVersion is Matches against an explicit local version.
func MatchesVersion(local, remote string) bool {
	if strings.HasSuffix(local, "-dirty") || local == "dev" || remote == "" {
		return false
	}
	n := min(len(local), len(remote))
	if n < 7 {
		return false
	}
	return strings.EqualFold(local[:n], remote[:n])
}
