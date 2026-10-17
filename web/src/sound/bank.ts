import { Buf, LP1, SVF, ad, bump, rng, sat, slowNoise } from './dsp';

// Every sound in the game, as a recipe that renders it into samples. A sound has a few
// variants rendered from different seeds (and slightly different numbers), and one is picked
// at random each time, so a burst of fire never sounds like a loop.

type R = () => number;
const TAU = Math.PI * 2;
const jit = (r: R, v: number, k: number) => v * (1 + (r() * 2 - 1) * k);

// --- building blocks ----------------------------------------------------------------------

// A gunshot is six things at once. The crack: the bullet breaking the sound barrier and the
// primer, a millisecond of everything. The blast: the muzzle gas, broadband noise whose top
// end dies in a few tens of milliseconds, overloaded into distortion the way a shot near a
// microphone is. The body: the gun's own ring in the mids, where the bang is. The boom: the low punch, a sine dropping in pitch as the gas spreads. The
// tail: the report rolling away over open ground, dark and long. And echoes: the blast again
// off buildings and treelines, later and darker.
interface Gun {
  len: number;
  crack: number; crackTau: number;
  blast: number; blastTau: number; blastF0: number; blastF1: number;
  body: number; bodyF: number;
  boom: number; boomF0: number; boomF1: number; boomTau: number;
  drive: number;
  tail: number; tailTau: number; tailF: number;
  echoes: [number, number][];
}

function gunshot(sr: number, r: R, g: Gun): Buf {
  const b = new Buf(sr, g.len);
  const coreLen = Math.min(b.len, Math.ceil(sr * 0.3));
  const core = new Float32Array(coreLen);
  const cs = new SVF(sr), sv = new SVF(sr), bs = new SVF(sr), ts = new SVF(sr);
  const blastF0 = jit(r, g.blastF0, 0.1), boomF0 = jit(r, g.boomF0, 0.07), boomF1 = jit(r, g.boomF1, 0.07);
  const blastTau = jit(r, g.blastTau, 0.1);
  // Gains that make each layer's level not depend on its bandwidth. The blast's is fixed at
  // its opening cutoff, so as the cutoff falls the top end dies away, as it does in the air.
  const blastComp = Math.sqrt(sr / 2 / blastF0), bodyComp = Math.sqrt(sr / 2 / (g.bodyF / 1.4)), tailComp = Math.sqrt(sr / 2 / (g.tailF / 0.6));
  let ph = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, n = r() * 2 - 1;
    let x = 0;
    if (i < coreLen) {
      const c = cs.run(n, 2500, 0.7).high * g.crack * ad(t, 0.0001, g.crackTau);
      const cut = g.blastF1 + (blastF0 - g.blastF1) * Math.exp(-t / (blastTau * 1.5));
      const bl = sv.run(n, cut, 0.8).low * blastComp * g.blast * ad(t, 0.0005, blastTau);
      // The bang itself: the gun's own ring in the mids, where a shot is loudest to the ear.
      const bd = bs.run(n, g.bodyF, 1.4).band * bodyComp * g.body * ad(t, 0.0005, blastTau * 1.3);
      const f = boomF1 + (boomF0 - boomF1) * Math.exp(-t / (g.boomTau * 0.6));
      ph += TAU * f / sr;
      const bo = Math.sin(ph) * g.boom * ad(t, 0.0012, g.boomTau);
      x = sat(c + bl + bd + bo, g.drive);
      core[i] = x;
    }
    // The report rolling away: a wide band round tailF, neither hiss nor rumble.
    b.d[i] = x + ts.run(r() * 2 - 1, g.tailF, 0.6).band * tailComp * g.tail * ad(t, 0.005, g.tailTau);
  }
  for (const [delay, gain] of g.echoes) {
    const a = new LP1(sr), c = new LP1(sr);
    const o = Math.floor(jit(r, delay, 0.12) * sr);
    for (let i = 0; i < coreLen && o + i < b.len; i++) b.d[o + i] += c.run(a.run(core[i], 1500), 1500) * gain;
  }
  return b.normalize(0.95).fadeOut(0.05);
}

// A mechanical click: band-passed noise a few milliseconds long, with a metal ring under it.
function click(b: Buf, r: R, at: number, f: number, gain: number, tau = 0.004, ring = 0): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(tau * 10 * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    sv.run(r() * 2 - 1, f, 2.5);
    let x = sv.band * ad(t, 0.0002, tau) * 2;
    if (ring) x += Math.sin(TAU * ring * t) * Math.exp(-t / (tau * 4)) * 0.6;
    b.d[o + i] += x * gain;
  }
}

// Metal sliding over metal, swelling and passing over dur.
function slide(b: Buf, r: R, at: number, dur: number, f: number, gain: number): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(dur * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    sv.run(r() * 2 - 1, f * (0.9 + 0.2 * t / dur), 1.5);
    const grit = 0.6 + 0.4 * Math.abs(Math.sin(TAU * 140 * t + r() * 0.3));
    b.d[o + i] += sv.band * bump(t, dur * 0.5, dur * 0.35) * grit * gain;
  }
}

// A struck piece of metal: inharmonic partials dying away.
function ping(b: Buf, at: number, freqs: number[], tau: number, gain: number): void {
  const o = Math.floor(at * b.sr), n = Math.ceil(tau * 7 * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    let x = 0;
    for (let k = 0; k < freqs.length; k++) x += Math.sin(TAU * freqs[k] * t) * Math.exp(-t / (tau / (1 + k * 0.4))) / (1 + k * 0.6);
    b.d[o + i] += x * ad(t, 0.0005, 1e9) * gain;
  }
}

// A low impact: a sine falling from f0 to f1 and a puff of dark noise.
function thud(b: Buf, r: R, at: number, f0: number, f1: number, tau: number, gain: number, noise = 0.5, cut = 900): void {
  const lp = new LP1(b.sr), lp2 = new LP1(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(tau * 7 * b.sr);
  const comp = Math.sqrt(b.sr / (2 * cut));
  let ph = 0;
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / (tau * 0.5))) / b.sr;
    const e = ad(t, 0.001, tau);
    b.d[o + i] += (Math.sin(ph) + lp2.run(lp.run(r() * 2 - 1, cut), cut) * comp * noise) * e * gain;
  }
}

// Air pushed aside: band-passed noise whose pitch glides from f0 to f1 as it swells and passes.
function whoosh(b: Buf, r: R, at: number, dur: number, f0: number, f1: number, gain: number, q = 1.2): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(dur * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr, u = t / dur;
    sv.run(r() * 2 - 1, f0 * Math.pow(f1 / f0, u), q);
    b.d[o + i] += sv.band * bump(t, dur * 0.45, dur * 0.28) * gain;
  }
}

// Noise low-passed with a cutoff falling from f0 to f1, enveloped, optionally overdriven: the
// body of explosions, splats and rubble.
function roar(b: Buf, r: R, at: number, len: number, f0: number, f1: number, a: number, tau: number, gain: number, drive = 0): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(len * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    const cut = f1 + (f0 - f1) * Math.exp(-t / (tau * 1.2));
    sv.run(r() * 2 - 1, cut, 0.7);
    let x = sv.low * Math.pow(b.sr / 2 / cut, 0.4) * ad(t, a, tau);
    if (drive) x = sat(x, drive);
    b.d[o + i] += x * gain;
  }
}

// Bits landing: n small clicks scattered from at over spread seconds, thinning out.
function debris(b: Buf, r: R, at: number, spread: number, n: number, f0: number, f1: number, gain: number): void {
  for (let k = 0; k < n; k++) {
    const u = -Math.log(1 - r() * 0.95) / 3;
    click(b, r, at + u * spread, f0 + r() * (f1 - f0), gain * (0.3 + r() * 0.7) * Math.exp(-u * 1.5), 0.002 + r() * 0.004);
  }
}

// A throat: a rough pulse train through three formant filters. f0 and the vowel move over
// the sound; rasp roughens it, jitter makes the pitch waver, am bubbles it.
interface Vox {
  dur: number; f0: (u: number) => number; vowel: (u: number) => [number, number, number];
  rasp: number; jitter: number; a: number; rel: number; gain: number; am?: number; drive?: number;
  // fry: every other glottal pulse weakened by this much, the creak of a ruined throat.
  // swell: how much the loudness wanders, slowly, as breath does.
  fry?: number; swell?: number;
}

const V = {
  uh: [570, 840, 2410], aa: [730, 1090, 2440], oh: [450, 800, 2400], eh: [530, 1840, 2480],
  ae: [660, 1720, 2410], ee: [300, 2250, 2900], ey: [420, 2050, 2650], er: [490, 1350, 1690],
} as const;
type Vowel = readonly [number, number, number];
const lerpV = (a: Vowel, b: Vowel, u: number): [number, number, number] => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

function vox(b: Buf, r: R, at: number, v: Vox): void {
  const sr = b.sr, o = Math.floor(at * sr), n = Math.ceil(v.dur * sr);
  const f1 = new SVF(sr), f2 = new SVF(sr), f3 = new SVF(sr);
  const wob = slowNoise(r, sr, v.dur + 0.1, 14), bub = v.am ? slowNoise(r, sr, v.dur + 0.1, v.am) : null;
  const breath = slowNoise(r, sr, v.dur + 0.1, 4);
  const fry = v.fry ?? 0, swell = v.swell ?? 0;
  let ph = 0, shimmer = 0, odd = false;
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / sr, u = t / v.dur;
    ph += v.f0(u) * (1 + wob[i] * v.jitter) / sr;
    if (ph >= 1) { ph -= 1; shimmer = (r() * 2 - 1) * v.rasp * 0.6; odd = !odd; }
    const src = (1 - 2 * ph) * (1 + shimmer) * (odd ? 1 - fry : 1) + (r() * 2 - 1) * v.rasp * 0.8;
    const [a, c, d] = v.vowel(u);
    const y = f1.run(src, a, 5).band + f2.run(src, c, 7).band * 0.55 + f3.run(src, d, 9).band * 0.25;
    const env = Math.min(1, t / v.a) * (t > v.dur - v.rel ? Math.max(0, (v.dur - t) / v.rel) : 1);
    const am = (bub ? 0.55 + 0.45 * Math.max(-1, Math.min(1, bub[i] * 2)) : 1) * (1 - swell * (0.5 - 0.5 * breath[i]));
    b.d[o + i] += sat(y * 0.6, v.drive ?? 1.5) * env * am * v.gain;
  }
}

// A siren on a pole across town, motor-driven: two rotors a minor third apart, each chopping
// air through its ports, so the tone is a buzz with wind in it, louder the faster it turns.
// The head turns, sweeping it towards you and away, and the hills send it back late.
function siren(sr: number, r: R, len: number, top: number, pitch: (t: number) => number, env: (t: number) => number): Buf {
  const b = new Buf(sr, len + 1.6), lp = new LP1(sr), lp2 = new LP1(sr), horn = new SVF(sr);
  const turn = 1 / jit(r, 3, 0.15), tp = r() * TAU;
  // A port opening: half a sine cubed, rich in harmonics; its mean taken out.
  const port = (p: number) => Math.pow(Math.max(0, Math.sin(TAU * p)), 3) - 0.212;
  let p1 = 0, p2 = 0;
  for (let i = 0; i < len * sr; i++) {
    const t = i / sr, f = pitch(t), head = Math.sin(TAU * turn * t + tp);
    const dop = 1 + 0.004 * Math.cos(TAU * turn * t + tp);
    p1 += f * dop / sr; p1 -= Math.floor(p1);
    p2 += f * 1.19 * dop / sr; p2 -= Math.floor(p2);
    const x = port(p1) + 0.85 * port(p2), air = (r() * 2 - 1) * (0.25 + Math.abs(x) * 0.4);
    const y = lp2.run(lp.run(x + air * 0.5, 3000), 3000) + horn.run(x, 850, 0.8).band * 0.6;
    b.d[i] = sat(y * 1.6, 1.4) * env(t) * Math.min(1, 0.3 + 0.7 * f / top) * (0.7 + 0.3 * head);
  }
  const dry = b.d.slice(0, Math.ceil(len * sr));
  for (const [delay, gain] of [[0.42, 0.3], [0.95, 0.17], [1.5, 0.09]]) {
    const a = new LP1(sr), c = new LP1(sr), o = Math.floor(delay * sr);
    for (let i = 0; i < dry.length && o + i < b.len; i++) b.d[o + i] += c.run(a.run(dry[i], 1800), 1800) * gain;
  }
  return b.normalize(0.8).fadeOut(0.1);
}

// A short tone with a soft edge, for the radio and the countdown.
function pip(b: Buf, at: number, f: number, dur: number, gain: number, square = false): void {
  const o = Math.floor(at * b.sr), n = Math.ceil(dur * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    const s = Math.sin(TAU * f * t);
    const x = square ? Math.tanh(s * 4) * 0.5 : s;
    b.d[o + i] += x * Math.min(1, t / 0.004, (dur - t) / 0.01) * gain;
  }
}

// Radio static, band-limited like a walkie-talkie's speaker.
function hiss(b: Buf, r: R, at: number, dur: number, gain: number): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(dur * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    sv.run(r() * 2 - 1, 2400, 0.9);
    b.d[o + i] += sv.band * Math.min(1, t / 0.005, (dur - t) / 0.02) * gain;
  }
}

// A bell's note: the partials of a cast bell (hum, prime, minor third, fifth, nominal and
// above), each doubled a hair sharp so it warbles as real bells do.
function bellNote(b: Buf, r: R, at: number, f: number, len: number, gain: number): void {
  const ratios = [0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011, 4.166];
  const amps = [0.55, 1, 0.6, 0.3, 0.5, 0.25, 0.18, 0.15, 0.08];
  const taus = [3.2, 2.4, 1.8, 1.3, 1.1, 0.8, 0.7, 0.5, 0.35];
  const o = Math.floor(at * b.sr), n = Math.ceil(len * b.sr), sr = b.sr;
  // Each partial and its sharp twin as a phasor turned a step every sample: a multiply-add
  // instead of a sine, which matters over seconds of eighteen partials.
  const m = ratios.length * 2;
  const re = new Float64Array(m), im = new Float64Array(m), cr = new Float64Array(m), ci = new Float64Array(m);
  const amp = new Float64Array(m), decay = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const p = k >> 1, w = TAU * f * ratios[p] * (k & 1 ? 1.0018 : 1) / sr, ph = k & 1 ? 0 : r() * TAU;
    re[k] = Math.cos(ph); im[k] = Math.sin(ph); cr[k] = Math.cos(w); ci[k] = Math.sin(w);
    amp[k] = amps[p]; decay[k] = Math.exp(-1 / (taus[p] * len / 4 * sr));
  }
  for (let i = 0; i < n && o + i < b.len; i++) {
    let x = 0;
    for (let k = 0; k < m; k++) {
      const a = re[k] * cr[k] - im[k] * ci[k];
      im[k] = re[k] * ci[k] + im[k] * cr[k]; re[k] = a;
      x += im[k] * amp[k];
      amp[k] *= decay[k];
    }
    b.d[o + i] += x * Math.min(1, i / (0.002 * sr)) * gain;
  }
  click(b, r, at, 1800, gain * 1.2, 0.004);
}

// --- weapons ------------------------------------------------------------------------------

// The pistol is a big-bore magnum, a desert eagle: no 9 mm snap but a heavy slam, a deep
// boom for a handgun and a report that carries.
const PISTOL: Gun = {
  len: 1.2, crack: 1.1, crackTau: 0.001, blast: 1.15, blastTau: 0.032, blastF0: 5200, blastF1: 650, body: 0.5, bodyF: 1000,
  boom: 1, boomF0: 135, boomF1: 45, boomTau: 0.05, drive: 3.2, tail: 0.32, tailTau: 0.17, tailF: 750,
  echoes: [[0.12, 0.24], [0.27, 0.11], [0.5, 0.05]],
};
// The shotgun is a 12 gauge: the widest, hardest blast of the guns, with more crack than a
// thump, a punch deeper than anything hand-held but the rifle, and a report that rolls off
// the treeline three times over.
const SHOTGUN: Gun = {
  len: 1.8, crack: 1, crackTau: 0.0012, blast: 1.25, blastTau: 0.045, blastF0: 5600, blastF1: 520, body: 0.45, bodyF: 850,
  boom: 1.05, boomF0: 115, boomF1: 36, boomTau: 0.07, drive: 3.6, tail: 0.4, tailTau: 0.26, tailF: 680,
  echoes: [[0.14, 0.28], [0.33, 0.14], [0.62, 0.06]],
};
// The SMG is a 9 mm machine pistol at eleven rounds a second: a snappy crack and a hard,
// tight punch in the upper mids, a boom short enough not to smear, and the bolt slamming
// home under every round, the clatter that makes a burst sound like a machine.
const SMG: Gun = {
  len: 0.6, crack: 1.05, crackTau: 0.0007, blast: 1.1, blastTau: 0.012, blastF0: 6800, blastF1: 1300, body: 0.55, bodyF: 1450,
  boom: 0.8, boomF0: 185, boomF1: 62, boomTau: 0.018, drive: 3.2, tail: 0.2, tailTau: 0.08, tailF: 1000,
  echoes: [[0.08, 0.13], [0.19, 0.05]],
};
// The rifle is a full-power bolt action, a springfield or an AWP: the sharpest crack in the
// game, a boom down where the cannon is and a report that rolls on for two seconds.
const RIFLE: Gun = {
  len: 2.6, crack: 1.7, crackTau: 0.0005, blast: 1.05, blastTau: 0.034, blastF0: 8500, blastF1: 900, body: 0.4, bodyF: 1050,
  boom: 1.05, boomF0: 105, boomF1: 32, boomTau: 0.07, drive: 3.6, tail: 0.5, tailTau: 0.34, tailF: 750,
  echoes: [[0.19, 0.34], [0.46, 0.2], [0.85, 0.1], [1.35, 0.05]],
};
// The minigun fires full rifle rounds, 22 a second: each a short, hard slam with a real boom
// under it, and a tail long enough that the rounds run together into one ripping roar.
const MINIGUN: Gun = {
  len: 0.5, crack: 0.9, crackTau: 0.0006, blast: 1.1, blastTau: 0.013, blastF0: 6500, blastF1: 1100, body: 0.5, bodyF: 1150,
  boom: 0.95, boomF0: 150, boomF1: 52, boomTau: 0.022, drive: 3.4, tail: 0.24, tailTau: 0.1, tailF: 850,
  echoes: [[0.09, 0.12], [0.21, 0.05]],
};
// The gun turret is a sentry: rifle rounds four a second, harder and drier than a hand-held
// gun, a short boom, and the feed's clack and the mount's servo after every shot.
const TURRET_GUN: Gun = {
  len: 0.6, crack: 0.95, crackTau: 0.0008, blast: 1.05, blastTau: 0.015, blastF0: 6000, blastF1: 1000, body: 0.42, bodyF: 1250,
  boom: 0.75, boomF0: 170, boomF1: 60, boomTau: 0.022, drive: 3, tail: 0.2, tailTau: 0.11, tailF: 900,
  echoes: [[0.1, 0.13], [0.24, 0.05]],
};
// The cannon is field artillery: a muzzle crack, a huge blast, the deepest boom in the game
// and a report rolling over the map; then the barrel ringing, the recoil running back and the
// breech dropping the spent case.
const CANNON: Gun = {
  len: 2.8, crack: 0.85, crackTau: 0.002, blast: 1.2, blastTau: 0.08, blastF0: 3400, blastF1: 260, body: 0.3, bodyF: 620,
  boom: 1.4, boomF0: 75, boomF1: 24, boomTau: 0.15, drive: 4.2, tail: 0.55, tailTau: 0.4, tailF: 480,
  echoes: [[0.22, 0.3], [0.55, 0.14], [1.05, 0.06]],
};
// The sniper tower is a .50 with a muzzle brake: a crack as sharp as the rifle's but a wider,
// harsher blast thrown sideways out of the brake, lower in the mids, and the bolt worked after.
const SNIPER: Gun = {
  len: 2.6, crack: 1.5, crackTau: 0.0007, blast: 1.25, blastTau: 0.04, blastF0: 7200, blastF1: 750, body: 0.55, bodyF: 800,
  boom: 1, boomF0: 100, boomF1: 30, boomTau: 0.07, drive: 3.8, tail: 0.5, tailTau: 0.32, tailF: 700,
  echoes: [[0.2, 0.32], [0.5, 0.17], [0.95, 0.08], [1.5, 0.04]],
};
// The door gunner's M60 heard from the ground: full rounds eight a second, the blast darker
// for being up in the air, and a report that carries over open ground.
const DOORGUN: Gun = {
  len: 0.8, crack: 0.9, crackTau: 0.0008, blast: 1.05, blastTau: 0.02, blastF0: 4800, blastF1: 850, body: 0.4, bodyF: 1000,
  boom: 0.85, boomF0: 140, boomF1: 48, boomTau: 0.03, drive: 3.2, tail: 0.32, tailTau: 0.18, tailF: 750,
  echoes: [[0.16, 0.16], [0.38, 0.06]],
};

// Spent brass hitting the ground and bouncing twice.
function brass(b: Buf, r: R, at: number, gain: number): void {
  const base = jit(r, 4200, 0.1);
  [0, 0.085, 0.14].forEach((d, k) => ping(b, at + d + r() * 0.01, [base, base * 1.47, base * 2.09, base * 2.7], 0.03, gain / (1 + k * 1.5)));
}

// A pump worked back and forward: the fore-end racked back, the spent hull thrown out and
// landing, a hollow plastic tock with the brass head ticking, then the fore-end slammed home.
function pump(b: Buf, r: R, at: number, gain: number): void {
  click(b, r, at, 2200, gain, 0.004, 380);
  slide(b, r, at + 0.005, 0.08, 1700, gain * 0.6);
  clack(b, r, at + 0.09, 1500, gain * 1.1, 260);
  const land = at + 0.38 + r() * 0.05;
  click(b, r, land, 900, gain * 0.5, 0.006, 620);
  ping(b, land + 0.002, [3100, 4550, 6400], 0.02, gain * 0.12);
  click(b, r, land + 0.09 + r() * 0.03, 1000, gain * 0.2, 0.005, 680);
  slide(b, r, at + 0.15, 0.06, 2000, gain * 0.5);
  clack(b, r, at + 0.21, 2500, gain * 1.3, 340);
}

// A bolt lifted, drawn, pushed home and turned down.
function bolt(b: Buf, r: R, at: number, gain: number): void {
  click(b, r, at, 3000, gain * 0.8, 0.003, 900);
  slide(b, r, at + 0.03, 0.09, 2600, gain * 0.5);
  click(b, r, at + 0.12, 2000, gain, 0.004, 600);
  slide(b, r, at + 0.2, 0.08, 2800, gain * 0.45);
  click(b, r, at + 0.28, 2400, gain * 1.1, 0.004, 700);
  click(b, r, at + 0.34, 3400, gain * 0.9, 0.003, 1100);
}

// A heavy part slamming home: a click, the gun's body knocked low under it and a short ring of
// steel. A slide or a bolt going forward, a magazine seated, a cover shut.
function clack(b: Buf, r: R, at: number, f: number, gain: number, low = 300): void {
  click(b, r, at, f, gain, 0.003, f * 0.55);
  thud(b, r, at, low, low * 0.6, 0.012, gain * 0.7, 0.4, 2500);
  ping(b, at + 0.001, [f * 0.83, f * 1.37, f * 2.21], 0.025, gain * 0.25);
}

// A small motor slewing: a whine round 900 Hz bending as the mount turns, with a buzz in it.
function servo(b: Buf, r: R, at: number, dur: number, gain: number): void {
  const o = Math.floor(at * b.sr), f = jit(r, 900, 0.1), up = r() < 0.5 ? 1 : -1;
  let ph = 0;
  for (let i = 0; i < Math.ceil(dur * b.sr) && o + i < b.len; i++) {
    const t = i / b.sr, u = t / dur;
    ph += TAU * f * (1 + up * 0.15 * u) / b.sr;
    b.d[o + i] += (Math.sin(ph) + 0.4 * Math.sin(ph * 2) + 0.25 * Math.sign(Math.sin(ph * 0.5))) * Math.sin(Math.PI * u) * gain;
  }
}

// A missile kicked out of its tube by gas before its motor lights: a hollow pop, the tube
// sounding like a blown bottle, a hiss of gas and the next one clacking up into place.
function pod(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  const f = jit(r, 190, 0.12), sv = new SVF(sr);
  let ph = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    ph += TAU * (f * (0.75 + 0.25 * Math.exp(-t / 0.03))) / sr;
    b.d[i] += Math.sin(ph) * ad(t, 0.002, 0.045) * 0.9;
    b.d[i] += sv.run(r() * 2 - 1, 2400, 1).band * ad(t, 0.003, 0.08) * 0.5;
  }
  thud(b, r, 0, 160, 70, 0.02, 0.6, 0.6, 1500);
  click(b, r, 0, 1400, 0.4, 0.004, 700);
  clack(b, r, 0.24 + r() * 0.03, 1700, 0.25, 300);
  return b.normalize(0.9).fadeOut();
}

// The rifle's ultimate, a railgun: no powder, a slug thrown by a magnetic field. A snap of
// discharge, an electric tone diving five octaves as the slug leaves, the air torn and fizzing
// behind it, the slug's weight in the low end, the rails ringing like struck steel, and the
// capacitors whining back up to the click of the next shot ready.
function railgun(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.6);
  const tear = new SVF(sr), f0 = jit(r, 5200, 0.08), f1 = jit(r, 110, 0.1);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < Math.ceil(sr * 0.6); i++) {
    const t = i / sr, n = r() * 2 - 1;
    const snap = n * ad(t, 0.0001, 0.0015) * 1.5;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.045);
    p1 += TAU * f / sr; p2 += TAU * f * 1.502 / sr;
    const zap = (Math.sin(p1) + 0.5 * Math.sin(p2)) * ad(t, 0.0005, 0.09) * 0.7;
    const fizz = tear.run(n, 900 + 7000 * Math.exp(-t / 0.06), 1.2).band * ad(t, 0.001, 0.12) * (r() < 0.3 ? 1.6 : 0.9);
    b.d[i] = sat(snap + zap + fizz, 2.5);
  }
  thud(b, r, 0, 90, 30, 0.12, 0.9, 0.3, 400);
  const f = jit(r, 1180, 0.05);
  ping(b, 0.002, [f, f * 1.41, f * 2.13, f * 2.97, f * 3.6], 0.35, 0.18);
  ping(b, 0.002, [f * 1.006], 0.5, 0.08);
  // The shot off the treeline, before the whine.
  const core = b.d.slice(0, Math.ceil(sr * 0.3));
  for (const [delay, gain] of [[0.2, 0.25], [0.48, 0.1]]) {
    const a = new LP1(sr), c = new LP1(sr), o = Math.floor(jit(r, delay, 0.1) * sr);
    for (let i = 0; i < core.length && o + i < b.len; i++) b.d[o + i] += c.run(a.run(core[i], 1400), 1400) * gain;
  }
  const w0 = 0.3, wl = 0.75, o = Math.floor(w0 * sr);
  let ph = 0;
  for (let i = 0; i < wl * sr && o + i < b.len; i++) {
    const u = i / sr / wl;
    ph += TAU * 300 * Math.pow(8, u) / sr;
    const e = Math.min(1, u * 3) * Math.min(1, (1 - u) / 0.04) * (1 + 0.3 * Math.sin(TAU * 100 * i / sr));
    b.d[o + i] += (Math.sin(ph) + 0.3 * Math.sin(2 * ph)) * e * 0.05;
  }
  click(b, r, w0 + wl, 3200, 0.15, 0.002, 2400);
  return b.normalize(0.95).fadeOut(0.05);
}

// Burning and sputtering: sharp ticks, rate a second at first, thinning out over dur.
function crackle(b: Buf, r: R, at: number, dur: number, rate: number, f0: number, f1: number, gain: number): void {
  for (let t = 0; ;) {
    t += -Math.log(1 - r() * 0.999) / (rate * Math.exp(-2.5 * t / dur));
    if (t >= dur) break;
    click(b, r, at + t, f0 + r() * (f1 - f0), gain * (0.3 + r() * 0.7) * Math.exp(-2 * t / dur), 0.0008 + r() * 0.0015);
  }
}

// A rocket leaving the tube: the ignition's crack and the backblast, a slam of gas out of the
// back of the tube, then the motor, a tearing roar that crackles as the burn goes ragged, its
// pitch sliding down and its top end thinning as it flies off. A missile is the battery's,
// already out of its tube: the motor lighting with a pop and a fizzing hiss streaking away.
function rocketLaunch(sr: number, r: R, small: boolean): Buf {
  const b = new Buf(sr, small ? 1.1 : 1.6);
  if (!small) {
    click(b, r, 0, 3000, 0.6, 0.0015);
    roar(b, r, 0, 0.5, 3200, 260, 0.0008, 0.07, 1.1, 3.5);
    thud(b, r, 0, 110, 38, 0.08, 1, 0.3, 500);
    whoosh(b, r, 0.01, 0.3, 2400, 500, 0.4, 0.8);
  } else {
    click(b, r, 0, 2600, 0.5, 0.002);
    thud(b, r, 0, 160, 70, 0.025, 0.5, 0.4, 900);
    roar(b, r, 0, 0.15, 4000, 900, 0.001, 0.02, 0.4, 2);
  }
  const len = b.len / sr, sv = new SVF(sr), cs = new SVF(sr), lp = new LP1(sr);
  const flutter = slowNoise(r, sr, len, 60), sway = slowNoise(r, sr, len, 6);
  const top = small ? 3400 : 2300, bottom = small ? 1100 : 650, away = small ? 0.35 : 0.5;
  const start = small ? 0.012 : 0.035, tau = small ? 0.3 : 0.45, spit = small ? 0.005 : 0.007;
  for (let i = Math.floor(start * sr); i < b.len; i++) {
    const t = i / sr - start, n = r() * 2 - 1;
    const f = (bottom + (top - bottom) * Math.exp(-t / away)) * (1 + 0.06 * sway[i]);
    let x = sv.run(n, f, 0.9).band * (0.7 + 0.4 * flutter[i]);
    // The burn going ragged: pops through a resonance above the roar.
    x += cs.run(r() < spit * Math.exp(-t / 0.7) ? (r() * 2 - 1) * (small ? 1.5 : 4) : 0, f * 1.6, 2).band;
    if (!small) x += lp.run(n, 300) * 2.2 * Math.exp(-t / 0.3);
    b.d[i] += x * ad(t, small ? 0.02 : 0.035, tau) * (small ? 0.9 : 0.7);
  }
  return b.normalize(0.9).fadeOut(0.05);
}

// The crowbar is Half-Life's: a short swish, then the bar ringing out like a struck pipe. Two
// modes a few hertz apart round 1.1 kHz beat as it rings, over the clank of the blow's first
// hundredths of a second.
function crowbar(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.8);
  whoosh(b, r, 0, 0.09, 700, 1900, 0.35, 1.4);
  const at = 0.07, o = Math.floor(at * sr), f = jit(r, 1095, 0.04), beat = 18 + r() * 14;
  const clank = [1.31, 1.8, 2.01, 2.47, 2.92, 3.47].map((k) => f * jit(r, k, 0.03));
  const ph = Array.from({ length: 12 }, () => r() * TAU);
  for (let i = 0; o + i < b.len; i++) {
    const t = i / sr;
    let x = (Math.sin(TAU * f * t + ph[0]) + 0.4 * Math.sin(TAU * (f + beat) * t + ph[1])) * Math.exp(-t / 0.3);
    x += 0.22 * Math.sin(TAU * f * 1.39 * t + ph[2]) * Math.exp(-t / 0.1);
    x += 0.18 * Math.sin(TAU * f * 2.8 * t + ph[3]) * Math.exp(-t / 0.12);
    x += 0.1 * Math.sin(TAU * f * 0.395 * t + ph[4]) * Math.exp(-t / 0.3);
    x += 0.14 * Math.sin(TAU * f * 0.115 * t + ph[5]) * Math.exp(-t / 0.35);
    for (let k = 0; k < clank.length; k++) x += 0.35 * Math.sin(TAU * clank[k] * t + ph[6 + k]) * Math.exp(-t / 0.012);
    b.d[o + i] += x * ad(t, 0.0004, 1e9) * 0.5;
  }
  click(b, r, at, 2200, 0.3, 0.003);
  return b.normalize(0.85).fadeOut(0.06);
}

// --- explosions and the weather -------------------------------------------------------------

// An explosion near enough to feel. The shock front: the air slammed up and sucked back (an
// N-wave) in a few milliseconds. The fireball: noise driven hard, its top end dying as it rolls
// out, a whump of gas under it and a boom falling below that. The fireball crackling as it
// burns off. Earth and stones thrown up and raining back down over the next second, clods
// thumping and stones ticking, a bit of metal ringing among them from the bigger ones. And all
// of it sent back off the treeline, darker, over a rumble that swells and settles.
function explosion(sr: number, r: R, scale: number): Buf {
  const b = new Buf(sr, 1.8 + scale * 1.6);
  const nw = 0.0025 * Math.sqrt(scale), nn = Math.ceil(nw * sr);
  for (let i = 0; i < nn; i++) { const u = i / nn; b.d[i] += (1 - 2 * u) * Math.min(1, u * 12, (1 - u) * 12) * 1.1; }
  roar(b, r, 0, 1.3 * scale, 4200, 140, 0.001, 0.14 * scale, 1.1, 4.5);
  roar(b, r, 0.015, 0.9 * scale, 900, 200, 0.02, 0.25 * scale, 0.6, 2);
  thud(b, r, 0, 70 / Math.sqrt(scale), 22, 0.3 * scale, 1.4, 0.15, 250);
  crackle(b, r, 0.03, 0.6 * scale, 110, 1500, 5000, 0.2);
  const lp = new LP1(sr), lp2 = new LP1(sr), swell = slowNoise(r, sr, b.len / sr, 5);
  const comp = Math.sqrt(sr / (2 * 220));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    b.d[i] += lp2.run(lp.run(r() * 2 - 1, 220), 220) * comp * (0.8 + 0.3 * swell[i]) * ad(t, 0.03, 0.9 * scale) * 0.55;
  }
  // What was thrown up comes down: clods first, stones after.
  for (let k = 0; k < Math.round(10 * scale); k++) {
    const u = r();
    thud(b, r, 0.3 + u * 0.9 * scale, 150 + r() * 120, 70, 0.012, 0.16 * (1 - u * 0.6), 0.9, 900);
  }
  debris(b, r, 0.35, 1.2 * scale, Math.round(22 * scale), 1400, 5000, 0.13);
  if (scale >= 1) for (let k = 0; k < Math.round(2 * scale); k++) {
    const f = 1500 + r() * 1500;
    ping(b, 0.5 + r() * 0.8 * scale, [f, f * 2.71, f * 4.13], 0.06, 0.05);
  }
  const dry = b.d.slice(0, Math.ceil(sr * 0.5));
  for (const [d, g] of [[0.28, 0.26], [0.65, 0.13], [1.2, 0.06]] as const) {
    const a = new LP1(sr), c = new LP1(sr), o = Math.floor(jit(r, d, 0.15) * sr);
    for (let i = 0; i < dry.length && o + i < b.len; i++) b.d[o + i] += c.run(a.run(dry[i], 800), 800) * g;
  }
  return b.normalize(0.95).fadeOut(0.3);
}

function concussion(sr: number, r: R, big: boolean): Buf {
  const b = new Buf(sr, big ? 1.8 : 1.1);
  thud(b, r, 0, big ? 60 : 75, 26, big ? 0.18 : 0.12, 1.2, 0.4, 500);
  roar(b, r, 0, 0.6, 700, 120, 0.004, big ? 0.12 : 0.08, 0.8, 2.5);
  whoosh(b, r, 0, 0.35, 900, 200, 0.4, 0.8);
  if (big) debris(b, r, 0.08, 0.9, 16, 900, 3500, 0.15);
  roar(b, r, 0.02, 1.2, 400, 120, 0.04, big ? 0.6 : 0.35, 0.35);
  return b.normalize(0.9).fadeOut(0.1);
}

// Thunder near enough to matter: the channel crackles along its length as it forms, ripping
// faster and faster into the clap, a crack and a boom felt in the chest. Then the roll: the
// same clap arriving again from each stretch of the bolt further off, later and darker,
// swelling and fading unevenly for seconds over a deep bed. Now and then it is further off,
// all roll and no rip.
function thunder(sr: number, r: R): Buf {
  const b = new Buf(sr, 7);
  const near = r() < 0.75, clap = near ? 0.2 + r() * 0.12 : 0.03;
  if (near) {
    for (let t = 0; t < clap;) {
      const u = t / clap;
      click(b, r, t, 1500 + r() * 3500, (0.12 + 0.7 * u * u) * (0.5 + r()), 0.0008 + r() * 0.002);
      t += (0.3 + r() * 1.4) / (50 + 1400 * u * u);
    }
    roar(b, r, clap, 0.5, 6000, 500, 0.0005, 0.04, 1.2, 3);
  }
  roar(b, r, clap, 1.8, near ? 2500 : 900, 160, 0.004, 0.35, 0.9, 2.5);
  thud(b, r, clap, 70, 26, 0.3, near ? 1.3 : 0.8, 0.5, 300);
  let at = clap + 0.25 + r() * 0.2, g = 0.85;
  while (at < 5.6) {
    const dark = Math.min(1, (at - clap) / 5);
    roar(b, r, at, 2, jit(r, 1000 * (1 - 0.75 * dark), 0.3), 90, 0.03 + r() * 0.15, 0.25 + r() * 0.45, g * (0.5 + r() * 0.6), 1.5);
    if (r() < 0.5) thud(b, r, at, 55, 28, 0.2 + r() * 0.2, g * 0.6, 0.6, 250);
    at += 0.18 + r() * 0.7;
    g *= 0.8 + r() * 0.12;
  }
  const lp = new LP1(sr), lp2 = new LP1(sr), swell = slowNoise(r, sr, 7, 2.5), comp = Math.sqrt(sr / (2 * 140));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, s = Math.max(0, 0.5 + swell[i]);
    b.d[i] += lp2.run(lp.run(r() * 2 - 1, 140), 140) * comp * s * s * ad(t - clap, 0.5, 2.2) * 0.6;
  }
  return b.normalize(0.95).fadeOut(0.4);
}

// A frost tower pulses every second, so its sound is short and soft: a cold gust pushed out,
// ice crackling as it forms on whatever it reached, and a glint of glass that dies at once.
// No sustained high tones, which is what made the old one tiring.
function frost(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.9);
  const sv = new SVF(sr), lo = jit(r, 550, 0.1), hi = jit(r, 3400, 0.1);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    sv.run(r() * 2 - 1, lo + (hi - lo) * Math.exp(-t / 0.12), 0.9);
    b.d[i] += (sv.low * 0.5 + sv.band) * ad(t, 0.018, 0.16) * 0.55;
  }
  thud(b, r, 0, 95, 50, 0.05, 0.35, 0.3, 500);
  // The crackle: little sharp ticks, crowded at first and thinning out, each ringing at its
  // own pitch the way ice cracks do.
  for (let k = 0; k < 34; k++) {
    const u = Math.pow(r(), 1.8), f = 1700 + r() * 3600;
    click(b, r, 0.02 + u * 0.55, f, (0.25 + r() * 0.35) * Math.exp(-u * 2.2), 0.0012 + r() * 0.002, f * (0.5 + r() * 0.3));
  }
  const glass = [1870, 2790, 4130].map((f) => jit(r, f, 0.05));
  ping(b, 0.03, glass, 0.12, 0.09);
  return b.normalize(0.75).fadeOut(0.08);
}

// An arc jumping: a hard snap, then the crackle of the spark itself (impulses at a ragged
// 150 to 400 a second, each ringing in the upper mids), a buzz thrown about in pitch and a
// zap falling through it. Bright but kept under 7 kHz, where a tower firing every second
// would hiss.
function tesla(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.35);
  const len = jit(r, 0.2, 0.2);
  const ring = new SVF(sr), buzz = new SVF(sr), top = new LP1(sr), top2 = new LP1(sr), fm = slowNoise(r, sr, 0.35, 80);
  const z0 = jit(r, 3200, 0.15), z1 = jit(r, 500, 0.15);
  let next = 0, ph = 0, zp = 0, rf = 2500, kick = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    const e = t < len ? ad(t, 0.0008, len * 0.45) : ad(t, 0.0008, len * 0.45) * Math.exp(-(t - len) / 0.012);
    if (t >= next) {
      // The next spark: a ragged gap, now and then a longer one where the arc stutters.
      next = t + (r() < 0.12 ? 0.006 + r() * 0.01 : 1 / (150 + r() * 250));
      kick = (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.8);
      rf = 1800 + r() * 3200;
    } else kick = 0;
    ring.run(kick * 12, rf, 6);
    ph += (120 + fm[i] * 70) / sr;
    ph -= Math.floor(ph);
    buzz.run((ph < 0.5 ? 1 : -1) + (r() * 2 - 1) * 0.6, 1300, 1.1);
    zp += TAU * (z1 + (z0 - z1) * Math.exp(-t / 0.03)) / sr;
    const zap = Math.tanh(Math.sin(zp) * 4) * ad(t, 0.001, 0.045) * 0.55;
    const snap = (r() * 2 - 1) * ad(t, 0.0002, 0.0025) * 1.6;
    const x = sat((ring.band * 0.9 + buzz.band * 0.6) * e + zap + snap, 2.2);
    b.d[i] = top2.run(top.run(x, 7000), 7000);
  }
  return b.normalize(0.8).fadeOut(0.03);
}

// --- creeps -------------------------------------------------------------------------------

// The voice each creep kind groans with: walker, runner, swarmer, brute, spitter,
// abomination, hurler, broodmother.
function creepVoice(b: Buf, r: R, at: number, kind: number, scale = 1): void {
  const v = (dur: number, f: number, fe: number, a: Vowel, z: Vowel, rasp: number, jitter: number, gain = 1, am = 0, drive = 1.5) =>
    vox(b, r, at, {
      dur: dur * scale, f0: (u) => f * (1 + 0.14 * Math.sin(Math.PI * Math.min(1, u * 1.6))) + (fe - f) * u, vowel: (u) => lerpV(a, z, u),
      rasp, jitter, a: 0.08, rel: dur * 0.35, gain, am, drive, fry: 0.25 + r() * 0.3, swell: 0.6,
    });
  switch (kind) {
    case 1: v(jit(r, 0.5, 0.2), jit(r, 300, 0.12), 230, V.ae, V.ee, 0.6, 0.1, 0.8, 0, 2); break;
    case 2: v(jit(r, 0.3, 0.2), jit(r, 520, 0.1), 600, V.ee, V.ae, 0.5, 0.15, 0.6, 22); break;
    case 3: v(jit(r, 1.1, 0.15), jit(r, 62, 0.08), 48, V.uh, V.oh, 0.75, 0.1, 1.1, 0, 3); break;
    case 4: v(jit(r, 1, 0.2), jit(r, 95, 0.1), 80, V.uh, V.er, 0.35, 0.08, 0.9, 12); break;
    case 5: v(jit(r, 1.6, 0.1), jit(r, 42, 0.08), 34, V.oh, V.aa, 0.85, 0.12, 1.2, 0, 3.5); break;
    case 6: v(jit(r, 0.9, 0.2), jit(r, 115, 0.1), 90, V.aa, V.uh, 0.45, 0.07, 0.9); break;
    case 7: v(jit(r, 1.5, 0.1), jit(r, 50, 0.08), 40, V.aa, V.er, 0.9, 0.12, 1.2, 9, 3.5); break;
    default: v(jit(r, 1.2, 0.2), jit(r, 92, 0.12), 72, r() < 0.5 ? V.uh : V.er, V.aa, 0.38, 0.07, 0.9); break;
  }
}

const BIG = new Set([3, 5, 7]);

function creepDeath(sr: number, r: R, kind: number): Buf {
  const big = BIG.has(kind), huge = kind === 5 || kind === 7;
  const b = new Buf(sr, huge ? 2.2 : big ? 1.4 : 0.7);
  // Flesh giving way: a wet, overdriven splat with bone crunching in it.
  roar(b, r, 0, 0.5, kind === 2 ? 2400 : 1500, 250, 0.002, big ? 0.12 : 0.07, 1, 3);
  debris(b, r, 0, 0.12, big ? 10 : 6, 700, 2200, 0.4);
  thud(b, r, 0, big ? 70 : 130, big ? 35 : 70, big ? 0.1 : 0.04, 0.6, 0.6);
  if (big) {
    creepVoice(b, r, 0.02, kind, 0.7);
    // The body coming down.
    thud(b, r, huge ? 0.65 : 0.4, 55, 25, huge ? 0.3 : 0.18, 1.1, 0.6, 400);
    debris(b, r, huge ? 0.68 : 0.42, 0.5, 12, 600, 2000, 0.2);
  }
  return b.normalize(big ? 0.9 : 0.75).fadeOut(0.05);
}

function creepStrike(sr: number, r: R, big: boolean): Buf {
  const b = new Buf(sr, big ? 0.9 : 0.35);
  if (big) {
    thud(b, r, 0, 75, 32, 0.1, 1.2, 0.7, 700);
    debris(b, r, 0.01, 0.4, 10, 700, 2500, 0.3);
  } else {
    // A blow: the thud of it, a slap of flesh or cloth of a different colour each time, and
    // now and then something cracking.
    thud(b, r, 0, jit(r, 125, 0.3), jit(r, 65, 0.2), jit(r, 0.035, 0.35), 1, jit(r, 0.7, 0.4), jit(r, 1600, 0.4));
    roar(b, r, 0.002, 0.08, jit(r, 2600, 0.4), 700, 0.001, jit(r, 0.012, 0.4), jit(r, 0.35, 0.5));
    click(b, r, r() * 0.01, jit(r, 1100, 0.35), 0.25, 0.006);
    if (r() < 0.4) debris(b, r, 0.005, 0.04, 2, 900, 2400, 0.2);
  }
  return b.normalize(0.8).fadeOut();
}

// Spit: a hack up from the throat, a wet lip-pop as the glob leaves, and the slime bubbling
// and spattering after it.
function spit(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  vox(b, r, 0, { dur: 0.13, f0: (u) => 95 + 60 * u, vowel: (u) => lerpV(V.uh, [500, 1300, 2500], u), rasp: 0.9, jitter: 0.15, a: 0.008, rel: 0.03, gain: 0.45, am: 45 });
  roar(b, r, 0.01, 0.12, 2800, 1200, 0.01, 0.04, 0.35, 2.5);
  const pop = 0.13 + r() * 0.01;
  thud(b, r, pop, 420, 160, 0.01, 0.7, 0.3, 2000);
  click(b, r, pop, 1600, 0.3, 0.004);
  // Bubbles: little sines rising fast as each pops, thinning out.
  for (let k = 0; k < 14; k++) {
    const at = pop + 0.01 + (-Math.log(1 - r() * 0.9) / 3) * 0.25, f0 = 350 + r() * 700, d = 0.006 + r() * 0.012, g = 0.25 * (0.4 + r() * 0.6);
    const o = Math.floor(at * sr);
    let ph = 0;
    for (let i = 0; i < Math.ceil(d * 3 * sr) && o + i < b.len; i++) {
      const t = i / sr;
      ph += TAU * f0 * (1 + 2.5 * t / d) / sr;
      b.d[o + i] += Math.sin(ph) * ad(t, 0.001, d) * g * Math.exp(-(at - pop) * 4);
    }
  }
  roar(b, r, pop + 0.01, 0.2, 1800, 500, 0.005, 0.05, 0.3);
  return b.normalize(0.7).fadeOut();
}

// Bone: torn out of the hurler with a crunch and a strained grunt, then thrown, the shard
// tumbling through the air; and where it lands, a hard crack, splinters and a hollow clatter.
function boneThrow(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.6);
  // The crunch: a dense burst of snaps with a wet squelch under it.
  for (let k = 0; k < 10; k++) click(b, r, r() * 0.07, 1200 + r() * 2200, 0.35 * (0.4 + r() * 0.6), 0.002 + r() * 0.003, 500 + r() * 900);
  roar(b, r, 0, 0.1, 1400, 500, 0.005, 0.03, 0.4, 2);
  vox(b, r, 0.02, { dur: 0.2, f0: (u) => 130 - 45 * u, vowel: () => lerpV(V.uh, V.uh, 0), rasp: 0.7, jitter: 0.1, a: 0.02, rel: 0.08, gain: 0.5 });
  // The swing, then the shard turning over and over: a whoosh chopped as it tumbles.
  const sv = new SVF(sr), o = Math.floor(0.17 * sr), rate = jit(r, 16, 0.15);
  for (let i = 0; i < Math.ceil(0.4 * sr) && o + i < b.len; i++) {
    const t = i / sr;
    sv.run(r() * 2 - 1, 700 + 900 * Math.abs(Math.sin(Math.PI * rate * t)), 1.6);
    b.d[o + i] += sv.band * bump(t, 0.12, 0.13) * (0.35 + 0.65 * Math.abs(Math.sin(Math.PI * rate * t))) * 0.9;
  }
  return b.normalize(0.7).fadeOut();
}
function boneLand(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  click(b, r, 0, 2600, 0.45, 0.003, 1300);
  thud(b, r, 0, 220, 110, 0.025, 0.6, 0.5, 1500);
  debris(b, r, 0.003, 0.12, 9, 2500, 6000, 0.3);
  // Bounces, each a knock of hollow bone, a short woody ring, smaller and sooner.
  let at = 0.11 + r() * 0.03, g = 0.45;
  for (let k = 0; k < 4; k++) {
    const f = jit(r, 1500, 0.15);
    click(b, r, at, f * 1.3, g, 0.004, f * 0.6);
    ping(b, at + 0.001, [f, f * 1.73, f * 2.6], 0.018, g * 0.35);
    at += (0.1 - k * 0.02) * (0.8 + r() * 0.4); g *= 0.55;
  }
  return b.normalize(0.9).fadeOut();
}

// Footsteps, barely there.

// A boot: the heel coming down, then the sole rolling onto the toe, grit crunching under it.
function step(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.22);
  const toe = jit(r, 0.045, 0.25);
  thud(b, r, 0, jit(r, 120, 0.15), 70, 0.014, 0.8, 0.9, 1100);
  thud(b, r, toe, jit(r, 150, 0.15), 90, 0.01, 0.4, 1, 1400);
  roar(b, r, 0.004, 0.08, jit(r, 3000, 0.2), 1100, 0.002, 0.016, 0.25);
  debris(b, r, 0.005, 0.06, 5, 1600, 4200, 0.12);
  debris(b, r, toe, 0.04, 3, 2000, 4500, 0.08);
  return b.normalize(0.65).fadeOut();
}

// A dead foot: dragged through the dirt as much as lifted, then slapped down, bare skin.
function creepStep(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.34);
  const drag = jit(r, 0.13, 0.3);
  roar(b, r, 0, drag, 1500, 600, drag * 0.6, drag * 0.25, 0.25);
  const at = drag * 0.85, sv = new SVF(sr), o = Math.floor(at * sr);
  for (let i = 0; i < sr * 0.04 && o + i < b.len; i++) b.d[o + i] += sv.run(r() * 2 - 1, 1100, 1.2).band * ad(i / sr, 0.0005, 0.006) * 1.2;
  thud(b, r, at, jit(r, 95, 0.15), 55, 0.02, 0.7, 0.8, 700);
  return b.normalize(0.6).fadeOut();
}

// A big one's weight landing: a deep thump in the ground, the dirt crushed and spraying.
function bigStep(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  thud(b, r, 0, jit(r, 58, 0.1), 26, 0.08, 1.3, 0.6, 400);
  roar(b, r, 0.004, 0.35, 1100, 180, 0.003, 0.06, 0.5, 2);
  debris(b, r, 0.02, 0.3, 9, 500, 2200, 0.14);
  return b.normalize(0.8).fadeOut();
}

// --- survivors ----------------------------------------------------------------------------

// pitch: 1 a man's voice, about 1.7 a woman's.
function shout(sr: number, r: R, pitch: number): Buf {
  const b = new Buf(sr, 0.6);
  // "Hey!": breath first, then the vowel sliding up and falling away.
  whoosh(b, r, 0, 0.07, 1400, 1800, 0.25, 0.7);
  vox(b, r, 0.04, {
    dur: 0.42, f0: (u) => pitch * (u < 0.25 ? 180 + 260 * u : 245 - 90 * (u - 0.25)), vowel: (u) => lerpV(V.eh, V.ey, Math.min(1, u * 1.5)),
    rasp: 0.12, jitter: 0.02, a: 0.02, rel: 0.15, gain: 1, drive: 2,
  });
  return b.normalize(0.85).fadeOut();
}
function grunt(sr: number, r: R, pitch: number): Buf {
  const b = new Buf(sr, 0.35);
  thud(b, r, 0, 110, 60, 0.03, 0.6, 0.6, 1200);
  vox(b, r, 0.01, { dur: jit(r, 0.2, 0.2), f0: (u) => pitch * (150 - 35 * u), vowel: () => [...V.uh], rasp: 0.3, jitter: 0.05, a: 0.01, rel: 0.09, gain: 0.8, drive: 2 });
  return b.normalize(0.75).fadeOut();
}
function downed(sr: number, r: R, pitch: number): Buf {
  const b = new Buf(sr, 1.4);
  vox(b, r, 0, { dur: 0.9, f0: (u) => pitch * (170 - 85 * u), vowel: (u) => lerpV(V.aa, V.uh, u), rasp: 0.3, jitter: 0.06, a: 0.03, rel: 0.4, gain: 0.9, drive: 2 });
  thud(b, r, 0.55, 70, 35, 0.09, 1, 0.7, 600);
  return b.normalize(0.85).fadeOut();
}
function revived(sr: number, r: R, pitch: number): Buf {
  const b = new Buf(sr, 0.9);
  // A gasp in, and a breath out.
  whoosh(b, r, 0, 0.4, 900, 2600, 0.7, 1.4);
  vox(b, r, 0.42, { dur: 0.3, f0: (u) => pitch * (135 - 25 * u), vowel: () => [...V.uh], rasp: 0.55, jitter: 0.04, a: 0.03, rel: 0.2, gain: 0.5 });
  return b.normalize(0.7).fadeOut();
}

// Reloading, the way each gun is: [start, end]. Built of clicks, metal sliding on metal and
// clacks, the heavy parts going home, which are what make a reload sound solid.
function reload(sr: number, r: R, w: number, end: boolean): Buf {
  const b = new Buf(sr, 0.8);
  switch (w) {
    case 0: // pistol: the release pressed, the magazine out and clattering down; in, seated, and the slide let go
      if (!end) {
        click(b, r, 0, 3200, 0.5, 0.002, 1600); slide(b, r, 0.01, 0.06, 2600, 0.35);
        clack(b, r, 0.3, 1800, 0.35, 420); click(b, r, 0.37, 2300, 0.15, 0.002, 1200);
      } else {
        slide(b, r, 0, 0.05, 2200, 0.35); clack(b, r, 0.05, 1600, 0.8, 260); clack(b, r, 0.24, 2400, 1.1, 340);
      }
      break;
    case 1: // shotgun: a shell thumbed into the tube; the pump racked back to its stop and slammed forward
      if (!end) { slide(b, r, 0, 0.06, 1400, 0.45); clack(b, r, 0.06, 1300, 0.6, 220); } else {
        click(b, r, 0, 1800, 0.6, 0.003, 500); slide(b, r, 0.01, 0.08, 1500, 0.5); clack(b, r, 0.09, 1400, 0.9, 200);
        slide(b, r, 0.15, 0.06, 1700, 0.45); clack(b, r, 0.21, 2000, 1.2, 260);
      }
      break;
    case 2: // SMG: the magazine out; in and slapped home, then the charging handle drawn and let fly
      if (!end) { click(b, r, 0, 3000, 0.5, 0.002, 1400); slide(b, r, 0.01, 0.05, 2600, 0.35); clack(b, r, 0.07, 1700, 0.45, 300); } else {
        slide(b, r, 0, 0.04, 2200, 0.3); clack(b, r, 0.04, 1500, 0.8, 240); thud(b, r, 0.045, 160, 110, 0.02, 0.4, 0.8, 900);
        click(b, r, 0.2, 2600, 0.5, 0.003, 1100); slide(b, r, 0.21, 0.05, 2800, 0.35); clack(b, r, 0.29, 2200, 1.1, 320);
      }
      break;
    case 3: // rifle: the bolt lifted and drawn to its stop; a clip of rounds pressed in, the bolt run home and turned down
      if (!end) { click(b, r, 0, 2600, 0.6, 0.003, 900); slide(b, r, 0.03, 0.09, 2400, 0.45); clack(b, r, 0.12, 1900, 0.6, 300); } else {
        slide(b, r, 0, 0.12, 1800, 0.35);
        for (let k = 0; k < 5; k++) click(b, r, 0.01 + k * 0.022 + r() * 0.006, 2400 + r() * 800, 0.25, 0.002, 1700);
        ping(b, 0.15, [3100, 4600], 0.02, 0.08);
        slide(b, r, 0.2, 0.08, 2600, 0.45); clack(b, r, 0.28, 1700, 1, 320); click(b, r, 0.34, 3000, 0.7, 0.003, 1000);
      }
      break;
    case 4: // minigun: the feed cover unlatched, the empty box out and dropped; the belt fed link by link, the cover slammed and the barrels given a turn
      if (!end) {
        clack(b, r, 0, 1100, 0.6, 200); slide(b, r, 0.1, 0.1, 1200, 0.3);
        thud(b, r, 0.3, 140, 80, 0.05, 0.9, 0.6, 700); debris(b, r, 0.31, 0.15, 6, 1500, 3500, 0.25);
      } else {
        for (let k = 0; k < 10; k++) click(b, r, k * 0.022, 1600 + r() * 900, 0.35, 0.0025, 1100 + r() * 600);
        clack(b, r, 0.25, 1000, 1.2, 180); thud(b, r, 0.25, 120, 70, 0.06, 0.8, 0.5, 600);
        const o = Math.floor(0.36 * sr);
        let ph = 0;
        for (let i = 0; i < 0.35 * sr; i++) {
          const t = i / sr;
          ph += (200 + 900 * Math.min(1, t / 0.15)) / sr; ph -= Math.floor(ph);
          b.d[o + i] += (1 - 2 * ph) * ad(t, 0.05, 0.08) * 0.12;
        }
      }
      break;
    case 5: // rocket launcher: the tube's latch opened, the tube hollow; a rocket slid in, latched, and armed
      if (!end) { clack(b, r, 0, 900, 0.6, 180); ping(b, 0.005, [310, 760, 1290], 0.09, 0.15); } else {
        slide(b, r, 0, 0.2, 1000, 0.55); ping(b, 0.02, [290, 700], 0.12, 0.08); clack(b, r, 0.21, 1100, 1, 170);
        pip(b, 0.38, 2100, 0.04, 0.1); pip(b, 0.44, 2800, 0.06, 0.1);
      }
      break;
  }
  return b.normalize(0.8).fadeOut();
}

// Changing guns: the one in hand slung with a rustle of webbing, the other drawn, its grip
// slapped into the palm and the safety thumbed off.
function weaponSwitch(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.4);
  roar(b, r, 0, 0.12, 3000, 1400, 0.02, 0.04, 0.45);
  slide(b, r, 0.06, 0.09, 1800, 0.35);
  thud(b, r, 0.15, 210, 120, 0.015, 0.7, 0.8, 1800);
  clack(b, r, 0.15, 1600, 0.5, 350);
  click(b, r, 0.23 + r() * 0.02, 3200, 0.5, 0.0015, 2100);
  return b.normalize(0.8).fadeOut();
}

// Patching up: the pouch's velcro ripped open, a dressing's packet torn, a hiss of
// antiseptic and the bandage pulled tight.
function medkit(sr: number, r: R): Buf {
  const b = new Buf(sr, 1);
  const sv = new SVF(sr), lo = new SVF(sr);
  for (let i = 0; i < sr * 0.3; i++) {
    // Velcro: hooks letting go in bursts, faster in the middle of the pull.
    const t = i / sr, p = 0.15 + 0.35 * bump(t, 0.14, 0.08);
    const x = r() < p ? (r() * 2 - 1) * 3 : 0;
    b.d[i] += (sv.run(x, 3000, 1.2).band + lo.run(x, 1300, 1).band * 0.5) * bump(t, 0.14, 0.1) * 0.6;
  }
  crackle(b, r, 0.34, 0.12, 400, 4000, 7000, 0.25);
  const hs = new SVF(sr), o = Math.floor(0.5 * sr);
  for (let i = 0; i < sr * 0.22 && o + i < b.len; i++) b.d[o + i] += hs.run(r() * 2 - 1, 5200, 0.8).band * ad(i / sr, 0.01, 0.08) * 0.3;
  whoosh(b, r, 0.72, 0.16, 1200, 2200, 0.35, 1);
  thud(b, r, 0.8, 200, 130, 0.012, 0.2, 0.9, 1500);
  return b.normalize(0.7).fadeOut();
}

// The ears ringing after a slam knocks you flat.
function tinnitus(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.8);
  const f = jit(r, 3700, 0.05);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    b.d[i] = Math.sin(TAU * f * t) * ad(t, 0.05, 0.7) * 0.4;
  }
  thud(b, r, 0, 60, 30, 0.2, 0.8, 0.3, 300);
  return b.normalize(0.5).fadeOut(0.1);
}

// --- the base -----------------------------------------------------------------------------

// Paying: a handful of coins tipped onto a pile, each strike two coins' own high modes ringing
// briefly, the clinks thinning as they settle, and the last one spinning down on its edge.
function coins(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.9);
  thud(b, r, 0, 260, 160, 0.015, 0.35, 0.8, 1500);
  let t = 0;
  for (let k = 0; k < 12; k++) {
    t += 0.008 + r() * 0.035 * (1 + k * 0.15);
    const f = jit(r, 2500, 0.25);
    ping(b, t, [f, f * 1.47, f * 2.09, f * 2.63], 0.03 + r() * 0.03, 0.3 * (1 - k / 16));
    click(b, r, t, 1800, 0.12, 0.002);
  }
  const f = jit(r, 2300, 0.1);
  for (let s = t + 0.05, gap = 0.06; gap > 0.008 && s < 0.85; s += gap, gap *= 0.8) ping(b, s, [f, f * 1.47], 0.02, 0.12);
  return b.normalize(0.7).fadeOut();
}

// An upgrade: an impact gun run up on a bolt, its hammer rattling the nut tight in two bursts
// over the air motor's whine, then the new part seated with a clank.
function upgrade(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.8);
  const rate = jit(r, 28, 0.1), f = jit(r, 1180, 0.08), mf = jit(r, 800, 0.1);
  const bursts = [[0, 0.13], [0.19, 0.38]];
  for (const [s, e] of bursts) {
    for (let t = s + 0.02; t < e; t += 1 / rate) clack(b, r, t, 2200 + r() * 300, 0.3, 500);
    const o = Math.floor(s * sr), n = Math.ceil((e - s) * sr), hs = new SVF(sr);
    let ph = 0;
    for (let i = 0; i < n && o + i < b.len; i++) {
      const u = i / n;
      ph += TAU * mf * (1 + 0.5 * Math.min(1, u * 4)) / sr;
      const env = Math.min(1, u * 10, (1 - u) * 6);
      b.d[o + i] += (Math.sin(ph) * 0.25 + Math.sin(ph * 2.01) * 0.12 + hs.run(r() * 2 - 1, 4500, 0.8).band * 0.15) * env;
    }
  }
  const seat = 0.44;
  ping(b, seat, [f, f * 2.43, f * 3.65], 0.12, 0.6);
  thud(b, r, seat, 240, 150, 0.03, 0.6, 0.5);
  return b.normalize(0.75).fadeOut();
}

// Building: a hammer driving a nail into a plank, the steel's ring rising as the nail goes in,
// the plank's knock under it, and the last blow a dead thump as the head meets the wood.
function hammer(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.8);
  const nail = jit(r, 2900, 0.06), plank = jit(r, 520, 0.08);
  [0, 0.17, 0.33].forEach((at, k) => {
    at += k ? (r() - 0.5) * 0.03 : 0;
    const last = k === 2;
    thud(b, r, at, plank * 0.5, plank * 0.32, 0.018, last ? 1 : 0.7, 0.7, 2500);
    ping(b, at, [plank, plank * 1.58, plank * 2.37], last ? 0.05 : 0.035, last ? 0.45 : 0.3);
    if (!last) ping(b, at, [nail * (1 + k * 0.08), nail * 2.32 * (1 + k * 0.08)], 0.05, 0.25);
    click(b, r, at, last ? 1800 : 3200, 0.6, 0.0015);
  });
  return b.normalize(0.85).fadeOut();
}

function crumble(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.9);
  thud(b, r, 0, 70, 30, 0.2, 1.1, 0.6, 500);
  roar(b, r, 0, 1.6, 1400, 180, 0.01, 0.45, 0.9, 2.5);
  debris(b, r, 0.03, 1.3, 40, 600, 3200, 0.35);
  ping(b, 0.1, [430, 1110, 1750], 0.15, 0.2);
  return b.normalize(0.85).fadeOut(0.1);
}

// A supply drop landing: the crate hitting the ground hard, its planks booming and rattling in
// their straps, a buckle ringing, dirt kicked up, the crate rocking back once, and the
// parachute settling over it with a soft, fluttering rush of cloth.
function crateLand(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.4);
  thud(b, r, 0, 100, 42, 0.09, 1.2, 0.8, 600);
  ping(b, 0.002, [jit(r, 175, 0.05), 290, 445, 610], 0.07, 0.45);
  roar(b, r, 0, 0.4, 1600, 300, 0.003, 0.08, 0.5, 2);
  debris(b, r, 0.01, 0.3, 10, 700, 2500, 0.3);
  ping(b, 0.03, [2100, 3400, 5200], 0.08, 0.06);
  clack(b, r, 0.12 + r() * 0.03, 900, 0.35, 160);
  thud(b, r, 0.22, 120, 60, 0.03, 0.4, 0.7, 700);
  const sv = new SVF(sr), flap = slowNoise(r, sr, 1, 11), o = Math.floor(0.3 * sr);
  for (let i = 0; i < sr * 0.9 && o + i < b.len; i++) {
    const t = i / sr;
    sv.run(r() * 2 - 1, 700 - 300 * t, 0.7);
    b.d[o + i] += sv.band * bump(t, 0.3, 0.22) * (0.6 + 0.4 * flap[i]) * 0.35;
  }
  return b.normalize(0.85).fadeOut();
}

// --- loot and the map ---------------------------------------------------------------------

// A find: the lid's latch knocked up and its hinge creaking, then two glockenspiel bars a fifth
// apart; which fifth, and how quickly, changes from find to find. A jackpot throws the lid
// open, runs up a chord and rains coins.
function lootFound(sr: number, r: R, jackpot: boolean): Buf {
  const b = new Buf(sr, jackpot ? 1.7 : 1.1);
  clack(b, r, 0, 1300 + r() * 400, 0.4, 260);
  // The hinge: stick and slip, a pulse train wandering in rate through the wood's resonance.
  const sv = new SVF(sr), crk = slowNoise(r, sr, 0.3, 12), cl = jackpot ? 0.12 : 0.18;
  let ph = 0;
  for (let i = Math.floor(0.03 * sr), n = Math.floor((0.03 + cl) * sr); i < n; i++) {
    const t = i / sr - 0.03;
    ph += (90 + 60 * crk[i]) / sr;
    const x = ph >= 1 ? 1 : 0;
    if (ph >= 1) ph -= 1;
    b.d[i] += sv.run(x * 4 + (r() * 2 - 1) * 0.1, 950, 3).band * Math.sin(Math.PI * t / cl) * 0.5;
  }
  const at = 0.06 + cl, root = jackpot ? 784 : [880, 784, 988][Math.floor(r() * 3)];
  const notes = jackpot ? [784, 988, 1175, 1568] : [root, root * 1.498];
  notes.forEach((f, k) => {
    const s = at + k * (jackpot ? 0.09 : jit(r, 0.11, 0.25));
    ping(b, s, [f, f * 2.76, f * 5.4], jackpot ? 0.55 : 0.4, 0.5);
    click(b, r, s, f * 3, 0.15, 0.001);
  });
  if (jackpot) {
    thud(b, r, at, 140, 70, 0.04, 0.4, 0.5);
    for (let k = 0; k < 10; k++) { const f = jit(r, 2500, 0.25); ping(b, at + 0.05 + r() * 0.5, [f, f * 1.47, f * 2.09], 0.04, 0.15); }
  }
  return b.normalize(0.65).fadeOut(0.1);
}

function bell(sr: number, r: R): Buf {
  const note = new Buf(sr, 4);
  bellNote(note, r, 0, 262, 4, 0.5);
  note.fadeOut(0.6);
  const b = new Buf(sr, 8);
  for (const at of [0, 2.1, 4.2]) {
    const o = Math.floor(at * sr);
    for (let i = 0; i < note.len && o + i < b.len; i++) b.d[o + i] += note.d[i];
  }
  return b.normalize(0.9).fadeOut(0.5);
}

function ambush(sr: number, r: R): Buf {
  const b = new Buf(sr, 2);
  thud(b, r, 0, 90, 40, 0.1, 0.8, 0.7, 600);
  debris(b, r, 0, 0.4, 10, 700, 2500, 0.3);
  creepVoice(b, r, 0.05, 1);
  creepVoice(b, r, 0.2, 0, 0.9);
  creepVoice(b, r, 0.35, 1, 0.8);
  creepVoice(b, r, 0.5, 0);
  return b.normalize(0.85).fadeOut(0.1);
}

function alert(sr: number, r: R): Buf {
  const b = new Buf(sr, 1);
  creepVoice(b, r, 0, r() < 0.5 ? 1 : 0, 0.8);
  return b.normalize(0.75).fadeOut();
}

function bile(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.2);
  roar(b, r, 0, 0.8, 1200, 200, 0.003, 0.15, 1, 3);
  thud(b, r, 0, 90, 45, 0.08, 0.8, 0.5);
  for (let k = 0; k < 10; k++) {
    const at = 0.05 + r() * 0.6, f = 250 + r() * 350;
    const o = Math.floor(at * sr);
    for (let i = 0; i < sr * 0.05 && o + i < b.len; i++) { const t = i / sr; b.d[o + i] += Math.sin(TAU * f * t * (1 - t * 6)) * ad(t, 0.002, 0.012) * 0.3; }
  }
  return b.normalize(0.85).fadeOut();
}

function retch(sr: number, r: R): Buf {
  const b = new Buf(sr, 1);
  vox(b, r, 0, { dur: 0.8, f0: (u) => 70 + 30 * Math.sin(u * 9), vowel: (u) => lerpV(V.uh, V.aa, u), rasp: 0.8, jitter: 0.15, a: 0.1, rel: 0.3, gain: 1, am: 14, drive: 3 });
  return b.normalize(0.8).fadeOut();
}

function sizzle(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.1);
  const sv = new SVF(sr);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    sv.run((r() < 0.25 ? 1 : 0.2) * (r() * 2 - 1), 5000, 0.8);
    b.d[i] = sv.high * ad(t, 0.05, 0.35);
  }
  return b.normalize(0.5).fadeOut();
}

function ignite(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.4);
  // Fuel catching all at once: a swelling roar opening up, then the crackle settling in.
  const sv = new SVF(sr);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    sv.run(r() * 2 - 1, 150 + 2200 * (1 - Math.exp(-t / 0.12)) * Math.exp(-t / 0.8), 0.7);
    b.d[i] += sat(sv.low * 2 * ad(t, 0.1, 0.45), 2);
  }
  debris(b, r, 0.1, 1, 20, 1500, 4000, 0.3);
  return b.normalize(0.85).fadeOut(0.1);
}

// A grenade thrown: the pin's ring scraping out with a tink, the spoon flying off and
// spinning away ringing, and the arm swung through.
function grenadeThrow(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  slide(b, r, 0, 0.05, 3600, 0.25);
  click(b, r, 0.045, 4200, 0.5, 0.002, 2900);
  ping(b, 0.047, [2900, 4400, 6900], 0.05, 0.25);
  const spoon = 0.2 + r() * 0.03;
  clack(b, r, spoon, 3000, 0.45, 600);
  const f = jit(r, 3700, 0.06);
  for (let i = 0; i < Math.ceil(0.4 * sr); i++) {
    const t = i / sr, o = Math.floor(spoon * sr) + i;
    if (o >= b.len) break;
    // A strip of steel spinning: its ring swept in and out as it turns.
    b.d[o] += Math.sin(TAU * f * t * (1 - 0.03 * t)) * Math.exp(-t / 0.12) * (0.5 + 0.5 * Math.abs(Math.sin(TAU * 22 * t))) * 0.12;
  }
  whoosh(b, r, 0.28, 0.32, 300, 1600, 0.9, 0.9);
  return b.normalize(0.9).fadeOut();
}

// A dash: the boot driving off with grit kicked up, the air ripped past in a rising rush, and
// a skid in the dirt where it stops.
function dash(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.6);
  thud(b, r, 0, 130, 60, 0.025, 0.6, 0.8, 1200);
  debris(b, r, 0.005, 0.06, 6, 1800, 4500, 0.15);
  whoosh(b, r, 0.01, 0.3, 300, 3200, 1.2, 0.7);
  whoosh(b, r, 0.05, 0.22, 900, 5000, 0.4, 2);
  roar(b, r, 0.26, 0.25, 3000, 900, 0.01, 0.07, 0.35);
  debris(b, r, 0.27, 0.15, 8, 1500, 4000, 0.12);
  thud(b, r, 0.27, 110, 60, 0.02, 0.35, 0.8, 1200);
  return b.normalize(0.65).fadeOut();
}

// Jets going over// Jets going over for an airstrike: the roar climbing as they come, a Doppler fall as they
// pass right overhead, and a long rumble going away.
function jets(sr: number, r: R): Buf {
  const b = new Buf(sr, 4.2);
  const sv = new SVF(sr), lp = new LP1(sr), comp = Math.sqrt(sr / (2 * 250));
  let ph = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, near = bump(t, 2.2, 0.8);
    sv.run(r() * 2 - 1, 300 + 3200 * near, 0.7);
    const f = 2400 - 1100 * (1 / (1 + Math.exp(-(t - 2.2) * 6)));
    ph += TAU * f / sr;
    b.d[i] = sv.low * near * 0.9 + lp.run(r() * 2 - 1, 250) * comp * bump(t, 2.4, 1.2) * 0.4 + Math.sin(ph) * bump(t, 2.1, 0.45) * 0.12;
  }
  return b.normalize(0.85).fadeOut(0.2);
}

// --- the game's own -----------------------------------------------------------------------

// The air-raid siren: the motor winding up, holding, and winding down when it is cut.
function sirenWave(sr: number, r: R): Buf {
  return siren(sr, r, 6, 560, (t) => t < 3.4 ? 60 + 500 * (1 - Math.exp(-t / 0.9)) : 60 + 495 * Math.exp(-(t - 3.4) / 1.5),
    (t) => Math.min(1, t / 0.3) * (t > 4.2 ? Math.max(0, (6 - t) / 1.8) : 1));
}
// The all clear: wound up quickly to one steady, lower tone, and let go.
function sirenClear(sr: number, r: R): Buf {
  return siren(sr, r, 4.5, 450, (t) => t < 3 ? 60 + 390 * (1 - Math.exp(-t / 0.5)) : 60 + 388 * Math.exp(-(t - 3) / 1),
    (t) => Math.min(1, t / 0.2) * (t > 3.2 ? Math.max(0, (4.5 - t) / 1.3) : 1) * 0.8);
}
// The end: the siren already screaming, its power gone, groaning all the way down.
function sirenOver(sr: number, r: R): Buf {
  return siren(sr, r, 5.5, 560, (t) => 35 + 525 * Math.exp(-t / 1.7), (t) => Math.min(1, t / 0.1) * Math.max(0, 1 - t / 5.5));
}

// The generator's alarm: a two-tone klaxon, the base calling for help.
function klaxon(sr: number): Buf {
  const b = new Buf(sr, 1);
  const lp = new LP1(sr);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, f = t % 0.5 < 0.25 ? 440 : 349;
    const x = Math.tanh(Math.sin(TAU * f * t) * 3) + 0.4 * Math.tanh(Math.sin(TAU * f * 2.01 * t) * 2);
    b.d[i] = lp.run(x, 2200) * Math.min(1, t / 0.01, (1 - t) / 0.08);
  }
  return b.normalize(0.6);
}

function beep(sr: number, last: boolean): Buf {
  const b = new Buf(sr, 0.25);
  pip(b, 0, last ? 1480 : 990, last ? 0.2 : 0.08, 0.5);
  return b;
}

// The walkie-talkie: a chirp and static, the way a teammate's voice or ping comes in.
function radio(sr: number, r: R, kind: string): Buf {
  const b = new Buf(sr, 0.45);
  switch (kind) {
    case 'chat': pip(b, 0, 1250, 0.04, 0.3); hiss(b, r, 0.05, 0.12, 0.35); break;
    case 'here': pip(b, 0, 1400, 0.05, 0.35); pip(b, 0.08, 1400, 0.05, 0.35); break;
    case 'danger': for (let k = 0; k < 3; k++) pip(b, k * 0.07, 1900, 0.045, 0.35, true); break;
    case 'loot': pip(b, 0, 1100, 0.06, 0.35); pip(b, 0.08, 1650, 0.08, 0.35); break;
    case 'defend': pip(b, 0, 1650, 0.06, 0.35); pip(b, 0.08, 1100, 0.06, 0.35); pip(b, 0.16, 1100, 0.06, 0.35); break;
    case 'good': hiss(b, r, 0, 0.06, 0.2); pip(b, 0.07, 1050, 0.05, 0.3); pip(b, 0.13, 1570, 0.08, 0.3); break;
    case 'bad': hiss(b, r, 0, 0.08, 0.25); pip(b, 0.09, 620, 0.08, 0.35, true); pip(b, 0.19, 470, 0.12, 0.35, true); break;
    case 'error': pip(b, 0, 160, 0.07, 0.45, true); pip(b, 0.09, 140, 0.09, 0.45, true); break;
  }
  return b.fadeOut();
}

// --- loops --------------------------------------------------------------------------------

// The Huey: blade slap at eleven beats a second over a turbine's whine. Two seconds of whole
// beats and whole cycles, so it loops without a seam.
function rotor(sr: number, r: R): Buf {
  const b = new Buf(sr, 2);
  const lp = new LP1(sr), comp = Math.sqrt(sr / (2 * 300));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    b.d[i] = lp.run(r() * 2 - 1, 300) * comp * 0.25 + Math.sin(TAU * 1100 * t) * 0.03 + Math.sin(TAU * 2200 * t) * 0.012;
  }
  for (let k = 0; k < 22; k++) {
    const at = k / 11;
    roar(b, r, at, 0.08, 700, 250, 0.003, 0.022, 0.9);
    thud(b, r, at, 85, 60, 0.025, 0.5, 0, 300);
  }
  return b.normalize(0.8);
}

// Fire: a low roar with crackles and the odd snap, cross-faded into its own start.
function fire(sr: number, r: R): Buf {
  const len = 3, xf = 0.3;
  const b = new Buf(sr, len + xf);
  const lp = new LP1(sr), comp = Math.sqrt(sr / (2 * 350)), swell = slowNoise(r, sr, len + xf, 2);
  for (let i = 0; i < b.len; i++) b.d[i] = lp.run(r() * 2 - 1, 350) * comp * (0.7 + 0.3 * swell[i]) * 0.35;
  for (let k = 0; k < 90; k++) click(b, r, r() * (len + xf - 0.05), 1200 + r() * 3500, (0.2 + r() * 0.8) * (r() < 0.08 ? 2.5 : 0.7), 0.0015 + r() * 0.004);
  const out = new Buf(sr, len), n = out.len, x = Math.floor(xf * sr);
  for (let i = 0; i < n; i++) out.d[i] = b.d[i];
  for (let i = 0; i < x; i++) { const u = i / x; out.d[i] = b.d[i] * u + b.d[n + i] * (1 - u); }
  return out.normalize(0.7);
}

// A minigun's motor and six barrels spinning: the motor's whine, the barrels chopping the air
// six times a turn, the gears growling under it and the feed rattling. Played faster or slower
// as it spins up and down. Every tone is a whole number of cycles a second, so it loops.
function spin(sr: number, r: R): Buf {
  const b = seamless(sr, 1, 0.1, (b) => {
    const sv = new SVF(sr);
    for (let i = 0; i < b.len; i++) {
      const t = i / sr, chop = Math.pow(0.5 + 0.5 * Math.sin(TAU * 300 * t), 6);
      b.d[i] = sv.run(r() * 2 - 1, 2200, 0.9).band * (0.15 + chop * 0.5);
    }
    for (let k = 0; k < 40; k++) click(b, r, r() * (b.len / sr - 0.01), 1800 + r() * 2000, 0.12 + r() * 0.1, 0.0015, 1500 + r() * 800);
  });
  const lp = new LP1(sr);
  for (let i = -Math.floor(sr * 0.1); i < b.len; i++) {
    const t = i / sr, saw = 1 - 2 * (((90 * t) % 1 + 1) % 1);
    const y = lp.run(saw, 500) * 0.6 + Math.sin(TAU * 300 * t) * 0.25 + Math.sin(TAU * 1080 * t) * 0.1 + Math.sin(TAU * 1620 * t) * 0.04;
    if (i >= 0) b.d[i] += y;
  }
  return b.normalize(0.6);
}

// --- feedback ------------------------------------------------------------------------------

// Your shot killing something: a short, dry knock, felt more than heard, under the gunfire.
function kill(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.12);
  thud(b, r, 0, jit(r, 260, 0.08), 150, 0.012, 0.8, 0.3, 2500);
  click(b, r, 0, jit(r, 1900, 0.08), 0.6, 0.0025, jit(r, 1250, 0.05));
  return b.normalize(0.7).fadeOut(0.01);
}

// The ultimate charged: two notes rising a fourth through a filter opening, a charge-up.
function ultReady(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  whoosh(b, r, 0, 0.3, 600, 3000, 0.25, 2);
  ping(b, 0.16, [660, 1320, 1985], 0.18, 0.45);
  ping(b, 0.28, [880, 1760, 2645], 0.3, 0.55);
  return b.normalize(0.7).fadeOut(0.05);
}

// A heartbeat, lub-dub, for a survivor nearly down.
function heart(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.45);
  thud(b, r, 0, 75, 45, 0.04, 1, 0.15, 300);
  thud(b, r, 0.17, 65, 40, 0.035, 0.7, 0.15, 300);
  return b.normalize(0.7).fadeOut(0.02);
}

// A big one drawing itself up to strike: a breath in, rising into a growl. The ear's warning
// of what is about to land, at night before the eye's.
function windup(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.6);
  whoosh(b, r, 0, 0.35, 500, 1400, 0.4, 1.5);
  vox(b, r, 0.12, {
    dur: 0.42, f0: (u) => jit(r, 55, 0.08) * (1 + 0.6 * u), vowel: (u) => lerpV(V.uh, V.aa, u),
    rasp: 0.8, jitter: 0.1, a: 0.3, rel: 0.06, gain: 1, drive: 3, fry: 0.4,
  });
  return b.normalize(0.85).fadeOut(0.02);
}

// --- ambience -----------------------------------------------------------------------------

// A loop made of len seconds of make plus xf more, the overhang cross-faded into its start
// so it has no seam.
function seamless(sr: number, len: number, xf: number, make: (b: Buf) => void): Buf {
  const b = new Buf(sr, len + xf);
  make(b);
  const out = new Buf(sr, len), n = out.len, x = Math.floor(xf * sr);
  for (let i = 0; i < n; i++) out.d[i] = b.d[i];
  for (let i = 0; i < x; i++) { const u = i / x; out.d[i] = b.d[i] * Math.sqrt(u) + b.d[n + i] * Math.sqrt(1 - u); }
  return out;
}

// Rain: a soft wash with drops in it, and the low patter of it on the fields. Nothing above
// about 7 kHz, so a long wave in it doesn't hiss.
function rain(sr: number, r: R): Buf {
  return seamless(sr, 5, 0.5, (b) => {
    const sv = new SVF(sr), lo = new LP1(sr), lo2 = new LP1(sr), top = new LP1(sr), swell = slowNoise(r, sr, b.len / sr, 0.7);
    const comp = Math.sqrt(sr / (2 * 400));
    for (let i = 0; i < b.len; i++) {
      const n = r() * 2 - 1;
      const wash = sv.run(n, 2600, 0.6).band;
      const patter = lo2.run(lo.run(r() * 2 - 1, 400), 400) * comp;
      b.d[i] = top.run(wash * 0.5 + patter * 0.35, 7000) * (0.85 + 0.15 * swell[i]);
    }
    for (let k = 0; k < 700; k++) click(b, r, r() * (b.len / sr - 0.02), 1500 + r() * 3500, 0.15 + r() * 0.35, 0.0015 + r() * 0.002);
    b.normalize(0.7);
  });
}

// Wind over open ground: dark noise through a band that wanders up and down with the gusts.
function wind(sr: number, r: R): Buf {
  return seamless(sr, 8, 1, (b) => {
    const sv = new SVF(sr), sv2 = new SVF(sr), gust = slowNoise(r, sr, b.len / sr, 0.35), wob = slowNoise(r, sr, b.len / sr, 1.3);
    for (let i = 0; i < b.len; i++) {
      const g = 0.5 + 0.5 * gust[i], n = r() * 2 - 1;
      const f = 260 + 520 * g + 90 * wob[i];
      b.d[i] = (sv.run(n, f, 1.6).band * 1.2 + sv2.run(n, f * 2.7, 4).band * 0.25 * g) * (0.35 + 0.65 * g);
    }
    b.normalize(0.7);
  });
}

// The night: crickets, a few of them, each chirping in its own time and pitch, and one far
// off. Every period divides the loop, so it has no seam.
function crickets(sr: number, r: R): Buf {
  const len = 6, b = new Buf(sr, len);
  const bugs = [[4300, 6 / 9, 1, 3], [4650, 6 / 7, 0.8, 4], [3950, 6 / 11, 0.55, 3], [4500, 6 / 5, 0.3, 2]];
  for (const [f, period, gain, pulses] of bugs) {
    const ff = jit(r, f, 0.02), off = r() * period;
    for (let at = off; at < len; at += period) {
      for (let k = 0; k < pulses; k++) {
        const o = Math.floor(((at + k * 0.032) % len) * sr), n = Math.floor(0.02 * sr);
        for (let i = 0; i < n; i++) {
          const t = i / sr, e = Math.sin(Math.PI * t / 0.02) ** 2;
          b.d[(o + i) % b.len] += Math.sin(TAU * ff * t) * e * gain * 0.3;
        }
      }
    }
  }
  // A breath of air under them, so they don't sit in silence.
  const air = seamless(sr, len, 0.5, (a) => {
    const lp = new LP1(sr), lp2 = new LP1(sr), comp = Math.sqrt(sr / (2 * 300));
    for (let i = 0; i < a.len; i++) a.d[i] = lp2.run(lp.run(r() * 2 - 1, 300), 300) * comp * 0.05;
  });
  for (let i = 0; i < b.len; i++) b.d[i] += air.d[i];
  return b.normalize(0.6);
}

// The generator at the base: a diesel's firing thrum under a hum and its harmonics, with a
// rattle of the housing. Two seconds of whole cycles.
function hum(sr: number, r: R): Buf {
  const b = new Buf(sr, 2);
  const sv = new SVF(sr), lp = new LP1(sr);
  const noise = new Float32Array(b.len);
  for (let i = 0; i < b.len; i++) noise[i] = r() * 2 - 1;
  // The filters run over the loop's last tenth of a second before its start, so its first
  // sample follows on from its last.
  for (let i = -Math.floor(sr * 0.1); i < b.len; i++) {
    const t = i / sr;
    const fire = Math.pow(0.5 + 0.5 * Math.cos(TAU * 25 * t), 6);
    const tone = Math.sin(TAU * 100 * t) * 0.5 + Math.sin(TAU * 150 * t) * 0.35 + Math.sin(TAU * 200 * t) * 0.2 + Math.sin(TAU * 300 * t) * 0.1;
    const rattle = sv.run(noise[(i + b.len) % b.len], 900, 2).band * fire;
    const y = lp.run(tone * (0.6 + 0.4 * fire) + rattle * 0.6 + Math.sin(TAU * 50 * t) * fire * 0.5, 1500);
    if (i >= 0) b.d[i] = y;
  }
  return b.normalize(0.7);
}

// --- the table ----------------------------------------------------------------------------

type Maker = (sr: number, r: R) => Buf;
const gun = (g: Gun, extra?: (b: Buf, r: R) => void): Maker => (sr, r) => {
  const b = gunshot(sr, r, g);
  extra?.(b, r);
  return b;
};

// name: [variants, maker, rate]. A loop has one variant. rate caps the sample rate a sound is
// made at: the long, low ones (explosions, voices, sirens) lose nothing at 24 kHz and take
// half the memory and half the time to make; a gun's crack needs the full rate.
const LOW = 24000;
export const RECIPES: Record<string, [number, Maker, number?]> = {
  pistol: [4, gun(PISTOL, (b, r) => brass(b, r, 0.3 + r() * 0.08, 0.05))],
  shotgun: [3, gun(SHOTGUN, (b, r) => pump(b, r, 0.36, 0.12))],
  smg: [5, gun(SMG, (b, r) => { clack(b, r, 0.028 + r() * 0.006, 2300 + r() * 300, 0.16, 420); click(b, r, 0.05, 3400, 0.05, 0.002); })],
  rifle: [3, gun(RIFLE, (b, r) => { bolt(b, r, 0.3, 0.14); brass(b, r, 0.5, 0.04); })],
  minigun: [6, gun(MINIGUN)],
  railgun: [3, railgun],
  rocket: [3, (sr, r) => rocketLaunch(sr, r, false)],
  missile: [3, (sr, r) => rocketLaunch(sr, r, true)],
  crowbar: [3, crowbar],
  turretGun: [4, gun(TURRET_GUN, (b, r) => { clack(b, r, 0.035 + r() * 0.005, 2100, 0.12, 380); ping(b, 0.04, [1450, 2310], 0.02, 0.05); servo(b, r, 0.07, 0.14, 0.035); })],
  cannon: [3, gun(CANNON, (b, r) => {
    ping(b, 0.004, [610, 1530, 2470], 0.25, 0.05 + r() * 0.01);
    slide(b, r, 0.06, 0.25, 900, 0.05);
    clack(b, r, 0.34, 1100, 0.18, 160);
    clack(b, r, 0.62, 1500, 0.12, 220);
    ping(b, 0.8 + r() * 0.04, [720, 1690, 2950], 0.09, 0.07);
  })],
  sniper: [3, gun(SNIPER, (b, r) => { bolt(b, r, 0.55, 0.11); brass(b, r, 0.95, 0.04); })],
  pod: [3, pod],
  doorGun: [4, gun(DOORGUN, (b, r) => clack(b, r, 0.045 + r() * 0.008, 1900, 0.1, 340))],
  tesla: [4, tesla],
  explosionS: [3, (sr, r) => explosion(sr, r, 0.7), LOW],
  explosion: [3, (sr, r) => explosion(sr, r, 1), LOW],
  explosionL: [3, (sr, r) => explosion(sr, r, 1.5), LOW],
  concussion: [2, (sr, r) => concussion(sr, r, false), LOW],
  slam: [2, (sr, r) => concussion(sr, r, true), LOW],
  frost: [3, frost],
  thunder: [3, thunder, LOW],
  bell: [1, bell, LOW],
  lootFound: [3, (sr, r) => lootFound(sr, r, false)],
  jackpot: [1, (sr, r) => lootFound(sr, r, true)],
  ambush: [2, ambush, LOW],
  alert: [3, alert, LOW],
  bile: [3, bile, LOW],
  retch: [2, retch, LOW],
  sizzle: [2, sizzle],
  ignite: [2, ignite, LOW],
  grenade: [2, grenadeThrow],
  dash: [2, dash],
  jets: [1, jets, LOW],
  spit: [3, spit],
  boneThrow: [2, boneThrow],
  boneLand: [3, boneLand],
  step: [6, step],
  creepStep: [6, creepStep],
  bigStep: [4, bigStep, LOW],
  strike: [8, (sr, r) => creepStrike(sr, r, false)],
  strikeBig: [3, (sr, r) => creepStrike(sr, r, true), LOW],
  coins: [2, coins],
  upgrade: [3, upgrade],
  hammer: [3, hammer],
  crumble: [3, crumble, LOW],
  crateLand: [1, crateLand, LOW],
  switch: [2, weaponSwitch],
  medkit: [1, medkit],
  tinnitus: [1, tinnitus],
  sirenWave: [2, sirenWave, LOW],
  sirenClear: [2, sirenClear, LOW],
  sirenOver: [2, sirenOver, LOW],
  klaxon: [1, klaxon, LOW],
  beep: [1, (sr) => beep(sr, false)],
  beepGo: [1, (sr) => beep(sr, true)],
  rotor: [1, rotor, LOW],
  fire: [1, fire, LOW],
  spin: [1, spin],
  rain: [1, rain, LOW],
  wind: [1, wind, LOW],
  crickets: [1, crickets],
  hum: [1, hum, LOW],
  kill: [4, kill],
  ultReady: [1, ultReady],
  heart: [1, heart, LOW],
  windup: [4, windup, LOW],
};
// The sounds that loop: played with Synth.loop, made whole, never cut short.
export const LOOPS = new Set(['rotor', 'fire', 'spin', 'rain', 'wind', 'crickets', 'hum']);

// Level corrections in dB, from measuring every sound's loudness (K-weighted, 400 ms) against
// the level it is played at, where one stood far out of line with the rest of its kind: the
// player's shout was the loudest thing in the game, the big ones' groans as loud as a shotgun,
// the reloads lost under the gun they reload, the minigun's dropped ammo box louder than them all,
// a creep's spit and thrown bone lost under the guns firing back, and the switch and the
// hammer, whose sharp first click holds them under the rest.
const TRIM: Record<string, number> = {
  shout_m: -6, shout_f: -6, groan5: -6, groan3: -5, groan7: -4, groan1: -3, retch: -5, ignite: -4.5, windup: -2.5,
  reload4: -3.5, reload1: 2, reload5: 1.5, reloaded0: 1.5, spit: 3, boneThrow: 3, boneLand: 3, dash: 3, grenade: 2, switch: 4, hammer: 2,
  radio_chat: 5, radio_here: 4, radio_danger: 5, radio_loot: 4, radio_defend: 3, radio_good: 4, radio_bad: 4, radio_error: 4, beep: 3,
};
for (const k of ['chat', 'here', 'danger', 'loot', 'defend', 'good', 'bad', 'error']) RECIPES['radio_' + k] = [1, (sr, r) => radio(sr, r, k)];
for (let k = 0; k < 8; k++) {
  RECIPES['groan' + k] = [k === 5 || k === 7 ? 3 : 4, (sr, r) => { const b = new Buf(sr, 2.2); creepVoice(b, r, 0, k); return b.normalize(0.8).fadeOut(); }, LOW];
  RECIPES['death' + k] = [BIG.has(k) ? 2 : 4, (sr, r) => creepDeath(sr, r, k), BIG.has(k) ? LOW : undefined];
}
for (const [s, p] of [['m', 1], ['f', 1.7]] as const) {
  RECIPES['shout_' + s] = [2, (sr, r) => shout(sr, r, p)];
  RECIPES['hurt_' + s] = [4, (sr, r) => grunt(sr, r, p)];
  RECIPES['down_' + s] = [2, (sr, r) => downed(sr, r, p), LOW];
  RECIPES['revived_' + s] = [2, (sr, r) => revived(sr, r, p)];
}
for (let w = 0; w < 6; w++) {
  RECIPES['reload' + w] = [1, (sr, r) => reload(sr, r, w, false)];
  RECIPES['reloaded' + w] = [1, (sr, r) => reload(sr, r, w, true)];
}

// render makes variant v of a sound at the context's rate sr, or the lower one its recipe
// asks for. Seeded by name and variant: the same sound every load.
export function render(name: string, v: number, sr: number): { d: Float32Array; rate: number } {
  const rec = RECIPES[name];
  const rate = Math.min(sr, rec[2] ?? sr);
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const made = rec[1](rate, rng(h + v * 7919));
  // A loop's offset is taken out whole: the filter that does it for the rest would start from
  // rest and leave its first samples off from its last, a click every time round.
  if (LOOPS.has(name)) {
    let m = 0;
    for (const x of made.d) m += x;
    m /= made.len;
    for (let i = 0; i < made.len; i++) made.d[i] -= m;
  } else made.dcBlock();
  let d = made.d;
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  const g = Math.min(0.97 / Math.max(pk, 1e-9), Math.pow(10, (TRIM[name] ?? 0) / 20));
  if (g !== 1) for (let i = 0; i < d.length; i++) d[i] *= g;
  // What is left after the sound has died to 60 dB under its peak is silence held in memory:
  // cut, with a short fade. A loop keeps its length.
  if (!LOOPS.has(name)) {
    let end = d.length;
    while (end > 0 && Math.abs(d[end - 1]) < pk * g * 0.001) end--;
    end = Math.min(d.length, end + Math.floor(rate * 0.01));
    if (end < d.length - rate * 0.05) {
      d = d.slice(0, end);
      const n = Math.min(end, Math.floor(rate * 0.01));
      for (let i = 0; i < n; i++) d[end - 1 - i] *= i / n;
    }
  }
  return { d, rate };
}
