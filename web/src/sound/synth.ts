import { RECIPES, render } from './bank';

// The worker's code, put in by the build (web/build.mjs).
declare const __SOUND_WORKER__: string;

// The sound engine: plays the bank's sounds through WebAudio. The whole bank is rendered once
// the context starts, in a worker so no frame waits on it, guns first; a sound asked for
// before it is ready is skipped. Every play is a buffer source through a distance filter, a gain and a pan, with a send into one shared reverb: open
// ground with buildings and trees round it, which is what makes a gunshot sound outdoors.

// More voices than this at once and the quieter new ones are dropped.
const MAX_VOICES = 56;
// Rendered first in the idle warm-up: what is heard in the first seconds of a fight.
const FIRST = ['pistol', 'smg', 'shotgun', 'rifle', 'minigun', 'turretGun', 'death0', 'strike', 'groan0', 'explosion', 'crowbar'];

export interface Placed {
  vol: number; // 0..1 before the master volume
  pan: number; // -1 left .. 1 right
  far: number; // 0 beside the listener .. 1 at the edge of hearing: darker and wetter
}

export interface Loop {
  set(p: Placed, rate?: number): void;
  stop(): void;
}

export class Synth {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: GainNode | null = null;
  private bufs = new Map<string, AudioBuffer>();
  private active = 0;
  private vol: number;
  private warmQueue: string[] = [];
  private worker: Worker | null = null;
  // Whether the player has clicked or pressed a key yet: before that a browser refuses to
  // start sound, and says so in the console.
  private gestured = false;

  // volume: 0..100, the VOLUME setting. 0 is off: no audio context is made at all.
  constructor(volume: number) { this.vol = volume; }

  get volume(): number { return this.vol; }

  setVolume(v: number): void {
    this.vol = Math.min(100, Math.max(0, Math.round(v)));
    if (this.vol > 0 && this.gestured) this.unlock();
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.ctx || !this.master) return;
    // Perceptual: squared, so the bottom of the slider is not all near silence.
    const g = (this.vol / 100) ** 2;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    if (this.vol === 0) void this.ctx.suspend(); else if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // Browsers only let a page make sound after the player has clicked or pressed a key, so the
  // context starts on the first one, and resumes on later ones should the browser suspend it.
  gesture(): void {
    this.gestured = true;
    this.unlock();
  }

  private unlock(): void {
    if (this.vol === 0) return;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = (this.vol / 100) ** 2;
      // A limiter, so a wave's worth of explosions gets louder without clipping.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 8;
      comp.attack.value = 0.002; comp.release.value = 0.25;
      master.connect(comp).connect(ctx.destination);
      const verb = ctx.createConvolver();
      verb.buffer = impulse(ctx);
      const send = ctx.createGain();
      send.gain.value = 0.55;
      send.connect(verb).connect(master);
      this.ctx = ctx; this.master = master; this.reverb = send;
      const names = [...FIRST, ...Object.keys(RECIPES).filter((k) => !FIRST.includes(k))];
      for (const n of names) for (let v = 0; v < RECIPES[n][0]; v++) this.warmQueue.push(n + '#' + v);
      this.worker = startWorker((name, v, d, rate) => this.store(name, v, d, rate), () => {
        // The worker would not run (a page's policy can forbid it): make the rest here.
        this.worker = null;
        this.warmQueue = names.flatMap((n) => Array.from({ length: RECIPES[n][0] }, (_, v) => n + '#' + v)).filter((k) => !this.bufs.has(k));
        this.warm();
      });
      if (this.worker) for (const key of this.warmQueue.splice(0)) {
        const [name, v] = key.split('#');
        this.worker.postMessage({ name, v: +v, sr: ctx.sampleRate });
      }
      else this.warm();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready(): boolean { return !!this.ctx && this.ctx.state === 'running' && this.vol > 0; }
  get now(): number { return this.ctx?.currentTime ?? 0; }

  // Without a worker, renders the bank one sound at a time while the page is idle.
  private warm(): void {
    const key = this.warmQueue.shift();
    if (!key) return;
    const go = () => {
      const [name, v] = key.split('#');
      if (!this.bufs.has(key)) { const { d, rate } = render(name, +v, this.ctx!.sampleRate); this.store(name, +v, d, rate); }
      this.warm();
    };
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(go, { timeout: 500 }); else setTimeout(go, 16);
  }

  private store(name: string, v: number, d: Float32Array, rate: number): void {
    const b = this.ctx!.createBuffer(1, d.length, rate);
    b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
    this.bufs.set(name + '#' + v, b);
  }

  // A variant that is ready, or any ready variant of the sound, or null while none is.
  private buffer(name: string, v: number): AudioBuffer | null {
    const rec = RECIPES[name];
    if (!rec) return null;
    for (let k = 0; k < rec[0]; k++) {
      const b = this.bufs.get(name + '#' + ((v + k) % rec[0]));
      if (b) return b;
    }
    return null;
  }

  // play starts one of name's variants at t (context time), placed p, at playback rate rate
  // (1 as rendered; a little either way keeps repeats from sounding alike).
  play(name: string, p: Placed, t = 0, rate = 1, urgent = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.reverb || !this.ready || p.vol < 0.003) return;
    if (this.active >= MAX_VOICES && !urgent) return;
    const rec = RECIPES[name];
    if (!rec) return;
    const buf = this.buffer(name, Math.floor(Math.random() * rec[0]));
    if (!buf) return;
    const at = Math.max(ctx.currentTime, t);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const out = this.chain(src, p);
    src.start(at);
    this.active++;
    src.onended = () => { this.active--; out.disconnect(); };
  }

  // chain is source -> distance low-pass -> gain -> pan -> master, plus a reverb send that
  // grows with distance: far things are heard mostly as what the surroundings send back.
  private chain(src: AudioNode, p: Placed): AudioNode {
    const ctx = this.ctx!;
    let node: AudioNode = src;
    const far = Math.min(1, Math.max(0, p.far));
    if (far > 0.05) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 18000 * Math.pow(1800 / 18000, far);
      lp.Q.value = 0.5;
      node.connect(lp);
      node = lp;
    }
    const g = ctx.createGain();
    g.gain.value = p.vol;
    node.connect(g);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, p.pan));
    g.connect(pan).connect(this.master!);
    const send = ctx.createGain();
    send.gain.value = 0.18 + 0.6 * far;
    g.connect(send).connect(this.reverb!);
    return pan;
  }

  // loop starts a looping sound, silent until set; the caller places it every frame and
  // stops it when what makes it is gone.
  loop(name: string): Loop | null {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.ready) return null;
    const buf = this.buffer(name, 0);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 18000; lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(lp).connect(g).connect(pan).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.2;
    g.connect(send).connect(this.reverb!);
    src.start(ctx.currentTime, Math.random() * buf.duration);
    let stopped = false;
    return {
      set: (p, rate = 1) => {
        if (stopped) return;
        const t = ctx.currentTime, far = Math.min(1, Math.max(0, p.far));
        g.gain.setTargetAtTime(p.vol, t, 0.08);
        pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p.pan)), t, 0.08);
        lp.frequency.setTargetAtTime(18000 * Math.pow(1800 / 18000, far), t, 0.08);
        send.gain.setTargetAtTime(0.18 + 0.6 * far, t, 0.08);
        src.playbackRate.setTargetAtTime(rate, t, 0.12);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        g.gain.setTargetAtTime(0, t, 0.12);
        src.stop(t + 0.8);
        src.onended = () => pan.disconnect();
      },
    };
  }
}

// startWorker starts the renderer, or returns null where a page can't have one, and the bank
// is made on the page's thread instead.
function startWorker(done: (name: string, v: number, d: Float32Array, rate: number) => void, failed: () => void): Worker | null {
  try {
    const url = URL.createObjectURL(new Blob([__SOUND_WORKER__], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (e: MessageEvent<{ name: string; v: number; d: Float32Array; rate: number }>) => done(e.data.name, e.data.v, e.data.d, e.data.rate);
    w.onerror = () => { w.terminate(); failed(); };
    return w;
  } catch {
    return null;
  }
}

// The reverb's impulse: two channels of decaying noise, darkening as it decays, with a few
// early reflections in front, the sound of a town's edge rather than of a hall.
function impulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate, len = Math.floor(sr * 1.8);
  const b = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const cut = 0.5 * Math.exp(-t / 0.5) + 0.04;
      lp += cut * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-t / 0.42) * (t < 0.012 ? t / 0.012 : 1);
    }
    for (const [at, g] of [[0.023, 0.5], [0.041, 0.35], [0.067, 0.3], [0.093, 0.2]]) {
      const o = Math.floor((at + c * 0.004) * sr);
      d[o] += g * (c ? -1 : 1);
    }
  }
  return b;
}
