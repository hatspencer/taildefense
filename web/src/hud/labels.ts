import * as THREE from 'three/webgpu';
import { EffectKind, K_ARMORY, K_SNIPER, Order, PF_ALIVE, PingKind, siteX, siteY, walled } from '../protocol';
import { type Game, PING_LIFE } from '../state';
import { SNIPER_HEAD_Y } from '../scene/structs';
import { cssHex, playerColor } from '../scene/util';
import { lighter } from '../scene/palette';
import { tame } from '../scene/dither';

interface LabelFocus { hoverStruct: number; selStruct: number; hoverCreep: number; selCreep: number; showAllBars: boolean; hoverSite: number; siteHint: string; hoverGun?: number; gunHint?: string; dropHold?: number; creepTop?: (kind: number) => number }

// The HUD's palette and faces, for the canvas (see app.css).
// Labels use the HUD's one face (see --font).
const FONT = '"Fira Code", Menlo, Consolas, monospace';
const INK = '#07080a', AMBER = '#e0a63a', MOSS = '#86a24c', RUST = '#b5472f', BONE = '#d9d1b3', KHAKI = '#938a66', TAPE = '#bfab72';

// 7x7 ping glyphs, by PingKind: here (a down arrow), danger (!), loot (a coin), defend (a shield).
const PING_GLYPH = [
  ['#######', '.#####.', '..###..', '...#...', '.......', '.#####.', '.......'],
  ['..###..', '..###..', '..###..', '..###..', '.......', '..###..', '..###..'],
  ['..###..', '.#...#.', '#..#..#', '#.###.#', '#..#..#', '.#...#.', '..###..'],
  ['#######', '#.....#', '#.###.#', '#.###.#', '.#.#.#.', '..#.#..', '...#...'],
];
const PING_WORD = ['here', 'danger', 'loot', 'defend'];

// The labels over figures are drawn in the scene's own pixels: a 3x5 pixel font (capitals,
// digits and a little punctuation), each glyph 15 bits, top row first, and bars two scene
// pixels high, all on the scene pixel grid. A name with a letter the font lacks falls back to
// the HUD's face.
const FONT5: Record<string, number> = {
  'A': 11245, 'B': 27566, 'C': 14627, 'D': 27502, 'E': 31143, 'F': 31140, 'G': 14699, 'H': 23533,
  'I': 29847, 'J': 4714, 'K': 23469, 'L': 18727, 'M': 24557, 'N': 27501, 'O': 11114, 'P': 27556,
  'Q': 11123, 'R': 27565, 'S': 14478, 'T': 29842, 'U': 23407, 'V': 23402, 'W': 23549, 'X': 23213,
  'Y': 23186, 'Z': 29351, '0': 31599, '1': 11415, '2': 25255, '3': 25230, '4': 23497, '5': 31118,
  '6': 14831, '7': 29330, '8': 31727, '9': 31694, '.': 2, ',': 20, '-': 448, '_': 7,
  '\'': 9216, '!': 9346, '?': 25218, ':': 1040, '/': 4772, '+': 1488, '(': 10530, ')': 8778,
  ' ': 0, '·': 128, '#': 24445, '*': 2728,
};
const FONT_INK = '#18150f';

// Health on a bar, in the palette: worn green, the hard hat's amber, the medkit's red.
const HP_OK = '#7f9640', HP_MID = '#c8962a', HP_LOW = '#b23a22', HP_EMPTY = '#2e2116';

// A 5x4 skull, one guard-level pip.
const SKULL = ['.###.', '#.#.#', '#####', '.#.#.'];

// Below this clarity a label isn't drawn at all; above it, it fades in to full by fade.
const HAZE_GONE = 0.35;
function fade(a: number): number { return Math.min(1, (a - HAZE_GONE) / (0.8 - HAZE_GONE)); }

// A survivor's search or revive ring, held back to draw over everything else.
interface Ring { x: number; y: number; frac: number; col: string; caption: string }
const RING_R = 10;

// Names, HP bars and countdowns drawn on a 2D canvas over the 3D view: cheaper than DOM
// elements when there are hundreds of them.
export class Labels {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private v = new THREE.Vector3();
  private w = 1; private h = 1; private dpr = 1;
  // One scene pixel, in CSS pixels.
  private px = 2;
  // Words already set in the pixel font, by text and colour: each a small canvas, one canvas
  // pixel a scene pixel, outlined.
  private words = new Map<string, HTMLCanvasElement | null>();

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'labels';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  // px: the scene pixel's size in CSS pixels (0 when the scene is drawn without them).
  resize(w: number, h: number, px = 0): void {
    this.px = px > 0 ? px : 2;
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
  }

  private project(cam: THREE.Camera, x: number, y: number, z: number): boolean {
    this.v.set(x, y, z).project(cam);
    if (this.v.z > 1 || this.v.x < -1.1 || this.v.x > 1.1 || this.v.y < -1.1 || this.v.y > 1.1) return false;
    this.v.x = Math.round((this.v.x + 1) / 2 * this.w); this.v.y = Math.round((1 - this.v.y) / 2 * this.h);
    return true;
  }

  // A health bar of the scene's pixels: w scene pixels long and two high, in a one-pixel dark
  // edge, centred on x with its top at y (CSS pixels), on the scene pixel grid.
  private bar(x: number, y: number, w: number, frac: number, hex = -1): void {
    const c = this.ctx, p = this.px;
    w = Math.max(4, Math.round(w));
    const bx = this.snap(x) - Math.floor(w / 2) * p, by = this.snap(y);
    c.fillStyle = FONT_INK;
    c.fillRect(bx - p, by - p, (w + 2) * p, 4 * p);
    c.fillStyle = HP_EMPTY;
    c.fillRect(bx, by, w * p, 2 * p);
    const f = Math.max(0, Math.min(1, frac)), n = f > 0 ? Math.max(1, Math.round(w * f)) : 0;
    c.fillStyle = hex >= 0 ? cssHex(hex) : f > 0.5 ? HP_OK : f > 0.25 ? HP_MID : HP_LOW;
    c.fillRect(bx, by, n * p, 2 * p);
  }

  private snap(v: number): number { return Math.round(v / this.px) * this.px; }

  // s set in the pixel font in col, outlined, or null when it has a letter the font lacks.
  private word(s: string, col: string): HTMLCanvasElement | null {
    const key = `${col}|${s}`;
    let k = this.words.get(key);
    if (k !== undefined) return k;
    if (this.words.size > 300) this.words.clear();
    const up = s.toUpperCase().replace(/…/g, '...');
    k = null;
    if ([...up].every((ch) => ch in FONT5)) {
      const n = [...up].length;
      k = document.createElement('canvas');
      k.width = n * 4 + 1; k.height = 7;
      const g = k.getContext('2d')!;
      const on: [number, number][] = [];
      [...up].forEach((ch, i) => {
        const bits = FONT5[ch];
        for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (bits & (1 << (14 - r * 3 - q))) on.push([1 + i * 4 + q, 1 + r]);
      });
      g.fillStyle = FONT_INK;
      for (const [x, y] of on) g.fillRect(x - 1, y - 1, 3, 3);
      g.fillStyle = col;
      for (const [x, y] of on) g.fillRect(x, y, 1, 1);
    }
    this.words.set(key, k);
    return k;
  }

  // A word in the pixel font, centred on x (or starting at x, left) with its foot at y (CSS
  // pixels), at scale times the scene pixel; a text the font cannot set is written in the HUD's
  // face instead.
  private label(s: string, x: number, y: number, col: string, scale = 1, left = false): void {
    const k = this.word(s, col), c = this.ctx, p = this.px * scale;
    if (!k) {
      c.save(); c.font = `600 ${Math.round(6 * p)}px ${FONT}`; c.textAlign = left ? 'left' : 'center'; c.textBaseline = 'bottom';
      this.text(s, x, y, col); c.restore();
      return;
    }
    c.imageSmoothingEnabled = false;
    c.drawImage(k, this.snap(x) - (left ? 0 : Math.floor(k.width / 2) * p), this.snap(y) - k.height * p, k.width * p, k.height * p);
  }

  // Text with a hard 2px pixel shadow instead of a soft outline.
  private text(s: string, x: number, y: number, col: string): void {
    const c = this.ctx;
    c.fillStyle = INK;
    c.fillText(s, x + 2, y + 2); c.fillText(s, x - 1, y); c.fillText(s, x + 1, y); c.fillText(s, x, y - 1);
    c.fillStyle = col;
    c.fillText(s, x, y);
  }

  // A segmented progress ring with a caption: a search, or a revive.
  private ring(x: number, y: number, frac: number, col: string, caption: string, r = RING_R): void {
    const c = this.ctx, segs = 12;
    const lit = Math.floor(Math.min(1, frac) * segs + 0.001);
    const step = (Math.PI * 2) / segs, gap = 0.12;
    c.lineCap = 'butt';
    c.lineWidth = 7; c.strokeStyle = INK;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 4;
    for (let i = 0; i < segs; i++) {
      const a = -Math.PI / 2 + i * step;
      c.strokeStyle = i < lit ? col : '#3a3a2c';
      c.beginPath(); c.arc(x, y, r, a + gap, a + step - gap); c.stroke();
    }
    if (caption) this.label(caption, x + r + 7, y + 4 * this.px, col, 1, true);
  }

  private skulls(x: number, y: number, n: number, col: string): void {
    const c = this.ctx, px = 2;
    for (let k = 0; k < n; k++) {
      const ox = x + k * (5 * px + 3);
      c.fillStyle = INK; c.fillRect(ox - 1, y - 1, 5 * px + 2, 4 * px + 2);
      c.fillStyle = col;
      for (let r = 0; r < SKULL.length; r++) for (let q = 0; q < 5; q++) if (SKULL[r][q] === '#') c.fillRect(ox + q * px, y + r * px, px, px);
    }
  }

  // The hovered site's tag: what it is, how hard its guards are and how many still stand.
  // It rises above any ring it would cover, so a search under way stays in sight.
  private siteTag(game: Game, i: number, hint: string, x: number, y: number, zoom: number, rings: Ring[]): void {
    const c = this.ctx, wd = game.welcome!, f = game.cur, s = wd.sites[i];
    const searched = f.siteSearched(i);
    // -1: fog of war, and nobody has been inside to count them. -2: night, never counted.
    const guards = game.guardsLeft(i);
    const level = Math.max(0, Math.min(4, s.guard ?? 0));
    const fs = Math.round(15 * Math.max(0.9, zoom));
    c.save();
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.font = `600 ${fs}px ${FONT}`;
    const line2 = searched ? (level > 0 ? 'picked clean' : '') : guards === -2 ? (level > 0 ? 'how many, nobody knows · search if you dare' : 'unguarded') : guards < 0 ? 'dark inside · go in to see' : level === 0 ? 'unguarded' : guards > 0 ? `${guards} ${guards === 1 ? 'guard' : 'guards'} left · search if you dare` : 'guards cleared';
    const w1 = c.measureText(hint).width;
    c.font = `600 ${fs - 1}px ${FONT}`;
    const skullW = level > 0 ? level * 13 + 4 : 0;
    const w2 = line2 ? c.measureText(line2).width + skullW : 0;
    const w = Math.round(Math.max(w1, w2) + 16), lh = fs + 5;
    const h = line2 ? lh * 2 + 6 : lh + 6;
    const bx = Math.round(x - w / 2);
    let by = Math.round(y - h);
    for (let moved = true; moved;) {
      moved = false;
      for (const r of rings) {
        const rx0 = r.x - RING_R - 4, rx1 = r.x + RING_R + 7 + ([...r.caption].length * 4 + 1) * this.px + 3;
        const ry0 = r.y - RING_R - 4, ry1 = r.y + RING_R + 4;
        if (bx - 2 < rx1 && bx + w + 2 > rx0 && by - 2 < ry1 && by + h + 2 > ry0) { by = Math.round(ry0 - 4 - h); moved = true; }
      }
    }
    // Plate: black edge, drab fill, tape strip down the left.
    c.fillStyle = INK; c.fillRect(bx - 2, by - 2, w + 4, h + 4);
    c.fillStyle = 'rgba(28,30,22,0.94)'; c.fillRect(bx, by, w, h);
    c.fillStyle = searched ? KHAKI : guards !== 0 ? RUST : TAPE; c.fillRect(bx, by, 3, h);
    c.font = `600 ${fs}px ${FONT}`;
    this.text(hint, bx + 9, by + 3 + lh / 2, searched ? KHAKI : '#f4c25c');
    if (line2) {
      const ly = by + 3 + lh + lh / 2;
      let tx = bx + 9;
      if (level > 0) { this.skulls(tx, Math.round(ly - 4), level, guards !== 0 && !searched ? RUST : KHAKI); tx += skullW; }
      c.font = `600 ${fs - 1}px ${FONT}`;
      this.text(line2, tx, ly, guards !== 0 && !searched ? '#e8846a' : searched ? KHAKI : BONE);
    }
    c.restore();
  }

  // clarity says how clearly a spot shows through the weather's haze (FogOfWar.clarity): what
  // the haze hides, its label hides too, or the bars would give away what the fog conceals.
  draw(game: Game, cam: THREE.Camera, focus: LabelFocus, now: number, dist: number, clarity: (x: number, z: number) => number = () => 1): void {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const f = game.cur, wd = game.welcome;
    if (!wd) return;
    const zoom = Math.max(0.6, Math.min(1.3, 34 / dist));
    c.textAlign = 'center'; c.textBaseline = 'bottom';

    // Structures: bars when damaged, hovered or selected. The armory is never hit, so it has none.
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i] || f.sKind[i] === K_ARMORY) continue;
      const damaged = f.sHp[i] < f.sMaxHp[i];
      if (!damaged && i !== focus.hoverStruct && i !== focus.selStruct && !focus.showAllBars) continue;
      const k = f.sKind[i];
      const hgt = k === 1 ? 3.0 : k === 2 ? 2.7 : k <= 4 ? 1.6 : k === K_SNIPER ? SNIPER_HEAD_Y + 0.5 : 1.9;
      const sx = f.sX[i] + f.sW[i] / 2, sz = f.sY[i] + f.sH[i] / 2, a = clarity(sx, sz);
      if (a < HAZE_GONE || !this.project(cam, sx, hgt, sz)) continue;
      c.globalAlpha = fade(a);
      this.bar(this.v.x, this.v.y, f.sW[i] > 1 ? 22 : 12, f.sHp[i] / Math.max(1, f.sMaxHp[i]));
    }
    c.globalAlpha = 1;

    // Big creeps always show their health; the hovered and selected one too.
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i], k = f.cKind[i];
      const def = wd.creeps[k];
      const focused = id === focus.hoverCreep || id === focus.selCreep;
      if (!focused && !(def && def.size >= 2 && f.cHp[i] < 255)) continue;
      const r = def ? def.radius : 0.45;
      const a = clarity(game.rx[i], game.ry[i]);
      // Just over the head as the model is drawn (the scene knows each kind's height), not
      // reckoned from the sim's radius, which put a brute's bar a metre and a half above him
      // and over whoever stood behind him in a crowd.
      const top = focus.creepTop?.(k) ?? r * 2.1 * 1.9;
      if (a < HAZE_GONE || !this.project(cam, game.rx[i], top + 0.22, game.ry[i])) continue;
      c.globalAlpha = fade(a);
      // Small and quiet: about the width of the figure's shoulders, a dull red unless it is the
      // one you point at.
      this.bar(this.v.x, this.v.y - 3 * this.px, Math.max(6, Math.min(16, Math.round(r * 11))), f.cHp[i] / 255, focused ? -1 : 0x9a3a22);
    }
    c.globalAlpha = 1;

    // Heroes: name and HP; the downed show where they fell, their countdown and any revive.
    const lift = 30 * Math.max(0.85, zoom), fog = game.fogged();
    const rings: Ring[] = [];
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      if (p.aboard) continue;
      const alive = (p.flags & PF_ALIVE) !== 0;
      // In thick fog other survivors show only their name: no bar, ring or countdown. Out in
      // the haze, where they can't be seen, not even that.
      const mine = p.id === wd.you, hide = fog && !mine;
      const a = mine ? 1 : clarity(game.prx[p.id], game.pry[p.id]);
      const col = cssHex(lighter(tame(playerColor(p.id), 0.85), 0.12));
      if (a < HAZE_GONE || !this.project(cam, game.prx[p.id], alive ? 2.05 : 0.5, game.pry[p.id])) continue;
      c.globalAlpha = fade(a);
      const x = this.v.x, y = this.v.y;
      if (alive) {
        // Just over the head: the bar, and the name in the player's colour over it.
        this.label(p.name, x, y - (hide ? 0 : 2 * this.px), col);
        if (hide) continue;
        this.bar(x, y, 14, p.hp / Math.max(1, p.maxHp));
        if (p.order === Order.Loot && p.channel > 0) rings.push({ x, y: y - lift, frac: p.channel, col: AMBER, caption: 'searching…' });
        else if (p.order === Order.Revive && p.channel > 0) rings.push({ x, y: y - lift, frac: p.channel, col: MOSS, caption: 'reviving…' });
        else if (p.order === Order.Pickup && p.channel > 0) rings.push({ x, y: y - lift, frac: p.channel, col: AMBER, caption: 'picking up…' });
        else if (mine && (focus.dropHold ?? 0) > 0) rings.push({ x, y: y - lift, frac: focus.dropHold!, col: AMBER, caption: 'dropping…' });
      } else {
        // A blinking cross over the body, the name and the seconds left to reach them; a
        // revive in progress rings the cross.
        const blink = Math.floor(now / 450) % 2 === 0;
        if (p.revived > 0 && !hide) this.ring(x, y - 17, p.revived, MOSS, '', 16);
        c.fillStyle = INK; c.fillRect(x - 5, y - 26, 10, 18); c.fillRect(x - 9, y - 22, 18, 6);
        c.fillStyle = blink ? RUST : '#7a2a1c'; c.fillRect(x - 3, y - 24, 6, 14); c.fillRect(x - 7, y - 20, 14, 2);
        this.label(p.name, x, y - (p.revived > 0 && !hide ? 37 : 30), col);
        if (hide) continue;
        this.label(`${p.respawn}s`, x, y + 16, '#e0805a', 2);
      }
    }

    c.globalAlpha = 1;

    // The hovered loot site says what it is and what guards it.
    const site = focus.hoverSite >= 0 ? wd.sites[focus.hoverSite] : undefined;
    if (site && focus.siteHint) {
      if (this.project(cam, siteX(site), walled(site.kind) ? 2.2 : 1.6, siteY(site))) {
        this.siteTag(game, focus.hoverSite, focus.siteHint, this.v.x, this.v.y, zoom, rings);
      }
    }

    // Supply crates: a tag, and a ring while someone opens one.
    for (const k of f.crates) {
      if (!this.project(cam, k.x, 1.3, k.y)) continue;
      if (k.open > 0) this.ring(this.v.x, this.v.y - 16, k.open, MOSS, 'opening…');
      else this.label('supply crate', this.v.x, this.v.y, MOSS);
    }

    // Weapons on the ground: the name, with its upgrades and whose it was when hovered.
    for (const g of f.guns) {
      if (!this.project(cam, g.x, 0.95, g.y)) continue;
      const hot = g.id === focus.hoverGun && focus.gunHint;
      this.label(hot ? focus.gunHint! : wd.weapons[g.kind]?.name ?? 'weapon', this.v.x, this.v.y, AMBER);
    }

    // Airstrike countdowns.
    const since = (now - game.frameAt) / 1000;
    for (let i = 0; i < f.nEffects; i++) {
      if (f.eKind[i] !== EffectKind.AirTarget) continue;
      if (!this.project(cam, f.eX[i], 0.3, f.eY[i])) continue;
      const s = Math.max(0, f.eLeft[i] / 10 - since).toFixed(1);
      this.label(s, this.v.x, this.v.y, '#e8846a', 2);
    }
    // Search and revive rings last, so no tag or label covers them.
    for (const r of rings) this.ring(r.x, r.y, r.frac, r.col, r.caption);
    this.pings(game, cam, now);
  }

  // Team pings: a pixel beacon standing over the spot with the pinger's name, or, when the
  // spot is off screen, an arrow at the screen's edge pointing to it.
  private pings(game: Game, cam: THREE.Camera, now: number): void {
    const c = this.ctx;
    for (const p of game.pings) {
      const age = (now - p.at) / 1000, life = PING_LIFE / 1000;
      if (age < 0 || age > life) continue;
      const fade = Math.min(1, (life - age) / 0.8);
      const col = p.kind === PingKind.Danger ? '#ff5a3c' : cssHex(playerColor(p.player));
      const name = game.cur.player(p.player)?.name ?? '';
      // Unclamped projection: behind the camera flips, so mirror it to keep the arrow honest.
      this.v.set(p.x, 0, p.y).project(cam);
      let nx = this.v.x, ny = this.v.y;
      if (this.v.z > 1) { nx = -nx; ny = -ny; }
      const on = this.v.z <= 1 && nx > -0.95 && nx < 0.95 && ny > -0.9 && ny < 0.9;
      c.globalAlpha = fade;
      if (on) {
        const gx = Math.round((nx + 1) / 2 * this.w), gy = Math.round((1 - ny) / 2 * this.h);
        // Drop in from above, then bob.
        const drop = Math.max(0, 1 - age / 0.25);
        const top = gy - 64 - Math.round(drop * 40) - (age > 0.25 ? Math.round(Math.sin(age * 5) * 2) : 0);
        c.fillStyle = INK; c.fillRect(gx - 2, top + 26, 4, gy - top - 26);
        c.fillStyle = col;
        for (let yy = top + 28; yy < gy - 2; yy += 6) c.fillRect(gx - 1, yy, 2, 3);
        this.glyph(gx, top, p.kind, col, age);
        c.font = `600 14px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'bottom';
        this.text(name ? `${name} · ${PING_WORD[p.kind] ?? ''}` : PING_WORD[p.kind] ?? '', gx, top - 14, col);
      } else {
        // The edge arrow: on the line from the screen centre towards the spot.
        // It keeps inside the play area, clear of the top bar and the console.
        const x0 = 28, x1 = this.w - 28, y0 = 84, y1 = this.h - consoleH() - 14;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const dx = (nx + 1) / 2 * this.w - cx, dy = (1 - ny) / 2 * this.h - cy;
        const k = 1 / Math.max(Math.abs(dx) / ((x1 - x0) / 2), Math.abs(dy) / ((y1 - y0) / 2), 1e-6);
        const ex = Math.round(cx + dx * Math.min(1, k)), ey = Math.round(cy + dy * Math.min(1, k));
        const ang = Math.atan2(dy, dx);
        c.save(); c.translate(ex, ey); c.rotate(ang);
        const pulse = Math.floor(age * 4) % 2 ? 0 : 3;
        c.fillStyle = INK; c.beginPath(); c.moveTo(14 + pulse, 0); c.lineTo(-8, -11); c.lineTo(-8, 11); c.closePath(); c.fill();
        c.fillStyle = col; c.beginPath(); c.moveTo(10 + pulse, 0); c.lineTo(-5, -7); c.lineTo(-5, 7); c.closePath(); c.fill();
        c.restore();
        c.font = `600 14px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        const tx = Math.min(this.w - 40, Math.max(40, ex - Math.cos(ang) * 30)), ty = Math.min(this.h - 20, Math.max(20, ey - Math.sin(ang) * 22));
        this.text(name || PING_WORD[p.kind], tx, ty, col);
      }
    }
    c.globalAlpha = 1;
    c.textBaseline = 'bottom';
  }

  // A ping's glyph in a bevelled pixel box, 3px per glyph pixel, flashing white as it lands.
  private glyph(x: number, top: number, kind: number, col: string, age: number): void {
    const c = this.ctx, g = PING_GLYPH[kind] ?? PING_GLYPH[0], px = 3, n = 7, box = n * px + 6;
    const bx = x - box / 2, flash = age < 0.35 && Math.floor(age * 12) % 2 === 0;
    c.fillStyle = INK; c.fillRect(bx - 2, top - 2, box + 4, box + 4);
    c.fillStyle = flash ? '#ffffff' : col; c.fillRect(bx, top, box, box);
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(bx + 2, top + 2, box - 4, box - 4);
    c.fillStyle = flash ? col : '#ffffff';
    for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++) if (g[yy][xx] === '#') c.fillRect(bx + 3 + xx * px, top + 3 + yy * px, px, px);
  }
}

// The bottom console's height, which the stylesheet sets by the size of the screen.
let consoleAt = 0, consoleVal = 196;
function consoleH(): number {
  const now = performance.now();
  if (now - consoleAt > 1000) {
    consoleAt = now;
    consoleVal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bottom-h')) || 196;
  }
  return consoleVal;
}
