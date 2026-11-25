package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"taildefense/internal/config"
	"taildefense/internal/game"
	"taildefense/internal/netplay"
	"taildefense/internal/slack"
	"taildefense/internal/tailnet"
	"taildefense/internal/ui"
)

// fakeSlack stands in for Slack's Web API: it answers the calls the notifier makes and keeps
// what each was sent. hold, when set, keeps chat.postMessage's answer back until it is closed.
type fakeSlack struct {
	*httptest.Server
	mu    sync.Mutex
	calls []fakeCall
	hold  chan struct{}
	fail  string // an error code every call answers with, "" for none
}

type fakeCall struct {
	Method string
	Body   map[string]any
	Bytes  int // an upload's length
}

func newFakeSlack(t *testing.T) *fakeSlack {
	f := &fakeSlack{}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeSlack) serve(w http.ResponseWriter, r *http.Request) {
	method := strings.TrimPrefix(r.URL.Path, "/")
	raw, _ := io.ReadAll(r.Body)
	call := fakeCall{Method: method, Body: map[string]any{}}
	switch {
	case method == "upload":
		call.Bytes = len(raw)
	case strings.HasPrefix(r.Header.Get("Content-Type"), "application/json"):
		_ = json.Unmarshal(raw, &call.Body)
	default:
		if form, err := url.ParseQuery(string(raw)); err == nil {
			for k := range form {
				call.Body[k] = form.Get(k)
			}
		}
	}
	if method == "chat.postMessage" && f.hold != nil {
		<-f.hold
	}
	f.mu.Lock()
	f.calls = append(f.calls, call)
	fail := f.fail
	f.mu.Unlock()
	if method == "upload" {
		return
	}
	if fail != "" {
		fmt.Fprintf(w, `{"ok":false,"error":%q}`, fail)
		return
	}
	switch method {
	case "chat.postMessage":
		fmt.Fprint(w, `{"ok":true,"channel":"C0TESTCHAN","ts":"1700000000.000100"}`)
	case "files.getUploadURLExternal":
		fmt.Fprintf(w, `{"ok":true,"upload_url":%q,"file_id":"F0FILE"}`, f.URL+"/upload")
	default:
		fmt.Fprint(w, `{"ok":true}`)
	}
}

func (f *fakeSlack) got() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
}

// warnings collects what a notifier warns of.
type warnings struct {
	mu   sync.Mutex
	said []string
}

func (w *warnings) warn(format string, a ...any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.said = append(w.said, fmt.Sprintf(format, a...))
}

func (w *warnings) all() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.said...)
}

func examplePlan() HostPlan {
	return HostPlan{
		Hint: "td join box:7790",
		Config: netplay.ServerConfig{
			Host: "Box-Laptop", LocalName: "Ada <&>", Difficulty: game.DiffHard, LastWave: 30,
			Mode: game.ModeBlades, FogOfWar: true, Version: "v1.4.2", Bots: 2,
		},
	}
}

func TestTheAnnouncementSaysTheVersionAndHowToJoin(t *testing.T) {
	got := AnnounceText(examplePlan())
	want := "*Ada &lt;&amp;&gt;* is hosting taildefense on *Box-Laptop*\n" +
		"Join with `td join box:7790` · needs td v1.4.2\n" +
		"Hard · 30 waves · blades · fog of war · 2 bots"
	if got != want {
		t.Errorf("announcement:\n%s\nwant:\n%s", got, want)
	}
	if !strings.Contains(got, "td v1.4.2") || !strings.Contains(got, "`td join box:7790`") {
		t.Errorf("the version and the join command must always be there:\n%s", got)
	}

	plain := examplePlan()
	plain.Config.Mode, plain.Config.FogOfWar, plain.Config.Bots, plain.Config.LastWave = game.ModeStandard, false, 0, 0
	plain.Config.Difficulty = game.DiffNormal
	if got := AnnounceText(plain); !strings.HasSuffix(got, "\nNormal · endless waves") {
		t.Errorf("a standard game says no more than it must:\n%s", got)
	}
}

func TestAShotRepliesInTheAnnouncementsThread(t *testing.T) {
	f := newFakeSlack(t)
	var w warnings
	n := newSlack(&slack.Client{Token: "xoxb-test", Base: f.URL}, "#games", w.warn)
	plan := examplePlan()
	n.Announce(&plan)
	png := []byte("\x89PNG fake picture")
	n.Shot(png, 12)
	png[0] = 'X' // the caller's buffer is its own to reuse
	n.Shot([]byte("\x89PNG another game"), 3)
	n.close(5 * time.Second)

	calls := f.got()
	var methods []string
	for _, c := range calls {
		methods = append(methods, c.Method)
	}
	want := "chat.postMessage files.getUploadURLExternal upload files.completeUploadExternal files.getUploadURLExternal upload files.completeUploadExternal"
	if strings.Join(methods, " ") != want {
		t.Fatalf("calls %v", methods)
	}
	if c := calls[0].Body; c["channel"] != "#games" || c["thread_ts"] != nil || !strings.Contains(c["text"].(string), "td v1.4.2") {
		t.Errorf("announcement sent %v", c)
	}
	if c := calls[1].Body; c["filename"] != "taildefense-wave12.png" {
		t.Errorf("upload asked for %v", c)
	}
	if calls[2].Bytes != len(png) {
		t.Errorf("uploaded %d bytes, want %d", calls[2].Bytes, len(png))
	}
	for _, i := range []int{3, 6} {
		c := calls[i].Body
		if c["channel_id"] != "C0TESTCHAN" || c["thread_ts"] != "1700000000.000100" {
			t.Errorf("call %d not in the thread: %v", i, c)
		}
	}
	if files := calls[3].Body["files"].([]any); files[0].(map[string]any)["title"] != "Field report · wave 12" {
		t.Errorf("title %v", files)
	}
	if s := w.all(); len(s) != 0 {
		t.Errorf("warned %v", s)
	}
}

func TestAShotBeforeTheAnnouncementsAnswerStillThreads(t *testing.T) {
	f := newFakeSlack(t)
	f.hold = make(chan struct{})
	n := newSlack(&slack.Client{Token: "xoxb-test", Base: f.URL}, "#games", nil)
	plan := examplePlan()
	n.Announce(&plan)
	n.Shot([]byte("\x89PNG"), 4) // queued while Slack has not answered the announcement
	time.Sleep(20 * time.Millisecond)
	close(f.hold)
	n.close(5 * time.Second)
	calls := f.got()
	if len(calls) != 4 {
		t.Fatalf("calls %+v", calls)
	}
	if c := calls[3].Body; c["channel_id"] != "C0TESTCHAN" || c["thread_ts"] != "1700000000.000100" {
		t.Errorf("the shot did not wait for the thread: %v", c)
	}
}

func TestAGameOverRepliesInText(t *testing.T) {
	f := newFakeSlack(t)
	n := newSlack(&slack.Client{Token: "xoxb-test", Base: f.URL}, "C0TESTCHAN", nil)
	plan := examplePlan()
	n.Announce(&plan)
	n.Over(GameOverText(netplay.GameEnd{Wave: 7, LastWave: 40, Kills: 812, Players: []string{"ada", "bot"}, Bots: 1}))
	n.close(5 * time.Second)
	calls := f.got()
	if len(calls) != 2 {
		t.Fatalf("calls %+v", calls)
	}
	c := calls[1].Body
	if c["channel"] != "C0TESTCHAN" || c["thread_ts"] != "1700000000.000100" {
		t.Errorf("not in the thread: %v", c)
	}
	if text := c["text"].(string); text != "Game over: the generator fell after 7 waves of 40 · 812 kills\nPlaying: ada, bot (1 bot among them)" {
		t.Errorf("text %q", text)
	}
	if got := GameOverText(netplay.GameEnd{Wave: 40, LastWave: 40, Evac: true, Aboard: 2, Kills: 1}); !strings.HasPrefix(got, "The Huey is away with 2 aboard: all 40 waves held · 1 kill") {
		t.Errorf("evac %q", got)
	}
}

func TestNoHintMeansNoPost(t *testing.T) {
	f := newFakeSlack(t)
	n := newSlack(&slack.Client{Token: "xoxb-test", Base: f.URL}, "#games", nil)
	plan := examplePlan()
	plan.Hint = ""
	n.Announce(&plan)
	n.Shot([]byte("\x89PNG"), 2) // no thread and no channel ID: nowhere to go
	n.close(5 * time.Second)
	if calls := f.got(); len(calls) != 0 {
		t.Errorf("a game only this machine can reach was posted: %+v", calls)
	}
	if len(plan.Notes) != 1 || !strings.Contains(plan.Notes[0], "not announced in Slack") {
		t.Errorf("notes %v", plan.Notes)
	}
	var nilSlack *Slack // Slack off: every call does nothing
	nilSlack.Announce(&plan)
	nilSlack.Shot(nil, 1)
	nilSlack.Over("")
	nilSlack.Close()
}

func TestAFailingSlackDoesNotFailHosting(t *testing.T) {
	t.Setenv(EnvListen, "127.0.0.1:0")
	tailnetStatus = noTailscale
	t.Cleanup(func() { tailnetStatus = tailnet.Status })
	f := newFakeSlack(t)
	f.fail = "not_in_channel"
	var w warnings
	n := newSlack(&slack.Client{Token: "xoxb-test", Base: f.URL}, "C0TESTCHAN", w.warn)
	srv, plan, err := StartHost(context.Background(), HostOptions{Seed: 1, Version: "v1", Slack: n}, nil)
	if err != nil {
		t.Fatalf("hosting failed with Slack failing: %v", err)
	}
	if plan.Hint == "" {
		t.Fatal("the listen override should give a join command")
	}
	n.Shot([]byte("\x89PNG"), 1)
	n.Shot([]byte("\x89PNG"), 2)
	srv.Close()
	n.close(5 * time.Second)
	said := w.all()
	// The announcement failed once; the channel being an ID, each shot was tried in the
	// channel and failed the same way, which is said once.
	if len(said) != 2 || !strings.Contains(said[0], "not_in_channel") || !strings.Contains(said[0], "/invite") {
		t.Errorf("warned %q", said)
	}
	if strings.Contains(strings.Join(said, " "), "xoxb-test") {
		t.Error("a warning carries the token")
	}
}

func TestClosingGivesUpOnASlackThatHangs(t *testing.T) {
	f := newFakeSlack(t)
	f.hold = make(chan struct{})
	defer close(f.hold)
	var w warnings
	n := newSlack(&slack.Client{Token: "xoxb-test", Base: f.URL}, "#games", w.warn)
	plan := examplePlan()
	n.Announce(&plan)
	n.Shot([]byte("\x89PNG"), 1)
	start := time.Now()
	n.close(100 * time.Millisecond)
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("closing took %v", d)
	}
	if s := w.all(); len(s) != 1 || !strings.Contains(s[0], "did not answer") {
		t.Errorf("warned %q", s)
	}
}

func TestDoctorAsksSlackWhoTheTokenIs(t *testing.T) {
	f := newFakeSlack(t)
	t.Setenv(config.EnvConfigDir, t.TempDir())
	config.TailnetName = func() string { return "" }
	newSlackClient = func(token string) *slack.Client { return &slack.Client{Token: token, Base: f.URL} }
	t.Cleanup(func() { newSlackClient = func(token string) *slack.Client { return &slack.Client{Token: token} } })
	// The fake answers auth.test with ok and nothing else; the names are blank but the row is
	// the passing one.
	for _, c := range []struct {
		token, channel, want string
	}{
		{"", "", ""},
		{"", "C0TESTCHAN", "no token"},
		{"xoxb-1-2-3", "", "no channel"},
		{"xoxb-1-2-3", "C0TESTCHAN", "announcing in C0TESTCHAN"},
	} {
		t.Setenv("TAILDEFENSE_SLACK_TOKEN", c.token)
		t.Setenv("TAILDEFENSE_SLACK_CHANNEL", c.channel)
		var b bytes.Buffer
		p := ui.New(&b)
		checkSlack(p, config.Load())
		out := b.String()
		if c.want == "" && out != "" || !strings.Contains(out, c.want) {
			t.Errorf("token %q channel %q:\n%s", c.token, c.channel, out)
		}
		if p.Failures() != 0 {
			t.Errorf("Slack must never fail the doctor:\n%s", out)
		}
	}
	f.fail = "invalid_auth"
	t.Setenv("TAILDEFENSE_SLACK_TOKEN", "xoxb-1-2-3")
	t.Setenv("TAILDEFENSE_SLACK_CHANNEL", "C0TESTCHAN")
	var b bytes.Buffer
	p := ui.New(&b)
	checkSlack(p, config.Load())
	if out := b.String(); !strings.Contains(out, "invalid_auth") || p.Failures() != 0 {
		t.Errorf("a bad token:\n%s", out)
	}
}
