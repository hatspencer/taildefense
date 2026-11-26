package plain

import "testing"

func TestLineIsPlainText(t *testing.T) {
	for in, want := range map[string]string{
		"bob\x1b]52;c;ZWNobyBoaQ==\x07":            "bob",
		"wave\x1b[2J\x1b[1;1H 3":                   "wave 3",
		"one\nfake row\r\n  two":                   "one fake row two",
		"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\": "link",
		"a\x00b\x7fc\u0085d":                       "a b c d",
		"\x1bP+q\x1b\\ok":                          "ok",
		"\x1b_hidden\x1b\\ok":                      "ok",
	} {
		if got := Line(in); got != want {
			t.Errorf("Line(%q) = %q, want %q", in, got, want)
		}
	}
}
