import type { Controller } from '../controller';
import { EffectKind, lootable, PF_ALIVE, PF_CONNECTED, PingKind, siteX, siteY } from '../protocol';
import { PING_LIFE } from '../state';
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
  // Expanded (M): the map fills the middle of the screen.
  expanded = false;
  private box: HTMLElement;

  constructor(parent: HTMLElement, private ctl: Controller) {
    this.box = parent;
    this.canvas = document.createElement('canvas');
    parent.appendChild(this.canvas);
    el('div', 'mmcap', parent, 'Map · M or Esc to close');
    window.addEventListener('resize', () => { if (this.expanded) this.size(); });
    this.tip = el('div', 'mmtip panel hidden', parent);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = this.toWorld(e);
      if (e.button === 0 && (e.altKey || ctl.mode.k === 'ping')) {
        ctl.pingAt(x, y, true);
        if (ctl.mode.k === 'ping' && !e.shiftKey) ctl.setMode({ k: 'none' });
      } else if (e.button === 0) { this.drag = true; this.canvas.setPointerCapture(e.pointerId); this.look(x, y); }
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

  toggle(on = !this.expanded): void {
    if (on === this.expanded) return;
    // The panel keeps its place in the console while the map itself floats over the view.
    if (on) { const r = this.box.getBoundingClientRect(); this.box.style.width = `${r.width}px`; this.box.style.height = `${r.height}px`; }
    else { this.box.style.width = ''; this.box.style.height = ''; }
    this.expanded = on;
    this.box.classList.toggle('big', on);
    this.size();
  }

  // The canvas's size on screen and its backing store.
  private size(): void {
    const g = this.ctl.game;
    if (!g.w || !g.h) return;
    this.dpr = Math.min(window.devicePixelRatio, 2);
    const aspect = g.h / Math.max(1, g.w);
    // Big, it fits between the compass and the console, caption on top.
    const top = 100, bottom = this.box.parentElement?.getBoundingClientRect().height ?? 180;
    const room = Math.max(160, window.innerHeight - top - bottom - 12);
    const w = this.expanded ? Math.round(Math.min(window.innerWidth - 32, room / aspect)) : WIDTH;
    const h = Math.round(w * aspect);
    this.box.style.setProperty('--mm-big', `${w}px`); this.box.style.setProperty('--mm-top', `${top}px`);
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    this.sx = this.canvas.width / g.w; this.sy = this.canvas.height / g.h;
    this.last = 0;
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
      if (!lootable(s.kind)) continue;
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
    const left = g.guardsLeft(i);
    const state = f.siteSearched(i) ? 'searched' : left < 0 ? 'dark inside' : lvl === 0 ? 'unguarded' : left > 0 ? `${left} left · search if you dare` : 'guards cleared';
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
    this.size();
  }

  // Fog of war: unseen ground goes dark, ground seen before stays dim. Crates, creeps and the
  // team are drawn over it; creeps out of sight are not in the frame at all.
  private drawFog(): void {
    const v = this.ctl.game.vision;
    if (!v) return;
    if (!this.fog || this.fog.width !== v.w || this.fog.height !== v.h) {
      this.fog = document.createElement('canvas');
      this.fog.width = v.w; this.fog.height = v.h;
      this.fogImg = this.fog.getContext('2d')!.createImageData(v.w, v.h);
      this.fogVersion = -1;
    }
    if (v.version !== this.fogVersion) {
      this.fogVersion = v.version;
      const d = this.fogImg!.data;
      for (let i = 0; i < v.now.length; i++) {
        d[i * 4 + 3] = v.now[i] ? 0 : v.seen[i] ? 130 : 235;
      }
      this.fog.getContext('2d')!.putImageData(this.fogImg!, 0, 0);
    }
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.fog, 0, 0, this.canvas.width, this.canvas.height);
    this.ctx.imageSmoothingEnabled = false;
  }
  private fog: HTMLCanvasElement | null = null;
  private fogImg: ImageData | null = null;
  private fogVersion = -1;

  draw(now: number, viewW: number, viewH: number): void {
    const g = this.ctl.game;
    if (!g.welcome || !g.tiles.length) return;
    if (g.terrainVersion !== this.version) { this.version = g.terrainVersion; this.prerender(); }
    if (now - this.last < 66) return;
    this.last = now;
    const c = this.ctx, f = g.cur, sx = this.sx, sy = this.sy, dpr = this.dpr * (this.expanded ? 1.6 : 1);
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
      if (!lootable(s.kind)) continue;
      const x = Math.round(siteX(s) * sx), y = Math.round(siteY(s) * sy);
      // Unknown under fog of war counts as guarded: it may well be.
      const lvl = Math.max(0, Math.min(4, s.guard ?? 0)), done = f.siteSearched(i), guards = g.guardsLeft(i) < 0 ? lvl : f.siteGuards(i);
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
    this.drawFog();
    // Supply crates: a blinking green box; a Huey on its way: a green cross where it is.
    const cb = Math.floor(now / 500) % 2 === 0, cr = 3 * dpr;
    for (const k of f.crates) {
      const x = Math.round(k.x * sx), y = Math.round(k.y * sy);
      c.fillStyle = '#000'; c.fillRect(x - cr - dpr, y - cr - dpr, 2 * cr + 2 * dpr, 2 * cr + 2 * dpr);
      c.fillStyle = cb ? '#6ee05a' : '#3d8a32'; c.fillRect(x - cr, y - cr, 2 * cr, 2 * cr);
    }
    for (let i = 0; i < f.nEffects; i++) {
      if (f.eKind[i] !== EffectKind.Drop) continue;
      const left = f.eLeft[i] / 10, total = Math.max(4, f.eTotal[i] / 10);
      const k0 = Math.min(1, Math.max(0, (total - left) / (total - 3))), k = 1 - (1 - k0) * (1 - k0);
      const x = Math.round((f.eX0[i] + (f.eX[i] - f.eX0[i]) * k) * sx), y = Math.round((f.eY0[i] + (f.eY[i] - f.eY0[i]) * k) * sy);
      c.fillStyle = '#000'; c.fillRect(x - 4 * dpr, y - 2 * dpr, 8 * dpr, 4 * dpr); c.fillRect(x - 2 * dpr, y - 4 * dpr, 4 * dpr, 8 * dpr);
      c.fillStyle = '#6ee05a'; c.fillRect(x - 3 * dpr, y - dpr, 6 * dpr, 2 * dpr); c.fillRect(x - dpr, y - 3 * dpr, 2 * dpr, 6 * dpr);
    }
    c.fillStyle = '#d04a34';
    const d = Math.max(1.5, sx * 1.1);
    for (let i = 0; i < f.nCreeps; i++) c.fillRect(f.cX[i] * sx - d / 2, f.cY[i] * sy - d / 2, d, d);
    const blink = Math.floor(now / 400) % 2 === 0, fog = g.fogged();
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      if (fog && p.id !== wd.you) continue;
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
    this.drawPings(now, dpr);
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

  // Team pings: a diamond in the pinger's colour (red for danger) with rings rippling out of
  // it, quickly at first, then once a second until it fades. Drawn over everything but the view frame, so
  // a ping is never lost under a horde.
  private drawPings(now: number, dpr: number): void {
    const g = this.ctl.game, c = this.ctx, sx = this.sx, sy = this.sy;
    for (const p of g.pings) {
      const age = (now - p.at) / 1000, life = PING_LIFE / 1000;
      if (age < 0 || age > life) continue;
      const x = Math.round(p.x * sx), y = Math.round(p.y * sy);
      const col = p.kind === PingKind.Danger ? '#ff5a3c' : cssHex(playerColor(p.player));
      const fade = Math.min(1, (life - age) / 1);
      c.globalAlpha = fade;
      // Ripples: fast at first, then one a second until it fades.
      const ripple = (t: number) => {
        if (t < 0 || t > 1) return;
        const r = Math.round((4 + 18 * t) * dpr);
        c.globalAlpha = fade * (1 - t);
        diamond(r + dpr, '#000', 2 * dpr + 2 * dpr);
        diamond(r, col, 2 * dpr);
      };
      const diamond = (r: number, stroke: string, lw: number) => {
        c.lineWidth = lw; c.strokeStyle = stroke;
        c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.stroke();
      };
      for (let k = 0; k < 3; k++) ripple(age * 1.6 - k * 0.3);
      if (age > 1.6) ripple((age - 1.6) % 1);
      c.globalAlpha = fade;
      // The pin: a diamond, so it never reads as a player's square.
      const s = Math.round((Math.floor(age * 4) % 2 ? 4 : 5) * dpr);
      c.fillStyle = '#000';
      c.beginPath(); c.moveTo(x, y - s - 2 * dpr); c.lineTo(x + s + 2 * dpr, y); c.lineTo(x, y + s + 2 * dpr); c.lineTo(x - s - 2 * dpr, y); c.closePath(); c.fill();
      c.fillStyle = col;
      c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath(); c.fill();
      c.fillStyle = '#fff'; c.fillRect(x - dpr, y - dpr, 2 * dpr, 2 * dpr);
    }
    c.globalAlpha = 1;
  }
}
