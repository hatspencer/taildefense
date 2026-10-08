package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"taildefense/internal/ui"
)

// Serve runs a dedicated host with no player of its own until SIGINT or SIGTERM: a game that
// keeps going on an always-on machine while people come and go. Every event is one line, so
// the output reads the same in a terminal, a log file or journalctl.
func Serve(w io.Writer, o HostOptions) int {
	p := ui.New(w)
	if !ui.BannerSuppressed() {
		p.Step("td serve")
	}
	log := func(format string, a ...any) {
		p.Plain("  %s %s", ui.StyleDim.Render(time.Now().Format("15:04:05")), oneLine(fmt.Sprintf(format, a...)))
	}
	srv, plan, err := StartHost(context.Background(), o, log)
	for _, n := range plan.Notes {
		p.Warn("%s", n)
	}
	if err != nil {
		p.Fail("%v", err)
		return 1
	}
	defer srv.Close()

	rows := [][2]string{
		{"listening", strings.Join(srv.Addrs(), ", ")},
		{"host", plan.Config.Host},
		{"owner", plan.Config.Owner},
		{"seed", fmt.Sprint(plan.Config.Seed)},
		{"version", o.Version},
	}
	p.Fields(rows)
	if plan.Hint != "" {
		p.OK("friends join with: %s", ui.StyleBold.Render(plan.Hint))
	} else {
		p.Warn("only this machine can join: td join localhost")
	}
	p.Note("ctrl+c stops the game and disconnects everyone")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sig)
	s := <-sig
	p.Plain("")
	in := srv.Info()
	log("%s: stopping at wave %d with %s connected", s, in.Wave, plural(len(in.Players), "player"))
	return 0
}

// plural is "1 player", "3 players".
func plural(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
