package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheFinalScoreboardIsKept(t *testing.T) {
	dir := t.TempDir()
	was := shotDir
	shotDir = func() (string, error) { return filepath.Join(dir, "screenshots"), nil }
	defer func() { shotDir = was }()
	var l launcher
	h := handler("secret", 1, nil, nil, nil, &l, "http://127.0.0.1:1/#secret", nil)
	png := string(pngMagic) + "rest of the image"

	post := func(query, origin, body string) int {
		r := httptest.NewRequest(http.MethodPost, "/shot?"+query, strings.NewReader(body))
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := post("token=wrong&wave=3", "", png); c != http.StatusForbidden {
		t.Errorf("a wrong token got %d", c)
	}
	if c := post("token=secret&wave=3", "http://evil.example", png); c != http.StatusForbidden {
		t.Errorf("a foreign origin got %d", c)
	}
	if c := post("token=secret&wave=3", "", "not a png"); c != http.StatusBadRequest {
		t.Errorf("something other than a PNG got %d", c)
	}
	if c := post("token=secret&wave=3", "http://127.0.0.1:1", png); c != http.StatusOK {
		t.Fatalf("the scoreboard got %d", c)
	}
	got, _ := filepath.Glob(filepath.Join(dir, "screenshots", "taildefense-*-wave3.png"))
	if len(got) != 1 {
		t.Fatalf("kept %v", got)
	}
	if b, _ := os.ReadFile(got[0]); string(b) != png {
		t.Error("the image was not kept as sent")
	}
}

func TestAKeptScoreboardGoesToTheHookOnlyWhenSet(t *testing.T) {
	dir := t.TempDir()
	was := shotDir
	shotDir = func() (string, error) { return filepath.Join(dir, "screenshots"), nil }
	defer func() { shotDir = was }()
	png := string(pngMagic) + "rest of the image"
	post := func(keep func([]byte, int), query, body string) int {
		var l launcher
		h := handler("secret", 1, nil, nil, nil, &l, "http://127.0.0.1:1/#secret", keep)
		r := httptest.NewRequest(http.MethodPost, "/shot?"+query, strings.NewReader(body))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := post(nil, "token=secret&wave=4", png); c != http.StatusOK {
		t.Fatalf("with no hook the scoreboard got %d", c)
	}
	var got []string
	var waves []int
	keep := func(b []byte, wave int) { got, waves = append(got, string(b)), append(waves, wave) }
	if c := post(keep, "token=wrong&wave=5", png); c != http.StatusForbidden {
		t.Errorf("a wrong token got %d", c)
	}
	if c := post(keep, "token=secret&wave=5", "not a png"); c != http.StatusBadRequest {
		t.Errorf("something other than a PNG got %d", c)
	}
	if len(got) != 0 {
		t.Fatalf("a refused upload reached the hook: %q", got)
	}
	if c := post(keep, "token=secret&wave=5", png); c != http.StatusOK {
		t.Fatalf("the scoreboard got %d", c)
	}
	if len(got) != 1 || got[0] != png || waves[0] != 5 {
		t.Errorf("the hook got %q at waves %v", got, waves)
	}
}
