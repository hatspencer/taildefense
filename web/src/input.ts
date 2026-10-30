import type { CameraRig } from './camera';
import { type Controller, KEYS } from './controller';
import type { Hud } from './hud/hud';
import { CROWBAR, GREAT, KATANA, K_ARMORY, PF_ALIVE, sellValue } from './protocol';

// Edge-pan band in CSS pixels; wide enough for fractional display scaling, where the last
// device pixel can land a pixel or more inside the reported edge.
const EDGE = 12;
// How long G is held to drop the weapon in hand, in ms.
export const DROP_HOLD = 1000;
// Full screen however it came about: the Fullscreen API (F11 in the page), or a browser
// started full screen or as a kiosk, which td does and which the API knows nothing of.
function fullScreen(): boolean {
  if (document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches) return true;
  return window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2;
}

// Pan speed in tiles per second per tile of camera distance.
const PAN_SPEED = 1.2;

// WASD by physical key, so it sits under the left hand on any layout: screen right and up.
const STEER: Record<string, [number, number]> = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
// How often a held direction is sent again; the host drops a steer it stops hearing about.
const STEER_EVERY = 120;
// Milliseconds within which a second Delete sells what the first one asked about.
const SELL_CONFIRM = 1500;

// Keyboard and mouse. Left and right clicks go to the controller; the camera library owns the
// middle button and the wheel (see camera.ts).
// The key as an upper-case letter or its name. On a layout that types non-Latin letters the
// physical key stands in, so the hotkeys work as printed on any layout (WASD does by code too).
function letter(e: KeyboardEvent): string {
  const k = e.key;
  if (k.length === 1 && !/^[a-z]$/i.test(k) && /^[A-Z]$/.test(e.code.slice(3)) && e.code.startsWith('Key')) return e.code.slice(3);
  return k.length === 1 ? k.toUpperCase() : k;
}

export class Input {
  private keys = new Set<string>();
  private steer = new Set<string>(); // WASD held, by code
  private steerAng = NaN; // the direction last sent, NaN when not steering
  private steerAt = 0;
  private lastSpace = 0;
  private spaceAt = 0; // when Space went down, 0 while it is up
  private moved = false;
  // The pointer anywhere in the window (the HUD covers the screen edges), for edge panning.
  private ex = -1; private ey = -1; private inWin = false;
  onRetroToggle: () => void = () => {};
  private dropTimer = 0; // G held: drops the weapon in hand when it fires
  private shiftTap = false; // Shift down while placing or pinging, with no click since

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
    window.addEventListener('pointerdown', (e) => { track(e); this.shiftTap = false; }, { capture: true, passive: true });
    document.addEventListener('mouseleave', (e) => {
      ctl.mouseIn = false;
      const w = window.innerWidth, h = window.innerHeight;
      const x = Number.isFinite(e.clientX) ? e.clientX : this.ex, y = Number.isFinite(e.clientY) ? e.clientY : this.ey;
      const atEdge = x <= EDGE || y <= EDGE || x >= w - EDGE || y >= h - EDGE;
      if (fullScreen() && atEdge) { this.ex = x; this.ey = y; return; }
      this.inWin = false;
    });
    window.addEventListener('blur', () => { this.shiftTap = false; this.keys.clear(); this.steer.clear(); this.spaceUp(false); this.holdCore(false); this.holdDrop(false); });
    window.addEventListener('keydown', (e) => this.down(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      if (this.steer.delete(e.code)) this.steerKeys();
      if (e.key === ' ') this.spaceUp(true);
      ctl.shift = e.shiftKey;
      if (e.key === 'Shift' && this.shiftTap) {
        this.shiftTap = false;
        if (ctl.mode.k === 'build' || ctl.mode.k === 'ping') ctl.cast(1);
      }
      if (e.key === 'Tab') this.hud.showScore(false);
      const up = letter(e);
      if (up === 'N') this.holdCore(false);
      if (up === 'G') this.holdDrop(false);
    });
  }

  // T: the next turret, in the order they stand in the base's list, selected (so its upgrade
  // and sell card shows) with the view on it.
  private nextTurret(): void {
    const ctl = this.ctl, g = ctl.game, f = g.cur, wd = g.welcome;
    if (!wd) return;
    const list: number[] = [];
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && wd.structs[f.sKind[i]]?.turret) list.push(i);
    if (!list.length) { this.hud.flash('no turrets standing'); return; }
    const n = (list.indexOf(ctl.selectedStruct()) + 1) % list.length, id = list[n];
    ctl.sel = { t: 'struct', id };
    this.rig.locked = false; this.rig.follow = false;
    this.rig.center(f.sX[id] + f.sW[id] / 2, f.sY[id] + f.sH[id] / 2, true);
    this.hud.flash(`turret ${n + 1} of ${list.length}`);
  }

  // H: every ghost rebuilt and every damaged structure mended, after a press that names the
  // price; a second within SELL_CONFIRM ms pays it.
  private fixArm = 0;
  private fixAll(): void {
    const ctl = this.ctl, now = performance.now();
    if (now - this.fixArm < SELL_CONFIRM) { this.fixArm = 0; ctl.fixAll(); return; }
    const c = ctl.fixCost();
    if (!c.ghosts && !c.damaged) { ctl.fixAll(); return; }
    this.fixArm = now;
    const what = [c.ghosts ? `rebuild ${c.ghosts}` : '', c.damaged ? `repair ${c.damaged}` : ''].filter(Boolean).join(' and ');
    this.hud.flash(`H again to ${what} for ${c.gold}g`);
  }

  // Delete: the first press asks, a second within SELL_CONFIRM ms sells the selected structure.
  // Selling is not on a letter, where a wall meant for the build card's X could sell one.
  private sellArm = { s: -1, at: 0 };
  private sell(): void {
    const ctl = this.ctl, s = ctl.selectedStruct(), now = performance.now();
    if (s < 0) return;
    if (this.sellArm.s === s && now - this.sellArm.at < SELL_CONFIRM) { this.sellArm.s = -1; ctl.sellSel(); return; }
    const f = ctl.game.cur, wd = ctl.game.welcome, d = wd?.structs[f.sKind[s]];
    if (!d || f.sKind[s] <= K_ARMORY) return;
    this.sellArm = { s, at: now };
    this.hud.flash(`Delete again to sell the ${d.name.toLowerCase()} for ${sellValue(d, f, s, wd!.sellFraction)}g`);
  }

  // N, held: the view on the generator; let go, back to how it was. Tapped twice, the hero walks there.
  private lastN = 0;
  private lastE = 0;
  private coreHeld: { follow: boolean; locked: boolean } | null = null;
  private holdCore(on: boolean): void {
    const rig = this.rig, wd = this.ctl.game.welcome;
    if (on) {
      if (this.coreHeld || !wd) return;
      this.coreHeld = { follow: rig.follow, locked: rig.locked };
      rig.follow = false; rig.locked = false;
      rig.center(wd.core.x, wd.core.y, true);
      return;
    }
    if (!this.coreHeld) return;
    rig.follow = this.coreHeld.follow; rig.locked = this.coreHeld.locked;
    this.coreHeld = null;
    const me = this.ctl.me();
    if (rig.follow && me) rig.center(me.x, me.y, true);
  }

  // G, held for DROP_HOLD ms: the weapon in hand goes on the ground for a teammate. Let go
  // sooner and nothing happens; the controller's dropAt drives the ring over the hero.
  private holdDrop(on: boolean): void {
    const ctl = this.ctl;
    clearTimeout(this.dropTimer);
    this.dropTimer = 0;
    ctl.dropAt = 0;
    if (!on) return;
    const me = ctl.me();
    if (!me || !(me.flags & PF_ALIVE)) return;
    const no = ctl.dropRefusal();
    if (no) { ctl.onToast(no, 2); return; }
    ctl.dropAt = performance.now();
    this.dropTimer = window.setTimeout(() => { this.dropTimer = 0; ctl.dropAt = 0; ctl.dropWeapon(); }, DROP_HOLD);
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
    if (hud.navKey(e)) return; // an open window's arrows, Tab and Enter
    const k = e.key;
    const up = letter(e);
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
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (!e.repeat) this.sell(); return; }
    if (k === 'Enter') { e.preventDefault(); this.steer.clear(); hud.openChat(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k.startsWith('Arrow')) { e.preventDefault(); this.keys.add(k); return; }
    // Sent at once rather than on the next animation frame, which can be a whole frame late
    // (or much later on a throttled page); steerKeys only sends when the angle changed.
    if (STEER[e.code]) { e.preventDefault(); this.steer.add(e.code); this.steerKeys(); return; }
    // Shift is the grenade. While placing or pinging, Shift held through a click keeps the
    // mode, so there the grenade waits for the key to come up with no click in between.
    if (k === 'Shift') {
      if (e.repeat) return;
      if (ctl.mode.k === 'build' || ctl.mode.k === 'ping') this.shiftTap = true;
      else ctl.cast(1);
      return;
    }
    // Space: held, sprint; tapped, back to the hero (twice quickly locks the camera to it).
    if (k === ' ') {
      e.preventDefault();
      if (!e.repeat && !this.spaceAt) { this.spaceAt = performance.now(); ctl.send({ op: 'sprint', on: true }); }
      return;
    }
    if (e.repeat) return;

    // While the build bar is open the top row picks what to place (1 wall to 8 missile
    // battery, then 9 0 - = the traps); otherwise the numbers are the medkit and the weapons.
    if (hud.buildCard) {
      const wd = ctl.game.welcome;
      const kind = wd?.buildable.find((b) => wd.structs[b]?.key.toUpperCase() === up);
      if (kind !== undefined) { ctl.startBuild(kind); return; }
    }
    const slot = KEYS.indexOf(up);
    if (slot >= 0) { ctl.cast(slot); return; }
    if (k === '1') { ctl.medkit(); return; }
    // 2 to 7 the pistol to the launcher, 0 the crowbar, 8 and 9 the legendaries.
    if (k >= '0' && k <= '9' && k !== '1') { const w = k === '0' ? CROWBAR : k === '8' ? KATANA : k === '9' ? GREAT : Number(k) - 2; const me = ctl.me(); if (me && me.owned & (1 << w)) ctl.send({ op: 'select', w }); return; }
    switch (up) {
      case 'Z': ctl.setMode({ k: ctl.mode.k === 'ping' ? 'none' : 'ping' }); return;
      case 'H': this.fixAll(); return;
      case 'T': this.nextTurret(); return;
      case 'R': ctl.reload(); return;
      case 'B': hud.buildCard = !hud.buildCard; if (!hud.buildCard) ctl.cancel(); return;
      case 'C': ctl.openArmory(!ctl.armoryOpen); return;
      case 'G': this.holdDrop(true); return;
      case 'N': {
        // Twice quickly: the hero walks back to the generator.
        const now = performance.now();
        if (now - this.lastN < 400 && ctl.walkToCore()) { hud.flash('back to the generator'); this.lastN = 0; } else this.lastN = now;
        this.holdCore(true);
        return;
      }
      case 'Y': ctl.toggleReady(); return;
      case 'P': ctl.send({ op: 'pause' }); return;
      case 'M': hud.minimap.toggle(); return;
      case 'U': ctl.upgradeSel(); return;
      case 'E': {
        if (ctl.board()) { hud.flash('get to the choppa!'); return; }
        // Twice quickly: the hero heads for the nearest loot site, and stays on it while E is spammed.
        const now = performance.now();
        if (now - this.lastE < 400) {
          this.lastE = now;
          if (ctl.seekLoot()) hud.flash('off to the nearest loot site'); else ctl.onToast('no loot site in sight', 1);
          return;
        }
        this.lastE = now;
        ctl.interact();
        return;
      }
      case 'J': ctl.taunt(); return;
    }
  }

  // Per frame: WASD walking, arrow keys and screen-edge panning.
  update(dt: number, w: number, h: number): void {
    if (this.steerKeys()) return;
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

  // Walks the hero the way WASD points on screen, turned onto the map by the camera's yaw, and
  // keeps the camera on them meanwhile. True while walking, which holds off panning.
  private steerKeys(): boolean {
    let dx = 0, dy = 0;
    for (const c of this.steer) { dx += STEER[c][0]; dy += STEER[c][1]; }
    if (!dx && !dy) {
      if (!Number.isNaN(this.steerAng)) { this.steerAng = NaN; this.ctl.send({ op: 'steer', x: 0, on: false }); }
      return false;
    }
    const s = Math.sin(this.rig.yaw), c = Math.cos(this.rig.yaw);
    const ang = Math.atan2(-dx * s - dy * c, dx * c - dy * s);
    const now = performance.now();
    if (ang !== this.steerAng || now - this.steerAt > STEER_EVERY) {
      this.steerAng = ang; this.steerAt = now;
      this.ctl.send({ op: 'steer', x: ang, on: true });
    }
    this.rig.follow = true;
    return true;
  }
}
