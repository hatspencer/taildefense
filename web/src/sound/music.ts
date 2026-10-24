import { CF_ASLEEP, K_CORE, Phase } from '../protocol';
import type { Game } from '../state';
import type { Synth } from './synth';

// The music: a track for each state of the game, streamed from dist/music (credits in
// src/sound/music/CREDITS.md) and crossfaded as the game moves between them.
//
//   build  between waves: ambient, the night holding its breath
//   low    a wave while it is light: a few of the dead, far from the generator
//   high   a wave that presses in: many of them awake, or the generator taking hits
//   boss   every tenth wave, whatever else is happening
//
// A wave's intensity, 0..1, is how many of the dead are awake, how many of them are near the
// generator and how hard it has just been hit, smoothed over a couple of seconds. It opens the
// playing track's low-pass and lifts it a little, so a wave thickens before the music changes,
// and moves between low and high with a gap between the two thresholds and a least time on
// each, so it does not flap. A track that has faded out pauses where it was, and picks up from
// there next time, so a long game does not keep hearing the same opening.
//
// Nothing loads until it is wanted (the build track, and the next likely one ahead of time),
// and nothing waits on it: a track that has not arrived is silence until it has, and one that
// never does (a td built without its music, a browser that can't play Opus) is silence for good.
//
// Over http the tracks go through the sound engine's context: a gain and a low-pass each,
// then the music's own gain, after the game's limiter so a fight's explosions do not pump
// the music. Opened from disk (the demo), a browser hands Web Audio only silence from a file,
// so the tracks play on their own and the fades are the elements' volume, without the filter.

type Track = 'build' | 'low' | 'high' | 'boss';
const FILES: Record<Track, string> = { build: 'music/build.ogg', low: 'music/combat-low.ogg', high: 'music/combat-high.ogg', boss: 'music/boss.ogg' };
// Each track's level in the mix, after their loudness was matched (CREDITS.md).
const MIX: Record<Track, number> = { build: 0.9, low: 0.85, high: 0.9, boss: 0.9 };
// The music as a whole under the game's sound at MUSIC 100.
const GAIN = 0.6;
// Seconds for a full crossfade.
const FADE = 3;
// Intensity thresholds between low and high, and the least seconds on either.
const UP = 0.62, DOWN = 0.38, HOLD = 12;
// How near the generator, in tiles, a creep counts double.
const NEAR = 22;

interface Voice {
  el: HTMLAudioElement;
  g: GainNode | null; lp: BiquadFilterNode | null;
  level: number; // 0..1, where the fade has got to
  failed: boolean;
}

export class Music {
  private music: number;
  private voices = new Map<Track, Voice>();
  private out: GainNode | null = null;
  private web = typeof location !== 'undefined' && location.protocol !== 'file:';
  private want: Track | null = null;
  private combat: 'low' | 'high' = 'low';
  private since = 0; // when combat last changed, in seconds
  private intensity = 0;
  private coreHp = -1; private hit = 0;
  private last = 0;

  // music: 0..100, the MUSIC setting, a share of the volume.
  constructor(private synth: Synth, music = 50) { this.music = music; }

  get level(): number { return this.music; }

  setMusic(v: number): void { this.music = Math.min(100, Math.max(0, Math.round(v))); }

  // What the F3 readout shows of the music.
  readout(): string {
    const on = [...this.voices].filter(([, v]) => v.level > 0.01).map(([t, v]) => `${t} ${Math.round(v.level * 100)}%`);
    return `music ${this.want ?? '-'} i=${this.intensity.toFixed(2)} ${on.join(' ')}`;
  }

  // onFrame follows the game; called with every frame, and cheap.
  onFrame(game: Game): void {
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.5, now - this.last) : 0;
    this.last = now;
    const f = game.cur;
    const on = this.synth.ready && this.music > 0 && !!game.welcome;
    this.measure(game, dt);

    let want: Track | null = null;
    if (f.phase === Phase.Build) want = 'build';
    else if (f.phase === Phase.Wave || f.phase === Phase.Evac) {
      if (f.phase === Phase.Wave && f.wave > 0 && f.wave % 10 === 0) want = 'boss';
      else {
        if (this.want !== 'low' && this.want !== 'high') { this.combat = this.intensity > UP ? 'high' : 'low'; this.since = now; }
        else if (now - this.since > HOLD) {
          const next = this.combat === 'low' ? (this.intensity > UP ? 'high' : 'low') : (this.intensity < DOWN ? 'low' : 'high');
          if (next !== this.combat) { this.combat = next; this.since = now; }
        }
        want = this.combat;
      }
    }
    // Game over: the music fades out under the report.
    this.want = want;
    if (!on) { for (const [t, v] of this.voices) { v.level = 0; this.apply(v, t, 0); if (!v.el.paused) v.el.pause(); } return; }

    // Loaded ahead: the first fight's music in the build, a boss's before its wave.
    if (f.phase === Phase.Build) this.voice((f.wave + 1) % 10 === 0 ? 'boss' : 'low');
    if (want) this.voice(want);

    const paused = f.pausedBy >= 0;
    for (const [t, v] of this.voices) {
      const target = t === want && !v.failed ? 1 : 0;
      const step = dt / FADE;
      v.level = target > v.level ? Math.min(target, v.level + step) : Math.max(target, v.level - step);
      if (v.level > 0 && v.el.paused && !v.failed && v.el.readyState >= 2) v.el.play().catch(() => { /* not yet: the next frame tries again */ });
      if (v.level === 0 && !v.el.paused) v.el.pause();
      // Equal power, so the middle of a crossfade does not sag; paused, the music steps back.
      const gain = Math.sin(v.level * Math.PI / 2) * MIX[t] * (paused ? 0.45 : 1);
      this.apply(v, t, gain, paused);
    }
  }

  // measure updates the wave's intensity from the frame.
  private measure(game: Game, dt: number): void {
    const f = game.cur, core = game.welcome?.core;
    let awake = 0, near = 0;
    for (let i = 0; i < f.nCreeps; i++) {
      if (f.cFlags[i] & CF_ASLEEP) continue;
      awake++;
      if (core) { const dx = f.cX[i] - core.x, dy = f.cY[i] - core.y; if (dx * dx + dy * dy < NEAR * NEAR) near++; }
    }
    let hp = -1, max = 1;
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] === K_CORE) { hp = f.sHp[i]; max = Math.max(1, f.sMaxHp[i]); break; }
    // A blow to the generator counts for a while after it lands: a tenth of its health is a full hit.
    if (hp >= 0 && this.coreHp >= 0 && hp < this.coreHp) this.hit = Math.min(1, this.hit + (this.coreHp - hp) / max * 10);
    this.coreHp = hp;
    this.hit *= Math.exp(-dt / 8);
    const wave = f.phase === Phase.Wave || f.phase === Phase.Evac;
    const target = !wave ? 0 : Math.min(1,
      0.5 * (1 - Math.exp(-awake / 60)) + 0.45 * (1 - Math.exp(-near / 12)) + 0.5 * this.hit + (hp >= 0 ? 0.25 * (1 - hp / max) : 0));
    // Up in about a second, down over several: a wave dying away lets go slowly.
    const tau = target > this.intensity ? 1 : 5;
    this.intensity += (target - this.intensity) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);
  }

  // apply sets a voice's level: the gain and the low-pass over Web Audio, else the element's volume.
  private apply(v: Voice, t: Track, gain: number, paused = false): void {
    const ctx = this.synth.ctx;
    // The music is a share of the volume: it goes in after the limiter, past the volume's own
    // gain, so it is scaled by the volume here.
    const master = GAIN * (this.music / 100) ** 2 * (this.synth.volume / 100) ** 2;
    if (v.g && v.lp && ctx && this.out) {
      const now = ctx.currentTime;
      this.out.gain.setTargetAtTime(master, now, 0.05);
      // The combat tracks open up with the wave; the build track stays as it is.
      const open = t === 'build' ? 1 : t === 'boss' ? 0.7 + 0.3 * this.intensity : 0.35 + 0.65 * this.intensity;
      const lift = t === 'build' ? 1 : 0.8 + 0.2 * this.intensity;
      const cut = paused ? 900 : 500 * Math.pow(18000 / 500, open);
      v.g.gain.setTargetAtTime(gain * lift, now, 0.1);
      v.lp.frequency.setTargetAtTime(cut, now, 0.3);
    } else {
      // Off the engine: the volume setting has to be applied here too, squared like the engine's.
      v.el.volume = Math.min(1, gain * master * (this.synth.volume / 100) ** 2);
    }
  }

  // voice is a track's player, started loading the first time it is asked for.
  private voice(t: Track): Voice {
    let v = this.voices.get(t);
    if (v) return v;
    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    v = { el, g: null, lp: null, level: 0, failed: false };
    const voice = v;
    el.addEventListener('error', () => { voice.failed = true; }, { once: true });
    if (el.canPlayType('audio/ogg; codecs=opus') === '') voice.failed = true;
    const ctx = this.synth.ctx;
    if (this.web && ctx) {
      try {
        if (!this.out) { this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(ctx.destination); }
        const src = ctx.createMediaElementSource(el);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 18000;
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(lp).connect(g).connect(this.out);
        v.g = g; v.lp = lp;
      } catch { /* the element plays on its own instead */ }
    }
    el.volume = v.g ? 1 : 0;
    if (!voice.failed) el.src = FILES[t];
    this.voices.set(t, v);
    return v;
  }
}
