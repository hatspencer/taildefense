package ui

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"

	"taildefense/internal/platform"
)

// --quiet and --json drop supporting detail and keep findings. Tested here, once, because
// both are global flags implemented in this layer rather than per command: a command that
// only ever calls Info/Fail must go quiet or verbose the same way as any other. A Printer
// pointed at a buffer is not os.Stdout, so this isolates the suppression from the stream
// redirection tested separately.
func TestQuietAndJSONDropSupportingDetail(t *testing.T) {
	for _, tc := range []struct {
		name string
		set  func(bool)
	}{
		{"quiet", SetQuiet},
		{"json", SetJSON},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.set(true)
			t.Cleanup(func() { tc.set(false) })

			var buf bytes.Buffer
			p := New(&buf)
			p.Info("a fact")
			p.Note("a note")
			p.Detail("a detail")
			if buf.Len() != 0 {
				t.Errorf("%s did not suppress supporting detail: %q", tc.name, buf.String())
			}

			// Findings still print: the whole point of both flags is to keep them.
			buf.Reset()
			p.Pass("held")
			p.Fail("broke")
			p.Warn("act")
			got := buf.String()
			for _, want := range []string{"held", "broke", "act"} {
				if !strings.Contains(got, want) {
					t.Errorf("%s suppressed a finding %q: %q", tc.name, want, got)
				}
			}
			// Fail is still counted under either flag: the exit code must not depend on
			// how loud the output is.
			if p.Failures() != 1 {
				t.Errorf("%s: Failures() = %d, want 1", tc.name, p.Failures())
			}
		})
	}
}

// The mode accessors report what the setters set, and default to off. A command reads
// ctx.JSON to decide whether to emit structured output, so a wrong default here would make
// every command either always or never machine-readable.
func TestModeAccessors(t *testing.T) {
	SetQuiet(false)
	SetJSON(false)
	if Quiet() || JSONMode() {
		t.Fatalf("modes not off by default: quiet=%v json=%v", Quiet(), JSONMode())
	}
	SetQuiet(true)
	SetJSON(true)
	t.Cleanup(func() { SetQuiet(false); SetJSON(false) })
	if !Quiet() || !JSONMode() {
		t.Errorf("setters did not take: quiet=%v json=%v", Quiet(), JSONMode())
	}
}

// In JSON mode the default stdout Printer must not write to stdout: stdout is reserved for
// the single JSON document a command emits, and a stray finding line there would make the
// output unparseable. The redirection only applies to the stdout Printer — a Printer aimed
// at a buffer or a shell pane is left alone, because that writer is a capture the caller
// asked for. dest() is the choke point, so it is what this pins.
func TestJSONModeKeepsFindingsOffStdout(t *testing.T) {
	SetJSON(true)
	t.Cleanup(func() { SetJSON(false) })

	// The Std printer targets os.Stdout, so in JSON mode dest() must send it elsewhere.
	if got := Std.dest(); got == io.Writer(os.Stdout) {
		t.Error("in JSON mode the stdout Printer still writes to stdout, which would corrupt the JSON")
	}
	if got := Std.dest(); got != io.Writer(os.Stderr) {
		t.Errorf("in JSON mode the stdout Printer should write to stderr, got %T", got)
	}

	// A Printer explicitly pointed at a buffer is untouched: that buffer is the capture.
	var buf bytes.Buffer
	p := New(&buf)
	if got := p.dest(); got != io.Writer(&buf) {
		t.Error("JSON mode redirected a buffer-backed Printer; only the stdout one should move")
	}
}

// The failure count is the contract between a command and its own summary line. In bash
// it was a global that got discarded whenever a loop calling fail() ran in a subshell, so
// a command reported ALL CHECKS PASSED under visible FAIL lines. Here it belongs to the
// Printer.
func TestPrinterCountsFailures(t *testing.T) {
	var buf bytes.Buffer
	p := New(&buf)

	p.Pass("all good")
	p.Info("just a fact")
	p.Note("detail")
	p.Warn("look at this")
	p.OK("done")
	// Bad is deliberately not counted: it is used where something else owns the tally.
	p.Bad("cross")
	if got := p.Failures(); got != 0 {
		t.Errorf("Failures() = %d before any Fail call", got)
	}

	p.Fail("first")
	p.Fail("second")
	if got := p.Failures(); got != 2 {
		t.Errorf("Failures() = %d, want 2", got)
	}

	p.ResetFailures()
	if got := p.Failures(); got != 0 {
		t.Errorf("Failures() = %d after ResetFailures", got)
	}
}

// A batch run gives each concurrent placement its own Printer, so the counts cannot
// merge. This asserts they are genuinely independent.
func TestPrintersAreIndependent(t *testing.T) {
	var a, b bytes.Buffer
	pa, pb := New(&a), New(&b)

	pa.Fail("only in a")
	if pb.Failures() != 0 {
		t.Error("a failure on one Printer was counted on another")
	}
	if !strings.Contains(a.String(), "only in a") {
		t.Error("the line did not reach its own buffer")
	}
	if b.Len() != 0 {
		t.Errorf("the other buffer received output: %q", b.String())
	}
}

func TestPrinterFormatting(t *testing.T) {
	var buf bytes.Buffer
	p := New(&buf)
	p.Pass("rule %s number %d", "abc", 42)
	if !strings.Contains(buf.String(), "rule abc number 42") {
		t.Errorf("format arguments were not applied: %q", buf.String())
	}
}

// Column widths have to be measured in visible characters. A styled cell is longer than
// it looks, and padding to the byte length misaligns every row after the first coloured
// one.
func TestTableAlignsAroundANSI(t *testing.T) {
	styled := "\x1b[32mbetting-integration\x1b[0m"
	rows := [][]string{
		{styled, "abc1234", "2026-08-31"},
		{"bet-resolution", "def5678", "2026-08-30"},
	}
	out := Table(rows, "  ")
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2:\n%s", len(lines), out)
	}

	// The second column has to start at the same visible offset on both rows.
	offsets := make([]int, 2)
	for i, line := range lines {
		plain := stripANSI(line)
		offsets[i] = strings.Index(plain, "abc1234")
		if offsets[i] < 0 {
			offsets[i] = strings.Index(plain, "def5678")
		}
	}
	if offsets[0] != offsets[1] {
		t.Errorf("the second column starts at %d and %d; the styled cell broke the alignment:\n%s",
			offsets[0], offsets[1], out)
	}
}

// Trailing whitespace shows up in diffs and in copied output for no benefit.
func TestTableHasNoTrailingWhitespace(t *testing.T) {
	out := Table([][]string{{"a", "bbbb"}, {"cccc", "d"}}, "  ")
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line != strings.TrimRight(line, " ") {
			t.Errorf("line has trailing whitespace: %q", line)
		}
	}
}

func TestTableEmpty(t *testing.T) {
	if got := Table(nil, "  "); got != "" {
		t.Errorf("Table(nil) = %q, want empty", got)
	}
}

func TestStripANSI(t *testing.T) {
	cases := map[string]string{
		"\x1b[32mgreen\x1b[0m":         "green",
		"plain":                        "plain",
		"\x1b[1;33mbold yellow\x1b[0m": "bold yellow",
		"":                             "",
	}
	for in, want := range cases {
		if got := stripANSI(in); got != want {
			t.Errorf("stripANSI(%q) = %q, want %q", in, got, want)
		}
	}
}

// NO_COLOR is honoured (https://no-color.org), and TAILDEFENSE_FORCE_COLOR overrides every
// heuristic — which is what makes piping into `less -R` work.
func TestColorSuppression(t *testing.T) {
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	if ColorEnabled() {
		t.Error("colour is enabled with NO_COLOR set")
	}

	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "dumb")
	InitColor(false)
	if ColorEnabled() {
		t.Error("colour is enabled with TERM=dumb")
	}

	// The --no-color flag.
	t.Setenv("TERM", "xterm-256color")
	InitColor(true)
	if ColorEnabled() {
		t.Error("colour is enabled with --no-color")
	}

	t.Setenv("TAILDEFENSE_FORCE_COLOR", "1")
	InitColor(true)
	if !ColorEnabled() {
		t.Error("TAILDEFENSE_FORCE_COLOR did not override --no-color")
	}

	// Leave the package in a predictable state for anything that runs after this.
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	InitColor(false)
}

// With colour off, output must be free of escape sequences: that is what makes
// `taildefense failures --curl | pbcopy` produce a usable command.
func TestNoColorProducesPlainText(t *testing.T) {
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	var buf bytes.Buffer
	p := New(&buf)
	p.Pass("passed")
	p.Fail("failed")
	p.Step("a section")
	if strings.Contains(buf.String(), "\x1b[") {
		t.Errorf("output contains escape sequences with colour disabled: %q", buf.String())
	}
	// The vocabulary still has to be readable.
	for _, want := range []string{"PASS", "FAIL", "passed", "failed", "a section"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("output is missing %q: %q", want, buf.String())
		}
	}
}

func TestHeadingAndSectionDoNotPanicOnEmptyInput(t *testing.T) {
	var buf bytes.Buffer
	p := New(&buf)
	p.Heading("")
	p.Section("", "")
	p.HR()
	if buf.Len() == 0 {
		t.Error("no output produced")
	}
}

// A heading is a blank line, the title, then one heavy rule under it — three lines total,
// down from the old five-line double-bar box. The shorter form repeats better: a batch run
// and the shell open a heading per tab, and the box was three lines of drawing before any
// content each time. This pins the new shape so a refactor cannot quietly grow it back.
func TestHeadingShape(t *testing.T) {
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	var buf bytes.Buffer
	p := New(&buf)
	p.Heading("E2E TEST  ·  target staging")

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	// Leading blank, title, rule.
	if len(lines) != 3 {
		t.Fatalf("heading has %d lines, want 3 (blank, title, rule): %q", len(lines), lines)
	}
	if strings.TrimSpace(lines[0]) != "" {
		t.Errorf("first heading line is not blank: %q", lines[0])
	}
	if !strings.Contains(lines[1], "E2E TEST") {
		t.Errorf("title line missing the title: %q", lines[1])
	}
	// The rule under the title is the heavy bar, and there is exactly one bar, not two.
	if !strings.Contains(lines[2], bannerChar) {
		t.Errorf("no heavy rule under the title: %q", lines[2])
	}
	if strings.Contains(lines[1], bannerChar) {
		t.Errorf("the title line itself is a bar — the old top bar was not removed: %q", lines[1])
	}
}

// A section heading is a blank line, an indented marker, the title, an optional dim
// caption and a rule under it. The `== title` it replaced had no vertical space of its
// own and sat at column 0 while its own findings were indented, which is what made a
// long transcript read as one undifferentiated block.
func TestSectionShape(t *testing.T) {
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	var buf bytes.Buffer
	p := New(&buf)
	p.Section("betting-integration.validations", "pre-placement checks + LRC")

	lines := strings.Split(buf.String(), "\n")
	if len(lines) < 4 || lines[0] != "" {
		t.Fatalf("a section must open with a blank line: %q", buf.String())
	}
	head, ruleLine := lines[1], lines[2]

	if !strings.HasPrefix(head, gutter+sectionMark) {
		t.Errorf("heading %q does not start at the shared left edge with the marker", head)
	}
	if !strings.Contains(head, "betting-integration.validations"+captionSep+"pre-placement checks + LRC") {
		t.Errorf("heading %q does not carry the title and its caption", head)
	}
	if !strings.HasPrefix(ruleLine, gutter+ruleChar) || strings.TrimSpace(strings.TrimLeft(ruleLine, " "+ruleChar)) != "" {
		t.Errorf("second line is not a rule at the same left edge: %q", ruleLine)
	}
	// The rule and the heading share a left edge, which is the whole point of the
	// gutter: a heading indented differently from its own findings has two left edges.
	if got := strings.Index(ruleLine, ruleChar); got != len(gutter) {
		t.Errorf("rule starts at column %d, want %d", got, len(gutter))
	}
}

// Step is the same heading with no caption, so it must not leave a dangling separator.
func TestStepHasNoEmptyCaption(t *testing.T) {
	t.Setenv("TAILDEFENSE_FORCE_COLOR", "")
	t.Setenv("NO_COLOR", "1")
	InitColor(false)
	t.Cleanup(func() { t.Setenv("NO_COLOR", ""); InitColor(false) })

	var buf bytes.Buffer
	p := New(&buf)
	p.Step("bet-resolution.betslips")
	if strings.Contains(buf.String(), captionSep) {
		t.Errorf("a captionless heading printed the separator anyway: %q", buf.String())
	}
}

// A rule must never be wider than the terminal: a wrapped rule reads as two rules with
// a stray fragment on the end.
func TestRuleNeverExceedsTheTerminal(t *testing.T) {
	room := platform.TermCols() - len([]rune(gutter))
	if got := len([]rune(rule(ruleChar, 500))); got > room {
		t.Errorf("rule is %d columns wide with only %d columns of room", got, room)
	}
}

// A listing must not borrow the verdict vocabulary. This is the guarantee that keeps a search
// result from printing as PASS: the marker is dim, and neither PASS nor FAIL appears.
func TestARowIsNeitherAPassNorAFailure(t *testing.T) {
	var buf bytes.Buffer
	p := New(&buf)
	p.Row("steering/knowledge-loop.md")

	got := buf.String()
	if !strings.Contains(got, "steering/knowledge-loop.md") {
		t.Fatalf("Row dropped its text: %q", got)
	}
	for _, verdict := range []string{"PASS", "FAIL", "▲"} {
		if strings.Contains(got, verdict) {
			t.Errorf("a listed row printed the %q verdict: %q", verdict, got)
		}
	}
	if p.Failures() != 0 {
		t.Errorf("a listed row counted as a failure")
	}
}
