package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLaunchLinksNeedTheTokenAndAKnownBrowser(t *testing.T) {
	var l launcher
	h := handler("secret", 1, nil, nil, nil, &l, "http://127.0.0.1:1/#secret")
	for path, want := range map[string]int{
		"/launch/chrome?token=wrong":    http.StatusForbidden,
		"/launch/chrome":                http.StatusForbidden,
		"/launch/netscape?token=secret": http.StatusNotFound,
		"/launch/..%2Fetc?token=secret": http.StatusNotFound,
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", path, rec.Code, want)
		}
	}
	if len(l.procs) != 0 {
		t.Error("a refused link started a browser")
	}
}

func TestBrowsersStartFullScreenInAProfileOfTheirOwn(t *testing.T) {
	t.Setenv("TAILDEFENSE_CONFIG_DIR", t.TempDir())
	const url = "http://127.0.0.1:1/#tok"
	chrome, _ := Browser{ID: "chrome", Path: "/bin/chrome", kind: "chromium"}.args(url)
	line := strings.Join(chrome, " ")
	for _, want := range []string{"--app=" + url, "--start-fullscreen", "--user-data-dir=", "browser/chrome"} {
		if !strings.Contains(line, want) {
			t.Errorf("chrome lacks %q: %s", want, line)
		}
	}
	ff, _ := Browser{ID: "firefox", Path: "/bin/firefox", kind: "firefox"}.args(url)
	if line := strings.Join(ff, " "); !strings.Contains(line, "-kiosk "+url) || !strings.Contains(line, "-profile") {
		t.Errorf("firefox: %s", line)
	}
	if !IsBrowserID("Chrome") || IsBrowserID("netscape") {
		t.Error("browser ids")
	}
}
