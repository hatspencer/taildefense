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
	h := handler("secret", 1, nil, nil, nil, &l, "http://127.0.0.1:1/#secret")
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
