import type { Controller } from '../controller';
import { PF_ALIVE, PF_CONNECTED, siteX, siteY } from '../protocol';
import { cssHex, playerColor } from '../scene/util';
import { el, esc, show } from './dom';

// Grass, dirt, floor, sand, water, tree, rock: the scene's colours, a little more washed out.
const TILE_RGB = [[78, 104, 54], [116, 96, 64], [112, 110, 100], [160, 146, 104], [48, 86, 104], [42, 62, 34], [94, 90, 80]];
const WIDTH = 210;
const GUARD = ['unguarded', 'lightly guarded', 'guarded', 'a lair', 'a garrison and its warlord'];

// A 2D map: prerendered terrain, structures, creeps, heroes and the camera's view.
export class Minimap {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private version = -1;
  private sx = 1; private sy = 1;
  private drag = false;
  private last = 0;
  private dpr = 1;
  private tip: HTMLElement;
  private hoverSite = -1;

  constructor(parent: HTMLElement, private ctl: Controller) {
    this.canvas = document.createElement('canvas');
    parent.appendChild(this.canvas);
    this.tip = el('div', 'mmtip panel hidden', parent);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = this.toWorld(e);
      if (e.button === 0) { this.drag = true; this.canvas.setPointerCapture(e.pointerId); this.look(x, y); }
      else if (e.button === 2) ctl.moveTo(x, y);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const [x, y] = this.toWorld(e);
      if (this.drag) this.look(x, y);
      this.hover(e);
    });
    this.canvas.addEventListener('pointerup', () => { this.drag = false; });
    this.canvas.addEventListener('pointerleave', () => { this.hoverSite = -1; show(this.tip, false); });
  }

  private look(x: number, y: number): void {
    this.ctl.rig.follow = false;
    this.ctl.rig.center(x, y, false);
  }

  private toWorld(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * this.ctl.game.w, (e.clientY - r.top) / r.height * this.ctl.game.h];
  }

  // The nearest loot site within a few screen pixels of the pointer names itself.
  private hover(e: PointerEvent): void {
    const wd = this.ctl.game.welcome;
    if (!wd) return;
    const r = this.canvas.getBoundingClientRect();
    const px = r.width / Math.max(1, this.ctl.game.w);
    let best = -1, bd = 7;
    for (let i = 0; i < wd.sites.length; i++) {
      const s = wd.sites[i];
      const d = Math.hypot(r.left + siteX(s) * px - e.clientX, r.top + siteY(s) * (r.height / Math.max(1, this.ctl.game.h)) - e.clientY);
      if (d < bd) { bd = d; best = i; }
    }
    this.hoverSite = best;
    this.updateTip();
  }

  private updateTip(): void {
    const g = this.ctl.game, wd = g.welcome, i = this.hoverSite;
    if (!wd || i < 0 || !wd.sites[i]) { show(this.tip, false); return; }
    const s = wd.sites[i], f = g.cur;
    const name = wd.siteKinds[s.kind]?.name ?? 'Loot site';
    const lvl = Math.max(0, Math.min(4, s.guard ?? 0));
    const left = f.siteGuards(i);
    const state = f.siteSearched(i) ? 'searched' : lvl === 0 ? 'unguarded' : left > 0 ? `${left} left · search if you dare` : 'guards cleared';
    const html = `<b>${esc(name)}</b> ${lvl > 0 ? `<span class="skulls">${'☠'.repeat(lvl)}</span> ${GUARD[lvl]}` : ''} <span class="muted">· ${esc(state)}</span>`;
    if (this.tip.innerHTML !== html) this.tip.innerHTML = html;
    show(this.tip, true);
  }

  private prerender(): void {
    const g = this.ctl.game;
    const c = document.createElement('canvas');
    c.width = g.w; c.height = g.h;
    const cx = c.getContext('2d')!;
    const img = cx.createImageData(g.w, g.h);
    for (let i = 0; i < g.tiles.length; i++) {
      const rgb = TILE_RGB[g.tiles[i]] ?? [0, 0, 0];
      // A little per-tile grit, so the map reads as ground rather than flat fills.
      const n = (Math.imul(i, 2654435761) >>> 28) - 8;
      img.data[i * 4] = rgb[0] + n; img.data[i * 4 + 1] = rgb[1] + n; img.data[i * 4 + 2] = rgb[2] + n; img.data[i * 4 + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    this.terrain = c;
    this.dpr = Math.min(window.devicePixelRatio, 2);
    const h = Math.round(WIDTH * g.h / Math.max(1, g.w));
    this.canvas.style.width = `${WIDTH}px`; this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(WIDTH * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    this.sx = this.canvas.width / g.w; this.sy = this.canvas.height / g.h;
  }

  draw(now: number, viewW: number, viewH: number): void {
    const g = this.ctl.game;
    if (!g.welcome || !g.tiles.length) return;
    if (g.terrainVersion !== this.version) { this.version = g.terrainVersion; this.prerender(); }
    if (now - this.last < 66) return;
    this.last = now;
    const c = this.ctx, f = g.cur, sx = this.sx, sy = this.sy, dpr = this.dpr;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.terrain!, 0, 0, this.canvas.width, this.canvas.height);

    // Build radius, a dashed amber line.
    const wd = g.welcome;
    c.strokeStyle = 'rgba(224,166,58,0.45)'; c.lineWidth = dpr; c.setLineDash([3 * dpr, 3 * dpr]);
    c.beginPath(); c.ellipse(wd.core.x * sx, wd.core.y * sy, wd.buildRadius * sx, wd.buildRadius * sy, 0, 0, 6.29); c.stroke();
    c.setLineDash([]);

    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const k = f.sKind[i];
      c.fillStyle = k === 1 ? '#9ec0bc' : k === 2 ? '#e0a63a' : k <= 4 ? '#c8bf9f' : cssHex(playerColor(f.sOwner[i]));
      c.fillRect(f.sX[i] * sx, f.sY[i] * sy, Math.max(1.5, f.sW[i] * sx), Math.max(1.5, f.sH[i] * sy));
    }
    // Loot sites: amber until searched, then grey; guarded ones carry a rust pip per guard
    // level while any guard lives.
    const sd = Math.max(2, 2 * dpr), pip = Math.max(1, dpr);
    for (let i = 0; i < wd.sites.length; i++) {
      const s = wd.sites[i];
      const x = Math.round(siteX(s) * sx), y = Math.round(siteY(s) * sy);
      const done = f.siteSearched(i), guards = f.siteGuards(i), lvl = Math.max(0, Math.min(4, s.guard ?? 0));
      const hot = i === this.hoverSite;
      const d = hot ? sd + 2 * dpr : sd;
      c.fillStyle = hot ? '#fff' : '#000'; c.fillRect(x - d / 2 - pip, y - d / 2 - pip, d + 2 * pip, d + 2 * pip);
      c.fillStyle = done ? '#7a776c' : guards > 0 ? '#c86a3c' : '#e8b444'; c.fillRect(x - d / 2, y - d / 2, d, d);
      if (!done && guards > 0 && lvl > 0) {
        const pw = 2 * pip, total = lvl * pw + (lvl - 1) * pip;
        for (let k = 0; k < lvl; k++) {
          const px = x - total / 2 + k * (pw + pip), py = y - d / 2 - pip - 3 * pip;
          c.fillStyle = '#000'; c.fillRect(px - pip / 2, py - pip / 2, pw + pip, pw + pip);
          c.fillStyle = '#d0503a'; c.fillRect(px, py, pw, pw);
        }
      }
    }
    c.fillStyle = '#d04a34';
    const d = Math.max(1.5, sx * 1.1);
    for (let i = 0; i < f.nCreeps; i++) c.fillRect(f.cX[i] * sx - d / 2, f.cY[i] * sy - d / 2, d, d);
    const blink = Math.floor(now / 400) % 2 === 0;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const r = 3 * dpr;
      const px = Math.round(p.x * sx), py = Math.round(p.y * sy);
      if (!(p.flags & PF_ALIVE)) {
        // Downed: a blinking cross where they fell.
        if (!(p.flags & PF_CONNECTED)) continue;
        c.fillStyle = '#000'; c.fillRect(px - r - dpr, py - dpr * 2, 2 * r + 2 * dpr, dpr * 4); c.fillRect(px - dpr * 2, py - r - dpr, dpr * 4, 2 * r + 2 * dpr);
        c.fillStyle = blink ? '#ff6a4a' : cssHex(playerColor(p.id));
        c.fillRect(px - r, py - dpr, 2 * r, dpr * 2); c.fillRect(px - dpr, py - r, dpr * 2, 2 * r);
        continue;
      }
      c.fillStyle = '#000'; c.fillRect(px - r - dpr, py - r - dpr, r * 2 + 2 * dpr, r * 2 + 2 * dpr);
      c.fillStyle = cssHex(playerColor(p.id)); c.fillRect(px - r, py - r, r * 2, r * 2);
    }
    const q = this.ctl.rig.viewQuad(viewW, viewH);
    c.strokeStyle = 'rgba(217,209,179,0.9)'; c.lineWidth = 1.5 * dpr;
    c.beginPath();
    q.forEach(([x, y], i) => (i ? c.lineTo(x * sx, y * sy) : c.moveTo(x * sx, y * sy)));
    c.closePath(); c.stroke();
    // The map is always north up.
    const W = this.canvas.width, Hh = this.canvas.height, m = 8 * dpr;
    c.font = `${Math.round(14 * dpr)}px VT323, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 3 * dpr; c.strokeStyle = 'rgba(0,0,0,0.85)';
    for (const [t, x, y] of [['N', W / 2, m], ['S', W / 2, Hh - m], ['W', m, Hh / 2], ['E', W - m, Hh / 2]] as [string, number, number][]) {
      c.strokeText(t, x, y);
      c.fillStyle = t === 'N' ? '#f4c25c' : '#d9d1b3';
      c.fillText(t, x, y);
    }
    if (this.hoverSite >= 0) this.updateTip();
  }
}
