// Offline sound making: each sound is rendered once into a buffer of samples by plain code
// (noise, swept sines, filters, saturation, envelopes), then played as often as wanted. Doing
// it sample by sample, rather than with live WebAudio nodes, is what lets a gunshot have the
// layers a real one has: a crack a millisecond long, a muzzle blast driven into distortion, a
// boom whose pitch falls as the gas expands, echoes, and the action working afterwards.

export class Buf {
  d: Float32Array;
  constructor(public sr: number, sec: number) { this.d = new Float32Array(Math.ceil(sr * sec)); }
  get len(): number { return this.d.length; }

  // Scales the loudest sample to peak.
  normalize(peak = 0.9): this {
    let m = 0;
    for (let i = 0; i < this.d.length; i++) m = Math.max(m, Math.abs(this.d[i]));
    if (m > 0) for (let i = 0; i < this.d.length; i++) this.d[i] *= peak / m;
    return this;
  }

  // Takes out DC and what is below about 20 Hz: saturating a lopsided boom leaves an offset
  // that no speaker plays and that only eats headroom.
  dcBlock(): this {
    const a = 1 - 2 * Math.PI * 20 / this.sr;
    let x1 = 0, y1 = 0;
    for (let i = 0; i < this.d.length; i++) { const x = this.d[i]; y1 = x - x1 + a * y1; x1 = x; this.d[i] = y1; }
    return this;
  }

  // Ends the sound with a short fade, so a buffer cut early never clicks.
  fadeOut(sec = 0.02): this {
    const n = Math.min(this.d.length, Math.floor(sec * this.sr));
    for (let i = 0; i < n; i++) this.d[this.d.length - 1 - i] *= i / n;
    return this;
  }
}

// A seeded generator, so each variant of a sound is the same every time the page loads.
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// The attack-decay shape most layers use: linear up over a, then exponential with time
// constant tau.
export function ad(t: number, a: number, tau: number): number {
  if (t < 0) return 0;
  return t < a ? t / a : Math.exp(-(t - a) / tau);
}

// A bell curve in time, for swooshes that swell and pass.
export function bump(t: number, at: number, width: number): number {
  const x = (t - at) / width;
  return Math.exp(-x * x);
}

// Soft clipping: how a muzzle blast gets its grit, the way a microphone near a gun overloads.
export function sat(x: number, drive: number): number {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

// A state-variable filter (Chamberlin, oversampled twice so high cutoffs stay stable). One
// pass gives low, band and high outputs; the cutoff can move every sample.
export class SVF {
  low = 0; band = 0; high = 0;
  constructor(private sr: number) {}
  run(x: number, cutoff: number, q: number): this {
    const f = 2 * Math.sin(Math.PI * Math.min(cutoff, this.sr * 0.24) / (this.sr * 2));
    const damp = 1 / Math.max(0.5, q);
    for (let k = 0; k < 2; k++) {
      this.low += f * this.band;
      this.high = x - this.low - damp * this.band;
      this.band += f * this.high;
    }
    return this;
  }
}

// One-pole low-pass, the cheap smoother.
export class LP1 {
  y = 0;
  constructor(private sr: number) {}
  run(x: number, cutoff: number): number {
    const a = 1 - Math.exp(-2 * Math.PI * cutoff / this.sr);
    this.y += a * (x - this.y);
    return this.y;
  }
}

// Noise that wanders slowly: a random value every 1/rate seconds, smoothly joined. For
// rumbles that swell and for wobble in a voice.
export function slowNoise(r: () => number, sr: number, sec: number, rate: number): Float32Array {
  const n = Math.ceil(sr * sec), out = new Float32Array(n);
  const step = Math.max(1, Math.floor(sr / rate));
  let a = r() * 2 - 1, b = r() * 2 - 1;
  for (let i = 0; i < n; i++) {
    const k = i % step;
    if (k === 0 && i > 0) { a = b; b = r() * 2 - 1; }
    const u = k / step, s = u * u * (3 - 2 * u);
    out[i] = a + (b - a) * s;
  }
  return out;
}

// Mixes src into dst starting at second at, scaled by gain.
export function mixIn(dst: Buf, src: Buf, at: number, gain: number): void {
  const o = Math.floor(at * dst.sr);
  for (let i = 0; i < src.len && o + i < dst.len; i++) if (o + i >= 0) dst.d[o + i] += src.d[i] * gain;
}
