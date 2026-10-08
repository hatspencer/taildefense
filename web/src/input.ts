import type { CameraRig } from './camera';
import type { Controller } from './controller';
import type { Hud } from './hud/hud';

const EDGE = 8;
// Pan speed in tiles per second per tile of camera distance.
const PAN_SPEED = 1.2;

// Keyboard and mouse. Left and right clicks go to the controller; the camera library owns the
// middle button and the wheel (see camera.ts).
export class Input {
  private keys = new Set<string>();
  private lastSpace = 0;
  private moved = false;
  // The pointer anywhere in the window (the HUD covers the screen edges), for edge panning.
  private ex = -1; private ey = -1; private inWin = false;
  onRetroToggle: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, private ctl: Controller, private rig: CameraRig, private hud: Hud) {
    canvas.addEventListener('pointermove', (e) => { ctl.mx = e.clientX; ctl.my = e.clientY; ctl.mouseIn = true; this.moved = true; });
    canvas.addEventListener('pointerleave', () => { ctl.mouseIn = false; });
    canvas.addEventListener('pointerdown', (e) => {
      ctl.mx = e.clientX; ctl.my = e.clientY; ctl.mouseIn = true; ctl.shift = e.shiftKey;
      this.hud.closeTransient();
      if (e.button === 0) ctl.leftClick();
      else if (e.button === 2) ctl.rightClick();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => { this.ex = e.clientX; this.ey = e.clientY; this.inWin = true; this.moved = true; });
    document.addEventListener('mouseleave', () => { ctl.mouseIn = false; this.inWin = false; });
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('keydown', (e) => this.down(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      ctl.shift = e.shiftKey;
      if (e.key === 'Tab') this.hud.showScore(false);
    });
  }

  private down(e: KeyboardEvent): void {
    const ctl = this.ctl, hud = this.hud;
    ctl.shift = e.shiftKey;
    if (hud.chatOpen()) return; // the chat input handles its own keys
    const k = e.key;
    const up = k.length === 1 ? k.toUpperCase() : k;
    if (k === 'Tab') { e.preventDefault(); hud.showScore(true); return; }
    if (k === 'F1' || k === '?') { e.preventDefault(); hud.toggleHelp(); return; }
    if (k === 'F3') { e.preventDefault(); hud.toggleStats(); return; }
    if (k === 'F4') { e.preventDefault(); this.onRetroToggle(); return; }
    if (k === 'F10') { e.preventDefault(); hud.toggleMenu(); return; }
    if (k === 'Escape') {
      if (ctl.cancel()) { hud.buildCard = false; return; }
      if (hud.buildCard) { hud.buildCard = false; return; }
      if (hud.closeWindows()) return;
      if (ctl.sel) { ctl.sel = null; return; }
      hud.toggleMenu();
      return;
    }
    if (k === 'Enter') { e.preventDefault(); hud.openChat(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k.startsWith('Arrow')) { e.preventDefault(); this.keys.add(k); return; }
    if (k === ' ') {
      e.preventDefault();
      const now = performance.now();
      if (now - this.lastSpace < 300) { this.rig.locked = !this.rig.locked; hud.flash(this.rig.locked ? 'camera locked to hero' : 'camera unlocked'); }
      this.lastSpace = now;
      this.rig.follow = true;
      const me = ctl.me();
      if (me) this.rig.center(me.x, me.y, true);
      return;
    }
    if (e.repeat) return;

    // The build card takes its own hotkeys first.
    if (hud.buildCard) {
      const wd = ctl.game.welcome;
      const kind = wd?.buildable.find((b) => wd.structs[b]?.key.toUpperCase() === up);
      if (kind !== undefined) { ctl.startBuild(kind); return; }
    }
    const slot = ['Q', 'W', 'E', 'R'].indexOf(up);
    if (slot >= 0) { ctl.startAbility(slot); return; }
    if (k >= '1' && k <= '7') { const w = Number(k) - 1; const me = ctl.me(); if (me && me.owned & (1 << w)) ctl.send({ op: 'select', w }); return; }
    switch (up) {
      case 'A': ctl.setMode({ k: 'amove' }); return;
      case 'S': ctl.cancel(); ctl.send({ op: 'stop' }); return;
      case 'H': ctl.cancel(); ctl.send({ op: 'hold' }); return;
      case 'T': ctl.send({ op: 'reload' }); return;
      case 'B': hud.buildCard = !hud.buildCard; if (!hud.buildCard) ctl.cancel(); return;
      case 'G': ctl.openArmory(!ctl.armoryOpen); return;
      case 'N': ctl.toggleReady(); return;
      case 'U': ctl.upgradeSel(); return;
      case 'X': ctl.sellSel(); return;
      case 'F': ctl.repairSel(); return;
    }
  }

  // Per frame: arrow keys and screen-edge panning.
  update(dt: number, w: number, h: number): void {
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy += 1;
    if (this.keys.has('ArrowDown')) dy -= 1;
    // Edge pan only once the mouse has really moved over the page (headless runs sit at 0,0).
    if (this.moved && this.inWin && document.hasFocus()) {
      if (this.ex <= EDGE) dx -= 1; else if (this.ex >= w - EDGE) dx += 1;
      if (this.ey <= EDGE) dy += 1; else if (this.ey >= h - EDGE) dy -= 1;
    }
    if (dx || dy) {
      const s = PAN_SPEED * this.rig.dist * dt;
      this.rig.pan(dx * s, dy * s);
    }
  }
}
