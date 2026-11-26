package tailnet

import (
	"context"
	"testing"
	"time"
)

// Only cap(whoisSlots) whois run at once; one more waits for a slot rather than failing, and
// gives up when its handshake's time is.
func TestWhoisSlots(t *testing.T) {
	var held []func()
	for range cap(whoisSlots) {
		release, err := whoisSlot(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	if _, err := whoisSlot(ctx); err == nil {
		t.Fatal("a whois past the slots ran")
	}
	cancel()
	got := make(chan error, 1)
	go func() {
		release, err := whoisSlot(context.Background())
		if err == nil {
			release()
		}
		got <- err
	}()
	time.Sleep(20 * time.Millisecond)
	held[0]()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("a waiting whois never got the slot let go")
	}
	for _, release := range held[1:] {
		release()
	}
}
