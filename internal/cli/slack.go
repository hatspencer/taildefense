package cli

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"taildefense/internal/config"
	"taildefense/internal/game"
	"taildefense/internal/netplay"
	"taildefense/internal/slack"
)

// How long each Slack call may take, and how long a host that is stopping waits for the ones
// still to go, such as the scoreboard of a game the host left the moment it ended.
const (
	slackPostTimeout   = 10 * time.Second
	slackUploadTimeout = 30 * time.Second
	slackCloseWait     = 4 * time.Second
	slackDoctorTimeout = 6 * time.Second
)

// slackQueue caps the calls waiting their turn. A hosting makes an announcement and one reply
// a game, so a full queue means Slack has stopped answering and more would only wait as well.
const slackQueue = 16

// Slack announces a hosted game in a Slack channel and replies in that announcement's thread
// when a game ends: the scoreboard picture from the host's page, or a line of text from a
// td serve, which has no page.
//
// Nothing here may slow a game: every call is queued for one goroutine of its own, which makes
// them in order, each with a timeout, and a failure is said once through warn and otherwise
// forgotten. A nil *Slack is Slack off, and every method does nothing.
type Slack struct {
	client  *slack.Client
	channel string
	warn    func(string, ...any)

	mu     sync.Mutex
	queue  []func(context.Context)
	closed bool
	wake   chan struct{}
	done   chan struct{}
	ctx    context.Context
	cancel context.CancelFunc

	// The worker's own: the announcement's channel ID and ts, the thread every game of this
	// hosting replies in, and the failures already said.
	channelID, thread string
	said              map[string]bool
}

// NewSlack is the notifier for the prefs' Slack settings, nil when they do not turn it on.
// warn takes a failure, once; it is called from another goroutine.
func NewSlack(prefs *config.Prefs, warn func(string, ...any)) *Slack {
	token, channel, on := prefs.Slack()
	if !on {
		return nil
	}
	return newSlack(&slack.Client{Token: token}, channel, warn)
}

func newSlack(c *slack.Client, channel string, warn func(string, ...any)) *Slack {
	if warn == nil {
		warn = func(string, ...any) {}
	}
	n := &Slack{client: c, channel: channel, warn: warn, wake: make(chan struct{}, 1), done: make(chan struct{}), said: map[string]bool{}}
	// A channel given as an ID is known before Slack answers, so a picture can still go to
	// the channel when the announcement failed.
	if config.IsChannelID(channel) {
		n.channelID = channel
	}
	n.ctx, n.cancel = context.WithCancel(context.Background())
	go n.run()
	return n
}

// Announce posts the game in the channel, once a host is listening. A game nobody else can
// reach is not announced; that goes in the plan's notes for the person hosting instead.
func (n *Slack) Announce(plan *HostPlan) {
	if n == nil {
		return
	}
	if plan.Hint == "" {
		plan.Notes = append(plan.Notes, "not announced in Slack: nobody but this machine can reach the game")
		return
	}
	text := AnnounceText(*plan)
	n.do(func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(ctx, slackPostTimeout)
		defer cancel()
		ch, ts, err := n.client.Post(ctx, n.channel, "", text)
		if err != nil {
			n.fail("could not announce the game in Slack: %v", err)
			return
		}
		n.channelID, n.thread = ch, ts
	})
}

// Shot replies in the announcement's thread with the final scoreboard's picture. It copies
// png, so the caller may reuse it.
func (n *Slack) Shot(png []byte, wave int) {
	if n == nil {
		return
	}
	png = bytes.Clone(png)
	n.do(func(ctx context.Context) {
		// The queue runs in order, so the announcement has had its answer by now; when it
		// failed the picture goes to the channel as it is, if its ID is known.
		if n.channelID == "" {
			return
		}
		ctx, cancel := context.WithTimeout(ctx, slackUploadTimeout)
		defer cancel()
		name := fmt.Sprintf("taildefense-wave%d.png", wave)
		title := fmt.Sprintf("Field report · wave %d", wave)
		if err := n.client.Upload(ctx, n.channelID, n.thread, name, title, "", png); err != nil {
			n.fail("could not post the scoreboard to Slack: %v", err)
		}
	})
}

// Over replies in the announcement's thread with a line of text: the game over of a td serve.
// It returns at once, so the game's tick may call it.
func (n *Slack) Over(text string) {
	if n == nil {
		return
	}
	n.do(func(ctx context.Context) {
		if n.channelID == "" {
			return
		}
		ctx, cancel := context.WithTimeout(ctx, slackPostTimeout)
		defer cancel()
		if _, _, err := n.client.Post(ctx, n.channelID, n.thread, text); err != nil {
			n.fail("could not post the game's end to Slack: %v", err)
		}
	})
}

// Close lets the calls still queued finish for a few seconds at most, then gives up on them.
func (n *Slack) Close() { n.close(slackCloseWait) }

func (n *Slack) close(wait time.Duration) {
	if n == nil {
		return
	}
	n.mu.Lock()
	n.closed = true
	n.mu.Unlock()
	n.poke()
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-n.done:
	case <-t.C:
		n.cancel()
		<-n.done
		n.warn("Slack did not answer before td stopped: the last post was not sent")
	}
	n.cancel()
}

// do queues a call, or drops it when the queue is full or closed.
func (n *Slack) do(f func(context.Context)) {
	n.mu.Lock()
	switch {
	case n.closed:
	case len(n.queue) >= slackQueue:
		n.mu.Unlock()
		n.failOnce("Slack is not answering: posts are being dropped")
		return
	default:
		n.queue = append(n.queue, f)
	}
	n.mu.Unlock()
	n.poke()
}

func (n *Slack) poke() {
	select {
	case n.wake <- struct{}{}:
	default:
	}
}

// run makes the queued calls one after another until the notifier is closed and the queue
// empty, or closed and given up on.
func (n *Slack) run() {
	defer close(n.done)
	for {
		n.mu.Lock()
		if len(n.queue) == 0 {
			closed := n.closed
			n.mu.Unlock()
			if closed {
				return
			}
			<-n.wake
			continue
		}
		f := n.queue[0]
		n.queue = n.queue[1:]
		n.mu.Unlock()
		if n.ctx.Err() != nil {
			continue // given up on: what is left is dropped without a word each
		}
		f(n.ctx)
	}
}

// fail says a failure, unless it was said before or td is giving up on Slack anyway.
func (n *Slack) fail(format string, a ...any) {
	if n.ctx.Err() != nil {
		return
	}
	n.failOnce(fmt.Sprintf(format, a...))
}

func (n *Slack) failOnce(msg string) {
	n.mu.Lock()
	seen := n.said[msg]
	n.said[msg] = true
	n.mu.Unlock()
	if !seen {
		n.warn("%s", msg)
	}
}

// AnnounceText is the announcement of a hosted game, in Slack's mrkdwn: who hosts on which
// machine and the td they run, the command to join with, and what kind of game it is.
func AnnounceText(plan HostPlan) string {
	c := plan.Config
	who := c.LocalName
	if who == "" {
		who = "someone"
	}
	ver := c.Version
	if ver == "" {
		ver = "dev"
	}
	kind := []string{c.Difficulty.String(), config.FormatWaves(c.LastWave) + " waves"}
	if c.Mode != game.ModeStandard {
		kind = append(kind, c.Mode.String())
	}
	if c.FogOfWar {
		kind = append(kind, "fog of war")
	}
	if c.Bots > 0 {
		kind = append(kind, plural(c.Bots, "bot"))
	}
	// A joiner on another td is refused, so the version is said where the command is.
	return fmt.Sprintf("*%s* is hosting taildefense on *%s*\n"+
		"Join with `%s` · needs td %s\n"+
		"%s",
		slackEscape(who), slackEscape(c.Host),
		slackEscape(plan.Hint), slackEscape(ver),
		strings.Join(kind, " · "))
}

// GameOverText is the reply a td serve posts when a game ends, having no picture to post.
func GameOverText(e netplay.GameEnd) string {
	var how string
	switch {
	case e.Evac && e.Aboard == 0:
		how = fmt.Sprintf("Game over: all %d waves held, but the Huey left with nobody aboard", e.Wave)
	case e.Evac:
		how = fmt.Sprintf("The Huey is away with %d aboard: all %d waves held", e.Aboard, e.Wave)
	default:
		how = fmt.Sprintf("Game over: the generator fell after %s", plural(e.Wave, "wave"))
		if e.LastWave > 0 {
			how += fmt.Sprintf(" of %d", e.LastWave)
		}
	}
	line := how + " · " + plural(int(e.Kills), "kill")
	if len(e.Players) > 0 {
		names := make([]string, len(e.Players))
		for i, p := range e.Players {
			names[i] = slackEscape(p)
		}
		line += "\nPlaying: " + strings.Join(names, ", ")
		if e.Bots > 0 {
			line += fmt.Sprintf(" (%s among them)", plural(e.Bots, "bot"))
		}
	}
	return line
}

// slackEscape keeps a name from being read as mrkdwn's markup: Slack wants &, < and > escaped
// in a message's text, and nothing else.
func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
