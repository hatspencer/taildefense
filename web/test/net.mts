// The page's socket (src/net.ts) against a stand-in WebSocket: td going away for a moment
// (1006) is retried, a stale link td refuses (open, then a 1008 close with nothing between)
// ends with td's reason, no retry, and without the cover lifting for the moment it was open.
// Run by `npm run check`.
import { WsTransport, type ConnState, type Handlers } from '../src/net.ts';

class FakeWS {
  static OPEN = 1;
  static made: FakeWS[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor() { FakeWS.made.push(this); }
  send(): void {}
  close(): void {}
}
const timers: (() => void)[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.WebSocket = FakeWS;
g.window = { setTimeout: (f: () => void) => timers.push(f) };
g.clearTimeout = () => {};

let bad = 0;
function want(what: string, ok: boolean): void {
  if (!ok) { bad++; console.error(`net: ${what}`); }
}

const seen: [ConnState, string | undefined][] = [];
const h: Handlers = {
  onWelcome() {}, onTerrain() {}, onFrame() {}, onText() {},
  onConn(state, detail) { seen.push([state, detail]); },
};

// td away for a moment: the handshake fails, which a browser reports as 1006, and is retried.
new WsTransport('ws://127.0.0.1:1/ws?token=t', h);
FakeWS.made[0].onclose!({ code: 1006, reason: '' });
want(`a 1006 schedules one retry, got ${timers.length}`, timers.length === 1);
timers.shift()!();
want(`the retry reconnects, got ${FakeWS.made.length} sockets`, FakeWS.made.length === 2);
want(`the retry says reconnecting, got ${JSON.stringify(seen)}`, seen.at(-1)?.[0] === 'reconnecting');

// The stale link: td completes the handshake, then closes with 1008.
const ws = FakeWS.made[1];
ws.onopen!();
want(`an open socket that has said nothing does not lift the cover: ${JSON.stringify(seen)}`, !seen.some(([s]) => s === 'open'));
ws.onclose!({ code: 1008, reason: 'refused by td: this link is from another game' });
const [state, detail] = seen.at(-1)!;
want(`a 1008 ends the page with td's reason, got ${state} ${detail}`, state === 'ended' && detail!.includes('refused'));
want(`a 1008 is not retried, ${timers.length} retries pending`, timers.length === 0);

// A live socket is open once td speaks.
seen.length = 0;
new WsTransport('ws://127.0.0.1:1/ws?token=t', h);
const live = FakeWS.made.at(-1)!;
live.onopen!();
live.onmessage!({ data: '{"t":"status","text":"hi"}' });
want(`td's first message opens the page, got ${JSON.stringify(seen)}`, seen.at(-1)?.[0] === 'open');

if (bad) process.exit(1);
console.log('net: a stale link ends on 1008, a lost td is retried');
