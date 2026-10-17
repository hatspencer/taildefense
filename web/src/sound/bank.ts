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

// A siren wound up by hand or motor: the pitch rides a curve, the tone is rich in odd
// harmonics, and a second rotor a hair out of tune beats against the first.
function siren(sr: number, len: number, pitch: (t: number) => number, env: (t: number) => number): Buf {
  const b = new Buf(sr, len), lp = new LP1(sr), lp2 = new LP1(sr);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, f = pitch(t);
    p1 += TAU * f / sr; p2 += TAU * f * 1.013 / sr;
    let x = 0;
    for (let k = 1; k <= 7; k += 2) x += (Math.sin(p1 * k) + 0.8 * Math.sin(p2 * k)) / Math.pow(k, 1.3);
    b.d[i] = lp2.run(lp.run(x, 2600), 2600) * env(t);
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
const SHOTGUN: Gun = {
  len: 1.4, crack: 0.6, crackTau: 0.002, blast: 1.2, blastTau: 0.05, blastF0: 3800, blastF1: 450, body: 0.35, bodyF: 900,
  boom: 1, boomF0: 110, boomF1: 38, boomTau: 0.075, drive: 3.5, tail: 0.35, tailTau: 0.25, tailF: 700,
  echoes: [[0.13, 0.28], [0.31, 0.12]],
};
const SMG: Gun = {
  len: 0.5, crack: 0.45, crackTau: 0.0009, blast: 1, blastTau: 0.013, blastF0: 5200, blastF1: 1500, body: 0.39, bodyF: 1700,
  boom: 0.45, boomF0: 200, boomF1: 80, boomTau: 0.016, drive: 2, tail: 0.15, tailTau: 0.07, tailF: 1200,
  echoes: [[0.09, 0.1]],
};
// The rifle is a full-power bolt action, a springfield or an AWP: the sharpest crack in the
// game, a boom down where the cannon is and a report that rolls on for two seconds.
const RIFLE: Gun = {
  len: 2.6, crack: 1.7, crackTau: 0.0005, blast: 1.05, blastTau: 0.034, blastF0: 8500, blastF1: 900, body: 0.4, bodyF: 1050,
  boom: 1.05, boomF0: 105, boomF1: 32, boomTau: 0.07, drive: 3.6, tail: 0.5, tailTau: 0.34, tailF: 750,
  echoes: [[0.19, 0.34], [0.46, 0.2], [0.85, 0.1], [1.35, 0.05]],
};
const MINIGUN: Gun = {
  len: 0.3, crack: 0.4, crackTau: 0.0007, blast: 0.9, blastTau: 0.009, blastF0: 5500, blastF1: 2200, body: 0.35, bodyF: 1800,
  boom: 0.4, boomF0: 230, boomF1: 100, boomTau: 0.01, drive: 2, tail: 0.08, tailTau: 0.05, tailF: 1500,
  echoes: [],
};
const TURRET_GUN: Gun = {
  len: 0.6, crack: 0.7, crackTau: 0.001, blast: 1, blastTau: 0.016, blastF0: 5500, blastF1: 1100, body: 0.35, bodyF: 1300,
  boom: 0.55, boomF0: 180, boomF1: 70, boomTau: 0.02, drive: 2.4, tail: 0.18, tailTau: 0.1, tailF: 1000,
  echoes: [[0.1, 0.12]],
};
const CANNON: Gun = {
  len: 2.4, crack: 0.5, crackTau: 0.003, blast: 1, blastTau: 0.09, blastF0: 2600, blastF1: 280, body: 0.28, bodyF: 600,
  boom: 1.3, boomF0: 80, boomF1: 26, boomTau: 0.14, drive: 4, tail: 0.5, tailTau: 0.35, tailF: 500,
  echoes: [[0.2, 0.25], [0.5, 0.1]],
};
const SNIPER: Gun = {
  len: 2.4, crack: 1.4, crackTau: 0.0007, blast: 1, blastTau: 0.035, blastF0: 8000, blastF1: 1000, body: 0.45, bodyF: 1100,
  boom: 0.8, boomF0: 110, boomF1: 36, boomTau: 0.06, drive: 3.2, tail: 0.45, tailTau: 0.28, tailF: 800,
  echoes: [[0.2, 0.3], [0.5, 0.15], [0.95, 0.07]],
};
const DOORGUN: Gun = {
  len: 0.7, crack: 0.8, crackTau: 0.001, blast: 1, blastTau: 0.018, blastF0: 5000, blastF1: 1000, body: 0.35, bodyF: 1200,
  boom: 0.55, boomF0: 150, boomF1: 60, boomTau: 0.025, drive: 2.5, tail: 0.25, tailTau: 0.15, tailF: 800,
  echoes: [[0.15, 0.12]],
};

// Spent brass hitting the ground and bouncing twice.
function brass(b: Buf, r: R, at: number, gain: number): void {
  const base = jit(r, 4200, 0.1);
  [0, 0.085, 0.14].forEach((d, k) => ping(b, at + d + r() * 0.01, [base, base * 1.47, base * 2.09, base * 2.7], 0.03, gain / (1 + k * 1.5)));
}

// A pump worked back and forward.
function pump(b: Buf, r: R, at: number, gain: number): void {
  click(b, r, at, 2200, gain, 0.004, 380);
  slide(b, r, at + 0.005, 0.07, 1800, gain * 0.5);
  click(b, r, at + 0.08, 1500, gain * 1.1, 0.005, 300);
  slide(b, r, at + 0.14, 0.06, 2000, gain * 0.5);
  click(b, r, at + 0.2, 2600, gain * 1.3, 0.004, 520);
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

function rocketLaunch(sr: number, r: R, small: boolean): Buf {
  const b = new Buf(sr, small ? 0.9 : 1.4);
  if (!small) {
    roar(b, r, 0, 0.4, 2200, 300, 0.001, 0.06, 1, 3);
    thud(b, r, 0, 95, 35, 0.07, 0.9, 0.3);
  } else {
    roar(b, r, 0, 0.2, 3000, 600, 0.001, 0.025, 0.6, 2);
  }
  // The motor: a hissing roar that flutters, falling in pitch as it goes away.
  const sv = new SVF(sr), flutter = slowNoise(r, sr, b.len / sr, 45);
  const top = small ? 2800 : 1900, bottom = small ? 1300 : 800;
  const start = small ? 0.01 : 0.03, tau = small ? 0.22 : 0.38;
  for (let i = Math.floor(start * sr); i < b.len; i++) {
    const t = i / sr - start;
    sv.run(r() * 2 - 1, bottom + (top - bottom) * Math.exp(-t / 0.5), 1.1);
    b.d[i] += sv.band * (0.75 + 0.35 * flutter[i]) * ad(t, 0.03, tau) * (small ? 0.9 : 0.6);
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

function explosion(sr: number, r: R, scale: number): Buf {
  const b = new Buf(sr, 1.6 + scale * 1.4);
  const crack = new Buf(sr, 0.03);
  let prev = 0;
  for (let i = 0; i < crack.len; i++) { const n = r() * 2 - 1; crack.d[i] = (n - prev) * ad(i / sr, 0.0002, 0.003); prev = n; }
  for (let i = 0; i < crack.len; i++) b.d[i] += crack.d[i] * 0.8;
  roar(b, r, 0, 1.2 * scale, 3500, 160, 0.0015, 0.16 * scale, 1, 4);
  thud(b, r, 0, 60 / Math.sqrt(scale), 20, 0.32 * scale, 1.3, 0.2, 300);
  // The rumble rolling on after it, swelling and settling.
  const lp = new LP1(sr), lp2 = new LP1(sr), swell = slowNoise(r, sr, b.len / sr, 5);
  const comp = Math.sqrt(sr / (2 * 220));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    b.d[i] += lp2.run(lp.run(r() * 2 - 1, 220), 220) * comp * (0.8 + 0.3 * swell[i]) * ad(t, 0.03, 0.9 * scale) * 0.55;
  }
  debris(b, r, 0.15, 1.2 * scale, Math.round(18 * scale), 1200, 4500, 0.14);
  for (const [d, g] of [[0.25, 0.22], [0.6, 0.1]] as const) {
    const a = new LP1(sr), c = new LP1(sr), o = Math.floor(jit(r, d, 0.15) * sr);
    for (let i = 0; i < sr * 0.4 && o + i < b.len; i++) b.d[o + i] += c.run(a.run(b.d[i], 900), 900) * g;
  }
  return b.normalize(0.95).fadeOut(0.2);
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

function thunder(sr: number, r: R): Buf {
  const b = new Buf(sr, 5.5);
  // The stroke: several cracks a few hundredths of a second apart, branch after branch.
  let prev = 0;
  const bursts = [0, 0.025 + r() * 0.02, 0.06 + r() * 0.03, 0.1 + r() * 0.04];
  for (const at of bursts) {
    const o = Math.floor(at * sr), g = 0.6 + r() * 0.4;
    for (let i = 0; i < sr * 0.08; i++) { const n = r() * 2 - 1; b.d[o + i] += (n - prev) * ad(i / sr, 0.0003, 0.012) * g; prev = n; }
  }
  roar(b, r, 0, 1.2, 2500, 400, 0.002, 0.25, 0.6, 2);
  // The roll: deep, swelling and fading unevenly for seconds.
  const lp = new LP1(sr), lp2 = new LP1(sr), swell = slowNoise(r, sr, 5.5, 3), comp = Math.sqrt(sr / (2 * 160));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, s = Math.max(0, 0.5 + swell[i]);
    b.d[i] += lp2.run(lp.run(r() * 2 - 1, 160), 160) * comp * s * s * ad(t, 0.3, 1.6) * 1.1;
  }
  return b.normalize(0.95).fadeOut(0.3);
}

function frost(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.5);
  // Ice forming: a fizz of tiny high clicks, then a cold shimmer of glassy partials.
  debris(b, r, 0, 0.5, 45, 4000, 9500, 0.25);
  const parts = [2350, 3120, 4710, 5930, 7400].map((f) => jit(r, f, 0.04));
  const trem = parts.map(() => [r() * 6 + 4, r() * TAU]);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    let x = 0;
    for (let k = 0; k < parts.length; k++) x += Math.sin(TAU * parts[k] * t) * (0.6 + 0.4 * Math.sin(TAU * trem[k][0] * t + trem[k][1])) / (1 + k * 0.5);
    b.d[i] += x * ad(t, 0.04, 0.45) * 0.25;
  }
  whoosh(b, r, 0, 0.5, 7000, 3000, 0.5, 0.7);
  return b.normalize(0.75).fadeOut(0.1);
}

function tesla(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.4);
  // An arc: a mains-like buzz whose pitch is thrown about, torn by a few crackles, with a zap
  // falling through it as the charge lands. Kept out of the top octave, where a tower firing
  // every second would only hiss.
  const sv = new SVF(sr), top = new LP1(sr), top2 = new LP1(sr), fm = slowNoise(r, sr, 0.4, 60);
  const z0 = jit(r, 2200, 0.15), z1 = jit(r, 380, 0.15);
  let ph = 0, zp = 0, prev = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    ph += (110 + fm[i] * 45) / sr;
    ph -= Math.floor(ph);
    const n = r() * 2 - 1;
    const crackle = r() < 0.012 * Math.exp(-t / 0.08) ? (r() * 2 - 1) * 3 : 0;
    sv.run((1 - 2 * ph) + (n - prev) * 0.5 + crackle, jit(r, 1500, 0.02), 0.9);
    prev = n;
    zp += TAU * (z1 + (z0 - z1) * Math.exp(-t / 0.035)) / sr;
    const zap = Math.tanh(Math.sin(zp) * 3) * ad(t, 0.001, 0.05) * 0.5;
    const x = sat((sv.band + sv.low * 0.3) * ad(t, 0.002, 0.09) * 1.5 + zap, 2.5);
    b.d[i] = top2.run(top.run(x, 5000), 5000);
  }
  return b.normalize(0.8).fadeOut();
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

function spit(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.45);
  thud(b, r, 0, 320, 180, 0.012, 0.6, 0.2);
  roar(b, r, 0.005, 0.3, 2400, 900, 0.004, 0.06, 0.8, 2);
  vox(b, r, 0, { dur: 0.18, f0: () => 120, vowel: () => [400, 900, 2300], rasp: 0.6, jitter: 0.1, a: 0.01, rel: 0.08, gain: 0.4, am: 30 });
  return b.normalize(0.7).fadeOut();
}

// Bone: thrown with a grunt and a swish, then clattering where it lands.
function boneThrow(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  vox(b, r, 0, { dur: 0.22, f0: (u) => 140 - 40 * u, vowel: () => lerpV(V.uh, V.uh, 0), rasp: 0.5, jitter: 0.08, a: 0.01, rel: 0.1, gain: 0.6 });
  whoosh(b, r, 0.1, 0.3, 400, 1400, 0.8);
  return b.normalize(0.7).fadeOut();
}
function boneLand(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  thud(b, r, 0, 200, 120, 0.02, 0.5, 0.4);
  for (let k = 0; k < 6; k++) click(b, r, k * 0.03 + r() * 0.04, 900 + r() * 1800, 0.5 / (1 + k * 0.4), 0.006, 600 + r() * 900);
  return b.normalize(0.65).fadeOut();
}

// Footsteps, barely there: a boot's heel and the grit under it; a bare foot of the dead
// dragged as much as set down; and the big ones' weight landing in the dirt.
function step(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.2);
  thud(b, r, 0, jit(r, 115, 0.15), 65, 0.016, 0.8, 0.9, 900);
  roar(b, r, 0.006, 0.08, jit(r, 3200, 0.2), 1200, 0.002, 0.018, 0.3);
  debris(b, r, 0.01, 0.05, 3, 1800, 4500, 0.1);
  return b.normalize(0.6).fadeOut();
}

function creepStep(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.32);
  thud(b, r, 0, jit(r, 90, 0.15), 55, 0.022, 0.7, 1, 600);
  whoosh(b, r, 0.015, jit(r, 0.2, 0.25), 1000, 500, 0.3, 0.8);
  return b.normalize(0.55).fadeOut();
}

function bigStep(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.6);
  thud(b, r, 0, jit(r, 62, 0.1), 30, 0.07, 1.2, 0.8, 500);
  debris(b, r, 0.02, 0.25, 6, 500, 1800, 0.12);
  return b.normalize(0.75).fadeOut();
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

// Reloading, the way each gun is: [start, end].
function reload(sr: number, r: R, w: number, end: boolean): Buf {
  const b = new Buf(sr, 0.6);
  switch (w) {
    case 0: // pistol: the magazine drops out; in, then the slide released home
      if (!end) { click(b, r, 0, 2600, 0.7, 0.003, 1200); slide(b, r, 0.02, 0.08, 3000, 0.4); } else {
        slide(b, r, 0, 0.06, 2600, 0.4); click(b, r, 0.06, 1600, 1, 0.004, 700); click(b, r, 0.2, 2200, 1, 0.003, 1300);
      }
      break;
    case 1: // shotgun: a shell thumbed in; the pump racked
      if (!end) { slide(b, r, 0, 0.05, 1600, 0.5); click(b, r, 0.05, 1500, 0.8, 0.004, 400); } else pump(b, r, 0.02, 0.9);
      break;
    case 2: // SMG: the magazine out; in, then the bolt racked
      if (!end) { click(b, r, 0, 2400, 0.7, 0.003, 1000); slide(b, r, 0.02, 0.07, 2800, 0.4); } else {
        click(b, r, 0, 1500, 1, 0.004, 650); slide(b, r, 0.12, 0.07, 2400, 0.5); click(b, r, 0.2, 2000, 0.9, 0.004, 900); click(b, r, 0.27, 2600, 1, 0.003, 1200);
      }
      break;
    case 3: // rifle: the bolt opened; rounds pressed in and the bolt closed
      if (!end) { click(b, r, 0, 3000, 0.7, 0.003, 900); slide(b, r, 0.03, 0.09, 2600, 0.5); click(b, r, 0.12, 2000, 0.8, 0.004, 600); } else {
        click(b, r, 0, 1700, 0.6, 0.004, 500); slide(b, r, 0.08, 0.08, 2800, 0.45); click(b, r, 0.16, 2400, 1, 0.004, 700); click(b, r, 0.22, 3400, 0.8, 0.003, 1100);
      }
      break;
    case 4: // minigun: the ammo box unlatched; the belt fed in and the cover slammed
      if (!end) { thud(b, r, 0, 300, 180, 0.03, 0.6, 0.6); click(b, r, 0.01, 1200, 0.8, 0.005, 400); } else {
        for (let k = 0; k < 8; k++) click(b, r, k * 0.025, 1800 + r() * 600, 0.45, 0.003, 900);
        thud(b, r, 0.25, 260, 150, 0.04, 0.8, 0.6); click(b, r, 0.25, 1300, 1, 0.005, 500);
      }
      break;
    case 5: // rocket launcher: the tube opened; a rocket slid in and latched
      if (!end) { thud(b, r, 0, 180, 110, 0.04, 0.5, 0.4); click(b, r, 0, 1000, 0.6, 0.005, 700); } else {
        slide(b, r, 0, 0.18, 1400, 0.6); thud(b, r, 0.2, 160, 100, 0.04, 0.7, 0.5); click(b, r, 0.2, 1400, 0.9, 0.004, 750);
      }
      break;
  }
  return b.normalize(0.7).fadeOut();
}

function weaponSwitch(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.35);
  roar(b, r, 0, 0.15, 2500, 1200, 0.03, 0.05, 0.5);
  click(b, r, 0.12, 2000, 0.8, 0.003, 900);
  click(b, r, 0.16, 1500, 0.6, 0.004, 600);
  return b.normalize(0.6).fadeOut();
}

// A medkit's velcro torn open, then the dressing.
function medkit(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  const sv = new SVF(sr);
  for (let i = 0; i < sr * 0.35; i++) {
    const t = i / sr;
    sv.run(r() < 0.35 ? (r() * 2 - 1) * 3 : 0, 3200, 1.2);
    b.d[i] += sv.band * bump(t, 0.17, 0.12) * 0.6;
  }
  whoosh(b, r, 0.38, 0.25, 1800, 2400, 0.3, 0.8);
  return b.normalize(0.6).fadeOut();
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

function coins(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  thud(b, r, 0, 220, 140, 0.02, 0.4, 0.5);
  for (let k = 0; k < 9; k++) {
    const f = 2600 + r() * 2200;
    ping(b, r() * 0.22, [f, f * 2.41, f * 3.93], 0.05, 0.35);
  }
  ping(b, 0.06, [2200, 3290, 4400], 0.32, 0.6);
  return b.normalize(0.65).fadeOut();
}

// A ratchet wrench turned a few times, then the part seating with a clank.
function upgrade(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  const turns = 4 + Math.floor(r() * 4), gap = jit(r, 0.035, 0.2), seat = turns * gap + 0.04, f = jit(r, 1180, 0.08);
  for (let k = 0; k < turns; k++) click(b, r, k * gap, 2800 + r() * 300, 0.6, 0.002, 1900);
  ping(b, seat, [f, f * 2.43, f * 3.65], 0.14, 0.7);
  thud(b, r, seat, 240, 160, 0.03, 0.5, 0.5);
  return b.normalize(0.65).fadeOut();
}

function hammer(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.75);
  [0, 0.16, 0.31].forEach((at, k) => {
    thud(b, r, at, jit(r, 230, 0.08), 150, 0.02, 0.8 + k * 0.1, 0.6, 2000);
    click(b, r, at, 2100, 0.5, 0.003, 1100);
    ping(b, at, [jit(r, 520, 0.05), 1310], 0.03, 0.25);
  });
  return b.normalize(0.7).fadeOut();
}

function crumble(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.9);
  thud(b, r, 0, 70, 30, 0.2, 1.1, 0.6, 500);
  roar(b, r, 0, 1.6, 1400, 180, 0.01, 0.45, 0.9, 2.5);
  debris(b, r, 0.03, 1.3, 40, 600, 3200, 0.35);
  ping(b, 0.1, [430, 1110, 1750], 0.15, 0.2);
  return b.normalize(0.85).fadeOut(0.1);
}

function crateLand(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.9);
  thud(b, r, 0, 90, 48, 0.08, 1.1, 0.7, 700);
  debris(b, r, 0.01, 0.3, 8, 700, 2000, 0.35);
  whoosh(b, r, 0.06, 0.4, 700, 480, 0.25, 4);
  return b.normalize(0.8).fadeOut();
}

// --- loot and the map ---------------------------------------------------------------------

function lootFound(sr: number, r: R, jackpot: boolean): Buf {
  const b = new Buf(sr, jackpot ? 1.6 : 1);
  for (let k = 0; k < 3; k++) click(b, r, k * 0.04, 1000 + r() * 1500, 0.4, 0.006, 500 + r() * 600);
  // A found thing rings a fifth; which fifth, and how quickly, changes from find to find.
  const root = jackpot ? 784 : [880, 784, 988][Math.floor(r() * 3)];
  const notes = jackpot ? [784, 988, 1175, 1568] : [root, root * 1.498];
  notes.forEach((f, k) => ping(b, 0.08 + k * (jackpot ? 0.09 : jit(r, 0.11, 0.25)), [f, f * 2.01, f * 3.02], jackpot ? 0.5 : 0.35, 0.5));
  if (jackpot) for (let k = 0; k < 8; k++) { const f = 2600 + r() * 2200; ping(b, 0.1 + r() * 0.3, [f, f * 2.41], 0.05, 0.2); }
  return b.normalize(0.6).fadeOut(0.1);
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

function grenadeThrow(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  ping(b, 0, [3200, 5150, 7300], 0.04, 0.5);
  click(b, r, 0.08, 4000, 0.4, 0.002, 2600);
  whoosh(b, r, 0.12, 0.3, 500, 1500, 0.8);
  return b.normalize(0.6).fadeOut();
}

function dash(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.45);
  whoosh(b, r, 0, 0.35, 350, 1600, 1, 0.9);
  thud(b, r, 0, 110, 70, 0.02, 0.4, 0.6, 1500);
  thud(b, r, 0.3, 110, 70, 0.02, 0.4, 0.6, 1500);
  return b.normalize(0.65).fadeOut();
}

// Jets going over for an airstrike: the roar climbing as they come, a Doppler fall as they
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

// The air-raid siren: winding up, holding, winding down.
function sirenWave(sr: number): Buf {
  return siren(sr, 6, (t) => t < 2.2 ? 150 + 410 * Math.sin(t / 2.2 * Math.PI / 2) : t < 3.4 ? 560 : 560 - 360 * Math.min(1, (t - 3.4) / 2.6),
    (t) => Math.min(1, t / 0.6) * (t > 4 ? Math.max(0, (6 - t) / 2) : 1));
}
function sirenClear(sr: number): Buf {
  return siren(sr, 4, (t) => t < 1 ? 160 + 260 * Math.sin(t * Math.PI / 2) : t < 2.4 ? 420 : 420 - 250 * (t - 2.4) / 1.6,
    (t) => Math.min(1, t / 0.4) * (t > 2.6 ? Math.max(0, (4 - t) / 1.4) : 1) * 0.8);
}
function sirenOver(sr: number): Buf {
  return siren(sr, 5, (t) => 560 * Math.exp(-t / 1.6) + 40, (t) => Math.min(1, t / 0.1) * Math.max(0, 1 - t / 5));
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

// A minigun's motor and barrels spinning: played faster or slower as it spins up and down.
function spin(sr: number, r: R): Buf {
  const b = new Buf(sr, 1);
  const lp = new LP1(sr);
  // The filter runs a tenth of a second before the loop starts, so the loop has no seam.
  for (let i = -Math.floor(sr * 0.1); i < b.len; i++) {
    const t = i / sr;
    const saw = 1 - 2 * (((180 * t) % 1 + 1) % 1);
    const y = lp.run(saw, 900) * 0.5 + Math.sin(TAU * 1080 * t) * 0.12 + (r() * 2 - 1) * 0.1 * Math.pow(0.5 + 0.5 * Math.sin(TAU * 36 * t), 8);
    if (i >= 0) b.d[i] = y;
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
  smg: [5, gun(SMG)],
  rifle: [3, gun(RIFLE, (b, r) => { bolt(b, r, 0.3, 0.14); brass(b, r, 0.5, 0.04); })],
  minigun: [6, gun(MINIGUN)],
  rocket: [3, (sr, r) => rocketLaunch(sr, r, false)],
  missile: [3, (sr, r) => rocketLaunch(sr, r, true)],
  crowbar: [3, crowbar],
  turretGun: [4, gun(TURRET_GUN, (b, r) => ping(b, 0.04, [1450, 2310], 0.02, 0.06 + r() * 0.02))],
  cannon: [3, gun(CANNON, (b, r) => ping(b, 0.35, [610, 1530, 2470], 0.12, 0.03 + r() * 0.01))],
  sniper: [3, gun(SNIPER, (b, r) => { click(b, r, 0.5, 1800, 0.08, 0.004, 600); slide(b, r, 0.53, 0.08, 2400, 0.04); click(b, r, 0.62, 2600, 0.09, 0.004, 900); })],
  pod: [3, (sr, r) => { const b = new Buf(sr, 0.3); thud(b, r, 0, jit(r, 220, 0.2), jit(r, 130, 0.2), 0.03, 0.7, 0.5); click(b, r, 0, jit(r, 1500, 0.3), 0.6, 0.004, jit(r, 800, 0.3)); return b.normalize(0.5).fadeOut(); }],
  doorGun: [4, gun(DOORGUN)],
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
  sirenWave: [1, sirenWave, LOW],
  sirenClear: [1, sirenClear, LOW],
  sirenOver: [1, sirenOver, LOW],
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
// and the reloads lost under the gun they reload.
const TRIM: Record<string, number> = {
  shout_m: -6, shout_f: -6, groan5: -6, groan3: -5, groan7: -4, groan1: -3, retch: -5, ignite: -4.5, windup: -2.5,
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
