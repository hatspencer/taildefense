package ui

import (
	"strings"
	"testing"
)

func TestWordmarkRowCounts(t *testing.T) {
	// The shell derives its header height and therefore its pane height from these, so a
	// row added to the art silently changes the frame arithmetic.
	if got := len(WordmarkLarge()); got != 3 {
		t.Errorf("the large wordmark is %d rows, want 3", got)
	}
	if got := len(WordmarkSmall()); got != 3 {
		t.Errorf("the small wordmark is %d rows, want 3", got)
	}
}

func TestWordmarkRowsAreEqualWidth(t *testing.T) {
	// Ragged rows would put the header's right-hand column in a different place on each
	// row, since it is positioned from the measured width.
	for _, w := range []struct {
		name string
		rows []string
	}{
		{"large", WordmarkLarge()},
		{"small", WordmarkSmall()},
	} {
		want := WordmarkWidth(w.rows)
		for i, r := range w.rows {
			// Trailing blanks are invisible and harmless; only an over-long row matters.
			if n := len([]rune(r)); n > want {
				t.Errorf("%s row %d is %d cells, wider than the measured width %d",
					w.name, i, n, want)
			}
		}
	}
}

func TestWordmarkWidthIgnoresStyling(t *testing.T) {
	// The width is used for layout, so it must count cells rather than bytes.
	plain := WordmarkWidth([]string{"abc"})
	styled := WordmarkWidth([]string{"\x1b[31mabc\x1b[0m"})
	if plain != styled {
		t.Errorf("styling changed the measured width: %d vs %d", plain, styled)
	}
}

// An update runs two programs that both open with a banner: `td update` and the
// `td install` it execs out of the fresh clone. The second one is suppressed, so
// that one command draws one wordmark.
func TestTheBannerIsSilentWhenSuppressed(t *testing.T) {
	t.Setenv(EnvNoBanner, "1")

	var buf strings.Builder
	New(&buf).Banner("installer")

	if buf.String() != "" {
		t.Errorf("Banner printed %q under %s; an update would draw two wordmarks",
			buf.String(), EnvNoBanner)
	}
}

func TestTheBannerPrintsWhenNotSuppressed(t *testing.T) {
	t.Setenv(EnvNoBanner, "")

	var buf strings.Builder
	New(&buf).Banner("installer")

	if !strings.Contains(buf.String(), "installer") {
		t.Error("Banner printed no subtitle with the suppression unset")
	}
}

// The banner is the wordmark, the tagline and the subtitle, and nothing else. No slogan on a line
// of its own between the first two: this pins the shape so one does not appear as a blank line or
// an accidental gap.
func TestTheBannerHasNoLineBetweenTheWordmarkAndTheTagline(t *testing.T) {
	t.Setenv(EnvNoBanner, "")

	var buf strings.Builder
	New(&buf).Banner("installer")
	lines := strings.Split(strings.Trim(buf.String(), "\n"), "\n")

	want := len(WordmarkRows()) + 2 // the tagline and the subtitle
	if len(lines) != want {
		t.Errorf("the banner is %d lines, want %d:\n%s", len(lines), want, buf.String())
	}
	for i, l := range lines {
		if strings.TrimSpace(stripANSI(l)) == "" {
			t.Errorf("line %d of the banner is blank:\n%s", i, buf.String())
		}
	}
	if !strings.Contains(buf.String(), "co-op wave defense over your tailnet") {
		t.Error("the tagline is missing, so the wordmark is followed by nothing")
	}
}
