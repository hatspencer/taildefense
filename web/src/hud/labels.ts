import * as THREE from 'three/webgpu';
import { EffectKind, Order, PF_ALIVE, siteX, siteY, walled } from '../protocol';
import type { Game } from '../state';
import { cssHex, playerColor } from '../scene/util';

export interface LabelFocus { hoverStruct: number; selStruct: number; hoverCreep: number; selCreep: number; showAllBars: boolean; hoverSite: number; siteHint: string }

// The HUD's palette and faces, for the canvas (see app.css).
const FONT = '"Pixelify Sans", "Lucida Console", monospace';
const CRT = '"VT323", "Lucida Console", monospace';
const INK = '#07080a', AMBER = '#e0a63a', MOSS = '#86a24c', RUST = '#b5472f', BONE = '#d9d1b3', KHAKI = '#938a66', TAPE = '#bfab72';

// A 5x4 skull, one guard-level pip.
const SKULL = ['.###.', '#.#.#', '#####', '.#.#.'];

// Names, HP bars and countdowns drawn on a 2D canvas over the 3D view: cheaper than DOM
// elements when there are hundreds of them.
export class Labels {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private v = new THREE.Vector3();
  private w = 1; private h = 1; private dpr = 1;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'labels';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(w: number, h: number): void {
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

  // A segmented pixel bar with a hard black outline.
  private bar(x: number, y: number, w: number, frac: number, hex = -1): void {
    const c = this.ctx;
    const h = 5;
    w = Math.round(w); x = Math.round(x - w / 2);
    c.fillStyle = INK;
    c.fillRect(x - 2, y - 2, w + 4, h + 4);
    c.fillStyle = '#2a1712';
    c.fillRect(x, y, w, h);
    c.fillStyle = hex >= 0 ? cssHex(hex) : frac > 0.5 ? MOSS : frac > 0.25 ? AMBER : RUST;
    c.fillRect(x, y, Math.round(w * Math.max(0, Math.min(1, frac))), h);
    c.fillStyle = 'rgba(255,255,230,0.2)';
    c.fillRect(x, y, Math.round(w * Math.max(0, Math.min(1, frac))), 1);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    for (let s = x + 6; s < x + w; s += 7) c.fillRect(s, y, 1, h);
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
  private ring(x: number, y: number, frac: number, col: string, caption: string, r = 10): void {
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
    if (!caption) return;
    c.save();
    c.font = `500 12px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'middle';
    this.text(caption, x + r + 7, y, col);
    c.restore();
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
  private siteTag(game: Game, i: number, hint: string, x: number, y: number, zoom: number): void {
    const c = this.ctx, wd = game.welcome!, f = game.cur, s = wd.sites[i];
    const searched = f.siteSearched(i);
    const guards = f.siteGuards(i);
    const level = Math.max(0, Math.min(4, s.guard ?? 0));
    const fs = Math.round(13 * Math.max(0.9, zoom));
    c.save();
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.font = `500 ${fs}px ${FONT}`;
    const line2 = searched ? (level > 0 ? 'picked clean' : '') : level === 0 ? 'unguarded' : guards > 0 ? `${guards} ${guards === 1 ? 'guard' : 'guards'} left · search if you dare` : 'guards cleared';
    const w1 = c.measureText(hint).width;
    c.font = `500 ${fs - 1}px ${FONT}`;
    const skullW = level > 0 ? level * 13 + 4 : 0;
    const w2 = line2 ? c.measureText(line2).width + skullW : 0;
    const w = Math.round(Math.max(w1, w2) + 16), lh = fs + 5;
    const h = line2 ? lh * 2 + 6 : lh + 6;
    const bx = Math.round(x - w / 2), by = Math.round(y - h);
    // Plate: black edge, drab fill, tape strip down the left.
    c.fillStyle = INK; c.fillRect(bx - 2, by - 2, w + 4, h + 4);
    c.fillStyle = 'rgba(28,30,22,0.94)'; c.fillRect(bx, by, w, h);
    c.fillStyle = searched ? KHAKI : guards > 0 ? RUST : TAPE; c.fillRect(bx, by, 3, h);
    c.font = `500 ${fs}px ${FONT}`;
    this.text(hint, bx + 9, by + 3 + lh / 2, searched ? KHAKI : '#f4c25c');
    if (line2) {
      const ly = by + 3 + lh + lh / 2;
      let tx = bx + 9;
      if (level > 0) { this.skulls(tx, Math.round(ly - 4), level, guards > 0 && !searched ? RUST : KHAKI); tx += skullW; }
      c.font = `500 ${fs - 1}px ${FONT}`;
      this.text(line2, tx, ly, guards > 0 && !searched ? '#e8846a' : searched ? KHAKI : BONE);
    }
    c.restore();
  }

  draw(game: Game, cam: THREE.Camera, focus: LabelFocus, now: number, dist: number): void {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const f = game.cur, wd = game.welcome;
    if (!wd) return;
    const zoom = Math.max(0.6, Math.min(1.3, 34 / dist));
    c.textAlign = 'center'; c.textBaseline = 'bottom';

    // Structures: bars when damaged, hovered or selected.
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const damaged = f.sHp[i] < f.sMaxHp[i];
      if (!damaged && i !== focus.hoverStruct && i !== focus.selStruct && !focus.showAllBars) continue;
      const k = f.sKind[i];
      const hgt = k === 1 ? 3.0 : k === 2 ? 2.7 : k <= 4 ? 1.6 : 1.9;
      if (!this.project(cam, f.sX[i] + f.sW[i] / 2, hgt, f.sY[i] + f.sH[i] / 2)) continue;
      this.bar(this.v.x, this.v.y, (f.sW[i] > 1 ? 54 : 30) * zoom, f.sHp[i] / Math.max(1, f.sMaxHp[i]));
    }

    // Big creeps always show their health; the hovered and selected one too.
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i], k = f.cKind[i];
      const def = wd.creeps[k];
      const focused = id === focus.hoverCreep || id === focus.selCreep;
      if (!focused && !(def && def.size >= 2 && f.cHp[i] < 255)) continue;
      const r = def ? def.radius : 0.45;
      if (!this.project(cam, game.rx[i], r * 2.1 * 1.9 + 0.3, game.ry[i])) continue;
      this.bar(this.v.x, this.v.y, Math.max(24, r * 40) * zoom, f.cHp[i] / 255, focused ? -1 : 0xb5472f);
    }

    // Heroes: name and HP; the downed show where they fell, their countdown and any revive.
    const fs = Math.round(13 * Math.max(0.85, zoom));
    const lift = 30 * Math.max(0.85, zoom), fog = game.fogged();
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const alive = (p.flags & PF_ALIVE) !== 0;
      // In thick fog other survivors show only their name: no bar, ring or countdown.
      const hide = fog && p.id !== wd.you;
      const col = cssHex(playerColor(p.id));
      if (!this.project(cam, game.prx[p.id], alive ? 2.25 : 0.5, game.pry[p.id])) continue;
      const x = this.v.x, y = this.v.y;
      c.font = `500 ${fs}px ${FONT}`;
      if (alive) {
        this.text(p.name, x, y - 3, col);
        if (hide) continue;
        this.bar(x, y + 1, 46 * zoom, p.hp / Math.max(1, p.maxHp));
        if (p.order === Order.Loot && p.channel > 0) this.ring(x, y - lift, p.channel, AMBER, 'searching…');
        else if (p.order === Order.Revive && p.channel > 0) this.ring(x, y - lift, p.channel, MOSS, 'reviving…');
      } else {
        // A blinking cross over the body, the name and the seconds left to reach them; a
        // revive in progress rings the cross.
        const blink = Math.floor(now / 450) % 2 === 0;
        if (p.revived > 0 && !hide) this.ring(x, y - 17, p.revived, MOSS, '', 16);
        c.fillStyle = INK; c.fillRect(x - 5, y - 26, 10, 18); c.fillRect(x - 9, y - 22, 18, 6);
        c.fillStyle = blink ? RUST : '#7a2a1c'; c.fillRect(x - 3, y - 24, 6, 14); c.fillRect(x - 7, y - 20, 14, 2);
        this.text(p.name, x, y - (p.revived > 0 && !hide ? 37 : 30), col);
        if (hide) continue;
        c.font = `${Math.round(fs * 1.5)}px ${CRT}`;
        this.text(`${p.respawn}s`, x, y + 14, '#e8846a');
      }
    }

    // The hovered loot site says what it is and what guards it.
    const site = focus.hoverSite >= 0 ? wd.sites[focus.hoverSite] : undefined;
    if (site && focus.siteHint) {
      if (this.project(cam, siteX(site), walled(site.kind) ? 2.2 : 1.6, siteY(site))) {
        this.siteTag(game, focus.hoverSite, focus.siteHint, this.v.x, this.v.y, zoom);
      }
    }

    // Airstrike countdowns.
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.font = `26px ${CRT}`;
    const since = (now - game.frameAt) / 1000;
    for (let i = 0; i < f.nEffects; i++) {
      if (f.eKind[i] !== EffectKind.AirTarget) continue;
      if (!this.project(cam, f.eX[i], 0.3, f.eY[i])) continue;
      const s = Math.max(0, f.eLeft[i] / 10 - since).toFixed(1);
      this.text(s, this.v.x, this.v.y, '#e8846a');
    }
  }
}
