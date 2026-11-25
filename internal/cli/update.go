package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"taildefense/internal/install"
	"taildefense/internal/platform"
	"taildefense/internal/ui"
	"taildefense/internal/version"
)

// UpdateOptions are the flags of `td update`.
type UpdateOptions struct {
	Force bool
	// Branch is the -b value; BranchSet tells "-b main" from no -b at all.
	Branch    string
	BranchSet bool
	// Commit is the -c value in lower case: a commit of main to install and pin to, "" for none.
	Commit string
}

// ParseUpdateArgs reads `update`'s arguments: -f/--force, -b/--branch NAME and -c/--commit HASH.
func ParseUpdateArgs(args []string) (UpdateOptions, error) {
	var o UpdateOptions
	commitSet := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-f" || a == "--force":
			o.Force = true
		case a == "-b" || a == "--branch":
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				return o, fmt.Errorf("%s needs a branch name", a)
			}
			i++
			o.Branch, o.BranchSet = args[i], true
		case strings.HasPrefix(a, "--branch="):
			o.Branch, o.BranchSet = strings.TrimPrefix(a, "--branch="), true
		case a == "-c" || a == "--commit":
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				return o, fmt.Errorf("%s needs a commit hash", a)
			}
			i++
			o.Commit, commitSet = args[i], true
		case strings.HasPrefix(a, "--commit="):
			o.Commit, commitSet = strings.TrimPrefix(a, "--commit="), true
		default:
			return o, fmt.Errorf("unknown argument %q  (try: td help)", a)
		}
	}
	if commitSet {
		o.Commit = strings.ToLower(strings.TrimSpace(o.Commit))
		if !install.IsCommitHash(o.Commit) {
			return o, fmt.Errorf("%q is not a commit hash: give 7 to 40 hex digits of one of main's commits", o.Commit)
		}
		if o.BranchSet {
			return o, fmt.Errorf("-c and -b do not go together: -c names a commit of main")
		}
	}
	if o.BranchSet {
		o.Branch = strings.TrimSpace(o.Branch)
		if o.Branch == "" || strings.ContainsAny(o.Branch, " \t\r\n") {
			return o, fmt.Errorf("%q is not a branch name", o.Branch)
		}
		if o.Branch == install.DefaultBranch {
			o.Branch = ""
		}
	}
	return o, nil
}

// target is what an update builds: a branch's tip, or a commit of main to pin the install to.
type target struct {
	Branch string // "" is main
	Commit string // a commit of main, as given or as pinned; "" builds the branch's tip
	Force  bool   // reinstall even when the build is already installed
}

// updateTarget picks what to clone and whether to reinstall regardless: -c names a commit and
// -b a branch, and both always reinstall; -f returns to main and reinstalls; none of them
// follows the record, which is the pinned commit when there is one, the followed branch
// otherwise. Every flag leaves a pin behind except -c, which moves it.
func updateTarget(o UpdateOptions, recorded, pinned string) target {
	switch {
	case o.Commit != "":
		return target{Commit: o.Commit, Force: true}
	case o.BranchSet:
		return target{Branch: o.Branch, Force: true}
	case o.Force:
		return target{Force: true}
	case pinned != "":
		return target{Commit: pinned}
	default:
		return target{Branch: recorded}
	}
}

// pinHolds reports whether a plain update has nothing to do because the install is the
// commit it is pinned to. It needs no network, so a pinned td says so at once.
func pinHolds(t target, installed string) bool {
	return t.Commit != "" && !t.Force && version.MatchesVersion(installed, t.Commit)
}

// gitError is a git command that failed: its exit code and what it said.
type gitError struct {
	code   int
	stderr string
}

func (e *gitError) Error() string {
	if e.stderr != "" {
		return lastLine(e.stderr)
	}
	return fmt.Sprintf("git exited with %d", e.code)
}

// gitIn runs git in dir for its output, a failure as a *gitError when git ran at all.
func gitIn(dir string) func(args ...string) (string, error) {
	return func(args ...string) (string, error) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = gitEnv()
		var stderr strings.Builder
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if ee, ok := err.(*exec.ExitError); ok {
			return "", &gitError{code: ee.ExitCode(), stderr: strings.TrimSpace(stderr.String())}
		}
		return strings.TrimSpace(string(out)), err
	}
}

// resolveCommit turns the hash given to -c into the full hash of a commit of main, in a
// clone of main's history whose HEAD is main's tip. Anything else fails here, before a build.
func resolveCommit(git func(args ...string) (string, error), commit string) (string, error) {
	full, err := git("rev-parse", "--verify", commit+"^{commit}")
	if err != nil {
		var ge *gitError
		if errors.As(err, &ge) && strings.Contains(ge.stderr, "ambiguous") {
			return "", fmt.Errorf("%s is ambiguous: more than one commit starts with it; give more of the hash", commit)
		}
		if errors.As(err, &ge) {
			return "", fmt.Errorf("%s is not a commit on %s", commit, install.DefaultBranch)
		}
		return "", err
	}
	if _, err := git("merge-base", "--is-ancestor", full, "HEAD"); err != nil {
		var ge *gitError
		if errors.As(err, &ge) && ge.code == 1 {
			return "", fmt.Errorf("%s is not a commit on %s", commit, install.DefaultBranch)
		}
		return "", err
	}
	return full, nil
}

// knowsPins reports whether the tree in dir is a td that reads the pin. One from before pins
// would let its launcher autoupdate it back to main's tip.
func knowsPins(dir string) bool {
	b, err := os.ReadFile(filepath.Join(dir, "internal", "install", "install.go"))
	return err == nil && strings.Contains(string(b), install.EnvInstallPin)
}

// Update is `td update`: shallow-clone the recorded origin, build the clone with its
// own build.sh in a container, and run the new binary's install. The new tree carries the
// installer, so an update also picks up changes to how td installs.
func Update(w io.Writer, o UpdateOptions) int {
	p := ui.New(w)
	p.Banner("")
	p.Step("update")
	paths, err := install.Resolve()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	recorded, pinned := paths.Branch(), paths.Pin()
	t := updateTarget(o, recorded, pinned)
	branch, force := t.Branch, t.Force
	source := install.SourceName(branch)
	if pinHolds(t, version.Current()) {
		p.OK("pinned to %s, which is installed: no update moves it", ui.StyleCyan.Render(short(pinned)))
		p.Note("another commit: td update -c COMMIT   ·   back to main: td update -f")
		return 0
	}
	if _, err := exec.LookPath("git"); err != nil {
		p.Fail("git is not installed; td update clones with it")
		return 1
	}
	repo, err := install.RepoURL()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	switch {
	case t.Commit != "" && pinned != "" && !SameCommit(t.Commit, pinned):
		p.Info("commit  %s on %s  %s", ui.StyleYellow.Render(short(t.Commit)), source, ui.StyleDim.Render("(moving the pin from "+short(pinned)+")"))
	case t.Commit != "" && pinned != "":
		p.Info("commit  %s on %s  %s", ui.StyleYellow.Render(short(t.Commit)), source, ui.StyleDim.Render("(pinned)"))
	case t.Commit != "" && recorded != "":
		p.Info("commit  %s on %s  %s", ui.StyleYellow.Render(short(t.Commit)), source, ui.StyleDim.Render("(leaving "+recorded+")"))
	case t.Commit != "":
		p.Info("commit  %s on %s", ui.StyleYellow.Render(short(t.Commit)), source)
	case pinned != "":
		p.Info("branch  %s  %s", ui.StyleBold.Render(source), ui.StyleDim.Render("(leaving the pin on "+short(pinned)+")"))
	case branch != "" && branch == recorded:
		p.Info("branch  %s  %s", ui.StyleYellow.Render(branch), ui.StyleDim.Render("(following)"))
	case branch != "":
		p.Info("branch  %s", ui.StyleYellow.Render(branch))
	case recorded != "":
		p.Info("branch  %s  %s", ui.StyleBold.Render(source), ui.StyleDim.Render("(leaving "+recorded+")"))
	default:
		p.Info("branch  %s", ui.StyleBold.Render(source))
	}

	engine, ok := platform.ContainerEngine()
	if !ok {
		p.Fail("no container engine: taildefense builds only in Docker or Podman, and neither answers")
		p.Detail("start one and try again; %s picks between them", platform.EnvContainerEngine)
		return 1
	}

	// Under $HOME, not $TMPDIR: colima, Lima and Rancher Desktop share only $HOME with their
	// VM, and a clone outside it mounts as an empty directory. Unique per run, so a run that
	// died cannot leave a tree the next one nests into.
	home, err := os.UserHomeDir()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	base := filepath.Join(home, ".cache")
	if err := os.MkdirAll(base, 0o755); err != nil {
		p.Fail("%v", err)
		return 1
	}
	sweepScratch(base)
	tmp, err := os.MkdirTemp(base, scratchPrefix+strconv.Itoa(os.Getpid())+"-*")
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	defer removeScratch(tmp)
	intr := catchInterrupts()
	defer intr.stop()
	interrupted := func() bool {
		if !intr.caught() {
			return false
		}
		p.Fail("interrupted; the previous version is still in place")
		return true
	}

	label := "fetching " + repo
	cloneArgs := []string{"clone", "--quiet", "--depth", "1"}
	if t.Commit != "" {
		// An older commit needs main's history to be found by a short hash and checked against
		// main. Without blobs it costs commits and trees only; the checkout fetches the files
		// of the one commit built. Only -c pays for it: an ordinary update stays one commit deep.
		label = "fetching " + source + "'s history from " + repo
		cloneArgs = []string{"clone", "--quiet", "--filter=blob:none", "--no-checkout",
			"--single-branch", "--branch", install.DefaultBranch}
	} else if branch != "" {
		cloneArgs = append(cloneArgs, "--branch", branch)
	}
	prog := ui.StartProgress(label)
	clone := exec.Command("git", append(cloneArgs, repo, tmp)...)
	clone.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var cloneErr strings.Builder
	clone.Stderr = &cloneErr
	err = intr.run(group(clone))
	prog.Stop()
	if interrupted() {
		return 130
	}
	if err != nil {
		p.Fail("could not fetch %s from %s: %v", source, repo, err)
		if d := strings.TrimSpace(cloneErr.String()); d != "" {
			p.Detail("%s", d)
		}
		return 1
	}
	pin := ""
	if t.Commit != "" {
		if pin, err = resolveCommit(gitIn(tmp), t.Commit); err != nil {
			p.Fail("%v", err)
			p.Detail("td update -c takes a commit of %s; td's changelog lists the latest", source)
			return 1
		}
		prog = ui.StartProgress("checking out " + short(pin))
		checkout := exec.Command("git", "-C", tmp, "checkout", "--quiet", "--detach", pin)
		checkout.Env = gitEnv()
		var checkoutErr strings.Builder
		checkout.Stderr = &checkoutErr
		err = intr.run(group(checkout))
		prog.Stop()
		if interrupted() {
			return 130
		}
		if err != nil {
			p.Fail("could not check out %s: %v", short(pin), err)
			if d := strings.TrimSpace(checkoutErr.String()); d != "" {
				p.Detail("%s", d)
			}
			return 1
		}
	}
	head, err := exec.Command("git", "-C", tmp, "rev-parse", "--short", "HEAD").Output()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	remote := strings.TrimSpace(string(head))

	if !force && version.Matches(remote) {
		p.OK("already up to date with %s (%s)", source, ui.StyleCyan.Render(version.Current()))
		if t.Commit != "" {
			p.Note("pinned to %s   ·   back to main: td update -f", short(remote))
		} else if branch != "" {
			p.Note("reinstall with: td update -b %s   ·   back to main: td update -f", branch)
		} else {
			p.Note("reinstall with: td update -f")
		}
		return 0
	}
	installed := version.Current()
	p.Info("updating %s -> %s from %s", ui.StyleYellow.Render(installed), ui.StyleGreen.Render(remote), source)

	prog = ui.StartProgress("building with " + engine)
	build := exec.Command("sh", "./build.sh", "build")
	build.Dir = tmp
	build.Env = append(os.Environ(), platform.EnvContainerEngine+"="+engine)
	var buildOut strings.Builder
	build.Stdout, build.Stderr = &buildOut, &buildOut
	err = intr.run(group(build))
	prog.Stop()
	if interrupted() {
		return 130
	}
	built := filepath.Join(tmp, install.Binary)
	if err != nil {
		p.Fail("the %s build failed; the previous version is still in place", engine)
		p.Detail("%s", strings.TrimSpace(buildOut.String()))
		return 1
	}
	if _, err := os.Stat(built); err != nil {
		p.Fail("the %s build reported success but left no binary", engine)
		return 1
	}
	p.OK("built with %s", engine)

	inst := exec.Command(built, "install", "-f")
	inst.Dir = tmp
	inst.Stdout, inst.Stderr, inst.Stdin = w, w, os.Stdin
	inst.Env = append(os.Environ(),
		install.EnvInstallVersion+"="+remote,
		install.EnvInstallBranch+"="+branch,
		install.EnvInstallPin+"="+pin,
		ui.EnvNoBanner+"=1")
	if err := intr.run(inst); err != nil {
		if interrupted() {
			return 130
		}
		p.Fail("the installer failed; the previous version is still in place: %v", err)
		return 1
	}
	// Recorded here as well as by the installer: a commit from before pins installs with an
	// installer that knows nothing of them, and would leave a stale pin or none at all.
	if err := paths.RecordPin(pin); err != nil {
		p.Warn("could not record the pin: %v", err)
	}
	news := readNews(tmp, installed, remote)
	printNews(p, news, source)
	saveNews(news, source)
	switch {
	case pin != "" && !knowsPins(tmp):
		p.Warn("%s is older than pinning: its launcher autoupdates to main's tip, and its td update goes there", short(pin))
		p.Detail("to stay on it, turn autoupdate off with: td config autoupdate off, and run no plain td update")
	case pin != "":
		p.Note("pinned to %s: the launcher leaves it there and a plain td update stays; back to main: td update -f", short(pin))
	case branch != "":
		p.Note("following %s: a plain td update stays on it, td update -f returns to main", branch)
	}
	return 0
}

// interrupts turns a ctrl+c or a kill into an update that stops the way a failure does, so the
// deferred cleanup still runs: the signal goes on to the step running at the time (build.sh
// removes its container on it), that step fails, and Update returns through its defers. A
// background update has its own process group, so a signal sent to it reaches only td and
// would otherwise leave the build running and the clone behind.
type interrupts struct {
	mu  sync.Mutex
	sig chan os.Signal
	cur *exec.Cmd
	got os.Signal
}

func catchInterrupts() *interrupts {
	i := &interrupts{sig: make(chan os.Signal, 1)}
	signal.Notify(i.sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for s := range i.sig {
			i.mu.Lock()
			i.got = s
			if i.cur != nil && i.cur.Process != nil {
				if a := i.cur.SysProcAttr; a != nil && a.Setpgid {
					_ = syscall.Kill(-i.cur.Process.Pid, s.(syscall.Signal))
				} else {
					_ = i.cur.Process.Signal(s)
				}
			}
			i.mu.Unlock()
		}
	}()
	return i
}

// group runs cmd in a process group of its own, so a signal passed on reaches all of it: sh
// waits for the engine client before it runs its trap, and only the client tells the
// container to stop. A step with no stdin to read loses nothing by leaving the terminal's
// group, and a ctrl+c then arrives once, through td, rather than twice.
func group(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

// run is cmd.Run with cmd as the step a signal is passed on to. A signal that came before
// the step started stops it from starting.
func (i *interrupts) run(cmd *exec.Cmd) error {
	i.mu.Lock()
	if i.got != nil {
		i.mu.Unlock()
		return fmt.Errorf("interrupted")
	}
	if err := cmd.Start(); err != nil {
		i.mu.Unlock()
		return err
	}
	i.cur = cmd
	i.mu.Unlock()
	err := cmd.Wait()
	i.mu.Lock()
	i.cur = nil
	i.mu.Unlock()
	return err
}

func (i *interrupts) caught() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.got != nil
}

func (i *interrupts) stop() {
	signal.Stop(i.sig)
	close(i.sig)
}

// scratchPrefix names an update's clone under ~/.cache. The pid after it says whose clone it
// is, so the next update can tell a dead run's leftover from a running one's tree.
const scratchPrefix = "taildefense-update-"

// scratchMaxAge is when a clone named the old way, with no pid to ask, counts as left over.
// A build takes minutes.
const scratchMaxAge = time.Hour

// sweepScratch removes the clones of updates that are no longer running: one that was
// killed with SIGKILL, or the machine went down mid-build, never ran its cleanup.
func sweepScratch(base string) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), scratchPrefix) {
			continue
		}
		if scratchIsStale(e, time.Now()) {
			removeScratch(filepath.Join(base, e.Name()))
		}
	}
}

func scratchIsStale(e os.DirEntry, now time.Time) bool {
	rest := strings.TrimPrefix(e.Name(), scratchPrefix)
	if pid, _, ok := strings.Cut(rest, "-"); ok {
		if n, err := strconv.Atoi(pid); err == nil && n > 0 {
			return !processAlive(n)
		}
	}
	info, err := e.Info()
	return err == nil && now.Sub(info.ModTime()) > scratchMaxAge
}

// processAlive reports whether pid is a running process; EPERM means it is, under another user.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// removeScratch deletes a build tree after restoring write permission, because the in-tree
// Go caches are written read-only and RemoveAll alone stops partway.
func removeScratch(dir string) {
	if dir == "" {
		return
	}
	_ = exec.Command("chmod", "-R", "u+w", dir).Run()
	_ = os.RemoveAll(dir)
}
