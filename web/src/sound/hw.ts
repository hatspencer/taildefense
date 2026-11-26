import { Buf, LP1, SVF, ad, sat, slowNoise } from './dsp';

// The hardware's building blocks: the guns, the blades, the turrets, the blasts and the base.
// They are built the way the real things make sound, so that a shot, a blow or a gate is a
// field recording of this world and not a tone: a struck thing is its modes (inharmonic, each
// dying at its own rate, the high ones first, excited only as high as the blow is hard), a
// blast is a pressure pulse, a tail is noise rolling and darkening, an echo is smeared, and
// cloth, grit and flesh are made of grains. Nothing here sustains a pure tone.

export type R = () => number;
const TAU = Math.PI * 2;
export const jit = (r: R, v: number, k: number) => v * (1 + (r() * 2 - 1) * k);

// --- struck things ----------------------------------------------------------------------------

// A material: the ratios of its modes to the lowest, how long the lowest rings, how much
// faster the higher ones die (tau falls as (f0/f)^damp), how far each ratio strays from piece
// to piece, and how far a mode's twin is detuned (a real bar or plate has modes in near pairs
// that beat).
export interface Mat { ratios: readonly number[]; tau: number; damp: number; spread: number; beat: number }

// A bar free at both ends: a crowbar, a blade, a spring arm, a gun's barrel.
export const BAR: Mat = { ratios: [1, 2.756, 5.404, 8.933, 13.34], tau: 0.4, damp: 0.7, spread: 0.02, beat: 0.003 };
// A pipe or tube: the bar's modes and the shell's ovalling ones among them.
export const PIPE: Mat = { ratios: [1, 1.39, 2.4, 2.756, 3.62, 5.404, 6.1], tau: 0.35, damp: 0.75, spread: 0.03, beat: 0.004 };
// Sheet or plate steel: a housing, a gate's leaf, an ammo box, a crate's fittings.
export const PLATE: Mat = { ratios: [1, 1.59, 2.14, 2.3, 2.65, 2.92, 3.16, 3.5, 3.6, 4.06, 4.15, 4.6, 5.1], tau: 0.18, damp: 0.9, spread: 0.04, beat: 0.006 };
// A small machined steel part held in a gun: rings for hundredths of a second.
export const PART: Mat = { ratios: [1, 1.47, 1.93, 2.51, 2.88, 3.42, 4.1], tau: 0.018, damp: 0.8, spread: 0.05, beat: 0.008 };
// A spent case: a short brass tube.
export const CASE: Mat = { ratios: [1, 1.52, 2.33, 2.71, 3.9], tau: 0.05, damp: 0.6, spread: 0.03, beat: 0.004 };
// Wood: a plank, a crate, a stock, a post. Dull: the lowest modes only, gone in hundredths.
export const WOOD: Mat = { ratios: [1, 2.31, 3.82, 5.6, 7.3], tau: 0.05, damp: 1.4, spread: 0.08, beat: 0.01 };
// Stone and packed earth's pebbles: a click with almost no ring.
export const STONE: Mat = { ratios: [1, 1.71, 2.6, 3.3], tau: 0.006, damp: 1, spread: 0.12, beat: 0 };
// Cast iron: heavy, dull and short for steel.
export const IRON: Mat = { ratios: [1, 1.63, 2.37, 2.95, 3.71, 4.4], tau: 0.12, damp: 1.1, spread: 0.04, beat: 0.005 };

// strike adds a blow on a thing made of mat whose lowest mode is f0: each mode a resonance
// excited by the blow and dying away. contact is how long the blow touches, in seconds: a hard
// blow (steel on steel, 0.1 ms) rings every mode; a soft one (a hand, a boot, 3 ms) only the
// low ones. tau scales how long it rings (a hand on it damps it). The contact's own noise
// is the tick a blow starts with.
export function strike(b: Buf, r: R, at: number, f0: number, mat: Mat, gain: number, contact = 0.0003, tau = 1): void {
  const sr = b.sr, o = Math.floor(at * sr);
  if (o >= b.len) return;
  // Where it was struck: each mode excited by how far that point is from its nodes.
  const pos = 0.1 + r() * 0.35;
  for (let k = 0; k < mat.ratios.length; k++) {
    const f = f0 * mat.ratios[k] * (1 + (r() * 2 - 1) * mat.spread);
    if (f > sr * 0.45) break;
    const t60 = mat.tau * tau * Math.pow(f0 / f, mat.damp);
    const hard = 1 / (1 + Math.pow(2 * f * contact, 2));
    const a = gain * hard * (0.35 + 0.65 * Math.abs(Math.sin(Math.PI * (k + 1) * pos))) / Math.sqrt(1 + k * 0.6);
    if (a < gain * 0.01) continue;
    resonate(b, o, f, t60, a, r() * TAU);
    if (mat.beat > 0 && k < 4) resonate(b, o, f * (1 + mat.beat * (0.5 + r())), t60 * 0.8, a * 0.45, r() * TAU);
  }
  // The contact itself: a burst of noise as long as the blow, as bright as it is hard.
  const n = Math.max(2, Math.ceil(contact * 2 * sr)), hp = new SVF(sr), cut = Math.min(9000, 0.5 / Math.max(contact, 1e-5));
  for (let i = 0; i < n && o + i < b.len; i++) {
    const u = i / n;
    b.d[o + i] += hp.run(r() * 2 - 1, cut, 0.7).band * Math.sin(Math.PI * u) * gain * 0.5;
  }
}

// One mode: a sine dying with time constant tau, its attack a quarter of a cycle so it never
// clicks. A recursive oscillator, so a bank of them is cheap.
function resonate(b: Buf, o: number, f: number, tau: number, a: number, ph: number): void {
  const sr = b.sr, n = Math.min(b.len - o, Math.ceil(tau * 6.9 * sr));
  if (n <= 0) return;
  const w = TAU * f / sr, k = Math.exp(-1 / (tau * sr)), c = 2 * k * Math.cos(w);
  let y1 = Math.sin(ph) * a, y2 = Math.sin(ph - w) * a / k;
  const att = Math.max(4, Math.floor(sr / f / 4));
  for (let i = 0; i < n; i++) {
    const y = c * y1 - k * k * y2;
    y2 = y1; y1 = y;
    b.d[o + i] += i < att ? y * i / att : y;
  }
}

// --- noise made physical --------------------------------------------------------------------

// A low push of air or ground: noise through two low-pass poles, so it is weight and not a
// tone. cut sets how low; tau how long.
export function thump(b: Buf, r: R, at: number, cut: number, a: number, tau: number, gain: number): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil((a + tau * 6) * b.sr);
  const comp = Math.sqrt(b.sr / (2 * cut)) * 0.9;
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    b.d[o + i] += sv.run(r() * 2 - 1, cut, 0.9).low * comp * ad(t, a, tau) * gain;
  }
}

// Noise in a band that moves from f0 to f1 (exponentially, with time constant glide), under
// an attack and decay; drive overloads it the way a close microphone does.
export function band(b: Buf, r: R, at: number, len: number, f0: number, f1: number, glide: number, q: number, a: number, tau: number, gain: number, drive = 0): void {
  const sv = new SVF(b.sr), o = Math.floor(at * b.sr), n = Math.ceil(len * b.sr);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr, f = f1 + (f0 - f1) * Math.exp(-t / glide);
    let x = sv.run(r() * 2 - 1, f, q).band * Math.sqrt(b.sr / f) * 0.25 * ad(t, a, tau);
    if (drive) x = sat(x, drive);
    b.d[o + i] += x * gain;
  }
}

// Grains: n tiny bursts of noise scattered from at over spread seconds (crowded at first, then
// thinning), each in a band between f0 and f1 and lasting a millisecond or a few. Grit and
// gravel, a spray of earth, cloth's crackle, the fizz of a fuse. stone rings some with a
// pebble's click.
export function grains(b: Buf, r: R, at: number, spread: number, n: number, f0: number, f1: number, gain: number, stone = 0): void {
  const sr = b.sr;
  for (let k = 0; k < n; k++) {
    const u = -Math.log(1 - r() * 0.95) / 3;
    const t0 = at + u * spread, g = gain * (0.25 + r() * 0.75) * Math.exp(-u * 1.2);
    const f = f0 * Math.pow(f1 / f0, r()), len = 0.0006 + r() * 0.003, o = Math.floor(t0 * sr), m = Math.ceil(len * sr);
    const sv = new SVF(sr);
    for (let i = 0; i < m && o + i < b.len; i++) b.d[o + i] += sv.run(r() * 2 - 1, f, 1.2).band * Math.sin(Math.PI * i / m) * g;
    if (stone && r() < stone) strike(b, r, t0, jit(r, 3200, 0.4), STONE, g * 0.5, 0.0002);
  }
}

// Cloth: a sleeve, a jacket, webbing, swept through a move. Fabric rubbing is a crackle of
// small slips, so it is grains in a band, packed as tight as the move is fast, swelling over
// dur and dying; heavy is canvas and denim, lower and duller than a shirt.
export function cloth(b: Buf, r: R, at: number, dur: number, gain: number, heavy = 0.5): void {
  const sr = b.sr, o = Math.floor(at * sr), n = Math.ceil(dur * sr);
  const lo = 900 - 400 * heavy, hi = 5200 - 2400 * heavy;
  const sv = new SVF(sr), body = new SVF(sr), slip = slowNoise(r, sr, dur + 0.05, 60);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / sr, u = t / dur;
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, u)), 1.5);
    // The slips: noise gated by a fast, lumpy envelope.
    const g = Math.max(0, slip[i] * 1.6 - 0.2);
    const f = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(u * 7 + slip[i]));
    const x = sv.run(r() * 2 - 1, f, 0.9).band * g * g + body.run(r() * 2 - 1, 500, 0.7).band * 0.25;
    b.d[o + i] += x * env * gain;
  }
}

// Air pushed aside by something swung past: a band of noise that rises in pitch and level as
// it comes and falls away as it goes, its peak at the pass. Wide (low q) for a club or a
// slab, with an edge's whistle (whistle) riding over it for a blade.
export function swing(b: Buf, r: R, at: number, dur: number, f0: number, f1: number, gain: number, whistle = 0): void {
  const sr = b.sr, o = Math.floor(at * sr), n = Math.ceil(dur * sr);
  const sv = new SVF(sr), ed = new SVF(sr), peak = 0.62;
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / sr, u = t / dur;
    // Up to the pass the pitch climbs; past it, it drops a little: the Doppler of a swing.
    const f = u < peak ? f0 * Math.pow(f1 / f0, u / peak) : f1 * (1 - 0.25 * (u - peak) / (1 - peak));
    const env = u < peak ? Math.pow(u / peak, 2.2) : Math.exp(-(u - peak) / (1 - peak) * 4);
    let x = sv.run(r() * 2 - 1, f, 0.7).band * Math.sqrt(sr / f) * 0.2;
    if (whistle) x += ed.run(r() * 2 - 1, f * 2.2, 6).band * Math.sqrt(sr / f) * 0.12 * whistle;
    b.d[o + i] += x * env * gain;
  }
}

// Flesh struck: the body's dull weight, the smack of the skin and, wet, the squelch of what is
// under it. size is the blow's mass: 1 a fist or a bar, 2 a slab of iron.
export function flesh(b: Buf, r: R, at: number, gain: number, wet = 0.5, size = 1): void {
  thump(b, r, at, 160 / Math.sqrt(size), 0.001, 0.025 * size, gain);
  band(b, r, at, 0.03, 1400, 700, 0.01, 1, 0.0005, 0.006, gain * 0.9, 1.5);
  if (wet > 0) {
    const sr = b.sr, o = Math.floor((at + 0.004) * sr), n = Math.ceil((0.06 + 0.05 * size) * sr), sv = new SVF(sr), lump = slowNoise(r, sr, 0.2, 90);
    for (let i = 0; i < n && o + i < b.len; i++) {
      const t = i / sr;
      b.d[o + i] += sv.run(r() * 2 - 1, 700 + 900 * Math.max(0, lump[i]), 2.5).band * Math.max(0, lump[i]) * ad(t, 0.004, 0.03 * size) * wet * gain * 0.9;
    }
  }
}

// The ground struck: a dull low push (no pitch), then earth and stones thrown and pattering.
export function earth(b: Buf, r: R, at: number, gain: number, size = 1): void {
  thump(b, r, at, 110 / Math.sqrt(size), 0.002, 0.04 * size, gain);
  band(b, r, at, 0.25 * size, 1600, 500, 0.05, 0.8, 0.002, 0.03 * size, gain * 0.5, 1.5);
  grains(b, r, at + 0.01, 0.25 * size, Math.round(10 * size), 1500, 6000, gain * 0.25, 0.3);
}

// --- shots and blasts -----------------------------------------------------------------------

// A blast's pressure: the Friedlander wave, a jump to full pressure falling through zero into a
// longer, shallower suction over T seconds. Not a tone: its spectrum is everything below 1/T,
// which is why a bigger charge (a longer T) is deeper.
export function pulse(b: Buf, at: number, T: number, gain: number): void {
  const o = Math.floor(at * b.sr), n = Math.ceil(T * 7 * b.sr), rise = Math.max(1, Math.floor(b.sr * 0.00005));
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / b.sr;
    b.d[o + i] += (1 - t / T) * Math.exp(-1.6 * t / T) * Math.min(1, i / rise) * gain;
  }
}

// A supersonic bullet's crack: the N-wave of its shock, a jump up, a straight fall through zero
// and a jump back, a few hundred microseconds long.
export function crack(b: Buf, at: number, len: number, gain: number): void {
  const o = Math.floor(at * b.sr), n = Math.max(3, Math.ceil(len * b.sr));
  for (let i = 0; i <= n && o + i < b.len; i++) b.d[o + i] += (1 - 2 * i / n) * gain;
}

// A report rolling away: noise darkening from f0 to f1 as it goes, lumpy as the ground and the
// trees send it back unevenly. The decay is tau; roll is how lumpy.
export function report(b: Buf, r: R, at: number, len: number, f0: number, f1: number, tau: number, gain: number, roll = 0.5): void {
  const sr = b.sr, o = Math.floor(at * sr), n = Math.ceil(len * sr);
  const lp = new SVF(sr), hp = new LP1(sr), lump = slowNoise(r, sr, len + 0.05, 28), swell = slowNoise(r, sr, len + 0.05, 6);
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / sr, f = f1 + (f0 - f1) * Math.exp(-t / (tau * 0.8));
    const x = lp.run(r() * 2 - 1, f, 0.6).low;
    const y = (x - hp.run(x, 130)) * Math.sqrt(sr / f) * 0.3;
    const am = 1 + roll * (0.6 * lump[i] + 0.4 * swell[i]);
    b.d[o + i] += y * Math.max(0, am) * ad(t, 0.004, tau) * gain;
  }
}

// An echo: a stretch of src sent back from far off, later, darker and smeared by the many
// surfaces it came off, so it is a softer copy and not a repeat.
export function echo(b: Buf, r: R, src: Float32Array, at: number, gain: number, cut = 1500, smear = 0.025): void {
  const sr = b.sr, o = Math.floor(at * sr), taps = 5;
  const tmp = new Float32Array(src.length + Math.ceil(smear * sr));
  for (let k = 0; k < taps; k++) {
    const d = Math.floor(r() * smear * sr), g = (0.4 + r() * 0.6) / taps * 2;
    for (let i = 0; i < src.length; i++) tmp[i + d] += src[i] * g * (k % 2 ? -1 : 1) * (k ? 0.7 : 1);
  }
  const a = new LP1(sr), c = new LP1(sr);
  for (let i = 0; i < tmp.length && o + i < b.len; i++) b.d[o + i] += c.run(a.run(tmp[i], cut), cut) * gain;
}

// A gun's shot, from the muzzle out:
//   crack   a supersonic round's N-wave (0 for a pistol's slow, heavy bullet)
//   blast   the muzzle's pressure pulse, positive phase T seconds, overdriven into the mic
//   gas     the muzzle gas roaring out, noise darkening from gasF over gasTau
//   body    the bang itself, where a shot is loudest to the ear: noise in a band round bodyF
//   ring    the gun's own steel ringing under the blast: lowest mode in Hz, level, how long
//   chest   the low push, noise below chestF, chestTau long: weight with no pitch
//   rep     the report rolling away over open ground: level, length, how dark it ends
//   echoes  the shot off buildings and the treeline: [delay s, level]
export interface Gun {
  len: number; crack: number; blast: number; T: number; drive: number;
  gas: number; gasF: number; gasTau: number; body: number; bodyF: number;
  ring: [number, number, number];
  chest: number; chestF: number; chestTau: number;
  rep: number; repTau: number; repF: number; repEnd: number;
  echoes: [number, number][];
}

// gunshot2 makes the shot; with tail it makes only what goes under a recording of it: the
// report and the echoes at the level they have in the whole shot.
export function shot(sr: number, r: R, g: Gun, tail = false): Buf {
  const core = new Buf(sr, Math.min(g.len, 0.35));
  const T = jit(r, g.T, 0.08);
  if (g.crack) crack(core, 0, 0.00025 + T * 0.1, g.crack);
  pulse(core, g.crack ? 0.0006 : 0, T, g.blast);
  band(core, r, 0, 0.3, jit(r, g.gasF, 0.1), Math.max(450, g.gasF * 0.3), g.gasTau * 0.8, 0.6, 0.0003, g.gasTau, g.gas);
  band(core, r, 0, 0.3, jit(r, g.bodyF, 0.06), g.bodyF * 0.8, 0.05, 1.3, 0.0003, g.gasTau * 1.5, g.body);
  thump(core, r, 0, jit(r, g.chestF, 0.08), 0.001, g.chestTau, g.chest);
  if (g.ring[1]) strike(core, r, 0.0005, jit(r, g.ring[0], 0.04), PART, g.ring[1], 0.0002, g.ring[2] / PART.tau);
  // The microphone overloaded, and the lowest of the pulse (which a speaker cannot play and
  // which only eats headroom) let go below about 70 Hz.
  // Past the first few metres of air the top end goes: two gentle poles round 5 kHz.
  const hp = new LP1(sr), t1 = new LP1(sr), t2 = new LP1(sr);
  for (let i = 0; i < core.len; i++) { const x = sat(core.d[i], g.drive); core.d[i] = t2.run(t1.run(x - hp.run(x, 70), 5000), 5000); }
  const b = new Buf(sr, g.len), only = tail ? new Buf(sr, g.len) : null;
  for (let i = 0; i < core.len; i++) b.d[i] = core.d[i];
  const add = (into: Buf[], f: (x: Buf) => void) => { for (const x of into) f(x); };
  const both = only ? [b, only] : [b];
  // One random stream for the layers both copies share, so the tail is the shot's own.
  const seed = Math.floor(r() * 1e9);
  add(both, (x) => {
    const rr = mk(seed);
    report(x, rr, 0.002, g.len - 0.002, g.repF, g.repEnd, g.repTau, g.rep * 1.4, 0.6);
    for (const [d, gn] of g.echoes) echo(x, rr, core.d, jit(rr, d, 0.12), gn * 1.4, 1300, 0.02 + d * 0.03);
  });
  if (!only) return b.normalize(0.95).fadeOut(0.05);
  let pk = 0;
  for (const x of b.d) pk = Math.max(pk, Math.abs(x));
  const k = 0.95 / Math.max(pk, 1e-9);
  for (let i = 0; i < only.len; i++) only.d[i] *= k;
  return only.fadeOut(0.05);
}

// A seeded stream, the same as dsp's rng (kept here so a shot and its tail can share one).
function mk(seed: number): R {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

// --- the hand on the gun ----------------------------------------------------------------------

// A steel part going home in a gun: the contact, the part's ring, and the gun's body (its
// stock, its frame, the hand round it) knocked under it. f is the part's lowest mode, body the
// frame's knock in Hz (wood lower, a polymer frame higher), weight how hard.
export function part(b: Buf, r: R, at: number, f: number, gain: number, body = 300, weight = 1): void {
  strike(b, r, at, jit(r, f, 0.05), PART, gain, 0.00015);
  strike(b, r, at, jit(r, body, 0.08), WOOD, gain * 0.7 * weight, 0.0012);
  thump(b, r, at, body * 0.8, 0.0008, 0.008 * weight, gain * 0.5 * weight);
}

// Steel drawn over steel: stick and slip, a run of tiny catches as fast as it moves, each
// ringing the part a little. f is where it rings, dur how long the stroke.
export function scrape(b: Buf, r: R, at: number, dur: number, f: number, gain: number): void {
  const sr = b.sr, o = Math.floor(at * sr), n = Math.ceil(dur * sr);
  const r1 = new SVF(sr), r2 = new SVF(sr), r3 = new SVF(sr), air = new SVF(sr);
  const f1 = jit(r, f, 0.05), f2 = f1 * 1.47, f3 = f1 * 2.3;
  let next = 0;
  for (let i = 0; i < n && o + i < b.len; i++) {
    const t = i / sr, u = t / dur, env = Math.sin(Math.PI * u);
    let x = 0;
    if (t >= next) { x = (r() * 2 - 1) * 3; next = t + 1 / (400 + 1400 * env * (0.5 + r())); }
    const y = r1.run(x, f1, 12).band + r2.run(x, f2, 10).band * 0.7 + r3.run(x, f3, 8).band * 0.4;
    b.d[o + i] += (y * 0.15 + air.run(r() * 2 - 1, f1 * 1.5, 1).band * 0.25) * env * gain;
  }
}

// A spent case thrown and landing on dry ground: on packed earth it ticks and barely rings;
// on a stone, now and then, it rings out. Bounces twice.
export function caseDrop(b: Buf, r: R, at: number, gain: number, f = 4200): void {
  const hard = r() < 0.35;
  [0, 0.07 + r() * 0.03, 0.12 + r() * 0.04].forEach((d, k) => {
    strike(b, r, at + d, jit(r, f, 0.08), CASE, gain / (1 + k * 1.6), hard ? 0.00012 : 0.0004, hard ? 1 : 0.25);
    grains(b, r, at + d, 0.01, 2, 2000, 6000, gain * 0.2 / (1 + k));
  });
}

// A blow recorded close, the way a foley microphone overloads on it: the peak held back so
// the weight behind it carries. drive 1 leaves it alone; 3 is about 7 dB of squash.
export function squash(b: Buf, drive: number): Buf {
  b.normalize(1);
  for (let i = 0; i < b.len; i++) b.d[i] = sat(b.d[i], drive);
  return b;
}
