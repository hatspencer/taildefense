// Package slack is the little of Slack's Web API td needs to announce a hosted game in a
// channel and post its final scoreboard into that message's thread: post a message, upload a
// file, and check a bot token.
//
// It is the standard library and nothing else. Every call is one try: a host that cannot reach
// Slack says so and plays on, so retrying (429 included) would only hold the game up.
package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBase is Slack's Web API.
const DefaultBase = "https://slack.com/api"

// maxBody caps how much of an answer is read. Slack's answers to these calls are a few hundred
// bytes; anything near the cap is not an answer worth reading.
const maxBody = 1 << 20

// defaultTimeout bounds a call when the caller gives no client. A scoreboard upload is small.
const defaultTimeout = 30 * time.Second

// Client talks to Slack's Web API with a bot token (xoxb-…).
type Client struct {
	Token string
	HTTP  *http.Client // nil: a client with a sensible timeout
	Base  string       // "" is https://slack.com/api; tests point it at httptest
}

var defaultHTTP = &http.Client{Timeout: defaultTimeout}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return defaultHTTP
}

func (c *Client) base() string {
	if c.Base != "" {
		return strings.TrimRight(c.Base, "/")
	}
	return DefaultBase
}

// Post sends a message to a channel (an ID like C0123…, or a name), in the thread `thread` when
// that is not "". It returns the channel's ID as Slack reports it and the message's ts.
func (c *Client) Post(ctx context.Context, channel, thread, text string) (channelID, ts string, err error) {
	body := map[string]string{"channel": channel, "text": text}
	if thread != "" {
		body["thread_ts"] = thread
	}
	var out struct {
		Channel string `json:"channel"`
		TS      string `json:"ts"`
	}
	if err := c.callJSON(ctx, "chat.postMessage", body, &out); err != nil {
		return "", "", err
	}
	return out.Channel, out.TS, nil
}

// Upload shares a file into channelID (must be an ID), in the thread when thread != "", with
// `comment` as the message beside it when not "".
//
// It is Slack's three-step upload, the old files.upload being retired: ask for an upload URL,
// send the bytes there, then complete the upload into the channel.
func (c *Client) Upload(ctx context.Context, channelID, thread, filename, title, comment string, data []byte) error {
	form := url.Values{}
	form.Set("filename", filename)
	form.Set("length", strconv.Itoa(len(data)))
	var got struct {
		UploadURL string `json:"upload_url"`
		FileID    string `json:"file_id"`
	}
	if err := c.callForm(ctx, "files.getUploadURLExternal", form, &got); err != nil {
		return err
	}
	if got.UploadURL == "" || got.FileID == "" {
		return errors.New("slack files.getUploadURLExternal: no upload URL in the answer")
	}

	// The upload URL is already signed for this one file, so the token does not go with it:
	// it is a URL Slack handed back, and the token goes only to the API base.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, got.UploadURL, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("slack upload: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("slack upload: %w", scrub(err))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBody))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack upload: HTTP %d", resp.StatusCode)
	}

	if title == "" {
		title = filename
	}
	complete := map[string]any{
		"files":      []map[string]string{{"id": got.FileID, "title": title}},
		"channel_id": channelID,
	}
	if thread != "" {
		complete["thread_ts"] = thread
	}
	if comment != "" {
		complete["initial_comment"] = comment
	}
	return c.callJSON(ctx, "files.completeUploadExternal", complete, nil)
}

// Whoami checks the token: the workspace and the bot's user name (auth.test).
func (c *Client) Whoami(ctx context.Context) (team, user string, err error) {
	var out struct {
		Team string `json:"team"`
		User string `json:"user"`
	}
	if err := c.callForm(ctx, "auth.test", url.Values{}, &out); err != nil {
		return "", "", err
	}
	return out.Team, out.User, nil
}

func (c *Client) callJSON(ctx context.Context, method string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("slack %s: %w", method, err)
	}
	return c.call(ctx, method, "application/json; charset=utf-8", b, out)
}

func (c *Client) callForm(ctx context.Context, method string, form url.Values, out any) error {
	return c.call(ctx, method, "application/x-www-form-urlencoded", []byte(form.Encode()), out)
}

// call posts to one Web API method and decodes the answer into out (when not nil), turning
// Slack's ok:false into an error.
func (c *Client) call(ctx context.Context, method, contentType string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base()+"/"+method, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("slack %s: %w", method, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", contentType)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("slack %s: %w", method, scrub(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return fmt.Errorf("slack %s: reading the answer: %w", method, err)
	}
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusTooManyRequests {
			return fmt.Errorf("slack %s: rate limited (HTTP 429), retry after %ss", method, resp.Header.Get("Retry-After"))
		}
		return fmt.Errorf("slack %s: HTTP %d", method, resp.StatusCode)
	}
	var status struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Needed string `json:"needed"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return fmt.Errorf("slack %s: the answer is not JSON", method)
	}
	if !status.OK {
		return &APIError{Method: method, Code: status.Error, Needed: status.Needed}
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("slack %s: %w", method, err)
		}
	}
	return nil
}

// scrub keeps a transport error's cause but drops the request it carries. The token is a
// header, which a *url.Error does not print, but the URL could be anything a caller set as
// Base, and saying the cause is enough.
func scrub(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// APIError is Slack answering ok:false: the method, its error code, and for missing_scope the
// scope it wanted.
type APIError struct {
	Method string
	Code   string
	Needed string
}

func (e *APIError) Error() string {
	code := e.Code
	if code == "" {
		code = "unknown error"
	}
	msg := "slack " + e.Method + ": " + code
	if hint := e.hint(); hint != "" {
		msg += " (" + hint + ")"
	}
	return msg
}

// hint says what to do about the errors a person setting this up meets.
func (e *APIError) hint() string {
	switch e.Code {
	case "not_in_channel":
		return "invite the bot to the channel: /invite @<bot name>"
	case "channel_not_found":
		return "no such channel, or the bot cannot see it: a private channel needs the bot invited"
	case "invalid_auth", "token_revoked", "not_authed", "account_inactive", "token_expired":
		return "the bot token is wrong or no longer valid: copy the xoxb- token again"
	case "missing_scope":
		h := "the bot needs the chat:write and files:write scopes"
		if e.Needed != "" {
			h += "; this call needs " + e.Needed
		}
		return h + ", then reinstall the app"
	case "ratelimited":
		return "rate limited by Slack"
	}
	return ""
}
