import { el } from './dom';

// The boot splash: the wordmark is laid brick by brick like a base wall while creeps crawl in
// from the dark, then the wall's guns open up and pick them off, a searchlight crosses the
// word, and the tagline types in under it. Drawn on a low-resolution canvas scaled up with
// hard pixels, in the HUD's palette; the tagline, the tape and the bar are DOM in the HUD's
// faces. Any key or click skips it; reduced motion shows the finished frame.

// The wordmark font: 6x7 blocks with 2-wide strokes, I a 2-wide bar. Every '#' is one brick.
const GLYPHS: Record<string, string[]> = {
  T: ['######', '######', '..##..', '..##..', '..##..', '..##..', '..##..'],
  A: ['.####.', '##..##', '##..##', '######', '##..##', '##..##', '##..##'],
  I: ['##', '##', '##', '##', '##', '##', '##'],
  L: ['##....', '##....', '##....', '##....', '##....', '######', '######'],
  D: ['#####.', '##..##', '##..##', '##..##', '##..##', '##..##', '#####.'],
  E: ['######', '##....', '##....', '#####.', '##....', '##....', '######'],
  F: ['######', '##....', '##....', '#####.', '##....', '##....', '##....'],
  N: ['##..##', '###.##', '######', '##.###', '##..##', '##..##', '##..##'],
  S: ['.#####', '##....', '##....', '.####.', '....##', '....##', '#####.'],
};
const WORD = 'TAILDEFENSE';
// "tail" is laid in bone, "defense" in amber.
const SPLIT = 4;
const ROWS = 7;
// Low-res pixels per brick.
const B = 3;

export const TAGLINE = 'hold the base · loot the dark · bring everyone home';

interface Brick { x: number; y: number; at: number; amber: boolean }

function bricks(): { list: Brick[]; w: number } {
  const list: Brick[] = [];
  let x = 0;
  for (let i = 0; i < WORD.length; i++) {
    const g = GLYPHS[WORD[i]];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '#') list.push({ x: x + c, y: r, at: 0, amber: i >= SPLIT });
    x += g[0].length + 1;
  }
  return { list, w: x - 1 };
}

// The palette, from app.css.
const INK = [7, 8, 10], SOOT = [14, 16, 11], DRAB = [28, 30, 22];
const BONE = { hi: [242, 236, 210], mid: [217, 209, 179], lo: [143, 138, 112] };
const AMBER = { hi: [244, 194, 92], mid: [224, 166, 58], lo: [156, 122, 52] };
const HOT = [255, 244, 214], RUST = [181, 71, 47], RUST_HI = [232, 132, 106], KHAKI = [147, 138, 102];

// Ordered dither threshold, 4x4 Bayer.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

const T = {
  lay0: 0.12, lay1: 1.15, // bricks land between these
  fall: 0.2, // seconds a brick falls
  cool: 0.35, // seconds a landed brick glows
  guns: 1.3, // the wall starts shooting
  sweep0: 1.45, sweep1: 2.0, // the searchlight's pass
  type0: 1.05, type1: 1.9, // the tagline types in
  done: 2.45, // the splash starts to fade
  fade: 0.25,
};
// The whole timeline plays this much faster than the seconds above.
const SPEED = 1.6;

function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Creep { x: number; y: number; vx: number; vy: number; born: number; dies: number; gun: number }
interface Bit { x: number; y: number; vx: number; vy: number; at: number; life: number; c: number[] }

export class Splash {
  private root: HTMLElement;
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img!: ImageData;
  private gw = 0; private gh = 0; private u = 4;
  private ox = 0; private oy = 0;
  private word = bricks();
  private creeps: Creep[] = [];
  private bits: Bit[] = [];
  private landed = new Set<number>();
  private shot = new Set<number>();
  // The splash's own clock. Each frame advances it by at most 1/30 s, so while the page is
  // busy loading (shaders compiling, the map arriving) the animation slows down rather than
  // skipping ahead.
  private t = 0;
  private last = -1;
  private out = -1; // seconds into the fade out, -1 before it
  private hold = 0;
  private raf = 0;
  private tag: HTMLElement; private tape: HTMLElement; private bar: HTMLElement; private fill: HTMLElement; private hint: HTMLElement;
  private still: boolean;
  private resolveDone!: () => void;
  // Resolves once the splash has faded out and removed itself.
  done = new Promise<void>((r) => { this.resolveDone = r; });

  // freeze holds the animation at that many seconds in, for screenshots (#splash=1.4).
  constructor(parent: HTMLElement, private freeze = -1) {
    this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.root = el('div', 'splash', parent);
    this.cv = el('canvas', '', this.root);
    this.ctx = this.cv.getContext('2d')!;
    this.tape = el('div', 'tape', this.root, 'co-op tower defense · over the tailnet');
    this.tag = el('div', 'tag', this.root);
    this.bar = el('div', 'bar', this.root);
    this.fill = el('i', '', this.bar);
    this.hint = el('div', 'hint', this.root, 'any key to skip');
    // Bricks are laid from both ends towards the middle, a column at a time, with a little
    // jitter so the rows don't land in lockstep.
    const r = rnd(7), w = this.word.w;
    for (const b of this.word.list) {
      const fromEdge = Math.min(b.x, w - 1 - b.x) / (w / 2);
      b.at = T.lay0 + (T.lay1 - T.lay0 - T.fall) * (0.92 * fromEdge + 0.08 * r()) + (ROWS - 1 - b.y) * 0.012;
    }
    this.layout();
    this.spawnCreeps();
    window.addEventListener('keydown', this.skip, { once: true });
    this.root.addEventListener('pointerdown', this.skip, { once: true });
    window.addEventListener('resize', this.onResize);
    if (this.still) { this.t = T.done; this.hold = 0.8; }
    if (freeze >= 0) this.t = freeze;
    this.raf = requestAnimationFrame(this.frame);
  }

  private onResize = () => { this.layout(); };
  private skip = () => { this.finish(); };

  // The low-res grid: the word takes about 60% of the width, at a whole number of screen
  // pixels per grid pixel.
  private layout(): void {
    const W = window.innerWidth, H = window.innerHeight;
    const wordPx = this.word.w * B;
    this.u = Math.max(2, Math.min(Math.floor((W * 0.62) / wordPx), Math.floor((H * 0.3) / (ROWS * B))));
    this.gw = Math.ceil(W / this.u); this.gh = Math.ceil(H / this.u);
    this.cv.width = this.gw; this.cv.height = this.gh;
    this.cv.style.width = `${this.gw * this.u}px`; this.cv.style.height = `${this.gh * this.u}px`;
    this.img = this.ctx.createImageData(this.gw, this.gh);
    this.ox = Math.round((this.gw - wordPx) / 2);
    this.oy = Math.round(this.gh * 0.42 - (ROWS * B) / 2);
    const u = this.u, bottom = (this.oy + ROWS * B) * u;
    // The tape is stuck across the top of the word's right end.
    this.tape.style.right = `${W - (this.ox + wordPx) * u - 6}px`;
    this.tape.style.top = `${this.oy * u - 34}px`;
    this.tag.style.top = `${bottom + 26}px`;
    const bw = Math.min(wordPx * u * 0.55, 420);
    this.bar.style.width = `${Math.round(bw / 12) * 12 + 4}px`;
    this.bar.style.top = `${bottom + 72}px`;
  }

  private spawnCreeps(): void {
    const r = rnd(42);
    const cx = this.word.w * B / 2, cy = ROWS * B / 2;
    const n = 14;
    for (let i = 0; i < n; i++) {
      // Just inside the screen's edge, word-relative, crawling in.
      const a = (i / n) * Math.PI * 2 + r() * 0.4;
      const x = cx + Math.cos(a) * this.gw * 0.46, y = cy + Math.sin(a) * this.gh * 0.44;
      const speed = 16 + r() * 10;
      const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy);
      this.creeps.push({
        x, y, vx: (dx / d) * speed, vy: (dy / d) * speed,
        born: 0.15 + r() * 0.5,
        dies: T.guns + (i % 7) * 0.09 + Math.floor(i / 7) * 0.045 + r() * 0.03,
        gun: Math.cos(a) < 0 ? 0 : 1,
      });
    }
  }

  // Skipping jumps to the finished frame and fades out from there.
  private finish(): void {
    if (this.freeze >= 0) { this.close(); return; }
    this.t = Math.max(this.t, T.done);
    if (this.out < 0) this.out = 0;
  }

  private frame = (now: number) => {
    const dt = this.last < 0 ? 0 : Math.min(1 / 30, (now - this.last) / 1000);
    this.last = now;
    if (this.freeze < 0) {
      this.t += dt * SPEED;
      if (this.out >= 0) this.out += dt;
      else if (this.t >= T.done + this.hold) this.out = 0;
    }
    const t = Math.min(this.t, T.done);
    this.draw(t);
    this.dom(t);
    // The fade out is stepped, like everything else in the kit.
    const out = Math.max(0, this.out) / T.fade;
    this.root.style.opacity = String(1 - Math.min(1, Math.floor(out * 4) / 4));
    if (out >= 1) { this.close(); return; }
    this.raf = requestAnimationFrame(this.frame);
  };

  private close(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.skip);
    this.root.remove();
    this.resolveDone();
  }

  private put(x: number, y: number, c: number[], a = 1): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.gw || y >= this.gh) return;
    const d = this.img.data, o = (y * this.gw + x) * 4;
    if (a >= 1) { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; return; }
    d[o] += (c[0] - d[o]) * a; d[o + 1] += (c[1] - d[o + 1]) * a; d[o + 2] += (c[2] - d[o + 2]) * a;
  }

  private draw(t: number): void {
    const d = this.img.data, gw = this.gw, gh = this.gh;
    // Ground: soot dithered into drab, darker at the edges, fading up from black.
    const ground = Math.min(1, t / 0.3);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const nx = x / gw - 0.5, ny = y / gh - 0.45;
        const v = Math.max(0, 1 - (nx * nx * 2.2 + ny * ny * 3.2)) * ground;
        const th = BAYER[(y & 3) * 4 + (x & 3)];
        const c = v * 0.9 > th ? DRAB : v * 2.2 > th ? SOOT : INK;
        const o = (y * gw + x) * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    // Scanlines, every third row.
    for (let y = 2; y < gh; y += 3) for (let x = 0; x < gw; x++) { const o = (y * gw + x) * 4; d[o] *= 0.82; d[o + 1] *= 0.82; d[o + 2] *= 0.82; }

    this.drawCreeps(t);
    this.drawWord(t);
    this.drawBits(t);
    this.ctx.putImageData(this.img, 0, 0);
  }

  private drawWord(t: number): void {
    const ox = this.ox, oy = this.oy;
    // The word's hard shadow, under the landed bricks.
    for (const b of this.word.list) {
      if (t < b.at + T.fall) continue;
      for (let i = 0; i < B; i++) { this.put(ox + b.x * B + B, oy + b.y * B + i + 1, INK); this.put(ox + b.x * B + i + 1, oy + b.y * B + B, INK); }
    }
    const sweep = (t - T.sweep0) / (T.sweep1 - T.sweep0);
    this.word.list.forEach((b, i) => {
      const k = t - b.at;
      if (k < 0) return;
      const fall = Math.min(1, k / T.fall);
      const lift = (1 - fall * fall) * (ROWS * B + 18);
      const bx = ox + b.x * B, by = oy + b.y * B - lift;
      if (fall >= 1 && !this.landed.has(i)) {
        this.landed.add(i);
        if (b.y === ROWS - 1 || !this.word.list.some((q) => q.x === b.x && q.y === b.y + 1)) this.dust(bx + 1, by + B, t);
      }
      const pal = b.amber ? AMBER : BONE;
      const heat = fall < 1 ? 0.6 : Math.max(0, 1 - (k - T.fall) / T.cool);
      // The searchlight: a slanted band crossing the word left to right.
      const band = sweep > 0 && sweep < 1 ? Math.max(0, 1 - Math.abs((b.x - b.y * 0.6) / this.word.w - (sweep * 1.3 - 0.15)) * 9) : 0;
      const glow = Math.max(heat, band * 0.85);
      for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) {
        const c = yy === 0 || xx === 0 ? pal.hi : yy === B - 1 || xx === B - 1 ? pal.lo : pal.mid;
        this.put(bx + xx, by + yy, c);
        if (glow > 0) this.put(bx + xx, by + yy, HOT, glow);
      }
    });
  }

  // Dust kicked up where a brick lands on nothing.
  private dust(x: number, y: number, t: number): void {
    for (let i = 0; i < 2; i++) this.bits.push({ x, y, vx: (i ? 1 : -1) * (6 + Math.random() * 10), vy: -6 - Math.random() * 6, at: t, life: 0.35, c: KHAKI });
  }

  private drawCreeps(t: number): void {
    const guns = [
      [this.ox + 1, this.oy - 1],
      [this.ox + this.word.w * B - 2, this.oy - 1],
    ];
    for (let i = 0; i < this.creeps.length; i++) {
      const c = this.creeps[i];
      if (t < c.born) continue;
      const age = Math.min(t, c.dies) - c.born;
      const x = this.ox + c.x + c.vx * age, y = this.oy + c.y + c.vy * age;
      if (t >= c.dies) {
        if (!this.shot.has(i)) {
          this.shot.add(i);
          // The tracer, and the creep bursts.
          const [gx, gy] = guns[c.gun];
          this.bits.push({ x: gx, y: gy, vx: x, vy: y, at: t, life: 0.07, c: [-1] });
          for (let k = 0; k < 7; k++) {
            const a = Math.random() * Math.PI * 2, s = 10 + Math.random() * 22;
            this.bits.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 8, at: t, life: 0.3 + Math.random() * 0.25, c: k % 3 ? RUST : RUST_HI });
          }
        }
        continue;
      }
      // A 3x3 hunched creep, its legs stepping.
      const step = Math.floor(t * 8 + i) % 2;
      const fade = Math.min(1, (t - c.born) / 0.25);
      for (const [dx, dy, col] of [[0, -1, RUST], [1, -1, RUST], [-1, 0, RUST], [0, 0, RUST_HI], [1, 0, RUST], [2, 0, INK], [0, -2, INK], [1, -2, INK]] as [number, number, number[]][]) this.put(x + dx, y + dy, col, fade);
      this.put(x + (step ? -1 : 0), y + 1, RUST, fade);
      this.put(x + (step ? 1 : 2), y + 1, RUST, fade);
    }
  }

  private drawBits(t: number): void {
    this.bits = this.bits.filter((b) => t - b.at < b.life);
    for (const b of this.bits) {
      const k = t - b.at;
      if (b.c[0] === -1) { this.line(b.x, b.y, b.vx, b.vy); continue; }
      const f = k / b.life;
      this.put(b.x + b.vx * k, b.y + b.vy * k + 40 * k * k, b.c, 1 - f * f);
    }
  }

  // A tracer: a hot core with amber either side, on the grid.
  private line(x0: number, y0: number, x1: number, y1: number): void {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      this.put(x, y, i > n * 0.6 ? HOT : AMBER.hi);
    }
  }

  private dom(t: number): void {
    const n = TAGLINE.length;
    const typed = Math.round(n * Math.min(1, Math.max(0, (t - T.type0) / (T.type1 - T.type0))));
    const cursor = t > T.type0 - 0.2 && t < T.done && Math.floor(t * 4) % 2 === 0 ? '▌' : ' ';
    const s = TAGLINE.slice(0, typed) + (typed < n ? cursor : '');
    if (this.tag.textContent !== s) this.tag.textContent = s;
    this.tape.classList.toggle('on', t > T.lay1);
    this.hint.classList.toggle('on', t > 0.6);
    // The bar fills in 12px segments, like a wave filling up.
    const frac = Math.min(1, Math.max(0, (t - 0.1) / (T.done - 0.25)));
    this.fill.style.width = `${Math.floor(frac * 100 / 5) * 5}%`;
  }
}

// The wordmark drawn once, finished, as a data URL, for the connection cover.
export function wordmarkURL(scale = 3): string {
  const { list, w } = bricks();
  const c = document.createElement('canvas');
  c.width = (w * B + 1) * scale; c.height = (ROWS * B + 1) * scale;
  const x = c.getContext('2d')!;
  const rgb = (v: number[]) => `rgb(${v[0]},${v[1]},${v[2]})`;
  for (const b of list) {
    x.fillStyle = rgb(INK);
    x.fillRect((b.x * B + 1) * scale, (b.y * B + 1) * scale, B * scale, B * scale);
  }
  for (const b of list) {
    const pal = b.amber ? AMBER : BONE;
    for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) {
      x.fillStyle = rgb(yy === 0 || xx === 0 ? pal.hi : yy === B - 1 || xx === B - 1 ? pal.lo : pal.mid);
      x.fillRect((b.x * B + xx) * scale, (b.y * B + yy) * scale, scale, scale);
    }
  }
  return c.toDataURL();
}
