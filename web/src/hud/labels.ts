import * as THREE from 'three/webgpu';
import { EffectKind, PF_ALIVE } from '../protocol';
import type { Game } from '../state';
import { cssHex, playerColor } from '../scene/util';

export interface LabelFocus { hoverStruct: number; selStruct: number; hoverCreep: number; selCreep: number; showAllBars: boolean }

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
    this.v.x = (this.v.x + 1) / 2 * this.w; this.v.y = (1 - this.v.y) / 2 * this.h;
    return true;
  }

  private bar(x: number, y: number, w: number, frac: number, hex = -1): void {
    const c = this.ctx;
    const h = 5;
    c.fillStyle = 'rgba(0,0,0,0.75)';
    c.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
    c.fillStyle = hex >= 0 ? cssHex(hex) : frac > 0.5 ? '#45d35a' : frac > 0.25 ? '#e8c040' : '#e8452f';
    c.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, frac)), h);
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
      this.bar(this.v.x, this.v.y, Math.max(24, r * 40) * zoom, f.cHp[i] / 255, focused ? -1 : 0xd04040);
    }

    // Heroes: name and HP; the dead show where they fell and when they return.
    c.font = `600 ${Math.round(12 * Math.max(0.85, zoom))}px system-ui, sans-serif`;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const alive = (p.flags & PF_ALIVE) !== 0;
      const col = cssHex(playerColor(p.id));
      if (!this.project(cam, game.prx[p.id], alive ? 2.25 : 0.5, game.pry[p.id])) continue;
      const x = this.v.x, y = this.v.y;
      c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.8)';
      if (alive) {
        c.strokeText(p.name, x, y - 2); c.fillStyle = col; c.fillText(p.name, x, y - 2);
        this.bar(x, y + 1, 46 * zoom, p.hp / Math.max(1, p.maxHp));
      } else {
        const s = `✝ ${p.name} · ${p.respawn}s`;
        c.globalAlpha = 0.85;
        c.strokeText(s, x, y); c.fillStyle = col; c.fillText(s, x, y);
        c.globalAlpha = 1;
      }
    }

    // Airstrike countdowns.
    c.font = '700 16px system-ui, sans-serif';
    const since = (now - game.frameAt) / 1000;
    for (let i = 0; i < f.nEffects; i++) {
      if (f.eKind[i] !== EffectKind.AirTarget) continue;
      if (!this.project(cam, f.eX[i], 0.3, f.eY[i])) continue;
      const s = Math.max(0, f.eLeft[i] / 10 - since).toFixed(1);
      c.lineWidth = 3; c.strokeStyle = '#000'; c.strokeText(s, this.v.x, this.v.y);
      c.fillStyle = '#ff6a50'; c.fillText(s, this.v.x, this.v.y);
    }
  }
}
