package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"taildefense/internal/install"
	"taildefense/internal/version"
)

// Telling the player that a newer td is out. At most once an hour the launcher asks the
// remote whether main has moved on past the installed version, and when it has, says so and
// that td update installs it. It never updates by itself: td update builds and runs what is
// on the repo's main, and that happens only when the player asks for it.
//
// An install that follows a branch hears about its branch, not main: a branch is somebody's
// choice. One pinned to a commit hears about nothing and asks nothing: being behind is what a
// pin is for. A binary run from a build tree is not checked either: there is no install to
// keep current.

// checkInterval is how old a cached answer may be before the remote is asked again.
const checkInterval = time.Hour

// selfcheckFile, under ~/.taildefense, caches the last answer.
const selfcheckFile = "selfcheck"

// UpdateState is what the launcher knows about td's own version.
type UpdateState string

const (
	UpdateUnknown   UpdateState = "unknown"   // not asked, or the remote did not answer
	UpdateCurrent   UpdateState = "current"   // the install is main's tip
	UpdateBehind    UpdateState = "behind"    // main has moved on: a newer td is out
	UpdateUpdated   UpdateState = "updated"   // the player's td update installed; this process is still the old one
	UpdateFollowing UpdateState = "following" // following a branch: told about the branch only
	UpdatePinned    UpdateState = "pinned"    // pinned to a commit: never told nor asked about
)

// SelfUpdate is the state with what the launcher shows next to it.
type SelfUpdate struct {
	State   UpdateState `json:"state"`
	Version string      `json:"version"`          // the installed version when checked
	Remote  string      `json:"remote,omitempty"` // main's tip
	Branch  string      `json:"branch,omitempty"` // followed branch, "" is main
	Pin     string      `json:"pin,omitempty"`    // the commit the install is pinned to
	After   string      `json:"after,omitempty"`  // installed by the player's td update
	Error   string      `json:"error,omitempty"`  // why the remote did not answer; never shown
}

// Text is the one line the launcher's header shows, or "" when there is nothing to say.
func (s SelfUpdate) Text() string {
	switch s.State {
	case UpdateBehind:
		return fmt.Sprintf("a newer td is out: %s → %s · td update installs it", short(s.Version), short(s.Remote))
	case UpdateUpdated:
		return fmt.Sprintf("updated %s → %s", short(s.Version), short(s.After))
	case UpdatePinned:
		return "pinned to " + short(s.Pin)
	case UpdateFollowing:
		if s.Remote != "" && !version.MatchesVersion(s.Version, s.Remote) {
			return fmt.Sprintf("branch %s has moved on to %s · td update installs it", s.Branch, short(s.Remote))
		}
	}
	return ""
}

// snapshot is the cached answer in ~/.taildefense/selfcheck. A file an older td wrote may
// also hold attemptedAt, from when it updated in the background; it is ignored.
type snapshot struct {
	CheckedAt time.Time  `json:"checkedAt"`
	Status    SelfUpdate `json:"status"`
}

// UpdateChecker asks whether a newer td is out. Its fields are functions so a test stands in
// for git and the remote.
type UpdateChecker struct {
	Dir string // the install prefix, where the cache lives

	now       func() time.Time
	installed func() string
	branch    func() string
	pin       func() string
	remote    func(branch string) (string, error)
}

// NewUpdateChecker is the launcher's checker, or nil when td is not installed: a binary run
// from a build tree has nothing to keep current.
func NewUpdateChecker() *UpdateChecker {
	paths, err := install.Resolve()
	if err != nil || !install.IsInstalled() {
		return nil
	}
	if _, err := os.Stat(paths.BinaryPath()); err != nil {
		return nil
	}
	return &UpdateChecker{
		Dir:       paths.Prefix,
		now:       time.Now,
		installed: func() string { return installedVersion(paths) },
		branch:    paths.Branch,
		pin:       paths.Pin,
		remote: func(branch string) (string, error) {
			repo, err := install.RepoURL()
			if err != nil {
				return "", err
			}
			return remoteHead(repo, install.SourceName(branch))
		},
	}
}

// installedVersion reads the record the installer wrote, which is what an update changes;
// version.Current would keep answering for the binary that is running.
func installedVersion(paths *install.Paths) string {
	if v := version.ReadRecord(paths.Prefix); v != "" {
		return v
	}
	return version.Current()
}

// Check is the state of the install: the cached answer when it is under an hour old and
// about the installed version, the remote otherwise. It blocks for up to the 5 s the remote
// is given, so the launcher calls it from a command.
func (u *UpdateChecker) Check() SelfUpdate {
	installed := u.installed()
	// Before the cache: an answer cached before the pin would still say behind.
	if pin := u.pinned(); pin != "" {
		return SelfUpdate{State: UpdatePinned, Version: installed, Pin: pin}
	}
	snap := u.load()
	if !snap.CheckedAt.IsZero() && u.now().Sub(snap.CheckedAt) < checkInterval && snap.Status.Version == installed {
		return snap.Status
	}
	branch := u.branch()
	s := SelfUpdate{State: UpdateUnknown, Version: installed, Branch: branch}
	remote, err := u.remote(branch)
	switch {
	case err != nil:
		s.Error = oneLine(err.Error())
	case branch != "":
		s.State, s.Remote = UpdateFollowing, remote
	case version.MatchesVersion(installed, remote):
		s.State, s.Remote = UpdateCurrent, remote
	default:
		s.State, s.Remote = UpdateBehind, remote
	}
	snap.Status, snap.CheckedAt = s, u.now()
	u.save(snap)
	return s
}

// pinned is the commit the install is pinned to, read afresh each time: a td update -c in
// another terminal pins an install a launcher is already watching.
func (u *UpdateChecker) pinned() string {
	if u.pin == nil {
		return ""
	}
	return u.pin()
}

// Updated is the state after a foreground `td update` the launcher ran: updated when the
// install record changed, unchanged otherwise.
func (u *UpdateChecker) Updated(before SelfUpdate) SelfUpdate {
	after := u.installed()
	if after == "" || after == before.Version {
		return before
	}
	return SelfUpdate{State: UpdateUpdated, Version: before.Version, After: after, Remote: before.Remote}
}

// ForegroundUpdated is the state after a foreground `td update` when there is no checker (td
// was run from a build tree): updated when the install record now differs from this binary.
func ForegroundUpdated(before SelfUpdate) SelfUpdate {
	paths, err := install.Resolve()
	if err != nil {
		return before
	}
	after := version.ReadRecord(paths.Prefix)
	cur := version.Current()
	if after == "" || after == cur {
		return before
	}
	return SelfUpdate{State: UpdateUpdated, Version: cur, After: after}
}

func (u *UpdateChecker) load() snapshot {
	var s snapshot
	b, err := os.ReadFile(filepath.Join(u.Dir, selfcheckFile))
	if err != nil || json.Unmarshal(b, &s) != nil {
		return snapshot{}
	}
	return s
}

// save writes the snapshot through a temp file and a rename, so a launcher reading it while
// another writes never sees half of one.
func (u *UpdateChecker) save(s snapshot) {
	if err := os.MkdirAll(u.Dir, 0o755); err != nil {
		return
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(u.Dir, ".selfcheck-*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return
	}
	if tmp.Close() == nil {
		_ = os.Rename(tmp.Name(), filepath.Join(u.Dir, selfcheckFile))
	}
}

// ForegroundUpdate is `td update` for the launcher to hand the terminal to, through
// tea.ExecProcess, when the player asks for it: the installed binary when there is one, this
// one otherwise.
func ForegroundUpdate() *exec.Cmd {
	bin := ""
	if paths, err := install.Resolve(); err == nil {
		if _, err := os.Stat(paths.BinaryPath()); err == nil {
			bin = paths.BinaryPath()
		}
	}
	if bin == "" {
		bin, _ = os.Executable()
	}
	cmd := exec.Command(bin, "update")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd
}

// Restart replaces this process with the installed td, given the same arguments, once the
// player has updated from the launcher and asks to restart into the new td. It returns only on
// failure.
func Restart(args []string) error {
	paths, err := install.Resolve()
	if err != nil {
		return err
	}
	bin := paths.BinaryPath()
	if _, err := os.Stat(bin); err != nil {
		return fmt.Errorf("no installed td at %s", tilde(bin))
	}
	return syscall.Exec(bin, append([]string{install.Binary}, args...), os.Environ())
}

// NeedsUpdate reports whether a failure to join is one an update fixes: the host refused
// this build's protocol, or the error says an update is the fix. Matched on the words rather
// than on *netplay.RejectError alone, because a host also refuses a full game, which no
// update fixes.
func NeedsUpdate(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "protocol") || strings.Contains(msg, " update")
}

// Outdated is what to tell someone starting a game from the shell when td is behind: the
// news and how to update, or "", "" when td is current, pinned, not installed, or the remote
// did not answer within wait. The answer is the launcher's cached one when it is fresh.
func Outdated(wait time.Duration) (news, how string) {
	u := NewUpdateChecker()
	if u == nil {
		return "", ""
	}
	return u.outdated(wait)
}

func (u *UpdateChecker) outdated(wait time.Duration) (news, how string) {
	got := make(chan SelfUpdate, 1)
	go func() { got <- u.Check() }()
	var s SelfUpdate
	select {
	case s = <-got:
	case <-time.After(wait):
		return "", ""
	}
	switch {
	case s.State == UpdateBehind:
		return fmt.Sprintf("this td is out of date: %s, main is at %s", short(s.Version), short(s.Remote)), "update with: td update"
	case s.State == UpdateFollowing && s.Remote != "" && !version.MatchesVersion(s.Version, s.Remote):
		return fmt.Sprintf("branch %s has moved on to %s", s.Branch, short(s.Remote)), "update with: td update"
	}
	return "", ""
}
