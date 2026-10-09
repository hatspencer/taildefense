package cli

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"unicode/utf8"

	"taildefense/internal/ui"
)

// News is what an update says after installing: the commit subjects between the build that
// was installed and the one that replaced it, read from the update's own clone.
//
// The clone is shallow, so it is deepened first, blobs left out: commit messages are all this
// needs, and a few hundred of them cost about a second. Everything here is best-effort. A
// fetch that fails, or an installed commit that is not in the deepened history (a local dirty
// build, a branch switch, an install older than newsDepth), still shows the most recent
// commits rather than nothing, and says that is what they are.
const (
	newsDepth        = 200
	newsShown        = 15
	newsSubjectWidth = 96
)

type change struct {
	Hash    string
	Subject string
}

type updateNews struct {
	From    string
	To      string
	Found   bool
	Changes []change
}

func printNews(p *ui.Printer, n updateNews, source string) {
	head := n.headline("→", source)
	if head == "" {
		return
	}
	p.Step("%s", head)
	list, more := n.shown()
	for _, c := range list {
		p.Plain("    %s  %s", ui.StyleInfo.Render(c.Hash), c.Subject)
	}
	if more > 0 {
		p.Note("+ %s", plural(more, "more commit"))
	}
}

func readNews(dir, installed, to string) updateNews {
	n := updateNews{From: baseCommit(installed), To: to}
	git := func(args ...string) (string, error) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_TERMINAL_PROMPT=0",
			"GIT_SSH_COMMAND=ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
		)
		out, err := cmd.Output()
		return string(out), err
	}
	_, _ = git("fetch", "--quiet", "--deepen", strconv.Itoa(newsDepth), "--filter=blob:none")
	args := []string{"log", "--no-merges", "--format=%h%x1f%s"}
	if n.From != "" {
		if _, err := git("rev-parse", "--verify", "--quiet", n.From+"^{commit}"); err == nil {
			n.Found = true
		}
	}
	if n.Found {
		args = append(args, n.From+"..HEAD")
	} else {
		args = append(args, "-n", strconv.Itoa(newsShown))
	}
	out, err := git(args...)
	if err != nil {
		return n
	}
	n.Changes = parseLog(out)
	return n
}

// baseCommit is the commit an installed version was built from: the hash without a -dirty
// suffix, or "" for anything that is not a hash at all.
func baseCommit(v string) string {
	v = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(v), "-dirty"))
	if len(v) < 7 {
		return ""
	}
	for _, r := range v {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return ""
		}
	}
	return v
}

func parseLog(out string) []change {
	var cs []change
	for _, line := range strings.Split(out, "\n") {
		hash, subject, ok := strings.Cut(strings.TrimSpace(line), "\x1f")
		if !ok || hash == "" {
			continue
		}
		cs = append(cs, change{Hash: hash, Subject: clip(strings.TrimSpace(subject), newsSubjectWidth)})
	}
	return cs
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-3])) + "..."
}

// headline is the line above the list, or "" when there is nothing to say: a forced
// reinstall of the same commit has no news.
func (n updateNews) headline(arrow, source string) string {
	count := len(n.Changes)
	switch {
	case n.Found && count == 0:
		return ""
	case n.Found:
		return "what's new  " + n.From + " " + arrow + " " + n.To + "  (" + plural(count, "commit") + ")"
	case count == 0:
		return ""
	case n.From != "":
		return "latest on " + source + "  (" + n.From + " is not in the last " + strconv.Itoa(newsDepth) + " commits)"
	default:
		return "latest on " + source
	}
}

// shown is the part of the list that is printed, and how many were left out.
func (n updateNews) shown() ([]change, int) {
	if len(n.Changes) <= newsShown {
		return n.Changes, 0
	}
	return n.Changes[:newsShown], len(n.Changes) - newsShown
}
