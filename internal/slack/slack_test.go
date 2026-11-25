package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

const token = "xoxb-test-secret-token"

// fake is a Slack that records what it was sent, in order. Its upload URL is on the same
// server, so the test sees the bytes and whether the token went with them.
type fake struct {
	t      *testing.T
	srv    *httptest.Server
	calls  []string
	auth   []string
	json   map[string]map[string]any
	form   map[string]map[string]string
	upload []byte
	reply  map[string]string // method -> raw JSON answer, overriding the default
}

func newFake(t *testing.T) *fake {
	f := &fake{t: t, json: map[string]map[string]any{}, form: map[string]map[string]string{}, reply: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fake) client() *Client {
	return &Client{Token: token, Base: f.srv.URL + "/api"}
}

func (f *fake) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		f.t.Errorf("%s %s: want POST", r.Method, r.URL.Path)
	}
	body, _ := io.ReadAll(r.Body)
	if r.URL.Path == "/refused" {
		f.calls = append(f.calls, "upload")
		http.Error(w, "gone", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/upload/F123" {
		f.calls = append(f.calls, "upload")
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.upload = body
		return
	}
	method := strings.TrimPrefix(r.URL.Path, "/api/")
	f.calls = append(f.calls, method)
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			f.t.Errorf("%s: body is not JSON: %v", method, err)
		}
		f.json[method] = m
	} else {
		q, err := url.ParseQuery(string(body))
		if err != nil {
			f.t.Errorf("%s: body is not a form: %v", method, err)
		}
		vals := map[string]string{}
		for k, v := range q {
			vals[k] = v[0]
		}
		f.form[method] = vals
	}
	w.Header().Set("Content-Type", "application/json")
	if ans, ok := f.reply[method]; ok {
		io.WriteString(w, ans)
		return
	}
	switch method {
	case "chat.postMessage":
		io.WriteString(w, `{"ok":true,"channel":"C0123","ts":"1700000000.000100"}`)
	case "files.getUploadURLExternal":
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "upload_url": f.srv.URL + "/upload/F123", "file_id": "F123"})
	case "files.completeUploadExternal":
		io.WriteString(w, `{"ok":true,"files":[{"id":"F123"}]}`)
	case "auth.test":
		io.WriteString(w, `{"ok":true,"team":"Tail Team","user":"tdbot","team_id":"T1","user_id":"U1"}`)
	default:
		io.WriteString(w, `{"ok":false,"error":"unknown_method"}`)
	}
}

func TestPost(t *testing.T) {
	f := newFake(t)
	ch, ts, err := f.client().Post(context.Background(), "#games", "1699999999.000001", "a game is up")
	if err != nil {
		t.Fatal(err)
	}
	if ch != "C0123" || ts != "1700000000.000100" {
		t.Errorf("got channel %q ts %q", ch, ts)
	}
	if f.auth[0] != "Bearer "+token {
		t.Errorf("Authorization %q", f.auth[0])
	}
	got := f.json["chat.postMessage"]
	if got["channel"] != "#games" || got["text"] != "a game is up" || got["thread_ts"] != "1699999999.000001" {
		t.Errorf("body %v", got)
	}
}

func TestPostNoThread(t *testing.T) {
	f := newFake(t)
	if _, _, err := f.client().Post(context.Background(), "C0123", "", "hi"); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.json["chat.postMessage"]["thread_ts"]; ok {
		t.Errorf("thread_ts sent for a top-level message: %v", f.json["chat.postMessage"])
	}
}

func TestUpload(t *testing.T) {
	f := newFake(t)
	png := []byte("\x89PNG\r\n\x1a\nnot really a scoreboard")
	err := f.client().Upload(context.Background(), "C0123", "1700000000.000100", "scoreboard.png", "Final scores", "GG", png)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"files.getUploadURLExternal", "upload", "files.completeUploadExternal"}
	if strings.Join(f.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("calls %v, want %v", f.calls, want)
	}
	if got := f.form["files.getUploadURLExternal"]; got["filename"] != "scoreboard.png" || got["length"] != strconv.Itoa(len(png)) {
		t.Errorf("getUploadURLExternal form %v (len %d)", got, len(png))
	}
	if f.auth[0] != "Bearer "+token || f.auth[2] != "Bearer "+token {
		t.Errorf("API calls without the token: %q", f.auth)
	}
	if f.auth[1] != "" {
		t.Errorf("the token went to the upload URL: %q", f.auth[1])
	}
	if !bytes.Equal(f.upload, png) {
		t.Errorf("uploaded %q", f.upload)
	}
	c := f.json["files.completeUploadExternal"]
	if c["channel_id"] != "C0123" || c["thread_ts"] != "1700000000.000100" || c["initial_comment"] != "GG" {
		t.Errorf("completeUploadExternal %v", c)
	}
	files, _ := c["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("files %v", c["files"])
	}
	file := files[0].(map[string]any)
	if file["id"] != "F123" || file["title"] != "Final scores" {
		t.Errorf("file %v", file)
	}
}

func TestUploadFailingUpload(t *testing.T) {
	f := newFake(t)
	f.reply["files.getUploadURLExternal"] = `{"ok":true,"upload_url":"` + f.srv.URL + `/refused","file_id":"F9"}`
	err := f.client().Upload(context.Background(), "C0123", "", "a.png", "", "", []byte("x"))
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("err %v, want HTTP 403", err)
	}
	for _, c := range f.calls {
		if c == "files.completeUploadExternal" {
			t.Error("completed an upload whose bytes were refused")
		}
	}
}

func TestNotOK(t *testing.T) {
	f := newFake(t)
	f.reply["chat.postMessage"] = `{"ok":false,"error":"not_in_channel"}`
	_, _, err := f.client().Post(context.Background(), "C0123", "", "hi")
	if err == nil {
		t.Fatal("no error")
	}
	var api *APIError
	if !errors.As(err, &api) || api.Code != "not_in_channel" {
		t.Errorf("err %#v", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "chat.postMessage") || !strings.Contains(msg, "not_in_channel") || !strings.Contains(msg, "invite") {
		t.Errorf("message %q", msg)
	}
	if strings.Contains(msg, token) {
		t.Errorf("the token is in the error: %q", msg)
	}
}

func TestMissingScope(t *testing.T) {
	f := newFake(t)
	f.reply["files.getUploadURLExternal"] = `{"ok":false,"error":"missing_scope","needed":"files:write","provided":"chat:write"}`
	err := f.client().Upload(context.Background(), "C0123", "", "a.png", "", "", []byte("x"))
	if err == nil || !strings.Contains(err.Error(), "missing_scope") || !strings.Contains(err.Error(), "files:write") {
		t.Fatalf("err %v", err)
	}
	if strings.Contains(err.Error(), token) {
		t.Errorf("the token is in the error: %q", err)
	}
}

func TestHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := &Client{Token: token, Base: srv.URL}
	_, _, err := c.Whoami(context.Background())
	if err == nil || !strings.Contains(err.Error(), "429") || strings.Contains(err.Error(), token) {
		t.Fatalf("err %v", err)
	}
}

func TestWhoami(t *testing.T) {
	f := newFake(t)
	team, user, err := f.client().Whoami(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if team != "Tail Team" || user != "tdbot" {
		t.Errorf("team %q user %q", team, user)
	}
	if f.calls[0] != "auth.test" || f.auth[0] != "Bearer "+token {
		t.Errorf("calls %v auth %v", f.calls, f.auth)
	}
}
