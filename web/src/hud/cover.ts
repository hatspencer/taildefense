import type { ConnState } from '../net';
import { esc } from './dom';

// The connection cover: what the page says while it has no game, and what to do about it.
// The page talks to the td on this machine, which talks to the host, so "the host went away"
// arrives as the end of the game from td, while losing td itself is a reconnect that never
// lands.

// After this long reconnecting, the cover stops saying it is a blip and says what to check.
const STUCK = 8000;

interface Said { head: string; what: string; tone: 'bad' | 'info' }

// What the end of a game means to the player, from the reason td gives (internal/web/session.go).
export function endText(reason: string): Said {
  const r = reason.toLowerCase();
  if (r.includes('you left')) return { head: 'You left the game', what: 'td is back in the terminal: host a new game, join one, or quit there.', tone: 'info' };
  if (r.includes('another tab')) return { head: 'The game moved to another tab', what: 'It was opened again somewhere else. Close this tab and play in the other one.', tone: 'info' };
  if (r.includes('stopped in the terminal')) return { head: 'td was stopped', what: 'Start td again in the terminal to host or join a game.', tone: 'info' };
  if (r.includes('refused') || r.includes('token')) return { head: 'This link no longer opens a game', what: 'Open the game from td in the terminal; it prints a fresh link.', tone: 'bad' };
  if (r.includes('host')) return { head: 'Lost the host', what: 'The host quit, or the tailnet between you dropped. When they are hosting again, join from td in the terminal.', tone: 'bad' };
  return { head: 'The game is over for this tab', what: 'td is back in the terminal; close this tab or start another game from there.', tone: 'bad' };
}

export class Cover {
  private since = 0; // when reconnecting began, 0 while connected
  private timer = 0;
  private state: ConnState = 'connecting';
  private detail = '';

  private key = '';
  // What Reload the page does; the page disarms its leave prompt first.
  onReload: () => void = () => location.reload();

  constructor(private root: HTMLElement, private mark: () => string) {}

  set(state: ConnState, detail = ''): void {
    if (state === 'reconnecting' && this.state !== 'reconnecting') this.since = performance.now();
    if (state !== 'reconnecting') this.since = 0;
    this.state = state; this.detail = detail;
    clearInterval(this.timer);
    // Reconnecting counts its seconds, and turns into advice once it has been a while.
    if (state === 'reconnecting') this.timer = window.setInterval(() => this.render(), 1000);
    this.render();
  }

  private render(): void {
    const c = this.root;
    if (this.state === 'open') { c.classList.add('hidden'); this.key = ''; return; }
    c.classList.remove('hidden');
    const logo = `<img class="mark" src="${this.mark()}" alt="taildefense">`;
    let html: string;
    if (this.state === 'ended') {
      const s = endText(this.detail);
      html = `${logo}<div class="big ${s.tone}">${esc(s.head)}</div><div class="what">${esc(s.what)}</div>${this.detail && s.tone === 'bad' ? `<div class="muted small">td said: ${esc(this.detail)}</div>` : ''}`;
    } else if (this.state === 'connecting') {
      html = `${logo}<div class="spin"></div><div class="big">Connecting…</div><div class="muted">to the td running on this machine</div>`;
    } else {
      const secs = Math.floor((performance.now() - this.since) / 1000);
      const stuck = secs * 1000 >= STUCK;
      html = `${logo}<div class="spin"></div><div class="big${stuck ? ' bad' : ''}">${stuck ? 'td is not answering' : 'Connection lost · reconnecting…'}</div>`
        + (stuck
          ? `<div class="what">This page lost the td running on this machine. If its terminal was closed or td stopped, start it again; this page keeps trying and picks the game back up if it is still on.</div>`
          : `<div class="muted">the game carries on at the host; you are back in as soon as the link is</div>`)
        + `<div class="muted small">trying for <span class="secs"></span>s</div>`
        + (stuck ? `<div class="row"><button class="primary" data-act="reload">Reload the page</button></div>` : '');
    }
    // Rebuilt only when what it says changes, so the scanner bar keeps running.
    if (html !== this.key) {
      this.key = html;
      c.innerHTML = html;
      const rl = c.querySelector<HTMLButtonElement>('[data-act="reload"]');
      if (rl) rl.onclick = () => this.onReload();
    }
    const n = c.querySelector('.secs');
    if (n) n.textContent = String(Math.floor((performance.now() - this.since) / 1000));
  }
}
