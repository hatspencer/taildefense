package tailnet

import (
	"testing"
	"time"
)

// statusDoc is a trimmed `tailscale status --json` with one peer on each path.
const statusDoc = `{
  "Version": "1.88.1",
  "BackendState": "Running",
  "CurrentTailnet": {"Name": "example.com"},
  "Self": {"HostName": "box", "DNSName": "box.tail1234.ts.net.", "TailscaleIPs": ["100.64.0.7"], "UserID": 1, "Relay": "fra"},
  "User": {"1": {"LoginName": "ada@example.com", "DisplayName": "Ada"}},
  "Peer": {
    "k1": {"HostName": "pal", "TailscaleIPs": ["100.64.0.9"], "Online": true, "UserID": 1,
           "CurAddr": "203.0.113.5:41641", "Relay": "fra", "Active": true, "LastHandshake": "2026-10-30T17:00:00Z"},
    "k2": {"HostName": "attic", "TailscaleIPs": ["100.64.0.12"], "Online": true, "UserID": 1,
           "CurAddr": "", "Relay": "nyc", "Active": true},
    "k3": {"HostName": "cabin", "TailscaleIPs": ["100.64.0.13"], "Online": true, "UserID": 1,
           "CurAddr": "", "Relay": "fra", "PeerRelay": "198.51.100.2:7777:vni:3", "Active": true},
    "k4": {"HostName": "dorm", "TailscaleIPs": ["100.64.0.14"], "Online": true, "UserID": 1,
           "CurAddr": "", "Relay": "lhr", "Active": false}
  }
}`

func TestStatusPaths(t *testing.T) {
	self, peers, err := parseStatus([]byte(statusDoc))
	if err != nil {
		t.Fatal(err)
	}
	if self.Relay != "fra" || !self.Running {
		t.Errorf("self %+v", self)
	}
	want := map[string][2]string{
		"pal":   {PathDirect, "203.0.113.5:41641"},
		"attic": {PathDERP, "nyc"},
		"cabin": {PathPeerRelay, "198.51.100.2:7777:vni:3"},
		"dorm":  {PathIdle, ""},
	}
	for _, p := range peers {
		if got := [2]string{p.Path, p.Via}; got != want[p.Host] {
			t.Errorf("%s: %v, want %v", p.Host, got, want[p.Host])
		}
	}
	for ip, w := range map[string]string{"100.64.0.12": PathDERP, "100.64.0.7": PathLocal, "127.0.0.1": PathLocal} {
		if path, _, ok := PeerPath(self, peers, ip); !ok || path != w {
			t.Errorf("%s: %q %v, want %q", ip, path, ok, w)
		}
	}
	if _, _, ok := PeerPath(self, peers, "100.64.0.99"); ok {
		t.Error("an unknown address has no path")
	}
}

func TestPathLabel(t *testing.T) {
	for _, c := range [][3]string{{PathDirect, "1.2.3.4:41641", "direct"}, {PathDERP, "fra", "DERP fra"},
		{PathPeerRelay, "x", "relay"}, {PathLocal, "", "local"}, {PathIdle, "", ""}, {"", "", ""}} {
		if got := PathLabel(c[0], c[1]); got != c[2] {
			t.Errorf("%s %s: %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestParseNetcheck(t *testing.T) {
	doc := `{"UDP": true, "IPv4": true, "MappingVariesByDestIP": true, "UPnP": false, "PMP": null, "PCP": "",
	  "PreferredDERP": 4, "RegionLatency": {"4": 21000000, "1": 95000000}, "GlobalV4": "203.0.113.9:41641"}`
	r, err := parseNetcheck([]byte("\nReport:\n" + doc))
	if err != nil {
		t.Fatal(err)
	}
	if !r.UDP || r.MappingVariesByDestIP == nil || !*r.MappingVariesByDestIP {
		t.Errorf("udp/mapping %+v", r)
	}
	if r.UPnP == nil || *r.UPnP || r.PMP != nil || r.PCP != nil {
		t.Errorf("port mapping %v %v %v", r.UPnP, r.PMP, r.PCP)
	}
	if r.PreferredDERP != 4 || r.PreferredLatency() != 21*time.Millisecond || r.RegionLatency[1] != 95*time.Millisecond {
		t.Errorf("derp %+v", r)
	}
}
