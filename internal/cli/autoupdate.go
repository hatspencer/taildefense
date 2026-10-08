package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"taildefense/internal/install"
	"taildefense/internal/ui"
	"taildefense/internal/version"
)

// Keeping td current from the launcher, the way mf keeps itself current from its shell: at
// most once an hour the launcher asks the remote whether main has moved on, and when it has,
// runs the installed `td update` in the background and says what changed when it finishes.
//
// The update is the installed td run as a child, not Update called in-process. That keeps
// the update contract intact (the new clone's own build.sh and installer), its output goes
// to a log rather than over the launcher, and it runs in its own process group, so leaving
// the launcher or a ctrl+c in a game does not cut a build off halfway.
//
// An install that follows a branch is never updated here: a branch is somebody's choice. A
// binary run from a build tree is not either: there is no install to keep current.

// checkInterval is how old a cached answer may be before the remote is asked again.
const checkInterval = time.Hour

// attemptInterval is how soon after one background update another may start, so one that
// keeps failing (no container engine, a broken main) is tried a few times a day, not on every
// launch.
const attemptInterval = 6 * time.Hour

// lockStale is when a lock left by a crashed update stops counting. A build takes minutes.
const lockStale = 30 * time.Minute

// The files under ~/.taildefense the autoupdate keeps.
const (
	selfcheckFile = "selfcheck"
	UpdateLogFile = "update.log"
	lockFile      = "update.lock"
)

// UpdateState is what the launcher knows about td's own version.
type UpdateState string

const (
	UpdateUnknown   UpdateState = "unknown"   // not asked, or the remote did not answer
	UpdateCurrent   UpdateState = "current"   // the install is main's tip
	UpdateBehind    UpdateState = "behind"    // main has moved on, nothing started
	UpdateUpdating  UpdateState = "updating"  // a background update is running
	UpdateUpdated   UpdateState = "updated"   // installed; this process is still the old one
	UpdateFailed    UpdateState = "failed"    // see the log
	UpdateFollowing UpdateState = "following" // following a branch: never updated here
)

// SelfUpdate is the state with what the launcher shows next to it.
type SelfUpdate struct {
	State   UpdateState `json:"state"`
	Version string      `json:"version"`          // the installed version when checked
	Remote  string      `json:"remote,omitempty"` // main's tip
	Branch  string      `json:"branch,omitempty"` // followed branch, "" is main
	After   string      `json:"after,omitempty"`  // installed by a finished update
	Log     string      `json:"log,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// Text is the one line the launcher's header shows, or "" when there is nothing to say.
func (s SelfUpdate) Text() string {
	switch s.State {
	case UpdateBehind:
		return fmt.Sprintf("a newer td is on main: %s → %s", short(s.Version), short(s.Remote))
	case UpdateUpdating:
		return fmt.Sprintf("updating %s → %s in the background", short(s.Version), short(s.Remote))
	case UpdateUpdated:
		return fmt.Sprintf("updated %s → %s", short(s.Version), short(s.After))
	case UpdateFailed:
		return "the background update failed: " + s.Error
	case UpdateFollowing:
		if s.Remote != "" && !version.MatchesVersion(s.Version, s.Remote) {
			return fmt.Sprintf("branch %s has moved on to %s · td update", s.Branch, short(s.Remote))
		}
	}
	return ""
}

// snapshot is the cached answer in ~/.taildefense/selfcheck.
type snapshot struct {
	CheckedAt   time.Time  `json:"checkedAt"`
	AttemptedAt time.Time  `json:"attemptedAt,omitzero"`
	Status      SelfUpdate `json:"status"`
}

// AutoUpdater checks and updates the install. Its fields are functions so a test stands in
// for git, the remote and the child process.
type AutoUpdater struct {
	Dir     string // the install prefix, where the state files live
	Binary  string // the installed td
	Enabled bool   // the AUTOUPDATE preference

	now       func() time.Time
	installed func() string
	branch    func() string
	remote    func(branch string) (string, error)
	start     func(log string) error
}

// NewAutoUpdater is the launcher's updater, or nil when td is not installed: a binary run
// from a build tree has nothing to keep current.
func NewAutoUpdater(enabled bool) *AutoUpdater {
	paths, err := install.Resolve()
	if err != nil || !install.IsInstalled() {
		return nil
	}
	if _, err := os.Stat(paths.BinaryPath()); err != nil {
		return nil
	}
	bin := paths.BinaryPath()
	return &AutoUpdater{
		Dir:       paths.Prefix,
		Binary:    bin,
		Enabled:   enabled,
		now:       time.Now,
		installed: func() string { return installedVersion(paths) },
		branch:    paths.Branch,
		remote: func(branch string) (string, error) {
			repo, err := install.RepoURL()
			if err != nil {
				return "", err
			}
			return remoteHead(repo, install.SourceName(branch))
		},
		start: func(log string) error { return runBackgroundUpdate(bin, log) },
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
func (u *AutoUpdater) Check() SelfUpdate {
	snap := u.load()
	installed := u.installed()
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

// ShouldStart reports whether a checked state is one to update from now: behind main,
// autoupdate on, and no attempt in the last six hours. It records the attempt, so two
// launchers opened together do not both start one.
func (u *AutoUpdater) ShouldStart(s SelfUpdate) bool {
	if s.State != UpdateBehind || !u.Enabled || s.Branch != "" {
		return false
	}
	snap := u.load()
	if u.now().Sub(snap.AttemptedAt) < attemptInterval {
		return false
	}
	snap.AttemptedAt = u.now()
	snap.Status = s
	u.save(snap)
	return true
}

// ErrUpdateRunning is another update holding the lock.
var ErrUpdateRunning = errors.New("another td update is already running")

// Run updates in the background and blocks until the child exits. The state it returns is
// updated, or failed with the reason and the log.
func (u *AutoUpdater) Run(s SelfUpdate) SelfUpdate {
	log := filepath.Join(u.Dir, UpdateLogFile)
	s.Log = log
	unlock, err := u.lock()
	if err != nil {
		s.State, s.Error = UpdateFailed, err.Error()
		return s
	}
	defer unlock()
	if err := u.start(log); err != nil {
		s.State, s.Error = UpdateFailed, fmt.Sprintf("%v · log %s", err, tilde(log))
		return s
	}
	after := u.installed()
	if version.MatchesVersion(s.Version, after) || after == s.Version {
		s.State, s.Error = UpdateFailed, "it installed nothing · log "+tilde(log)
		return s
	}
	s.State, s.After = UpdateUpdated, after
	snap := u.load()
	snap.Status = SelfUpdate{State: UpdateCurrent, Version: after, Remote: s.Remote}
	snap.CheckedAt = u.now()
	u.save(snap)
	return s
}

// Updated is the state after a foreground `td update` the launcher ran: updated when the
// install record changed, unchanged otherwise.
func (u *AutoUpdater) Updated(before SelfUpdate) SelfUpdate {
	after := u.installed()
	if after == "" || after == before.Version {
		return before
	}
	return SelfUpdate{State: UpdateUpdated, Version: before.Version, After: after, Remote: before.Remote}
}

// ForegroundUpdated is the state after a foreground `td update` when there is no updater (td
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

func (u *AutoUpdater) load() snapshot {
	var s snapshot
	b, err := os.ReadFile(filepath.Join(u.Dir, selfcheckFile))
	if err != nil || json.Unmarshal(b, &s) != nil {
		return snapshot{}
	}
	return s
}

// save writes the snapshot through a temp file and a rename, so a launcher reading it while
// another writes never sees half of one.
func (u *AutoUpdater) save(s snapshot) {
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

// lock takes ~/.taildefense/update.lock with O_EXCL, so two launchers never build at once.
// A lock older than any build is a crashed run's and is taken over.
func (u *AutoUpdater) lock() (func(), error) {
	if err := os.MkdirAll(u.Dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(u.Dir, lockFile)
	if fi, err := os.Stat(path); err == nil && u.now().Sub(fi.ModTime()) > lockStale {
		os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return nil, ErrUpdateRunning
		}
		return nil, err
	}
	fmt.Fprintf(f, "%d\n", os.Getpid())
	f.Close()
	return func() { os.Remove(path) }, nil
}

// runBackgroundUpdate runs `td update` with its output in log, in its own process group so a
// ctrl+c in the terminal does not reach it, with no stdin since nothing is there to answer,
// and with colour, animation and the banner off since the log is read as plain text.
func runBackgroundUpdate(bin, log string) error {
	f, err := os.OpenFile(log, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	fmt.Fprintf(f, "td update, started %s by the launcher\n\n", time.Now().Format(time.RFC3339))
	cmd := exec.Command(bin, "update")
	cmd.Stdout, cmd.Stderr = f, f
	cmd.Env = append(os.Environ(), ui.EnvNoAnim+"=1", "NO_COLOR=1", ui.EnvNoBanner+"=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd.Run()
}

// ForegroundUpdate is `td update` for the launcher to hand the terminal to, through
// tea.ExecProcess: the installed binary when there is one, this one otherwise.
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

// Restart replaces this process with the installed td, given the same arguments, so an
// update takes effect without the player retyping anything. It returns only on failure.
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
