package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/config"
)

// The golden frames: every launcher screen at two window sizes, as plain text, kept in
// testdata/frames. A change to how the launcher looks shows up as a diff of these files in
// the commit, and an unintended one fails here. After a deliberate change, rewrite them with
// ./build.sh golden and read the diff.
func TestGoldenFrames(t *testing.T) {
	isolate(t)
	update := os.Getenv("TD_GOLDEN") == "update"
	views := []string{FrameMenu, FrameJoin, FrameSettings, FrameChangelog, FrameDoctor, FrameHelp, FrameSplash}
	for _, view := range views {
		for _, size := range [][2]int{{80, 24}, {120, 36}} {
			name := fmt.Sprintf("%s-%dx%d.txt", view, size[0], size[1])
			t.Run(name, func(t *testing.T) {
				got := framePlain(Frame(Options{}, size[0], size[1], view))
				path := filepath.Join("testdata", "frames", name)
				if update {
					if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
						t.Fatal(err)
					}
					return
				}
				want, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("%v; create the frames with ./build.sh golden", err)
				}
				if got != string(want) {
					t.Errorf("%s changed; if on purpose, ./build.sh golden and read the diff\n--- got\n%s\n--- want\n%s", name, got, want)
				}
			})
		}
	}
}

// framePlain strips colour and trailing blanks, so a golden file diffs by what a person sees,
// and names the test's throwaway config directory, which differs every run.
func framePlain(s string) string {
	s = ansi.Strip(s)
	if dir := os.Getenv(config.EnvConfigDir); dir != "" {
		s = strings.ReplaceAll(s, dir, "<config>")
	}
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	return strings.Join(lines, "\n") + "\n"
}
