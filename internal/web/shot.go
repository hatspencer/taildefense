package web

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"taildefense/internal/install"
)

// maxShot caps a scoreboard screenshot's upload; one at a laptop's resolution is well under.
const maxShot = 12 << 20

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// shotDir is where finished games' scoreboards are kept: screenshots in the install folder.
// A variable so tests write somewhere of their own.
var shotDir = func() (string, error) {
	p, err := install.Resolve()
	if err != nil {
		return "", err
	}
	return filepath.Join(p.Prefix, "screenshots"), nil
}

// saveShot takes the page's PNG of the final scoreboard and keeps it. Like the socket it wants
// the token and this server's origin, so no other page can fill the disk.
func saveShot(token string, origins map[string]bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(token)) != 1 {
			http.Error(w, "wrong token", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !origins[o] {
			http.Error(w, "foreign origin", http.StatusForbidden)
			return
		}
		img, err := io.ReadAll(io.LimitReader(r.Body, maxShot+1))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(img) > maxShot || !bytes.HasPrefix(img, pngMagic) {
			http.Error(w, "not a PNG, or too big", http.StatusBadRequest)
			return
		}
		dir, err := shotDir()
		if err == nil {
			err = os.MkdirAll(dir, 0o755)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		wave, _ := strconv.Atoi(r.URL.Query().Get("wave"))
		path := filepath.Join(dir, fmt.Sprintf("taildefense-%s-wave%d.png", time.Now().Format("20060102-150405"), max(wave, 0)))
		if err := os.WriteFile(path, img, 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"path": tildePath(path)})
	}
}

// tildePath shows a path under the home folder as ~/…, for the toast that says where it went.
func tildePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil {
		if rel, err := filepath.Rel(home, p); err == nil && rel != "." && !filepath.IsAbs(rel) && rel[0] != '.' {
			return filepath.Join("~", rel)
		}
	}
	return p
}
