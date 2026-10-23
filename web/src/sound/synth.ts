import { LOOPS, RECIPES, render } from './bank';

// The worker's code, put in by the build (web/build.mjs).
declare const __SOUND_WORKER__: string;

// The sound engine: plays the bank's sounds through WebAudio. The whole bank is rendered once
// the context starts, in a worker so no frame waits on it, guns first; a sound asked for
// before it is ready is skipped. Every play is a buffer source through a distance filter, a
// gain and a pan, with a send into one shared reverb: open ground with buildings and trees
// round it, which is what makes a gunshot sound outdoors.
//
// Three buses meet before the limiter. The world (everything placed on the map, and the
// reverb) can be muffled by the weather and while paused, and dips under a cue. Cues (the
// siren, the klaxon, the radio, what happens to you) are never muffled. The ambience (rain,
// wind, the night, the generator) sits under both and steps back as a fight fills the mix.
// The volume setting comes after the limiter, so the mix is the same at every volume.

// More voices than this at once and a new one takes the place of the least of those playing,
// or is dropped if it is the least. More than SAME of one sound and the oldest of them gives
// way: a wall of the same shot or groan is what tires the ear, and the newest say it best.
const MAX_VOICES = 40;
const SAME = 6;
// Guns that fire in a stream need more of their own to stay a stream.
const SAME_OF: Record<string, number> = { minigun: 16, smg: 12, turretGun: 12, doorGun: 10, pistol: 8, rifle: 8 };

// How much a sound matters when voices run short. A sound outranks one with a lower
// priority whatever their loudness; among equals, the louder one stays.
export const enum Prio { Step = 0, Texture = 1, Normal = 2, Heavy = 3, Own = 4, Cue = 5 }
const PRIO_OF: Record<string, Prio> = {
  step: Prio.Step, creepStep: Prio.Step, bigStep: Prio.Texture,
  strike: Prio.Texture, boneLand: Prio.Texture, sizzle: Prio.Texture, windup: Prio.Heavy,
  explosionS: Prio.Heavy, explosion: Prio.Heavy, explosionL: Prio.Heavy, concussion: Prio.Heavy, slam: Prio.Heavy,
  cannon: Prio.Heavy, sniper: Prio.Heavy, rocket: Prio.Heavy, strikeBig: Prio.Heavy, crumble: Prio.Heavy,
  thunder: Prio.Heavy, bell: Prio.Heavy, jets: Prio.Heavy, ambush: Prio.Heavy, alert: Prio.Heavy, bile: Prio.Heavy,
  death3: Prio.Heavy, death5: Prio.Heavy, death7: Prio.Heavy,
  sirenWave: Prio.Cue, sirenBoss: Prio.Cue, sirenClear: Prio.Cue, sirenOver: Prio.Cue, klaxon: Prio.Cue, beep: Prio.Cue, beepGo: Prio.Cue,
  tinnitus: Prio.Cue, kill: Prio.Cue, ultReady: Prio.Cue, heart: Prio.Cue,
};
function prioOf(name: string): Prio {
  return PRIO_OF[name] ?? (name.startsWith('groan') ? Prio.Texture : name.startsWith('radio_') ? Prio.Cue : Prio.Normal);
}

// Every play is pitched and set a little apart, up to this either way, so no sound repeats
// exactly: the ear stops hearing a sound that varies and keeps hearing one that doesn't. A
// voice varies less, or it stops being the same person; a cue not at all, since its pitch is
// what it says.
const JITTER = 0.15, VOICE_JITTER = 0.05;
const VOICES = /^(shout|hurt|down|revived)_/;
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

export type Bus = 'world' | 'cue' | 'amb';

interface Voice { name: string; src: AudioBufferSourceNode; g: GainNode; prio: Prio; vol: number; start: number; end: number }

export class Synth {
  ctx: AudioContext | null = null;
  private bus: Record<Bus, GainNode> | null = null;
  private muffle: BiquadFilterNode | null = null;
  private duck: GainNode | null = null;
  private out: GainNode | null = null;
  private reverb: GainNode | null = null;
  private bufs = new Map<string, AudioBuffer>();
  private voices: Voice[] = [];
  // How many sounds are playing: the least of them (footsteps) wait for a quieter moment.
  get busy(): number { return this.voices.length / MAX_VOICES; }
  private playing = new Map<string, number>();
  // For the F3 readout: the most voices at once, the sounds dropped and taken over since it
  // last looked, and the output's loudest sample, to see the limiter at work.
  private most = 0; private dropped = 0; private stolen = 0;
  private meter: AnalyserNode | null = null; private comp: DynamicsCompressorNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  // Every play, drop and steal since the page started, by sound: the demo hands these to a test.
  readonly plays = new Map<string, number>(); readonly drops = new Map<string, number>(); readonly steals = new Map<string, number>();
  private duckUntil = 0;
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
    if (!this.ctx || !this.out) return;
    // Perceptual: squared, so the bottom of the slider is not all near silence.
    const g = (this.vol / 100) ** 2;
    this.out.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
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
      // Into the compressor a little under unity, so it holds the peaks of a big fight
      // together without pulling down everything under them.
      const mix = ctx.createGain();
      mix.gain.value = 0.55;
      // A gentle compressor holding a wave's worth of explosions together, then a clipper
      // that is clean until the last 2 dB and rounds off whatever gets past it.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.2;
      const clip = ctx.createWaveShaper();
      clip.curve = softClip(); clip.oversample = '2x';
      const out = ctx.createGain();
      out.gain.value = (this.vol / 100) ** 2;
      // Back up to the level the mix was made at, the compressor's own make-up gain included.
      const trim = ctx.createGain();
      trim.gain.value = 1.1;
      mix.connect(comp).connect(trim).connect(clip).connect(out).connect(ctx.destination);
      const meter = ctx.createAnalyser();
      meter.fftSize = 2048;
      out.connect(meter);
      const world = ctx.createGain(), muffle = ctx.createBiquadFilter(), duck = ctx.createGain();
      muffle.type = 'lowpass'; muffle.frequency.value = 20000; muffle.Q.value = 0.5;
      world.connect(muffle).connect(duck).connect(mix);
      const cue = ctx.createGain();
      cue.connect(mix);
      const amb = ctx.createGain();
      amb.connect(muffle);
      const verb = ctx.createConvolver();
      verb.buffer = impulse(ctx);
      const send = ctx.createGain();
      send.gain.value = 0.55;
      send.connect(verb).connect(world);
      this.ctx = ctx; this.bus = { world, cue, amb }; this.muffle = muffle; this.duck = duck; this.out = out; this.reverb = send;
      this.meter = meter; this.comp = comp; this.meterBuf = new Float32Array(meter.fftSize);
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
  // (1 as rendered), both jittered. prio is how much it matters when voices run short, by
  // default its sound's; a cue goes to the cue bus, everything else is in the world.
  play(name: string, p: Placed, t = 0, rate = 1, prio = prioOf(name)): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus || !this.reverb || !this.ready || p.vol < 0.003) return;
    const rec = RECIPES[name];
    if (!rec) return;
    const buf = this.buffer(name, Math.floor(Math.random() * rec[0]));
    if (!buf) return;
    const now = ctx.currentTime;
    if ((this.playing.get(name) ?? 0) >= (SAME_OF[name] ?? SAME) && !this.giveWay(name, now)) return this.drop(name);
    if (this.voices.length >= MAX_VOICES && !this.makeRoom(prio, p.vol, now)) return this.drop(name);
    const cue = prio === Prio.Cue;
    const j = cue ? 0 : VOICES.test(name) ? VOICE_JITTER : JITTER;
    const at = Math.max(now, t);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const r = rate * jitter(j);
    src.playbackRate.value = r;
    const vol = p.vol * jitter(j);
    const { g, out } = this.chain(src, { ...p, vol }, cue ? 'cue' : 'world', cue ? 0.06 : -1);
    src.start(at);
    const v: Voice = { name, src, g, prio, vol, start: at, end: at + buf.duration / r };
    this.voices.push(v);
    this.most = Math.max(this.most, this.voices.length);
    this.plays.set(name, (this.plays.get(name) ?? 0) + 1);
    this.playing.set(name, (this.playing.get(name) ?? 0) + 1);
    src.onended = () => { this.release(v); out.disconnect(); };
  }

  private drop(name: string): void {
    this.dropped++;
    this.drops.set(name, (this.drops.get(name) ?? 0) + 1);
  }

  private release(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i < 0) return;
    this.voices.splice(i, 1);
    this.playing.set(v.name, this.playing.get(v.name)! - 1);
  }

  // A voice taken over fades out in a few milliseconds rather than clicking off.
  private steal(v: Voice, now: number): void {
    this.release(v);
    this.stolen++;
    this.steals.set(v.name, (this.steals.get(v.name) ?? 0) + 1);
    v.g.gain.setTargetAtTime(0, now, 0.008);
    try { v.src.stop(now + 0.05); } catch { /* already stopped */ }
  }

  // giveWay ends the oldest of name's voices playing, once it is past its first third (the
  // part heard; the rest is tail), so a stream of fire stays current. False if none is.
  private giveWay(name: string, now: number): boolean {
    let old: Voice | null = null;
    for (const v of this.voices) if (v.name === name && (!old || v.start < old.start)) old = v;
    if (!old || now < old.start + (old.end - old.start) / 3) return false;
    this.steal(old, now);
    return true;
  }

  // makeRoom ends the least of the voices playing if it matters less than a new one of prio
  // at vol: a lower priority, or as much and quieter by now (a voice fades as it plays).
  private makeRoom(prio: Prio, vol: number, now: number): boolean {
    let least: Voice | null = null, lv = Infinity;
    for (const v of this.voices) {
      const left = Math.max(0.05, 1 - (now - v.start) / Math.max(0.05, v.end - v.start));
      const score = v.prio * 10 + v.vol * left;
      if (score < lv) { lv = score; least = v; }
    }
    if (!least || lv >= prio * 10 + vol) return false;
    this.steal(least, now);
    return true;
  }

  // chain is source -> distance low-pass -> gain -> pan -> bus, plus a reverb send that grows
  // with distance: far things are heard mostly as what the surroundings send back. wet, when
  // not -1, is the send whatever the distance.
  private chain(src: AudioNode, p: Placed, bus: Bus, wet = -1): { g: GainNode; out: AudioNode } {
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
    g.connect(pan).connect(this.bus![bus]);
    const send = ctx.createGain();
    send.gain.value = wet >= 0 ? wet : 0.18 + 0.6 * far;
    g.connect(send).connect(this.reverb!);
    return { g, out: pan };
  }

  // duckWorld lowers the world by db for hold seconds, under a cue that has to be heard.
  duckWorld(db: number, hold: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.duck) return;
    const now = ctx.currentTime, until = Math.max(this.duckUntil, now + hold), g = this.duck.gain;
    const to = Math.min(g.value, Math.pow(10, -db / 20));
    g.cancelScheduledValues(now);
    g.setTargetAtTime(to, now, 0.02);
    g.setTargetAtTime(1, until, 0.25);
    this.duckUntil = until;
  }

  // mood sets what the world and the ambience sound like now: cutoff the world's muffling in
  // Hz (20000 for none), amb the ambience's level 0..1. Both glide.
  mood(cutoff: number, amb: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.muffle || !this.bus) return;
    const t = ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(cutoff, t, 0.25);
    this.bus.amb.gain.setTargetAtTime(amb, t, 0.6);
  }

  // readout is the F3 line: voices playing, the most at once, the sounds dropped and taken
  // over since the last call, the output's peak just now in dBFS and how far the compressor
  // is pulling it down.
  readout(): string {
    if (!this.ctx || !this.meter || !this.meterBuf) return 'off';
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let pk = 0;
    for (const x of this.meterBuf) pk = Math.max(pk, Math.abs(x));
    const s = `${this.voices.length}/${this.most} v  ${this.dropped} drop  ${this.stolen} steal  ${(20 * Math.log10(pk + 1e-9)).toFixed(0)} dB  lim ${this.comp!.reduction.toFixed(0)}`;
    this.most = this.voices.length; this.dropped = 0; this.stolen = 0;
    return s;
  }

  // loop starts a looping sound, silent until set; the caller places it every frame and
  // stops it when what makes it is gone. Loops are not voices: there are only ever a few.
  loop(name: string, bus: Bus = 'world'): Loop | null {
    const ctx = this.ctx;
    if (!ctx || !this.bus || !this.ready || !LOOPS.has(name)) return null;
    const buf = this.buffer(name, 0);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 18000; lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(lp).connect(g).connect(pan).connect(this.bus[bus]);
    // The ambience is the surroundings already: it sends nothing to the reverb.
    const send = ctx.createGain();
    send.gain.value = bus === 'amb' ? 0 : 0.2;
    if (bus !== 'amb') g.connect(send).connect(this.reverb!);
    src.start(ctx.currentTime, Math.random() * buf.duration);
    let stopped = false;
    return {
      set: (p, rate = 1) => {
        if (stopped) return;
        const t = ctx.currentTime, far = Math.min(1, Math.max(0, p.far));
        g.gain.setTargetAtTime(p.vol, t, bus === 'amb' ? 0.5 : 0.08);
        pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p.pan)), t, 0.08);
        lp.frequency.setTargetAtTime(18000 * Math.pow(1800 / 18000, far), t, 0.08);
        if (bus !== 'amb') send.gain.setTargetAtTime(0.18 + 0.6 * far, t, 0.08);
        src.playbackRate.setTargetAtTime(rate, t, 0.12);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        g.gain.setTargetAtTime(0, t, bus === 'amb' ? 0.4 : 0.12);
        src.stop(t + (bus === 'amb' ? 2.5 : 0.8));
        src.onended = () => pan.disconnect();
      },
    };
  }
}

// jitter is 1 give or take k, mostly near 1: the mean of two draws, so the ends are rare.
function jitter(k: number): number {
  return 1 + k * (Math.random() + Math.random() - 1);
}

// The last stage's curve: straight up to 0.8, then bending smoothly into 1.
function softClip(): Float32Array<ArrayBuffer> {
  const n = 4097, c = new Float32Array(n), knee = 0.8;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
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
