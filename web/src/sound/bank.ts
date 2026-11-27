import { Buf, LP1, SVF, ad, bump, rng, sat, slowNoise } from './dsp';
import { BAR, CASE, type Gun, IRON, PART, PIPE, PLATE, WOOD, band, caseDrop, cloth, squash, earth, echo, flesh, grains, part, pulse, report, scrape, shot as gunshot, strike, swing, thump } from './hw';

// Every sound in the game, as a recipe that renders it into samples. A sound has a few
// variants rendered from different seeds (and slightly different numbers), and one is picked
// at random each time, so a burst of fire never sounds like a loop.

type R = () => number;
const TAU = Math.PI * 2;
const jit = (r: R, v: number, k: number) => v * (1 + (r() * 2 - 1) * k);

// --- building blocks ----------------------------------------------------------------------

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

// The guns, built by hw.ts's shot: each told from the others by its blast (how long the
// pressure pulse is, so how deep), its crack (only a supersonic round has one), its gas, its
// steel, its chest and how long its report rolls.
//
// The pistol is a big-bore handgun, a .45 or heavier: no crack (its bullet is slow), a fat,
// short blast with the weight low in the mids, the slide's steel ringing under it, and a
// report that carries half a second.
const PISTOL: Gun = {
  len: 1.1, crack: 0, blast: 1, T: 0.0011, drive: 5.4,
  gas: 1.3, gasF: 1600, gasTau: 0.02, body: 1.2, bodyF: 900, ring: [2300, 0.18, 0.02], chest: 0.54, chestF: 220, chestTau: 0.03,
  rep: 0.35, repTau: 0.2, repF: 1800, repEnd: 380, echoes: [[0.12, 0.3], [0.27, 0.13], [0.5, 0.06]],
};
// The shotgun is a 12 gauge: the widest blast of the hand guns, a long pressure pulse with a
// gas cloud that roars out after it, little crack, the most chest, and a report rolling off
// the treeline three times.
const SHOTGUN: Gun = {
  len: 1.7, crack: 0.25, blast: 1.15, T: 0.0016, drive: 6.1,
  gas: 1.8, gasF: 1300, gasTau: 0.035, body: 1.2, bodyF: 750, ring: [1700, 0.12, 0.025], chest: 0.75, chestF: 180, chestTau: 0.05,
  rep: 0.45, repTau: 0.3, repF: 1500, repEnd: 320, echoes: [[0.14, 0.33], [0.33, 0.16], [0.62, 0.07]],
};
// The SMG is a 9 mm at eleven rounds a second: a short, tight blast high in the mids, a quick
// snap of gas, the bolt's steel bright under it, little chest and a short report, so a burst
// stays a burst of rounds.
const SMG: Gun = {
  len: 0.55, crack: 0, blast: 0.9, T: 0.0006, drive: 5.4,
  gas: 1.2, gasF: 2400, gasTau: 0.012, body: 1.2, bodyF: 1500, ring: [2900, 0.22, 0.015], chest: 0.27, chestF: 300, chestTau: 0.015,
  rep: 0.25, repTau: 0.09, repF: 2400, repEnd: 600, echoes: [[0.08, 0.16], [0.19, 0.06]],
};
// The rifle is a full-power bolt action, a .30-06: the sharpest crack in the hand guns ahead
// of its blast, a deep pulse, and a report that rolls on for two seconds off the treeline.
const RIFLE: Gun = {
  len: 2.4, crack: 1.3, blast: 1, T: 0.0013, drive: 6.1,
  gas: 1.3, gasF: 2000, gasTau: 0.03, body: 1, bodyF: 1000, ring: [2000, 0.12, 0.03], chest: 0.6, chestF: 170, chestTau: 0.05,
  rep: 0.55, repTau: 0.45, repF: 1600, repEnd: 260, echoes: [[0.19, 0.38], [0.46, 0.22], [0.85, 0.11], [1.35, 0.05]],
};
// The minigun fires full rifle rounds 22 a second: each a crack and a short, hard pulse, its
// report just long enough that the rounds run together into one ripping roar.
const MINIGUN: Gun = {
  len: 0.5, crack: 0.8, blast: 1, T: 0.0009, drive: 5.8,
  gas: 1.1, gasF: 1900, gasTau: 0.016, body: 1.1, bodyF: 1100, ring: [2600, 0.08, 0.012], chest: 0.42, chestF: 220, chestTau: 0.02,
  rep: 0.3, repTau: 0.12, repF: 2000, repEnd: 500, echoes: [[0.09, 0.14], [0.21, 0.06]],
};
// The gun turret is a sentry on a steel mount: rifle rounds four a second, a crack, a drier,
// higher blast than the hand guns and the mount's steel ringing under it.
const TURRET_GUN: Gun = {
  len: 0.6, crack: 0.7, blast: 0.9, T: 0.0008, drive: 5.4,
  gas: 1, gasF: 2200, gasTau: 0.015, body: 1.1, bodyF: 1300, ring: [1500, 0.25, 0.04], chest: 0.3, chestF: 260, chestTau: 0.02,
  rep: 0.3, repTau: 0.14, repF: 2000, repEnd: 500, echoes: [[0.1, 0.15], [0.24, 0.06]],
};
// The cannon is field artillery: the longest pulse in the game, so the deepest, a gas cloud
// rolling out of the muzzle, the chest of it felt, and a report rolling over the map.
const CANNON: Gun = {
  len: 2.8, crack: 0, blast: 1.3, T: 0.004, drive: 7.2,
  gas: 1.6, gasF: 700, gasTau: 0.08, body: 0.8, bodyF: 550, ring: [620, 0.08, 0.2], chest: 0.96, chestF: 110, chestTau: 0.12,
  rep: 0.6, repTau: 0.5, repF: 900, repEnd: 160, echoes: [[0.22, 0.35], [0.55, 0.16], [1.05, 0.07]],
};
// The sniper tower is a .50 with a muzzle brake: a bigger crack than the rifle's, a longer
// pulse, the brake throwing the gas sideways in a harsher, wider roar, and a long report.
const SNIPER: Gun = {
  len: 2.6, crack: 1.5, blast: 1.1, T: 0.0019, drive: 6.8,
  gas: 2, gasF: 1600, gasTau: 0.04, body: 1.2, bodyF: 800, ring: [1300, 0.1, 0.05], chest: 0.72, chestF: 140, chestTau: 0.07,
  rep: 0.6, repTau: 0.5, repF: 1400, repEnd: 220, echoes: [[0.2, 0.36], [0.5, 0.19], [0.95, 0.09], [1.5, 0.04]],
};
// The door gunner's M60 heard from the ground: full rounds eight a second, the blast farther
// off so its crack leads and its report carries more of it.
const DOORGUN: Gun = {
  len: 0.8, crack: 0.9, blast: 0.8, T: 0.0011, drive: 5,
  gas: 0.9, gasF: 1400, gasTau: 0.02, body: 1, bodyF: 950, ring: [1800, 0.06, 0.02], chest: 0.36, chestF: 200, chestTau: 0.03,
  rep: 0.45, repTau: 0.22, repF: 1500, repEnd: 380, echoes: [[0.16, 0.2], [0.38, 0.08]],
};

// Spent brass thrown out and landing on dry ground: a tick on packed earth, now and then a
// ring off a stone, bouncing twice.
function brass(b: Buf, r: R, at: number, gain: number): void {
  caseDrop(b, r, at, gain * 2.2);
}

// A pump worked back and forward: the fore-end (wood on a steel tube) racked back to its stop,
// the spent hull thrown out and landing on the dirt with a hollow plastic tock, then the
// fore-end slammed home and the action locking.
function pump(b: Buf, r: R, at: number, gain: number): void {
  scrape(b, r, at, 0.08, 1600, gain * 0.8);
  part(b, r, at + 0.085, 1250, gain * 1.6, 240, 1.4);
  const land = at + 0.38 + r() * 0.05;
  strike(b, r, land, jit(r, 700, 0.1), WOOD, gain * 0.9, 0.0015, 0.4);
  grains(b, r, land, 0.02, 3, 1500, 5000, gain * 0.3);
  strike(b, r, land + 0.09 + r() * 0.03, jit(r, 760, 0.1), WOOD, gain * 0.3, 0.0015, 0.4);
  scrape(b, r, at + 0.14, 0.06, 1900, gain * 0.7);
  part(b, r, at + 0.205, 1900, gain * 2, 280, 1.6);
}

// A bolt lifted, drawn back to its stop, run home and turned down: steel on steel, each move
// ending on a part that rings a little, the stock knocked under the last.
function bolt(b: Buf, r: R, at: number, gain: number): void {
  part(b, r, at, 2600, gain * 0.9, 380, 0.4);
  scrape(b, r, at + 0.025, 0.09, 2300, gain * 0.8);
  part(b, r, at + 0.12, 1800, gain * 1.2, 320, 0.8);
  scrape(b, r, at + 0.19, 0.08, 2500, gain * 0.7);
  part(b, r, at + 0.28, 2100, gain * 1.4, 300, 1.2);
  part(b, r, at + 0.34, 3000, gain * 0.9, 360, 0.5);
}

// A heavy part slamming home: a click, the gun's body knocked low under it and a short ring of
// steel. A slide or a bolt going forward, a magazine seated, a cover shut.
function clack(b: Buf, r: R, at: number, f: number, gain: number, low = 300): void {
  click(b, r, at, f, gain, 0.003, f * 0.55);
  thud(b, r, at, low, low * 0.6, 0.012, gain * 0.7, 0.4, 2500);
  ping(b, at + 0.001, [f * 0.83, f * 1.37, f * 2.21], 0.025, gain * 0.25);
}

// A geared motor slewing a mount: the teeth meshing (a run of tiny impacts as fast as it turns,
// ringing the housing), the brushes' hiss, speeding up and slowing as it starts and stops.
function servo(b: Buf, r: R, at: number, dur: number, gain: number): void {
  const sr = b.sr, o = Math.floor(at * sr), rate = jit(r, 420, 0.15), h1 = new SVF(sr), h2 = new SVF(sr), hs = new SVF(sr);
  const f1 = jit(r, 1300, 0.1), f2 = f1 * 2.17;
  let ph = 0;
  for (let i = 0; i < Math.ceil(dur * sr) && o + i < b.len; i++) {
    const t = i / sr, u = t / dur, sp = Math.sin(Math.PI * u);
    ph += rate * (0.6 + 0.4 * sp) / sr;
    let x = 0;
    if (ph >= 1) { ph -= 1; x = (0.6 + r() * 0.8) * 2; }
    const y = h1.run(x, f1, 9).band + h2.run(x, f2, 7).band * 0.6 + hs.run(r() * 2 - 1, 5000, 0.8).band * 0.12;
    b.d[o + i] += y * sp * gain;
  }
}

// A missile kicked out of its tube by gas before its motor lights: a hollow pop, the tube
// sounding like a blown bottle, a hiss of gas and the next one clacking up into place.
function pod(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  // The air column rung by the gas rushing out: noise through the tube's own resonance (its
  // pitch dropping as the missile clears the mouth and the tube becomes open), not a tone.
  const f = jit(r, 190, 0.12), col = new SVF(sr), sv = new SVF(sr);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, n = r() * 2 - 1;
    const fq = f * (0.75 + 0.25 * Math.exp(-t / 0.03));
    b.d[i] += col.run(n * ad(t, 0.002, 0.03), fq, 9).band * Math.sqrt(sr / fq) * 0.5;
    b.d[i] += sv.run(n, 2400, 1).band * ad(t, 0.003, 0.08) * 0.5;
  }
  pulse(b, 0, 0.002, 0.7);
  thump(b, r, 0, 160, 0.001, 0.02, 0.6);
  strike(b, r, 0, jit(r, 700, 0.06), PIPE, 0.12, 0.0008, 0.3);
  part(b, r, 0.24 + r() * 0.03, 1700, 0.15, 520, 0.6);
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
  // The rails knocked by the slug leaving: two heavy bars ringing, a little apart in pitch.
  const f = jit(r, 590, 0.05);
  strike(b, r, 0.002, f, BAR, 0.35, 0.0002, 0.6);
  strike(b, r, 0.002, f * 1.013, BAR, 0.25, 0.0002, 0.6);
  // The shot off the treeline, before the whine.
  const core = b.d.slice(0, Math.ceil(sr * 0.3));
  for (const [delay, gain] of [[0.2, 0.25], [0.48, 0.1]]) {
    const a = new LP1(sr), c = new LP1(sr), o = Math.floor(jit(r, delay, 0.1) * sr);
    for (let i = 0; i < core.length && o + i < b.len; i++) b.d[o + i] += c.run(a.run(core[i], 1400), 1400) * gain;
  }
  // The capacitors charging again: coil whine, a narrow band of noise climbing (a real one
  // sings through its windings rather than as a clean tone), buzzing at the mains' 100 Hz,
  // to the relay's clack.
  const w0 = 0.3, wl = 0.75, o = Math.floor(w0 * sr), cw = new SVF(sr);
  for (let i = 0; i < wl * sr && o + i < b.len; i++) {
    const u = i / sr / wl, fq = 300 * Math.pow(8, u);
    const e = Math.min(1, u * 3) * Math.min(1, (1 - u) / 0.04) * (1 + 0.4 * Math.sin(TAU * 100 * i / sr));
    b.d[o + i] += cw.run(r() * 2 - 1, fq, 14).band * Math.sqrt(sr / fq) * e * 0.04;
  }
  part(b, r, w0 + wl, 3200, 0.12, 900, 0.2);
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
    // The backblast: a pressure pulse out of the open back of the tube, the gas behind it
    // tearing and dying, and the tube knocked on the shoulder.
    pulse(b, 0, 0.004, 0.6);
    band(b, r, 0, 0.5, 2200, 280, 0.06, 0.7, 0.0008, 0.07, 1.4, 1.5);
    thump(b, r, 0, 110, 0.002, 0.08, 1);
    strike(b, r, 0.001, jit(r, 300, 0.05), PIPE, 0.12, 0.0015, 0.3);
    band(b, r, 0.01, 0.4, 1400, 450, 0.12, 0.8, 0.02, 0.12, 0.9, 1.5);
  } else {
    // A missile's motor lighting in the open: a pop, and the tube's rim knocked.
    pulse(b, 0, 0.0012, 0.6);
    thump(b, r, 0, 160, 0.001, 0.025, 0.5);
    band(b, r, 0, 0.15, 4000, 900, 0.03, 0.7, 0.001, 0.02, 0.5, 2);
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
  return (small ? b : squash(b, 2.2)).normalize(0.9).fadeOut(0.05);
}

// Melee is three things at once: the arm and its sleeve moving (cloth), the air the weapon
// pushes aside (a swing, rising to the pass), and what it hits, which here is a body: flesh's
// dull weight and wet smack, and the weapon's own steel, damped by what it is buried in.

// The crowbar: a jacket sleeve and a short swing, then the blow into a body, a thump and the
// bar's own modes ringing, damped by the flesh round it. The bar's second mode sits near
// 820 Hz, so it still rings the way Half-Life's does, a little deeper, but for a third of a
// second and not as a chime.
function crowbar(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  cloth(b, r, 0, 0.1, 0.25, 0.6);
  swing(b, r, 0, 0.085, 350, 1300, 0.7);
  const at = 0.075;
  flesh(b, r, at, 0.9, 0.35, 1);
  strike(b, r, at, jit(r, 298, 0.03), BAR, 0.32, 0.0005, 0.4);
  return squash(b, 3).normalize(0.85).fadeOut(0.06);
}

// A katana's cut: a sleeve, a thin fast rush of air with the edge's whistle over it, the edge
// through a body (a short tearing hiss and a wet slap, no thump: it parts rather than hits),
// and the faintest ring of the blade after. The moonlit edge is the long, slow cut of the
// ultimate: more air, a deeper cut and the blade left ringing longer.
function katana(sr: number, r: R, moon: boolean): Buf {
  const b = new Buf(sr, moon ? 1 : 0.55);
  const d = moon ? 0.16 : 0.1;
  cloth(b, r, 0, d + 0.02, 0.2, 0.3);
  swing(b, r, 0, d, moon ? 380 : 480, moon ? 1600 : 2000, 0.9, 0.25);
  const at = d * 0.7;
  band(b, r, at, 0.08, 2600, 1100, 0.02, 1.2, 0.002, moon ? 0.03 : 0.018, 0.55, 1.5);
  flesh(b, r, at + 0.006, 0.35, moon ? 0.7 : 0.5, 0.6);
  strike(b, r, at + 0.01, jit(r, moon ? 620 : 540, 0.04), BAR, moon ? 0.05 : 0.025, 0.0008, moon ? 0.7 : 0.25);
  return b.normalize(0.8).fadeOut(0.05);
}

// The greatsword: a coat swung round, a long low rush of air as the slab comes, and the blow
// landing in a body with a slab of iron's weight: a heavy wet thump and the iron's dull,
// short clang. The follow-through goes on into the ground: the earth breaks under it and
// stones skitter.
function greatsword(sr: number, r: R, follow: boolean): Buf {
  const b = new Buf(sr, follow ? 1.3 : 0.8);
  cloth(b, r, 0, 0.24, 0.3, 0.9);
  swing(b, r, 0, 0.22, 160, 900, 1.1);
  const at = 0.2;
  flesh(b, r, at, 1, 0.6, 2);
  strike(b, r, at, jit(r, 190, 0.05), IRON, 0.35, 0.001, 0.8);
  if (follow) earth(b, r, at + 0.02, 0.9, 2.2);
  return squash(b, 3).normalize(0.85).fadeOut(0.08);
}

// Worldsplitter raised: the slab hauled up overhead, cloth and a slow rush of air rising with
// it, and under it the ground already giving, a rumble swelling and grit trickling, to a dull
// knock of the iron at the top.
function splitRaise(sr: number, r: R): Buf {
  const b = new Buf(sr, 1);
  cloth(b, r, 0, 0.35, 0.3, 1);
  swing(b, r, 0, 0.32, 150, 700, 0.8);
  const sv = new SVF(sr), comp = Math.sqrt(sr / (2 * 90));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, u = Math.min(1, t / 0.8);
    const e = u * u * (t > 0.8 ? Math.exp(-(t - 0.8) / 0.06) : 1);
    b.d[i] += sv.run(r() * 2 - 1, 60 + 50 * u, 0.9).low * comp * e * 0.8;
  }
  grains(b, r, 0.3, 0.5, 26, 1200, 5000, 0.12, 0.4);
  strike(b, r, 0.62, jit(r, 210, 0.04), IRON, 0.2, 0.002, 0.6);
  return b.normalize(0.75).fadeOut(0.05);
}

// Worldsplitter coming down: the slab into the ground with everything behind it, a slam felt
// more than heard (a long pressure pulse), the iron's dull clang, the earth tearing open down
// the line and rock thrown up and falling for a while.
function worldsplit(sr: number, r: R): Buf {
  const b = new Buf(sr, 2.4);
  swing(b, r, 0, 0.1, 300, 1400, 0.7);
  const at = 0.08;
  pulse(b, at, 0.006, 1.4);
  earth(b, r, at, 1.2, 3);
  strike(b, r, at, jit(r, 170, 0.05), IRON, 0.35, 0.0015, 0.8);
  // The tear running out from the blade: earth breaking, darkening as it gets further off.
  band(b, r, at + 0.02, 1.4, 1800, 160, 0.35, 0.7, 0.01, 0.35, 0.9, 2);
  grains(b, r, at + 0.03, 0.5, 40, 500, 2500, 0.3);
  grains(b, r, at + 0.25, 1.6, 36, 1500, 6000, 0.16, 0.5);
  return b.normalize(0.95).fadeOut(0.2);
}

// A burst of the cracked ground: a cough of pressure out of the ground, a spatter of rock and
// a hiss of steam. Short and soft: three go off every half second for four seconds.
function erupt(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  pulse(b, 0, jit(r, 0.004, 0.15), 0.8);
  thump(b, r, 0, 120, 0.002, 0.07, 0.7);
  band(b, r, 0.01, 0.4, 1400, 350, 0.1, 0.7, 0.01, 0.1, 0.5, 1.5);
  band(b, r, 0.02, 0.5, 4500, 3000, 0.2, 0.9, 0.03, 0.15, 0.12);
  grains(b, r, 0.1, 0.4, 8, 900, 4000, 0.15, 0.5);
  return b.normalize(0.7).fadeOut(0.06);
}

// Worldbreaker: the charges down the line going off at once, a rip of sparks into a slam with
// the ground heaving under it, and the charges' arcs snapping off through the crowd.
function worldbreak(sr: number, r: R): Buf {
  const b = new Buf(sr, 3);
  const clap = 0.08;
  grains(b, r, 0, clap, 60, 1500, 6000, 0.5);
  pulse(b, clap, 0.005, 1.3);
  band(b, r, clap, 0.4, 5000, 600, 0.04, 0.7, 0.0005, 0.05, 1.1, 3);
  thump(b, r, clap, 70, 0.004, 0.4, 1.2);
  band(b, r, clap, 2.2, 1200, 120, 0.5, 0.7, 0.004, 0.5, 0.8, 2);
  // The arcs: snaps, thick at first and scattering off, each ringing the air a little.
  grains(b, r, clap + 0.05, 1.6, 70, 2500, 7000, 0.5);
  grains(b, r, clap + 0.2, 1.5, 20, 900, 3500, 0.15, 0.6);
  return b.normalize(0.95).fadeOut(0.3);
}

// Home Run: the bar coming round with everything behind it, a sleeve and a rising rush of
// air, then the blow landing in a body with a heavy thump and the bar ringing out like the
// crowbar's, longer for being swung harder, a crack and grit after.
function homeRun(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.1);
  cloth(b, r, 0, 0.2, 0.3, 0.7);
  swing(b, r, 0, 0.18, 220, 2000, 1.2);
  const at = 0.17;
  flesh(b, r, at, 1.1, 0.4, 1.5);
  strike(b, r, at, jit(r, 284, 0.04), BAR, 0.4, 0.0004, 1);
  grains(b, r, at + 0.04, 0.35, 10, 1500, 5000, 0.12, 0.4);
  return squash(b, 3).normalize(0.9).fadeOut(0.1);
}

// Flash Draw (iaido): the blade drawn out of its wooden scabbard, steel on wood, across the
// line in one breath with a tearing rush of air, the bodies parted one after another, and the
// blade slid home with the click of the guard on the scabbard's mouth.
function flashDraw(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.4);
  scrape(b, r, 0, 0.07, 1900, 0.4);
  strike(b, r, 0.07, jit(r, 900, 0.05), WOOD, 0.2, 0.0006);
  swing(b, r, 0.06, 0.18, 400, 2100, 1.2, 0.25);
  for (let k = 0; k < 4; k++) {
    const at = 0.16 + k * 0.035 + r() * 0.015;
    band(b, r, at, 0.05, 2500, 1100, 0.015, 1.2, 0.001, 0.012, 0.4 / (1 + k * 0.3), 1.5);
    flesh(b, r, at + 0.004, 0.25 / (1 + k * 0.3), 0.6, 0.6);
  }
  const home = 0.75 + r() * 0.05;
  scrape(b, r, home - 0.12, 0.12, 2400, 0.25);
  part(b, r, home, 2800, 0.45, 800, 0.3);
  strike(b, r, home, jit(r, 560, 0.04), BAR, 0.06, 0.0003, 0.6);
  return b.normalize(0.85).fadeOut(0.15);
}

// Blood loss bursting: a wet, heavy spatter, and drops hitting the dirt.
function bleed(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.5);
  flesh(b, r, 0, 0.6, 1, 1.2);
  band(b, r, 0, 0.3, 1800, 500, 0.06, 1.5, 0.002, 0.05, 0.6, 1.5);
  grains(b, r, 0.03, 0.25, 14, 400, 1800, 0.25);
  return squash(b, 2).normalize(0.75).fadeOut(0.05);
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
  // The shock front: a Friedlander pulse, longer for a bigger charge (its positive phase grows
  // as the cube root of the charge).
  pulse(b, 0, 0.004 * Math.cbrt(scale * scale * scale * 2), 1.4);
  // The fireball: a roar of driven noise rolling out, its top dying as it goes, and the gas
  // under it, a whump that falls with the fireball's size.
  report(b, r, 0.001, 1.3 * scale, 5000, 150, 0.16 * scale, 2.4, 0.8);
  band(b, r, 0.01, 0.9 * scale, 900, 200, 0.12, 0.7, 0.02, 0.25 * scale, 0.9, 2);
  thump(b, r, 0, 90 / Math.sqrt(scale), 0.003, 0.22 * scale, 1.5);
  crackle(b, r, 0.03, 0.6 * scale, 110, 1500, 5000, 0.2);
  const lp = new LP1(sr), lp2 = new LP1(sr), swell = slowNoise(r, sr, b.len / sr, 5);
  const comp = Math.sqrt(sr / (2 * 220));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    b.d[i] += lp2.run(lp.run(r() * 2 - 1, 220), 220) * comp * (0.8 + 0.3 * swell[i]) * ad(t, 0.03, 0.9 * scale) * 0.55;
  }
  // The ground torn up, and what was thrown up coming down: clods first, stones after.
  earth(b, r, 0.005, 0.8, 1.5 * scale);
  for (let k = 0; k < Math.round(10 * scale); k++) {
    const u = r();
    thump(b, r, 0.3 + u * 0.9 * scale, 200 + r() * 150, 0.002, 0.02, 0.25 * (1 - u * 0.6));
  }
  grains(b, r, 0.35, 1.2 * scale, Math.round(26 * scale), 1200, 5000, 0.16, 0.35);
  // From the bigger ones a bit of sheet metal lands among the stones.
  if (scale >= 1) for (let k = 0; k < Math.round(2 * scale); k++) strike(b, r, 0.5 + r() * 0.8 * scale, jit(r, 700, 0.3), PLATE, 0.08, 0.0006, 0.4);
  // All of it sent back off the treeline, darker and smeared.
  const dry = b.d.slice(0, Math.ceil(sr * 0.5));
  for (const [d, g] of [[0.28, 0.26], [0.65, 0.13], [1.2, 0.06]] as const) echo(b, r, dry, jit(r, d, 0.15), g, 800, 0.03 + d * 0.03);
  return squash(b, 2.5).normalize(0.95).fadeOut(0.3);
}

// The old concussion, which the slam (a creep's) still uses.
function slamBlast(sr: number, r: R, big: boolean): Buf {
  const b = new Buf(sr, big ? 1.8 : 1.1);
  thud(b, r, 0, big ? 60 : 75, 26, big ? 0.18 : 0.12, 1.2, 0.4, 500);
  roar(b, r, 0, 0.6, 700, 120, 0.004, big ? 0.12 : 0.08, 0.8, 2.5);
  whoosh(b, r, 0, 0.35, 900, 200, 0.4, 0.8);
  if (big) debris(b, r, 0.08, 0.9, 16, 900, 3500, 0.15);
  roar(b, r, 0.02, 1.2, 400, 120, 0.04, big ? 0.6 : 0.35, 0.35);
  return b.normalize(0.9).fadeOut(0.1);
}

// A concussion charge: built to knock down, not to throw anything, so a pressure wave and
// little else. A long, heavy pulse felt in the chest, the air it shoves past (a low rush and
// its suck back), dust lifted off the ground in a hiss and a dull rumble off the trees.
function concussion(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.2);
  pulse(b, 0, 0.009, 1.5);
  thump(b, r, 0, 75, 0.004, 0.14, 1.3);
  band(b, r, 0.003, 0.5, 1100, 220, 0.06, 0.6, 0.004, 0.09, 0.9, 2);
  swing(b, r, 0.06, 0.3, 700, 220, 0.4);
  grains(b, r, 0.02, 0.4, 30, 1500, 5000, 0.1);
  report(b, r, 0.03, 1.1, 600, 120, 0.3, 0.5, 0.6);
  return squash(b, 2.5).normalize(0.9).fadeOut(0.1);
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
  // The glint: a sliver of ice ringing as it snaps, a few short inharmonic modes.
  strike(b, r, 0.03, jit(r, 1870, 0.05), PLATE, 0.1, 0.0002, 0.5);
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
    // The hound snarls: short, high for the dead, a growl bubbling through it.
    case 8: v(jit(r, 0.35, 0.25), jit(r, 210, 0.1), 160, V.aa, V.uh, 0.8, 0.12, 0.7, 32, 2.5); break;
    // The mauler a brute's chest with a runner's rage in it.
    case 9: v(jit(r, 1, 0.15), jit(r, 75, 0.08), 58, V.aa, V.uh, 0.8, 0.1, 1.1, 0, 3.2); break;
    // The goliath the deepest throat there is, slow and rolling.
    case 10: v(jit(r, 1.8, 0.1), jit(r, 36, 0.06), 30, V.oh, V.uh, 0.9, 0.12, 1.25, 7, 3.6); break;
    // The burster a runner's shriek gone shrill and wheezing, rising as it comes.
    case 11: v(jit(r, 0.45, 0.2), jit(r, 360, 0.12), 470, V.aa, V.ee, 0.7, 0.14, 0.75, 18, 2.4); break;
    default: v(jit(r, 1.2, 0.2), jit(r, 92, 0.12), 72, r() < 0.5 ? V.uh : V.er, V.aa, 0.38, 0.07, 0.9); break;
  }
}

// The big ones: brute, abomination, broodmother, mauler, goliath; the huge are the bosses.
const BIG = new Set([3, 5, 7, 9, 10]);

function creepDeath(sr: number, r: R, kind: number): Buf {
  const big = BIG.has(kind), huge = kind === 5 || kind === 7 || kind === 10;
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
  // The drag kept short: a horde's steps are the commonest sound there is, and a long one ran
  // together into a hiss under everything.
  const b = new Buf(sr, 0.18);
  const drag = jit(r, 0.06, 0.25);
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

// Reloading, the way each gun is: [start, end]. Steel on steel and the hand on the gun: catches
// and latches (a small part struck, ringing for a few milliseconds), strokes (steel drawn over
// steel), the heavy parts going home (a part with the gun's wooden or polymer body knocked
// under it) and a magazine or box dropped on the dirt. The body under each blow is what makes a
// reload sound solid; no part rings longer than a real one, so nothing chimes.
function reload(sr: number, r: R, w: number, end: boolean): Buf {
  const b = new Buf(sr, 0.8);
  // A latch or catch: small, light, high.
  const tick = (at: number, f: number, g: number) => part(b, r, at, f, g * 0.5, 700, 0.15);
  // A heavy part home: the part and the body under it.
  const home = (at: number, f: number, g: number, body = 300) => part(b, r, at, f, g * 0.55, body * 1.8, 1);
  switch (w) {
    case 0: // pistol: the release pressed, the magazine out and onto the dirt; in, seated, and the slide let go
      if (!end) {
        tick(0, 3200, 0.5); scrape(b, r, 0.01, 0.06, 2300, 0.5);
        strike(b, r, 0.3, jit(r, 1300, 0.1), PLATE, 0.07, 0.0008, 0.3); earth(b, r, 0.3, 0.07, 0.3); tick(0.37, 2300, 0.2);
      } else {
        scrape(b, r, 0, 0.05, 2100, 0.45); home(0.05, 1600, 0.8, 260); scrape(b, r, 0.2, 0.04, 2600, 0.4); home(0.24, 2400, 1.1, 340);
      }
      break;
    case 1: // shotgun: a shell thumbed into the tube, brass on steel and the follower's spring; the pump racked back to its stop and slammed forward
      if (!end) { scrape(b, r, 0, 0.06, 1300, 0.55); home(0.06, 1300, 0.6, 220); strike(b, r, 0.065, jit(r, 2600, 0.05), CASE, 0.06, 0.0002, 0.4); } else {
        tick(0, 1800, 0.6); scrape(b, r, 0.01, 0.08, 1400, 0.6); home(0.09, 1400, 0.9, 200);
        strike(b, r, 0.09, jit(r, 620, 0.05), WOOD, 0.25, 0.001); scrape(b, r, 0.15, 0.06, 1600, 0.55); home(0.21, 2000, 1.2, 260);
      }
      break;
    case 2: // SMG: the magazine out; in and slapped home with the palm, then the charging handle drawn and let fly
      if (!end) { tick(0, 3000, 0.5); scrape(b, r, 0.01, 0.05, 2400, 0.45); home(0.07, 1700, 0.45, 300); } else {
        scrape(b, r, 0, 0.04, 2100, 0.4); home(0.04, 1500, 0.8, 240); flesh(b, r, 0.045, 0.25, 0, 0.6);
        tick(0.2, 2600, 0.5); scrape(b, r, 0.21, 0.05, 2600, 0.45); home(0.29, 2200, 1.1, 320);
      }
      break;
    case 3: // rifle: the bolt lifted and drawn to its stop; a clip of rounds stripped in, the bolt run home and turned down
      if (!end) { tick(0, 2600, 0.6); scrape(b, r, 0.03, 0.09, 2200, 0.6); home(0.12, 1900, 0.6, 300); } else {
        scrape(b, r, 0, 0.12, 1700, 0.45);
        for (let k = 0; k < 5; k++) strike(b, r, 0.01 + k * 0.022 + r() * 0.006, jit(r, 3300, 0.06), CASE, 0.08, 0.0002, 0.3);
        tick(0.15, 3100, 0.3);
        scrape(b, r, 0.2, 0.08, 2400, 0.6); home(0.28, 1700, 1, 320); tick(0.34, 3000, 0.7);
      }
      break;
    case 4: // minigun: the feed cover unlatched, the empty box out and onto the ground; the belt fed link by link, the cover slammed and the barrels given a turn
      if (!end) {
        home(0, 1100, 0.6, 200); scrape(b, r, 0.1, 0.1, 1100, 0.4);
        strike(b, r, 0.3, jit(r, 420, 0.08), PLATE, 0.3, 0.001, 0.4); earth(b, r, 0.3, 0.45, 0.8);
      } else {
        for (let k = 0; k < 10; k++) strike(b, r, k * 0.022 + r() * 0.004, jit(r, 2400, 0.2), CASE, 0.1, 0.0003, 0.3);
        home(0.25, 1000, 1.2, 180); strike(b, r, 0.25, jit(r, 380, 0.05), PLATE, 0.25, 0.001, 0.4);
        servo(b, r, 0.36, 0.3, 0.12);
      }
      break;
    case 5: // rocket launcher: the tube's latch opened, the tube hollow; a rocket slid in, latched, and the arming switch thrown
      if (!end) { home(0, 900, 0.6, 180); strike(b, r, 0.005, jit(r, 310, 0.04), PIPE, 0.18, 0.0012, 0.25); } else {
        scrape(b, r, 0, 0.2, 900, 0.55); strike(b, r, 0.02, jit(r, 290, 0.04), PIPE, 0.12, 0.002, 0.3); home(0.21, 1100, 1, 170);
        tick(0.38, 2100, 0.35); tick(0.42, 2800, 0.5);
      }
      break;
  }
  return b.normalize(0.8).fadeOut();
}

// Changing guns: the one in hand slung with a rustle of webbing, the other drawn, its grip
// slapped into the palm and the safety thumbed off.
function weaponSwitch(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.4);
  cloth(b, r, 0, 0.14, 0.4, 0.8);
  scrape(b, r, 0.06, 0.09, 1600, 0.4);
  flesh(b, r, 0.15, 0.35, 0, 0.5);
  part(b, r, 0.15, 1600, 0.3, 350, 0.6);
  part(b, r, 0.23 + r() * 0.02, 3200, 0.25, 700, 0.1);
  return b.normalize(0.8).fadeOut();
}

// Pulling the trigger on an empty chamber: the trigger's travel, the hammer falling on nothing
// with a hard, dry snap and the frame knocked under it, and no shot.
function dryFire(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.25);
  part(b, r, 0, 2400, 0.12, 700, 0.1);
  const at = 0.035 + r() * 0.01;
  part(b, r, at, jit(r, 3600, 0.08), 0.6, 420, 0.5);
  strike(b, r, at, jit(r, 2900, 0.05), PART, 0.15, 0.0001, 1.5);
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

// Paying: a handful of coins tipped onto a pile, each strike two coins' own modes ringing
// briefly, the clinks thinning as they settle, and the last one spinning down on its edge. It
// plays on every buy and sell, often several in a row: rings kept short and below the
// harshest band, and the spin a brief rattle, not a ringing tail.
function coins(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  thud(b, r, 0, 260, 160, 0.015, 0.35, 0.8, 1500);
  let t = 0;
  for (let k = 0; k < 12; k++) {
    t += 0.008 + r() * 0.03 * (1 + k * 0.12);
    const f = jit(r, 2100, 0.25);
    ping(b, t, [f, f * 1.47, f * 2.09], 0.018 + r() * 0.018, 0.3 * (1 - k / 16));
    click(b, r, t, 1600, 0.12, 0.002);
  }
  const f = jit(r, 1900, 0.1);
  for (let s = t + 0.04, gap = 0.04; gap > 0.008 && s < 0.62; s += gap, gap *= 0.72) ping(b, s, [f, f * 1.47], 0.012, 0.08);
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

// Building: a hammer driving a nail into a plank. The nail is a thin steel bar struck on its
// end, ringing higher and shorter as less of it stands proud; the plank knocks under it (wood's
// modes, short); the hammer's head is a heavy block that barely rings. The last blow is a dead
// thump as the head meets the wood.
function hammer(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.8);
  const nail = jit(r, 2300, 0.06), plank = jit(r, 380, 0.08);
  [0, 0.17, 0.33].forEach((at, k) => {
    at += k ? (r() - 0.5) * 0.03 : 0;
    const last = k === 2;
    strike(b, r, at, plank, WOOD, last ? 0.6 : 0.4, 0.0006, last ? 1.3 : 1);
    grains(b, r, at, 0.004, 3, 1500, 5000, 0.3);
    thump(b, r, at, plank * 0.45, 0.001, 0.018, last ? 0.9 : 0.5);
    if (!last) strike(b, r, at, nail * (1 + k * 0.15), BAR, 0.3, 0.0001, 0.12 / (1 + k));
    else strike(b, r, at, jit(r, 1700, 0.05), IRON, 0.12, 0.0004, 0.2);
  });
  return b.normalize(0.85).fadeOut();
}

// A structure falling down: the frame giving with a crack of timber, the mass hitting the
// ground, masonry and dirt sliding off it and stones rattling down after, a dust-laden rush.
function crumble(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.9);
  grains(b, r, 0, 0.06, 18, 600, 3000, 0.5);
  strike(b, r, 0.01, jit(r, 260, 0.08), WOOD, 0.4, 0.002);
  thump(b, r, 0.05, 70, 0.006, 0.22, 1.2);
  earth(b, r, 0.05, 1, 2);
  band(b, r, 0.05, 1.6, 1400, 180, 0.4, 0.7, 0.01, 0.45, 0.9, 2);
  grains(b, r, 0.08, 1.3, 50, 600, 3200, 0.35, 0.5);
  return squash(b, 2).normalize(0.85).fadeOut(0.1);
}

// A supply drop landing: the crate hitting the ground hard, its planks knocking and rattling in
// their straps, a buckle on the strap ticking, dirt kicked up, the crate rocking back once, and
// the parachute settling over it with a soft, fluttering rush of cloth.
function crateLand(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.4);
  thump(b, r, 0, 100, 0.002, 0.09, 1.2);
  strike(b, r, 0.002, jit(r, 175, 0.05), WOOD, 0.8, 0.002, 1.6);
  earth(b, r, 0, 0.6, 1);
  strike(b, r, 0.03, jit(r, 2100, 0.06), PART, 0.05, 0.0002);
  part(b, r, 0.12 + r() * 0.03, 900, 0.3, 260, 1);
  thump(b, r, 0.22, 120, 0.002, 0.03, 0.4);
  strike(b, r, 0.22, jit(r, 220, 0.05), WOOD, 0.25, 0.002);
  cloth(b, r, 0.3, 0.8, 0.6, 1);
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

// A grenade thrown: the pin's ring drawn out of its hole with a scrape and a tick, the spoon
// flying off (a thin strip of steel, ringing briefly as it spins away), and the arm swung
// through in a sleeve.
function grenadeThrow(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.7);
  scrape(b, r, 0, 0.05, 3000, 0.35);
  part(b, r, 0.045, 4200, 0.25, 900, 0.1);
  const spoon = 0.2 + r() * 0.03;
  part(b, r, spoon, 3000, 0.3, 700, 0.3);
  strike(b, r, spoon, jit(r, 1900, 0.06), PLATE, 0.08, 0.0002, 0.6);
  cloth(b, r, 0.22, 0.3, 0.4, 0.6);
  swing(b, r, 0.28, 0.3, 300, 1300, 0.35);
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

// Jets going over for an airstrike: the roar climbing as they come, a Doppler fall as they pass
// right overhead (the turbine's whine is a narrow band of noise, not a tone, falling with the
// rest), and a long rumble going away.
function jets(sr: number, r: R): Buf {
  const b = new Buf(sr, 4.2);
  const sv = new SVF(sr), wh = new SVF(sr), lp = new LP1(sr), comp = Math.sqrt(sr / (2 * 250));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, near = bump(t, 2.2, 0.8);
    sv.run(r() * 2 - 1, 300 + 3200 * near, 0.7);
    const f = 2400 - 1100 * (1 / (1 + Math.exp(-(t - 2.2) * 6)));
    const whine = wh.run(r() * 2 - 1, f, 10).band * Math.sqrt(sr / f) * 0.08;
    b.d[i] = sv.low * near * 0.9 + lp.run(r() * 2 - 1, 250) * comp * bump(t, 2.4, 1.2) * 0.4 + whine * bump(t, 2.1, 0.45);
  }
  return b.normalize(0.85).fadeOut(0.2);
}

// --- the game's own -----------------------------------------------------------------------

// The air-raid siren: the motor winding up, holding, and winding down when it is cut.
function sirenWave(sr: number, r: R): Buf {
  return siren(sr, r, 6, 560, (t) => t < 3.4 ? 60 + 500 * (1 - Math.exp(-t / 0.9)) : 60 + 495 * Math.exp(-(t - 3.4) / 1.5),
    (t) => Math.min(1, t / 0.3) * (t > 4.2 ? Math.max(0, (6 - t) / 1.8) : 1));
}
// A boss: the attack signal rather than the alert, the siren wound up hard and wailing up and
// down instead of holding, and a deeper one farther off wailing out of step with it, so the
// whole town is calling and the two beat against each other; both cut and groan down.
function sirenBoss(sr: number, r: R): Buf {
  const wail = (base: number, depth: number, per: number, cut: number, ph: number) => {
    const p = (t: number) => 60 + (base - 60) * (1 - Math.exp(-t / 0.5)) + depth * Math.sin(TAU * t / per + ph) * Math.min(1, t / 1.2);
    return (t: number) => t < cut ? p(t) : 60 + (p(cut) - 60) * Math.exp(-(t - cut) / 1.3);
  };
  const env = (cut: number, len: number) => (t: number) => Math.min(1, t / 0.25) * (t > cut ? Math.max(0, (len - t) / (len - cut)) : 1);
  const b = siren(sr, r, 8.5, 600, wail(480, 120, 1.7, 6.6, 0), env(6.6, 8.5));
  const far = siren(sr, r, 7.5, 420, wail(320, 80, 2.2, 6, Math.PI), env(6, 7.5)), o = Math.floor(0.6 * sr);
  for (let i = 0; i < far.len && o + i < b.len; i++) b.d[o + i] += far.d[i] * 0.45;
  return b.normalize(0.8).fadeOut(0.1);
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
// A burster's fuse lit: a sharp click, then the sputtering hiss of the fuse running down, an
// electronic beep quickening over it.
function burstFuse(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.55);
  click(b, r, 0, 2600, 0.6, 0.003, 1400);
  hiss(b, r, 0.02, 0.48, 0.5);
  for (let i = 0; i < 12; i++) click(b, r, 0.03 + r() * 0.45, 3000 + r() * 2500, 0.25, 0.0015);
  for (const t of [0.04, 0.2, 0.31, 0.38, 0.43]) ping(b, t, [2200, 4400], 0.03, 0.35);
  return b.normalize(0.85).fadeOut(0.02);
}

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

// --- the base grown, traps, affixes, evolutions -----------------------------------------------
//
// The features that came after the first sound pass (web/src/sound/coverage.ts and
// ambience.ts play them). Built of the same parts as the rest: clicks and clacks for metal,
// thuds and roars for weight and fire, voices through formants, nothing above about 7 kHz that
// repeats often.

// A bait pit going off: the hooks' chains snatched taut with a rattle and a clank, a wet heave
// of the meat in the pit, and the low drag of everything in reach hauled in at once.
function baitGrab(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.4);
  clack(b, r, 0, jit(r, 1100, 0.1), 0.5, 240);
  for (let k = 0; k < 3; k++) clack(b, r, 0.03 + k * 0.05 + r() * 0.02, jit(r, 1700, 0.2), 0.25, 400);
  debris(b, r, 0.02, 0.4, 18, 1800, 4200, 0.18);
  const sv = new SVF(sr), o = Math.floor(0.08 * sr);
  for (let i = 0; i < sr * 0.5 && o + i < b.len; i++) {
    const t = i / sr;
    b.d[o + i] += sv.run(r() * 2 - 1, 260 + 180 * Math.sin(t * 18), 3).band * bump(t, 0.2, 0.18) * 0.9;
  }
  roar(b, r, 0.1, 1.1, 500, 120, 0.15, 0.6, 0.5, 2);
  thud(b, r, 0.05, 90, 45, 0.08, 0.7, 0.5, 400);
  return b.normalize(0.8).fadeOut(0.15);
}

// A catapult pit throwing: the catch let go, the arm whipping up on its rope, the timber frame
// groaning and knocking, the slam of the arm against its padded stop and the air it throws.
function catapult(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.9);
  part(b, r, 0, 2400, 0.3, 600, 0.3);
  const f = jit(r, 210, 0.12);
  strike(b, r, 0.01, f, WOOD, 0.5, 0.003, 2.5);
  swing(b, r, 0.0, 0.1, 400, 1500, 0.8);
  strike(b, r, 0.07, jit(r, 330, 0.1), WOOD, 0.8, 0.0015, 1.5);
  thump(b, r, 0.07, 130, 0.002, 0.04, 0.8);
  cloth(b, r, 0.07, 0.05, 0.4, 1);
  return b.normalize(0.8).fadeOut();
}

// A thrown creep coming down: a heavy body hitting the dirt, a crack and a scatter of grit.
function fallThud(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.6);
  thud(b, r, 0, jit(r, 75, 0.2), 38, 0.06, 1, 0.5, 450);
  click(b, r, 0.004, 1600, 0.3, 0.004, 700);
  debris(b, r, 0.02, 0.3, 10, 700, 3000, 0.15);
  return b.normalize(0.75).fadeOut();
}

// A gate swung: the latch knocked up, the hinges creaking (stick and slip, heavier and lower
// than a crate's lid), the air the leaf pushes, and the steel stopping against its post. Open
// it stops with a clank and a rattle; shut it slams and the latch drops home.
function gate(sr: number, r: R, open: boolean): Buf {
  const b = new Buf(sr, 1.3);
  part(b, r, 0, jit(r, 1400, 0.1), 0.25, 470, 0.8);
  const sv = new SVF(sr), crk = slowNoise(r, sr, 0.7, 9), cl = open ? jit(r, 0.45, 0.15) : jit(r, 0.3, 0.15);
  const base = jit(r, 120, 0.15);
  let ph = 0;
  for (let i = Math.floor(0.05 * sr), n = Math.floor((0.05 + cl) * sr); i < n; i++) {
    const t = i / sr - 0.05;
    ph += (base + 50 * crk[i]) / sr;
    const x = ph >= 1 ? 1 : 0;
    if (ph >= 1) ph -= 1;
    b.d[i] += sv.run(x * 4 + (r() * 2 - 1) * 0.08, jit(r, 1050, 0.02), 4).band * Math.sin(Math.PI * t / cl) * 0.4;
  }
  band(b, r, 0.05, cl + 0.1, 250, 500, cl, 0.6, cl * 0.5, cl * 0.4, 0.35);
  const stop = 0.05 + cl, f = jit(r, 310, 0.08);
  if (open) {
    part(b, r, stop, 900, 0.35, 300, 1);
    strike(b, r, stop, f, IRON, 0.3, 0.0008, 0.5);
    grains(b, r, stop + 0.01, 0.15, 6, 1200, 3000, 0.15);
  } else {
    thump(b, r, stop, 120, 0.002, 0.05, 1);
    part(b, r, stop, 1200, 0.5, 360, 1);
    strike(b, r, stop, f * 0.9, IRON, 0.35, 0.001, 0.6);
    part(b, r, stop + jit(r, 0.12, 0.2), 2100, 0.2, 700, 0.3);
  }
  return b.normalize(0.8).fadeOut();
}

// A pylon switched on: the contactor shutting, the coil charging up in a rising whine, and
// the steady buzz it settles to, a spark ticking off its top.
function pylonOn(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.4);
  part(b, r, 0, 1600, 0.35, 420, 0.8);
  // The coil charging: its windings singing in a narrow band of noise that climbs, and under
  // it the core's 100 Hz buzz (the laminations rattling twice a mains cycle).
  const cw = new SVF(sr), lam = new SVF(sr);
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, u = Math.min(1, t / 0.7), fq = 120 + 1900 * u * u;
    const whine = cw.run(r() * 2 - 1, fq, 12).band * Math.sqrt(sr / fq) * 0.05;
    const buzz = lam.run(Math.tanh(Math.sin(TAU * 100 * t) * 3) + (r() * 2 - 1) * 0.3, 400, 0.8).low * 0.12;
    b.d[i] += (whine * (1 - 0.6 * u) + buzz) * Math.min(1, t / 0.05) * Math.max(0, Math.min(1, (1.4 - t) / 0.5));
  }
  grains(b, r, 0.6, 0.6, 5, 2500, 5000, 0.3);
  return b.normalize(0.7).fadeOut();
}

// A pylon standing: a transformer's buzz at twice the mains, a thin whine high over it, beating
// slowly. Two seconds of whole cycles, filters run in from before the start, so no seam.
function pylon(sr: number, r: R): Buf {
  const b = new Buf(sr, 2);
  const sv = new SVF(sr), noise = new Float32Array(b.len);
  for (let i = 0; i < b.len; i++) noise[i] = r() * 2 - 1;
  for (let i = -Math.floor(sr * 0.1); i < b.len; i++) {
    const t = i / sr;
    const buzz = Math.tanh(Math.sin(TAU * 120 * t) * 2.5) + 0.3 * Math.sin(TAU * 240 * t);
    const y = sv.run(buzz + noise[(i + b.len) % b.len] * 0.15, 700, 1).band * (0.85 + 0.15 * Math.sin(TAU * t))
      + Math.sin(TAU * 2400 * t) * 0.04 * (0.6 + 0.4 * Math.sin(TAU * 2 * t));
    if (i >= 0) b.d[i] = y;
  }
  return b.normalize(0.6);
}

// Paying into the generator: a hundred in coin tipped into its hopper, rattling down a metal
// chute, and the counter ticking it up with a clunk.
function payIn(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.1);
  let t = 0;
  for (let k = 0; k < 9; k++) {
    t += 0.01 + r() * 0.025;
    const f = jit(r, 2000, 0.25);
    ping(b, t, [f, f * 1.47, f * 2.09], 0.015 + r() * 0.012, 0.25 * (1 - k / 14));
  }
  // The chute: the coins knocking down a tube, ringing in it.
  const tube = new SVF(sr), o = Math.floor(0.2 * sr);
  for (let i = 0; i < sr * 0.35 && o + i < b.len; i++) {
    const x = r() < 0.004 ? (r() * 2 - 1) * 4 : 0;
    b.d[o + i] += tube.run(x, jit(r, 950, 0.01), 5).band * Math.max(0, 1 - i / (sr * 0.35)) * 0.6;
  }
  for (let k = 0; k < 3; k++) click(b, r, 0.62 + k * 0.07, 1700, 0.3, 0.002, 900);
  clack(b, r, 0.86, 1100, 0.5, 220);
  return b.normalize(0.7).fadeOut();
}

// The generator going up a tier: a breaker thrown, the machine spinning up from a growl to a
// higher, fuller hum, the transformer buzzing in, pressure let off, and its housing ringing.
function tierUp(sr: number, r: R): Buf {
  const b = new Buf(sr, 3);
  part(b, r, 0, 900, 0.6, 290, 1);
  thump(b, r, 0, 90, 0.002, 0.06, 0.8);
  let ph = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, u = Math.min(1, t / 1.8);
    const f = 25 + 75 * (1 - Math.pow(1 - u, 2));
    ph += TAU * f / sr;
    const tone = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.15 * Math.sin(4 * ph);
    const buzz = Math.tanh(Math.sin(TAU * 100 * t) * 2) * 0.25 * Math.min(1, Math.max(0, (t - 1) / 0.6));
    b.d[i] += (tone * 0.45 * u + buzz) * Math.min(1, t / 0.1) * Math.max(0, Math.min(1, (3 - t) / 0.8));
  }
  const hs = new SVF(sr), o = Math.floor(1.6 * sr);
  for (let i = 0; i < sr * 0.7 && o + i < b.len; i++) b.d[o + i] += hs.run(r() * 2 - 1, 3200, 0.7).band * ad(i / sr, 0.02, 0.25) * 0.3;
  strike(b, r, 1.75, jit(r, 180, 0.05), PLATE, 0.35, 0.002, 1.5);
  return b.normalize(0.8).fadeOut(0.2);
}

// The Overload: the generator's capacitors whining up for a breath, then letting go all at
// once, a crack and a slam felt in the chest, arcs crackling out over the walls, and the cold
// it leaves crackling into ice on everything it caught.
function overload(sr: number, r: R): Buf {
  const b = new Buf(sr, 3.4);
  const charge = 0.3;
  // The bank charging: the coils' whine, a narrow band of noise climbing fast.
  const cw = new SVF(sr);
  for (let i = 0; i < charge * sr; i++) {
    const t = i / sr, u = t / charge, fq = 200 + 2200 * u * u;
    b.d[i] += cw.run(r() * 2 - 1, fq, 12).band * Math.sqrt(sr / fq) * u * u * 0.07;
  }
  const o = Math.floor(charge * sr);
  pulse(b, charge, 0.005, 1.3);
  roar(b, r, charge, 1.2, 5200, 300, 0.0008, 0.12, 1.1, 4);
  thud(b, r, charge, 65, 20, 0.35, 1.5, 0.2, 250);
  crackle(b, r, charge + 0.02, 1.6, 260, 1800, 6000, 0.35);
  // The arcs: a buzz thrown about in pitch, dying out over a second.
  const buzz = new SVF(sr), fm = slowNoise(r, sr, 3.4, 40);
  let bp = 0;
  for (let i = o; i < b.len; i++) {
    const t = i / sr - charge;
    bp += (110 + 60 * fm[i]) / sr; bp -= Math.floor(bp);
    b.d[i] += buzz.run((bp < 0.5 ? 1 : -1) + (r() * 2 - 1) * 0.5, 1400, 1).band * ad(t, 0.005, 0.5) * 0.35;
  }
  // The freeze: ice cracking on what was caught, crowded at first and thinning.
  for (let k = 0; k < 40; k++) {
    const u = Math.pow(r(), 1.6), f = 1800 + r() * 3200;
    click(b, r, charge + 0.4 + u * 1.6, f, (0.2 + r() * 0.3) * Math.exp(-u * 1.5), 0.0012 + r() * 0.002, f * 0.6);
  }
  const dry = b.d.slice(o, o + Math.ceil(0.5 * sr));
  for (const [d, g] of [[0.3, 0.25], [0.7, 0.12], [1.3, 0.05]] as const) {
    const a = new LP1(sr), c = new LP1(sr), e = o + Math.floor(jit(r, d, 0.1) * sr);
    for (let i = 0; i < dry.length && e + i < b.len; i++) b.d[e + i] += c.run(a.run(dry[i], 900), 900) * g;
  }
  return b.normalize(0.95).fadeOut(0.3);
}

// The Overload charged for this wave: the capacitor bank whining up and a relay shutting.
function overloadReady(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.1);
  const cw = new SVF(sr);
  for (let i = 0; i < 0.85 * sr; i++) {
    const t = i / sr, u = t / 0.85, fq = 300 + 1500 * u;
    b.d[i] += cw.run(r() * 2 - 1, fq, 14).band * Math.sqrt(sr / fq) * (0.6 + 0.4 * Math.sin(TAU * 100 * t)) * Math.min(1, t / 0.1) * (0.3 + 0.7 * u) * 0.05;
  }
  part(b, r, 0.85, 1500, 0.35, 470, 0.8);
  part(b, r, 0.9, 2800, 0.15, 800, 0.2);
  return b.normalize(0.65).fadeOut();
}

// A turret evolving: the hydraulics hissing as it is lifted apart, an impact gun rattling the
// new parts on, a heavy clank as they seat, and the servos running it through its arc once.
function evolve(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.6);
  const hs = new SVF(sr);
  for (let i = 0; i < sr * 0.3; i++) b.d[i] += hs.run(r() * 2 - 1, 3500, 0.8).band * ad(i / sr, 0.02, 0.12) * 0.35;
  for (const [s, e] of [[0.25, 0.4], [0.48, 0.66]]) for (let t = s; t < e; t += 1 / jit(r, 28, 0.1)) part(b, r, t, 2200 + r() * 300, 0.14, 800, 0.4);
  const f = jit(r, 520, 0.06);
  thump(b, r, 0.78, 110, 0.002, 0.06, 1);
  strike(b, r, 0.78, f, IRON, 0.4, 0.0008, 0.8);
  servo(b, r, 1, 0.4, 0.06);
  part(b, r, 1.42, 1900, 0.2, 520, 0.6);
  return b.normalize(0.8).fadeOut();
}

// The gatling evolution: lighter rounds than the sentry's, more than twice as many, the six
// barrels ticking round under them.
const GATLING: Gun = {
  len: 0.45, crack: 0.5, blast: 0.8, T: 0.0005, drive: 5,
  gas: 0.9, gasF: 2700, gasTau: 0.01, body: 1.1, bodyF: 1700, ring: [3300, 0.12, 0.01], chest: 0.18, chestF: 320, chestTau: 0.012,
  rep: 0.22, repTau: 0.08, repF: 2600, repEnd: 700, echoes: [[0.09, 0.11], [0.2, 0.04]],
};
// The penetrator: armour-piercing rounds, a harder crack and more weight behind each.
const PENETRATOR: Gun = {
  len: 0.9, crack: 1.2, blast: 1, T: 0.0011, drive: 6.1,
  gas: 1.1, gasF: 1800, gasTau: 0.02, body: 1.1, bodyF: 1150, ring: [1500, 0.25, 0.05], chest: 0.48, chestF: 200, chestTau: 0.035,
  rep: 0.38, repTau: 0.2, repF: 1700, repEnd: 400, echoes: [[0.12, 0.2], [0.3, 0.09]],
};
// Anti-materiel: a 20 mm through everything in its line, deeper and wider than the .50.
const ANTIMAT: Gun = {
  len: 3, crack: 1.6, blast: 1.2, T: 0.0026, drive: 7.2,
  gas: 2, gasF: 1300, gasTau: 0.05, body: 1.1, bodyF: 650, ring: [900, 0.1, 0.08], chest: 0.84, chestF: 120, chestTau: 0.09,
  rep: 0.65, repTau: 0.55, repF: 1200, repEnd: 180, echoes: [[0.22, 0.38], [0.55, 0.2], [1, 0.1], [1.6, 0.04]],
};

// A mortar: the shell slid down the tube and ringing on the way, then the hollow thoomp of it
// going, the tube sounding, and the shell whispering up out of earshot.
function mortar(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.6);
  scrape(b, r, 0, 0.08, 1500, 0.3);
  strike(b, r, 0.07, jit(r, 760, 0.05), PIPE, 0.1, 0.0004, 0.3);
  // The thoomp: the charge's gas ringing the tube's air column (a resonance excited by noise,
  // falling as the shell leaves the mouth), the pulse out of the mouth and the baseplate
  // knocked into the ground.
  const at = 0.1, f = jit(r, 160, 0.1), o = Math.floor(at * sr), col = new SVF(sr);
  for (let i = 0; i < sr * 0.4 && o + i < b.len; i++) {
    const t = i / sr, fq = f * (0.8 + 0.2 * Math.exp(-t / 0.04));
    b.d[o + i] += col.run((r() * 2 - 1) * ad(t, 0.002, 0.05), fq, 10).band * Math.sqrt(sr / fq) * 0.4;
  }
  pulse(b, at, 0.003, 0.9);
  thump(b, r, at, 95, 0.002, 0.09, 1.2);
  earth(b, r, at, 0.3, 0.8);
  roar(b, r, at, 0.3, 1600, 200, 0.002, 0.05, 0.7, 3);
  whoosh(b, r, at + 0.05, 0.6, 1300, 650, 0.12, 2);
  const dry = b.d.slice(o, o + Math.ceil(0.3 * sr));
  for (const [d, g] of [[0.25, 0.25], [0.6, 0.1]] as const) {
    const a = new LP1(sr), c = new LP1(sr), e = o + Math.floor(jit(r, d, 0.1) * sr);
    for (let i = 0; i < dry.length && e + i < b.len; i++) b.d[e + i] += c.run(a.run(dry[i], 1000), 1000) * g;
  }
  return b.normalize(0.9).fadeOut(0.1);
}

// A napalm missile leaving: over the tube's pop, the jelly in its nose burning as it goes, a
// fluttering, fiery roar streaking off.
function napalmFlight(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.1);
  const sv = new SVF(sr), lp = new LP1(sr), flutter = slowNoise(r, sr, 1.1, 30);
  const comp = Math.sqrt(sr / (2 * 300));
  for (let i = 0; i < b.len; i++) {
    const t = i / sr, n = r() * 2 - 1;
    const f = 600 + 900 * Math.exp(-t / 0.4);
    b.d[i] += (sv.run(n, f, 0.8).band * (0.7 + 0.4 * flutter[i]) + lp.run(n, 300) * comp * 0.3) * ad(t, 0.03, 0.35);
  }
  crackle(b, r, 0.02, 0.9, 120, 1200, 4000, 0.2);
  return b.normalize(0.8).fadeOut(0.05);
}

// Napalm bursting: no shock front but a soft, heavy whump of jelly catching, a liquid splash as
// it sheets out, the fire rolling up over it and crackling.
function napalmBurst(sr: number, r: R): Buf {
  const b = new Buf(sr, 2.2);
  thud(b, r, 0, 75, 30, 0.2, 1.2, 0.3, 300);
  roar(b, r, 0, 1.3, 1900, 220, 0.03, 0.35, 1, 2.5);
  // The splash: wet noise rising and falling, and the fat bubbles in it.
  const sv = new SVF(sr);
  for (let i = 0; i < sr * 0.35; i++) {
    const t = i / sr;
    b.d[i] += sv.run(r() * 2 - 1, 700 + 900 * Math.sin(Math.PI * t / 0.35), 1.5).band * bump(t, 0.1, 0.08) * 0.5;
  }
  for (let k = 0; k < 10; k++) {
    const at = 0.05 + r() * 0.5, f = 200 + r() * 300, o = Math.floor(at * sr);
    for (let i = 0; i < sr * 0.04 && o + i < b.len; i++) { const t = i / sr; b.d[o + i] += Math.sin(TAU * f * t * (1 + 8 * t)) * ad(t, 0.002, 0.012) * 0.25; }
  }
  crackle(b, r, 0.1, 1.9, 140, 1300, 4500, 0.3);
  return b.normalize(0.85).fadeOut(0.2);
}

// The arc web: one strike crackling out from creep to creep, a snap at each jump and a zap
// falling through it, the buzz of the web held between them. Kept under 7 kHz.
function arcWeb(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.55);
  const n = 4 + Math.floor(r() * 4);
  let at = 0;
  for (let k = 0; k < n; k++) {
    const f = 2000 + r() * 2500, z0 = jit(r, 2600, 0.2);
    click(b, r, at, f, 0.7 * (1 - k / (n + 2)), 0.0015, f * 0.6);
    // The jump's tear through the air: a band of noise falling fast, not a tone.
    band(b, r, at, 0.04, z0, 350, 0.012, 2.5, 0.0005, 0.015, 0.9, 2);
    at += 0.025 + r() * 0.045;
  }
  const buzz = new SVF(sr), top = new LP1(sr);
  let bp = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    bp += (120 + r() * 40) / sr; bp -= Math.floor(bp);
    b.d[i] += buzz.run((bp < 0.5 ? 1 : -1) + (r() * 2 - 1) * 0.6, 1300, 1.1).band * Math.min(1, t / 0.01) * Math.max(0, 1 - t / (at + 0.08)) * 0.35;
    b.d[i] = top.run(b.d[i], 7000);
  }
  return b.normalize(0.8).fadeOut(0.03);
}

// A round off armour: the plate's ring, and now and then the round whining off it, else a
// dull clank where it bit in.
function ricochet(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.4);
  const f = jit(r, 1900, 0.2);
  strike(b, r, 0, f, PLATE, 0.45, 0.0001, 0.25);
  if (r() < 0.55) {
    // The round tumbling away: the air torn round a spinning, deformed slug, a narrow band of
    // noise falling with its Doppler and wobbling at its spin.
    const w0 = jit(r, 3000, 0.15), w1 = w0 * (0.4 + r() * 0.15), d = jit(r, 0.22, 0.2), o = Math.floor(0.008 * sr), wh = new SVF(sr);
    for (let i = 0; i < d * sr && o + i < b.len; i++) {
      const t = i / sr, fq = (w1 + (w0 - w1) * Math.exp(-t / (d * 0.5))) * (1 + 0.01 * Math.sin(TAU * 40 * t));
      b.d[o + i] += wh.run(r() * 2 - 1, fq, 22).band * Math.sqrt(sr / fq) * bump(t, d * 0.3, d * 0.3) * 0.028;
    }
  } else thump(b, r, 0, 300, 0.001, 0.012, 0.4);
  return b.normalize(0.6).fadeOut();
}

// A sapper's fuse: a lit cord spitting and hissing, crackling unevenly. Made whole.
function fuse(sr: number, r: R): Buf {
  return seamless(sr, 2, 0.2, (b) => {
    const sv = new SVF(sr), sputter = slowNoise(r, sr, b.len / sr, 22);
    for (let i = 0; i < b.len; i++) b.d[i] = sv.run(r() * 2 - 1, 3600, 0.8).band * (0.4 + 0.6 * Math.max(0, sputter[i])) * 0.5;
    for (let k = 0; k < 120; k++) click(b, r, r() * (b.len / sr - 0.01), 1500 + r() * 3000, 0.2 + r() * 0.3, 0.001 + r() * 0.0015);
    b.normalize(0.6);
  });
}

// A splitter bursting: the body tearing open wet, and the two swarmers inside squealing out.
function splitBurst(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.9);
  roar(b, r, 0, 0.4, 1800, 300, 0.002, 0.08, 1, 3);
  thud(b, r, 0, 160, 70, 0.04, 0.6, 0.6);
  debris(b, r, 0.01, 0.25, 10, 600, 2200, 0.35);
  creepVoice(b, r, 0.08, 2, 0.5);
  creepVoice(b, r, 0.15 + r() * 0.05, 2, 0.45);
  return b.normalize(0.8).fadeOut();
}

// A creep frenzying: it has lost patience with the maze, and it shrieks it.
function frenzy(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.8);
  const f = jit(r, 190, 0.15);
  vox(b, r, 0, {
    dur: jit(r, 0.55, 0.15), f0: (u) => f * (1 + 0.7 * Math.sin(Math.PI * Math.min(1, u * 1.3))), vowel: (u) => lerpV(V.ae, V.ee, u),
    rasp: 0.75, jitter: 0.12, a: 0.03, rel: 0.2, gain: 1, drive: 3, fry: 0.3,
  });
  vox(b, r, 0.02, { dur: 0.45, f0: (u) => f * 0.5 * (1 + 0.4 * u), vowel: () => [...V.aa], rasp: 0.85, jitter: 0.15, a: 0.03, rel: 0.15, gain: 0.5, drive: 3 });
  return b.normalize(0.75).fadeOut();
}

// The horde far off: dozens of the dead moaning over one another, blurred by distance into one
// sound, a shuffle of feet and a deep swell under it. Heard as one thing, never as one creep.
function horde(sr: number, r: R): Buf {
  return seamless(sr, 6, 0.6, (b) => {
    const voices = new Buf(sr, b.len / sr);
    for (let k = 0; k < 40; k++) {
      const kind = [0, 0, 0, 1, 3, 8][Math.floor(r() * 6)];
      creepVoice(voices, r, r() * (b.len / sr - 1.6), kind, 0.8 + r() * 0.6);
    }
    const a = new LP1(sr), c = new LP1(sr), sv = new SVF(sr), swell = slowNoise(r, sr, b.len / sr, 0.6);
    for (let i = 0; i < b.len; i++) {
      const v = c.run(a.run(voices.d[i], 1100), 1100) * 0.25;
      const rumble = sv.run(r() * 2 - 1, 140, 0.7).band * 1.5;
      b.d[i] = (v + rumble) * (0.8 + 0.2 * swell[i]);
    }
    for (let k = 0; k < 70; k++) thud(b, r, r() * (b.len / sr - 0.1), 90 + r() * 50, 50, 0.02, 0.05 + r() * 0.05, 0.9, 500);
    b.normalize(0.7);
  });
}

// A war horn blown far off: a long bone horn, the breath catching as it starts, brassy as it
// swells, wavering, and the hills sending it back. A boss wave's is two, lower, one under the
// other.
function horn(b: Buf, r: R, at: number, f0: number, dur: number, gain: number): void {
  const sr = b.sr, o = Math.floor(at * sr), wob = slowNoise(r, sr, dur + 0.1, 5), sv = new SVF(sr), br = new SVF(sr);
  let ph = 0;
  for (let i = 0; i < dur * sr && o + i < b.len; i++) {
    const t = i / sr, u = t / dur;
    const env = Math.min(1, t / 0.35) * (u > 0.8 ? Math.max(0, (1 - u) / 0.2) : 1) * (0.85 + 0.15 * Math.sin(TAU * 0.7 * t));
    const f = f0 * (0.94 + 0.06 * Math.min(1, t / 0.3)) * (1 + 0.006 * wob[i]) * (u > 0.85 ? 1 - 0.06 * (u - 0.85) / 0.15 : 1);
    ph += f / sr; ph -= Math.floor(ph);
    const saw = 1 - 2 * ph, cut = 250 + 1500 * env;
    const y = sv.run(saw, cut, 0.9).low * 1.3 + br.run(saw, 900, 3).band * 0.3 * env;
    b.d[o + i] += sat(y * (0.4 + env), 2) * env * gain + (r() * 2 - 1) * 0.02 * env * gain;
  }
}
function warHorn(sr: number, r: R, boss: boolean): Buf {
  const b = new Buf(sr, boss ? 6 : 4.5);
  if (boss) { horn(b, r, 0, jit(r, 73, 0.03), 3.2, 1); horn(b, r, 0.5, jit(r, 55, 0.03), 3.4, 0.9); } else horn(b, r, 0, jit(r, 98, 0.05), 2.4, 1);
  const len = Math.ceil((boss ? 3.9 : 2.4) * sr), dry = b.d.slice(0, len);
  for (const [d, g] of [[0.55, 0.35], [1.2, 0.18], [1.9, 0.08]] as const) {
    const a = new LP1(sr), c = new LP1(sr), e = Math.floor(jit(r, d, 0.1) * sr);
    for (let i = 0; i < dry.length && e + i < b.len; i++) b.d[e + i] += c.run(a.run(dry[i], 900), 900) * g;
  }
  return b.normalize(0.8).fadeOut(0.3);
}

// A boss roaring: two throats in one chest beating against each other, the breath tearing, a
// thump in the chest under it. The abomination bellows; the broodmother's is wet, gurgling, a
// shriek riding on it; the goliath's the deepest and longest.
function bossRoar(sr: number, r: R, kind: number): Buf {
  const b = new Buf(sr, 3);
  const def: { f: number; dur: number; a: Vowel; z: Vowel; am: number; top: boolean } = kind === 7
    ? { f: 62, dur: 1.6, a: V.aa, z: V.er, am: 9, top: true }
    : kind === 10 ? { f: 34, dur: 2.2, a: V.oh, z: V.uh, am: 0, top: false } : { f: 44, dur: 1.8, a: V.oh, z: V.aa, am: 0, top: false };
  const { f, dur, a, z, am, top } = def;
  const f0 = jit(r, f, 0.06), d = jit(r, dur, 0.1);
  for (const [k, g] of [[1, 1], [1.07, 0.6]]) {
    vox(b, r, 0.05, {
      dur: d, f0: (u) => f0 * k * (1 + 0.3 * Math.sin(Math.PI * Math.min(1, u * 1.4))), vowel: (u) => lerpV(a, z, u),
      rasp: 0.9, jitter: 0.12, a: 0.15, rel: d * 0.35, gain: g, am, drive: 3.8, fry: 0.4, swell: 0.4,
    });
  }
  if (top) vox(b, r, 0.25, { dur: d * 0.6, f0: (u) => 300 + 120 * Math.sin(Math.PI * u), vowel: () => [...V.eh], rasp: 0.7, jitter: 0.1, a: 0.08, rel: 0.2, gain: 0.35, drive: 2.5 });
  roar(b, r, 0.05, d, 900, 200, 0.12, d * 0.4, 0.35, 2);
  thud(b, r, 0.08, 55, 25, 0.3, 0.8, 0.3, 250);
  return b.normalize(0.85).fadeOut(0.2);
}

// A boss's tread: the ground itself thumping, felt more than heard, so it carries, with the
// dirt shaken loose round it.
function bossStep(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.1);
  thud(b, r, 0, jit(r, 45, 0.1), 20, 0.14, 1.4, 0.4, 250);
  roar(b, r, 0.005, 0.6, 450, 80, 0.006, 0.12, 0.6, 2);
  debris(b, r, 0.04, 0.5, 14, 600, 2000, 0.12);
  return b.normalize(0.85).fadeOut();
}

// The generator shorting: a burst of sparks, snaps ringing off the housing over an arc's buzz.
function sparks(sr: number, r: R): Buf {
  const b = new Buf(sr, 0.6);
  const n = 3 + Math.floor(r() * 6), len = jit(r, 0.25, 0.4);
  for (let k = 0; k < n; k++) {
    const f = 2000 + r() * 3500;
    click(b, r, Math.pow(r(), 1.5) * len, f, 0.4 + r() * 0.5, 0.001 + r() * 0.0015, f * 0.55);
  }
  const buzz = new SVF(sr), top = new LP1(sr);
  let bp = 0;
  for (let i = 0; i < b.len; i++) {
    const t = i / sr;
    bp += (100 + r() * 30) / sr; bp -= Math.floor(bp);
    const on = t < len ? 1 : Math.exp(-(t - len) / 0.03);
    b.d[i] = top.run(b.d[i] + buzz.run((bp < 0.5 ? 1 : -1) * (r() < 0.9 ? 1 : 0), 1500, 1.2).band * on * Math.min(1, t / 0.003) * 0.3, 7000);
  }
  return b.normalize(0.7).fadeOut();
}

// The generator burning: wiring crackling and arcing in fits, a low fire under it. Made whole.
function coreCrackle(sr: number, r: R): Buf {
  return seamless(sr, 4, 0.4, (b) => {
    const lp = new LP1(sr), comp = Math.sqrt(sr / (2 * 300)), fits = slowNoise(r, sr, b.len / sr, 3), buzz = new SVF(sr);
    let bp = 0;
    for (let i = 0; i < b.len; i++) {
      const t = i / sr;
      bp += 100 / sr; bp -= Math.floor(bp);
      const arc = Math.max(0, fits[i] - 0.2) * 1.4;
      b.d[i] = lp.run(r() * 2 - 1, 300) * comp * 0.25 + buzz.run(bp < 0.5 ? 1 : -1, 1400, 1.2).band * arc * 0.3 * (0.6 + 0.4 * Math.sin(TAU * 7 * t));
    }
    for (let k = 0; k < 160; k++) click(b, r, r() * (b.len / sr - 0.01), 1300 + r() * 4000, (0.2 + r() * 0.6) * (r() < 0.08 ? 2 : 0.8), 0.0012 + r() * 0.003);
    b.normalize(0.65);
  });
}

// The generator's critical alarm: a small motor siren on its housing, three whoops, unlike the
// klaxon that calls a hit, so a failing generator is known from a struck one. A motor siren is
// a rotor chopping air through the ports of a stator: puffs of air at the port rate (a buzz
// with a pitch, not a sine) and the rush of the air itself, both rising as the motor spins up
// on each whoop and sagging as it is cut.
function coreAlarm(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.5);
  const lp = new LP1(sr), body = new SVF(sr), air = new SVF(sr);
  for (let k = 0; k < 3; k++) {
    const o = Math.floor(k * 0.45 * sr), d = 0.36;
    let ph = 0;
    for (let i = 0; i < d * sr; i++) {
      const t = i / sr, u = t / d;
      const f = 450 + 600 * (1 - Math.exp(-u * 2.5)) / (1 - Math.exp(-2.5));
      ph += f / sr; ph -= Math.floor(ph);
      const puff = Math.exp(-Math.pow((ph - 0.5) / 0.14, 2)) - 0.42;
      const e = Math.min(1, t / 0.01, (d - t) / 0.03);
      b.d[o + i] += (body.run(puff, 1400, 0.9).low + air.run(r() * 2 - 1, f * 3, 1.5).band * 0.25 * (0.5 + puff)) * e;
    }
  }
  for (let i = 0; i < b.len; i++) b.d[i] = lp.run(b.d[i], 3000);
  return b.normalize(0.6);
}

// The evac Huey touching down: the skids hitting the pad, one and then the other, its frame
// creaking as it settles, and the dust blown out from under it.
function touchdown(sr: number, r: R): Buf {
  const b = new Buf(sr, 1.2);
  const two = jit(r, 0.06, 0.3);
  thump(b, r, 0, 90, 0.002, 0.06, 1);
  strike(b, r, 0, jit(r, 260, 0.05), PIPE, 0.25, 0.002, 0.4);
  thump(b, r, two, 100, 0.002, 0.05, 0.8);
  strike(b, r, two, jit(r, 280, 0.05), PIPE, 0.2, 0.002, 0.4);
  part(b, r, 0.02, 700, 0.25, 260, 0.8);
  // The airframe settling on its skids: the aluminium skin knocked and a creak.
  strike(b, r, 0.05, jit(r, 420, 0.05), PLATE, 0.1, 0.002, 0.6);
  scrape(b, r, 0.15, 0.2, 700, 0.15);
  band(b, r, 0.03, 0.8, 1500, 400, 0.3, 0.6, 0.05, 0.3, 0.5);
  grains(b, r, 0.1, 0.6, 14, 1500, 4000, 0.1);
  return b.normalize(0.8).fadeOut();
}

// --- the table ----------------------------------------------------------------------------

type Maker = (sr: number, r: R) => Buf;
// A gun's maker carries its tail's: the same gun and mechanism without the shot.
type GunMaker = Maker & { tail: Maker };
const gun = (g: Gun, extra?: (b: Buf, r: R) => void): GunMaker => {
  const make = (tail: boolean): Maker => (sr, r) => {
    const b = gunshot(sr, r, g, tail);
    extra?.(b, r);
    return b;
  };
  return Object.assign(make(false), { tail: make(true) });
};

// name: [variants, maker, rate]. A loop has one variant. rate caps the sample rate a sound is
// made at: the long, low ones (explosions, voices, sirens) lose nothing at 24 kHz and take
// half the memory and half the time to make; a gun's crack needs the full rate.
const LOW = 24000;
export const RECIPES: Record<string, [number, Maker, number?]> = {
  pistol: [4, gun(PISTOL, (b, r) => brass(b, r, 0.3 + r() * 0.08, 0.05))],
  shotgun: [3, gun(SHOTGUN, (b, r) => pump(b, r, 0.36, 0.06))],
  smg: [5, gun(SMG, (b, r) => { part(b, r, 0.028 + r() * 0.006, 2500 + r() * 300, 0.18, 450, 0.8); caseDrop(b, r, 0.3 + r() * 0.1, 0.06, 5200); })],
  rifle: [3, gun(RIFLE, (b, r) => { bolt(b, r, 0.3, 0.14); brass(b, r, 0.5, 0.04); })],
  minigun: [6, gun(MINIGUN)],
  railgun: [3, railgun],
  rocket: [3, (sr, r) => rocketLaunch(sr, r, false)],
  missile: [3, (sr, r) => rocketLaunch(sr, r, true)],
  crowbar: [3, crowbar],
  katana: [4, (sr, r) => katana(sr, r, false)],
  moonCut: [3, (sr, r) => katana(sr, r, true)],
  greatsword: [3, (sr, r) => greatsword(sr, r, false)],
  followThrough: [2, (sr, r) => greatsword(sr, r, true), LOW],
  flashDraw: [2, flashDraw],
  homeRun: [2, homeRun],
  splitRaise: [2, splitRaise, LOW],
  worldsplit: [2, worldsplit, LOW],
  erupt: [4, erupt, LOW],
  worldbreak: [2, worldbreak, LOW],
  bleed: [3, bleed],
  turretGun: [4, gun(TURRET_GUN, (b, r) => { part(b, r, 0.035 + r() * 0.005, 2100, 0.25, 520, 0.6); caseDrop(b, r, 0.2 + r() * 0.08, 0.05); servo(b, r, 0.07, 0.16, 0.05); })],
  cannon: [3, gun(CANNON, (b, r) => {
    // The barrel ringing, the recoil running back on its slide, the breech opened and the
    // spent case dropped out ringing onto the ground.
    strike(b, r, 0.004, jit(r, 610, 0.05), PIPE, 0.06, 0.0008, 0.6);
    scrape(b, r, 0.06, 0.25, 800, 0.08);
    part(b, r, 0.34, 1100, 0.35, 160, 2);
    part(b, r, 0.62, 1500, 0.25, 220, 1.2);
    strike(b, r, 0.8 + r() * 0.04, jit(r, 720, 0.08), PIPE, 0.12, 0.0004, 0.25);
    grains(b, r, 0.8, 0.05, 4, 1200, 4000, 0.05);
  })],
  sniper: [3, gun(SNIPER, (b, r) => { bolt(b, r, 0.55, 0.11); brass(b, r, 0.95, 0.04); })],
  pod: [3, pod],
  doorGun: [4, gun(DOORGUN, (b, r) => part(b, r, 0.045 + r() * 0.008, 1900, 0.14, 400, 0.5))],
  tesla: [4, tesla],
  explosionS: [3, (sr, r) => explosion(sr, r, 0.7), LOW],
  explosion: [3, (sr, r) => explosion(sr, r, 1), LOW],
  explosionL: [3, (sr, r) => explosion(sr, r, 1.5), LOW],
  concussion: [2, concussion, LOW],
  slam: [2, (sr, r) => slamBlast(sr, r, true), LOW],
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
  coins: [3, coins],
  upgrade: [3, upgrade],
  hammer: [3, hammer],
  crumble: [3, crumble, LOW],
  crateLand: [1, crateLand, LOW],
  switch: [2, weaponSwitch],
  medkit: [1, medkit],
  tinnitus: [1, tinnitus],
  sirenWave: [2, sirenWave, LOW],
  sirenBoss: [2, sirenBoss, LOW],
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
  burstFuse: [3, burstFuse],
};
// Every gun's tail, <name>Tail: its report, echoes and mechanism without the shot, what a
// recording of the shot is layered over (samples.ts).
for (const [name, rec] of Object.entries(RECIPES)) {
  const tail = (rec[1] as Partial<GunMaker>).tail;
  if (tail) RECIPES[name + 'Tail'] = [rec[0], tail, rec[2]];
}
RECIPES.dry = [2, dryFire];
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
  reload4: -3.5, reload1: 2, dry: 2, reload5: 1.5, reloaded0: 1.5, spit: 3, boneThrow: 3, boneLand: 3, dash: 3, grenade: 2, switch: 4, hammer: 2,
  radio_chat: 5, radio_here: 4, radio_danger: 5, radio_loot: 4, radio_defend: 3, radio_good: 4, radio_bad: 4, radio_error: 4, beep: 3,
};
for (const k of ['chat', 'here', 'danger', 'loot', 'defend', 'good', 'bad', 'error']) RECIPES['radio_' + k] = [1, (sr, r) => radio(sr, r, k)];
for (let k = 0; k < 12; k++) {
  RECIPES['groan' + k] = [k === 5 || k === 7 || k === 10 ? 3 : 4, (sr, r) => { const b = new Buf(sr, 2.2); creepVoice(b, r, 0, k); return b.normalize(0.8).fadeOut(); }, LOW];
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

// The features that came after the first pass: traps, the generator's tiers, the pylon and the
// Overload, gates, the turrets' evolutions, the waves' affixes, the bosses and the horde
// (coverage.ts and ambience.ts play them).
Object.assign(RECIPES, {
  baitGrab: [2, baitGrab, LOW],
  catapult: [3, catapult],
  fallThud: [4, fallThud, LOW],
  gateOpen: [3, (sr: number, r: R) => gate(sr, r, true)],
  gateShut: [3, (sr: number, r: R) => gate(sr, r, false)],
  pylonOn: [1, pylonOn],
  pylon: [1, pylon, LOW],
  payIn: [3, payIn],
  tierUp: [2, tierUp, LOW],
  overload: [2, overload],
  overloadReady: [1, overloadReady],
  evolve: [2, evolve],
  gatling: [5, gun(GATLING, (b, r) => part(b, r, 0.022 + r() * 0.004, 2900, 0.14, 600, 0.3))],
  penetrator: [4, gun(PENETRATOR, (b, r) => { part(b, r, 0.04 + r() * 0.005, 1700, 0.3, 420, 1); servo(b, r, 0.08, 0.16, 0.045); })],
  antiMat: [3, gun(ANTIMAT, (b, r) => { bolt(b, r, 0.6, 0.12); brass(b, r, 1.05, 0.05); })],
  mortar: [3, mortar],
  napalmFlight: [3, napalmFlight, LOW],
  napalmBurst: [3, napalmBurst, LOW],
  arcWeb: [4, arcWeb],
  ricochet: [6, ricochet],
  fuse: [1, fuse],
  splitBurst: [3, splitBurst, LOW],
  frenzy: [4, frenzy, LOW],
  horde: [1, horde, LOW],
  warHorn: [2, (sr: number, r: R) => warHorn(sr, r, false), LOW],
  warHornBoss: [1, (sr: number, r: R) => warHorn(sr, r, true), LOW],
  roar5: [2, (sr: number, r: R) => bossRoar(sr, r, 5), LOW],
  roar7: [2, (sr: number, r: R) => bossRoar(sr, r, 7), LOW],
  roar10: [2, (sr: number, r: R) => bossRoar(sr, r, 10), LOW],
  bossStep: [4, bossStep, LOW],
  sparks: [5, sparks],
  coreCrackle: [1, coreCrackle, LOW],
  coreAlarm: [1, (sr, r) => coreAlarm(sr, r), LOW],
  touchdown: [1, touchdown, LOW],
} satisfies Record<string, [number, Maker, number?]>);
for (const n of ['pylon', 'fuse', 'horde', 'coreCrackle']) LOOPS.add(n);
// Measured as the rest were: the mauler's groan and a frenzy's shriek stood out like the
// brute's did, the horns and roars a little hot for being long.
Object.assign(TRIM, { groan8: -3, groan9: -6, groan10: -1, frenzy: -4, warHorn: -3, warHornBoss: -2, roar5: -3, roar7: -1, roar10: -3 });
// The hardware's, set by measurement against what they replaced (docs/game-design.md § Sound).
Object.assign(TRIM, { pylonOn: -5, overloadReady: -5 });

// The evolved turrets' tails, which their recordings (samples/turrets.ts) play over.
for (const n of ['gatling', 'penetrator', 'antiMat']) RECIPES[n + 'Tail'] = [RECIPES[n][0], (RECIPES[n][1] as GunMaker).tail];

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
