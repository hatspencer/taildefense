import type { CameraRig } from './camera';
import { type Controller, KEYS } from './controller';
import type { Hud } from './hud/hud';

// Edge-pan band in CSS pixels; wide enough for fractional display scaling, where the last
// device pixel can land a pixel or more inside the reported edge.
const EDGE = 12;
// Full screen however it came about: the Fullscreen API (F11 in the page), or a browser
// started full screen or as a kiosk, which td does and which the API knows nothing of.
function fullScreen(): boolean {
  if (document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches) return true;
  return window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2;
}

// Pan speed in tiles per second per tile of camera distance.
const PAN_SPEED = 1.2;

// Keyboard and mouse. Left and right clicks go to the controller; the camera library owns the
// middle button and the wheel (see camera.ts).
export class Input {
  private keys = new Set<string>();
  private lastSpace = 0;
  private spaceAt = 0; // when Space went down, 0 while it is up
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
      if (e.button === 0) ctl.leftClick(e.altKey);
      else if (e.button === 2) ctl.rightClick();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Edge panning tracks the pointer on the window in the capture phase, so nothing over the
    // HUD can swallow it. Leaving the page at an edge in full screen keeps that edge: with
    // fractional scaling the browser reports the last pixel row or column as outside the page
    // and fires a leave while the pointer sits pinned there, and no move follows to restore it.
    const track = (e: PointerEvent | MouseEvent) => { this.ex = e.clientX; this.ey = e.clientY; this.inWin = true; this.moved = true; };
    window.addEventListener('pointermove', track, { capture: true, passive: true });
    window.addEventListener('pointerdown', track, { capture: true, passive: true });
    document.addEventListener('mouseleave', (e) => {
      ctl.mouseIn = false;
      const w = window.innerWidth, h = window.innerHeight;
      const x = Number.isFinite(e.clientX) ? e.clientX : this.ex, y = Number.isFinite(e.clientY) ? e.clientY : this.ey;
      const atEdge = x <= EDGE || y <= EDGE || x >= w - EDGE || y >= h - EDGE;
      if (fullScreen() && atEdge) { this.ex = x; this.ey = y; return; }
      this.inWin = false;
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.spaceUp(false); });
    window.addEventListener('keydown', (e) => this.down(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      if (e.key === ' ') this.spaceUp(true);
      ctl.shift = e.shiftKey;
      if (e.key === 'Tab') this.hud.showScore(false);
    });
  }

  private spaceUp(tap: boolean): void {
    if (!this.spaceAt) return;
    const held = performance.now() - this.spaceAt;
    this.spaceAt = 0;
    this.ctl.send({ op: 'sprint', on: false });
    if (!tap || held > 250) return;
    const now = performance.now();
    if (now - this.lastSpace < 400) { this.rig.locked = !this.rig.locked; this.hud.flash(this.rig.locked ? 'camera locked to hero' : 'camera unlocked'); }
    this.lastSpace = now;
    this.rig.follow = true;
    const me = this.ctl.me();
    if (me) this.rig.center(me.x, me.y, true);
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
    // Space: held, sprint; tapped, back to the hero (twice quickly locks the camera to it).
    if (k === ' ') {
      e.preventDefault();
      if (!e.repeat && !this.spaceAt) { this.spaceAt = performance.now(); ctl.send({ op: 'sprint', on: true }); }
      return;
    }
    if (e.repeat) return;

    // The build card takes its own hotkeys first.
    if (hud.buildCard) {
      const wd = ctl.game.welcome;
      const kind = wd?.buildable.find((b) => wd.structs[b]?.key.toUpperCase() === up);
      if (kind !== undefined) { ctl.startBuild(kind); return; }
    }
    const slot = KEYS.indexOf(up);
    if (slot >= 0) { ctl.startAbility(slot); return; }
    if (k >= '1' && k <= '7') { const w = Number(k) - 1; const me = ctl.me(); if (me && me.owned & (1 << w)) ctl.send({ op: 'select', w }); return; }
    switch (up) {
      case 'A': ctl.setMode({ k: 'amove' }); return;
      case 'Z': ctl.setMode({ k: ctl.mode.k === 'ping' ? 'none' : 'ping' }); return;
      case 'S': ctl.cancel(); ctl.send({ op: 'stop' }); return;
      case 'H': ctl.cancel(); ctl.send({ op: 'hold' }); return;
      case 'T': e.preventDefault(); hud.openChat(); return;
      case 'R': ctl.send({ op: 'reload' }); return;
      case 'B': hud.buildCard = !hud.buildCard; if (!hud.buildCard) ctl.cancel(); return;
      case 'G': ctl.openArmory(!ctl.armoryOpen); return;
      case 'N': ctl.toggleReady(); return;
      case 'P': ctl.send({ op: 'pause' }); return;
      case 'M': hud.minimap.toggle(); return;
      case 'U': ctl.upgradeSel(); return;
      case 'X': ctl.sellSel(); return;
      case 'F': ctl.repairSel(); return;
      case 'V': ctl.taunt(); return;
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
    // Clamped into the page, since leave and fractional coordinates can land past the edge.
    if (this.moved && this.inWin && document.hasFocus()) {
      const x = Math.min(Math.max(this.ex, 0), w - 1), y = Math.min(Math.max(this.ey, 0), h - 1);
      if (x <= EDGE) dx -= 1; else if (x >= w - 1 - EDGE) dx += 1;
      if (y <= EDGE) dy += 1; else if (y >= h - 1 - EDGE) dy -= 1;
    }
    if (dx || dy) {
      const s = PAN_SPEED * this.rig.dist * dt;
      this.rig.pan(dx * s, dy * s);
    }
  }
}
