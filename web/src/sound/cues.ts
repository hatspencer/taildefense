import { K_CORE, PF_ALIVE, PF_CONNECTED, Phase, type Frame, type Welcome } from '../protocol';
import type { Game } from '../state';
import type { Synth } from './synth';

// The recorded cues, put in by the build (web/build.mjs): JSON of name -> MP3 in base64, from
// src/sound/cues (see CREDITS.md there).
declare const __SOUND_CUES__: string;

// The game's musical cues: a few seconds of music, once, when the night turns. A wave starting,
// a boss wave (every tenth), a wave cleared, a last stand (the generator nearly gone, or one
// survivor left standing of several), the evac called, the Huey away with survivors or the game
// lost, and the generator raised a tier. Read off the frames like every other sound: nothing is
// sent for them.
//
// They are not anywhere, so they skip the world's placing, muffling and ducking, and go in
// through musicBus, a gain into the mix before the limiter: the VOLUME setting applies to them.
// The MUSIC setting's level belongs on musicBus too: whoever plays the music can either send
// the loops through cues.musicBus and set its gain, or hand their own music gain to
// cues.useBus(node) so the cues follow it.
//
// The recordings are decoded once, the first frame the sound engine is running, off the page's
// thread; a cue asked for before its recording is ready is let go: a late cue says the wrong thing.

type Name = 'waveStart' | 'boss' | 'waveClear' | 'lastStand' | 'evac' | 'victory' | 'defeat' | 'tierUp';

// Each cue's level, how much it matters (a cue does not cut off one that matters more), and
// how long after the turn it comes in. The phase cues land on top of sound.ts's sirens, so they
// wait for the siren to be heard first and sit under it.
const CUE: Record<Name, { vol: number; prio: number; delay: number }> = {
  waveStart: { vol: 0.32, prio: 2, delay: 0.5 },
  boss: { vol: 0.42, prio: 3, delay: 0.9 },
  waveClear: { vol: 0.4, prio: 2, delay: 0.35 },
  lastStand: { vol: 0.42, prio: 2, delay: 0 },
  evac: { vol: 0.45, prio: 3, delay: 0.4 },
  victory: { vol: 0.5, prio: 4, delay: 0.8 },
  defeat: { vol: 0.5, prio: 4, delay: 1 },
  tierUp: { vol: 0.32, prio: 1, delay: 0 },
};
// The generator below this share of its health in a wave is a last stand.
const CORE_LOW = 0.25;
// How long a cue playing out takes to get out of the way of the next.
const FADE = 0.25;

interface Playing { src: AudioBufferSourceNode; g: GainNode; prio: number; end: number }

export class Cues {
  private bus: GainNode | null = null;
  private target: AudioNode | null = null;
  private bufs = new Map<string, AudioBuffer>();
  private decoding = false;
  private now: Playing | null = null;
  // The last frame's state the turns are read against, for the welcome it belongs to.
  private wd: Welcome | null = null;
  private phase = -1; private tier = 0;
  // Whether this wave has had its last stand.
  private stood = false;

  constructor(private readonly synth: Synth) {}

  // The gain the cues go through, made with the context; null until the sound has started.
  get musicBus(): GainNode | null { this.connect(); return this.bus; }

  // useBus sends the cues through node (a MUSIC volume gain, say) rather than straight into the
  // mix; node is the music player's to connect onwards.
  useBus(node: AudioNode): void {
    this.target = node;
    if (this.bus) { this.bus.disconnect(); this.bus.connect(node); }
  }

  // level follows the MUSIC setting (0..100): the default 50 plays the cues as cut, 0 silences
  // them, 100 lifts them half again.
  level(music: number): void {
    if (!this.bus || !this.synth.ctx) return;
    this.bus.gain.setTargetAtTime(Math.min(1.5, Math.max(0, music / 50)), this.synth.ctx.currentTime, 0.05);
  }

  private connect(): void {
    const ctx = this.synth.ctx, input = this.synth.input;
    if (this.bus || !ctx || !input) return;
    this.bus = ctx.createGain();
    this.bus.connect(this.target ?? input);
  }

  onFrame(game: Game): void {
    const wd = game.welcome;
    if (!wd) return;
    const f = game.cur;
    // A new game, or the first frame of this one: only read.
    if (wd !== this.wd) { this.wd = wd; this.remember(f); this.stood = false; return; }
    if (this.synth.ready) { this.connect(); this.decode(); }
    const was = this.phase, tierWas = this.tier;
    this.remember(f);
    if (!this.synth.ready) return;

    if (f.phase !== was) {
      this.stood = false;
      if (f.phase === Phase.Wave) this.play(f.wave % 10 === 0 ? 'boss' : 'waveStart');
      else if (f.phase === Phase.Evac) this.play('evac');
      else if (f.phase === Phase.Over) this.play(escaped(f) ? 'victory' : 'defeat');
      else if (was === Phase.Wave) this.play('waveClear');
      return;
    }
    if (wd.tiers && f.tier > tierWas) this.play('tierUp');
    if (f.phase === Phase.Wave && !this.stood && lastStand(f)) this.stood = this.play('lastStand');
  }

  private remember(f: Frame): void {
    this.phase = f.phase;
    this.tier = f.tier;
  }

  // play starts a cue, true if it did.
  private play(name: Name): boolean {
    const ctx = this.synth.ctx, buf = this.bufs.get(name), bus = this.bus;
    if (!ctx || !buf || !bus) return false;
    const c = CUE[name], t = ctx.currentTime, at = t + c.delay;
    const old = this.now;
    if (old && old.end > t) {
      if (old.prio > c.prio) return true;
      old.g.gain.setTargetAtTime(0, Math.max(t, at - FADE), FADE / 3);
      try { old.src.stop(at + FADE); } catch { /* already stopped */ }
    }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    g.gain.value = c.vol;
    src.connect(g).connect(bus);
    src.start(at);
    const p: Playing = { src, g, prio: c.prio, end: at + buf.duration };
    this.now = p;
    src.onended = () => { g.disconnect(); if (this.now === p) this.now = null; };
    // The world steps back a little under the music, as under the sirens.
    this.synth.duckWorld(2, c.delay + Math.min(2, buf.duration / 2));
    this.synth.plays.set('cue:' + name, (this.synth.plays.get('cue:' + name) ?? 0) + 1);
    return true;
  }

  // decode starts every recording decoding, once.
  private decode(): void {
    const ctx = this.synth.ctx;
    if (this.decoding || !ctx) return;
    this.decoding = true;
    let all: Record<string, string>;
    try { all = JSON.parse(__SOUND_CUES__); } catch { return; }
    for (const [name, b64] of Object.entries(all)) {
      const bin = atob(b64), a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      ctx.decodeAudioData(a.buffer).then((b) => { this.bufs.set(name, b); }, () => { /* left out: the game goes on without it */ });
    }
  }
}

// escaped: the game ended with the Huey gone and someone aboard it.
function escaped(f: Frame): boolean {
  for (let i = 0; i < f.nPlayers; i++) if (f.players[i].aboard) return true;
  return false;
}

// lastStand: the generator below CORE_LOW of its health, or one survivor standing of two or more.
function lastStand(f: Frame): boolean {
  for (let i = 0; i < f.nStructs; i++) {
    if (f.sAlive[i] && f.sKind[i] === K_CORE && f.sMaxHp[i] > 0 && f.sHp[i] < f.sMaxHp[i] * CORE_LOW) return true;
  }
  let here = 0, up = 0;
  for (let i = 0; i < f.nPlayers; i++) {
    const p = f.players[i];
    if (!(p.flags & PF_CONNECTED)) continue;
    here++;
    if (p.flags & PF_ALIVE) up++;
  }
  return here >= 2 && up === 1;
}
