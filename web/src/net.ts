import type { Command, TextMsg, Welcome } from './protocol';

// Receives everything the host sends. Binary frames arrive as raw buffers so the decoder can
// reuse its arrays; the demo host feeds the same handler with frames it encoded itself.
export interface Handlers {
  onWelcome(w: Welcome): void;
  onTerrain(tiles: Uint8Array): void;
  onFrame(buf: ArrayBuffer): void;
  onText(msg: TextMsg): void;
  onConn(state: ConnState, detail?: string): void;
}

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'ended';

export interface Transport {
  send(cmd: Command): void;
  close(): void;
}

// Dispatches one message from the host, text or binary.
// Returns true when the message was `end`, after which no reconnect should happen.
export function dispatch(h: Handlers, data: string | ArrayBuffer): boolean {
  if (typeof data === 'string') {
    let msg: TextMsg;
    try { msg = JSON.parse(data) as TextMsg; } catch { return false; }
    if (msg.t === 'welcome') h.onWelcome(msg);
    else h.onText(msg);
    if (msg.t === 'end') { h.onConn('ended', msg.reason); return true; }
    return false;
  }
  if (data.byteLength < 1) return false;
  const type = new Uint8Array(data, 0, 1)[0];
  if (type === 1) h.onFrame(data);
  else if (type === 2) h.onTerrain(new Uint8Array(data, 1));
  return false;
}

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private ended = false;
  private delay = 500;
  private timer = 0;

  constructor(private url: string, private h: Handlers) {
    this.connect(false);
  }

  private connect(again: boolean): void {
    this.h.onConn(again ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.delay = 500; this.h.onConn('open'); };
    ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => { if (dispatch(this.h, ev.data)) this.ended = true; };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ended) return;
      // 1008 is a policy refusal (bad token): retrying will not help.
      if (ev.code === 1008) { this.ended = true; this.h.onConn('ended', ev.reason || 'refused by td'); return; }
      this.timer = window.setTimeout(() => this.connect(true), this.delay);
      this.delay = Math.min(this.delay * 2, 8000);
    };
  }

  send(cmd: Command): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  close(): void {
    this.ended = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
