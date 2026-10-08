import type { Controller } from '../controller';
import { PF_ALIVE } from '../protocol';
import { cssHex, playerColor } from '../scene/util';

const TILE_RGB = [[79, 122, 52], [138, 108, 66], [124, 124, 118], [194, 173, 116], [44, 108, 150], [38, 74, 30], [106, 100, 88]];
const WIDTH = 210;

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

  constructor(parent: HTMLElement, private ctl: Controller) {
    this.canvas = document.createElement('canvas');
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = this.toWorld(e);
      if (e.button === 0) { this.drag = true; this.canvas.setPointerCapture(e.pointerId); this.look(x, y); }
      else if (e.button === 2) ctl.moveTo(x, y);
    });
    this.canvas.addEventListener('pointermove', (e) => { if (this.drag) { const [x, y] = this.toWorld(e); this.look(x, y); } });
    this.canvas.addEventListener('pointerup', () => { this.drag = false; });
  }

  private look(x: number, y: number): void {
    this.ctl.rig.follow = false;
    this.ctl.rig.center(x, y, false);
  }

  private toWorld(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * this.ctl.game.w, (e.clientY - r.top) / r.height * this.ctl.game.h];
  }

  private prerender(): void {
    const g = this.ctl.game;
    const c = document.createElement('canvas');
    c.width = g.w; c.height = g.h;
    const cx = c.getContext('2d')!;
    const img = cx.createImageData(g.w, g.h);
    for (let i = 0; i < g.tiles.length; i++) {
      const rgb = TILE_RGB[g.tiles[i]] ?? [0, 0, 0];
      img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 255;
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
    const c = this.ctx, f = g.cur, sx = this.sx, sy = this.sy;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.terrain!, 0, 0, this.canvas.width, this.canvas.height);

    // Build radius, faint.
    const wd = g.welcome;
    c.strokeStyle = 'rgba(255,230,150,0.25)'; c.lineWidth = 1;
    c.beginPath(); c.ellipse(wd.core.x * sx, wd.core.y * sy, wd.buildRadius * sx, wd.buildRadius * sy, 0, 0, 6.29); c.stroke();

    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const k = f.sKind[i];
      c.fillStyle = k === 1 ? '#5ff0ff' : k === 2 ? '#e0b030' : k <= 4 ? '#d8d4c8' : cssHex(playerColor(f.sOwner[i]));
      c.fillRect(f.sX[i] * sx, f.sY[i] * sy, Math.max(1.5, f.sW[i] * sx), Math.max(1.5, f.sH[i] * sy));
    }
    c.fillStyle = '#ff3a2a';
    const d = Math.max(1.5, sx * 1.1);
    for (let i = 0; i < f.nCreeps; i++) c.fillRect(f.cX[i] * sx - d / 2, f.cY[i] * sy - d / 2, d, d);
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      if (!(p.flags & PF_ALIVE)) continue;
      const r = 3.2 * this.dpr;
      c.fillStyle = '#000'; c.fillRect(p.x * sx - r - 1, p.y * sy - r - 1, r * 2 + 2, r * 2 + 2);
      c.fillStyle = cssHex(playerColor(p.id)); c.fillRect(p.x * sx - r, p.y * sy - r, r * 2, r * 2);
    }
    const q = this.ctl.rig.viewQuad(viewW, viewH);
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 1.2 * this.dpr;
    c.beginPath();
    q.forEach(([x, y], i) => (i ? c.lineTo(x * sx, y * sy) : c.moveTo(x * sx, y * sy)));
    c.closePath(); c.stroke();
  }
}
