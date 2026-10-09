package cli

import (
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
}

// ParseUpdateArgs reads `update`'s arguments: -f/--force and -b/--branch NAME.
func ParseUpdateArgs(args []string) (UpdateOptions, error) {
	var o UpdateOptions
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
		default:
			return o, fmt.Errorf("unknown argument %q  (try: td help)", a)
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

// updateTarget picks the branch to clone and whether to reinstall regardless: -b names a
// branch and always reinstalls, -f returns to main and reinstalls, neither follows the record.
func updateTarget(o UpdateOptions, recorded string) (branch string, force bool) {
	switch {
	case o.BranchSet:
		return o.Branch, true
	case o.Force:
		return "", true
	default:
		return recorded, false
	}
}

// Update is `td update`: shallow-clone the recorded origin, build the clone with its
// own build.sh in a container, and run the new binary's install. The new tree carries the
// installer, so an update also picks up changes to how td installs.
func Update(w io.Writer, o UpdateOptions) int {
	p := ui.New(w)
	p.Banner("")
	p.Step("update")
	if _, err := exec.LookPath("git"); err != nil {
		p.Fail("git is not installed; td update clones with it")
		return 1
	}
	repo, err := install.RepoURL()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	paths, err := install.Resolve()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	recorded := paths.Branch()
	branch, force := updateTarget(o, recorded)
	source := install.SourceName(branch)
	switch {
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

	prog := ui.StartProgress("fetching " + repo)
	cloneArgs := []string{"clone", "--quiet", "--depth", "1"}
	if branch != "" {
		cloneArgs = append(cloneArgs, "--branch", branch)
	}
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
	head, err := exec.Command("git", "-C", tmp, "rev-parse", "--short", "HEAD").Output()
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	remote := strings.TrimSpace(string(head))

	if !force && version.Matches(remote) {
		p.OK("already up to date with %s (%s)", source, ui.StyleCyan.Render(version.Current()))
		if branch != "" {
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
		ui.EnvNoBanner+"=1")
	if err := intr.run(inst); err != nil {
		if interrupted() {
			return 130
		}
		p.Fail("the installer failed; the previous version is still in place: %v", err)
		return 1
	}
	printNews(p, readNews(tmp, installed, remote), source)
	if branch != "" {
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
