package tailnet

import "testing"

// A device names itself, so what it says reaches td as one line of plain text.
func TestAPeersOwnWordsArePlainText(t *testing.T) {
	doc := `{"BackendState": "Running",
  "Self": {"HostName": "box\u001b]0;owned\u0007", "UserID": 1},
  "Peer": {"k1": {"HostName": "pal\u001b]52;c;aGk=\u0007\u001b[1A\nfake row", "OS": "linux\u001b[2J", "TailscaleIPs": ["100.64.0.9"], "Online": true}}}`
	self, peers, err := parseStatus([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if self.Host != "box" {
		t.Errorf("self %q", self.Host)
	}
	if len(peers) != 1 || peers[0].Host != "pal fake row" || peers[0].OS != "linux" {
		t.Errorf("peers %+v", peers)
	}
}
