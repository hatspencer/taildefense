import * as THREE from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { EffectKind, EvacStage, TRACER_HELI } from '../protocol';
import type { Game } from '../state';
import type { Effects } from './effects';
import { litMaterial } from './structs';
import { box, cyl, merge, part, type Part, sphere } from './util';

// Supply drops: the Huey gunship that flies the crate in, with the surfboards strapped to its
// side (a nod to Kilgore in Apocalypse Now), the crate coming down under a chute, and the crates
// waiting on the ground with green smoke over them. And at the end of the last wave the same Huey
// coming in to the helipad to get the survivors out. Its door gunner works a minigun, its
// barrels spinning up whenever it fires.

const OD = 0x4b5631, OD_DARK = 0x363e22, GLASS = 0x34505a, BLACK = 0x1c1c1a, STEEL = 0x55574f;
const CRUISE = 10, HOVER = 6.5; // flying height in, and over the drop zone
const HOVER_TIME = 3; // the host's dropHover: seconds over the zone before the crate is down
const RELEASE = 1.6; // seconds before landing that the crate is let go under its chute
const DEPART = 7; // seconds the Huey takes to fly off after the crate is down
const SCALE = 0.75; // a touch under life size, so it does not swallow the screen
const OUTRO = 3.5; // seconds the evac Huey flies on, climbing away, once the host has it gone

interface Flight {
  root: THREE.Group; body: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; crate: THREE.Group; chute: THREE.Object3D;
  gun: THREE.Object3D; spin: number; // the minigun's barrels, and how fast they turn
  x0: number; y0: number; x: number; y: number;
  heading: number; seen: number; landedAt: number; // landedAt: seconds, 0 while still in flight
}

// A surfboard on its edge along x: a long rounded plank with a stripe down it.
function board(color: number, stripe: number, x: number, y: number, z: number): Part[] {
  const p = (w: number, d: number, dx: number, c = color) => part(box(w, 0.07, d), c, x + dx, y, z, Math.PI / 2, 0, 0);
  return [p(1.7, 0.5, 0), p(0.45, 0.38, 1.05), p(0.3, 0.24, 1.4), p(0.12, 0.1, 1.58), p(0.35, 0.4, -1.0), p(0.12, 0.3, -1.22),
    part(box(2.6, 0.075, 0.07), stripe, x + 0.1, y, z, Math.PI / 2, 0, 0)];
}

function hueyBody(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  // Cabin, nose and the sloped windscreen with the chin bubbles under it.
  add(3.4, 1.7, 1.9, OD, 0, 1.25);
  add(1.2, 1.35, 1.75, OD, 2.25, 1.1);
  add(0.7, 0.75, 1.5, OD, 3.0, 0.75);
  add(0.9, 0.75, 1.78, GLASS, 2.45, 1.55, 0, 0, 0, -0.55);
  add(0.5, 0.4, 0.5, GLASS, 3.1, 0.65, 0.42); add(0.5, 0.4, 0.5, GLASS, 3.1, 0.65, -0.42);
  // Open cargo doors, dark inside.
  add(1.5, 1.15, 0.05, 0x141510, -0.1, 1.2, 0.96); add(1.5, 1.15, 0.05, 0x141510, -0.1, 1.2, -0.96);
  // The hump over the cabin: transmission, engine and exhaust.
  add(2.1, 0.6, 1.15, OD_DARK, -0.4, 2.4);
  add(0.45, 0.4, 0.55, BLACK, -1.55, 2.4);
  p.push(part(cyl(0.08, 0.1, 0.55), STEEL, 0.1, 2.9, 0));
  // Tail boom, fin, stabiliser.
  add(2.2, 0.62, 0.55, OD, -2.6, 1.75);
  add(2.8, 0.42, 0.36, OD, -4.9, 1.8);
  add(1.0, 1.5, 0.12, OD_DARK, -6.2, 2.45, 0, 0, 0, 0.4);
  add(0.55, 0.08, 1.7, OD_DARK, -5.2, 1.75);
  add(0.25, 0.25, 0.2, STEEL, -6.4, 2.9, 0.12);
  // Skids and struts.
  for (const z of [0.95, -0.95]) {
    add(4.2, 0.1, 0.12, STEEL, 0.15, 0.05, z);
    add(0.45, 0.1, 0.12, STEEL, 2.4, 0.16, z, 0, 0, 0.55);
    add(0.1, 0.75, 0.1, STEEL, 1.1, 0.42, z * 0.88, z > 0 ? 0.25 : -0.25);
    add(0.1, 0.75, 0.1, STEEL, -0.9, 0.42, z * 0.88, z > 0 ? 0.25 : -0.25);
  }
  // The door gunner on the right, helmet on, behind the minigun on its pintle mount: the
  // post, the receiver and its motor, the ammo can and the feed chute up into it. The barrels
  // are their own mesh (minigunGeo), to spin.
  add(0.45, 0.65, 0.4, 0x5a5f3a, 0.1, 1.2, 0.62);
  p.push(part(sphere(0.2), 0x3d4426, 0.1, 1.7, 0.62));
  add(0.08, 0.5, 0.08, STEEL, 0.25, 1.05, 0.98);
  add(0.22, 0.24, 0.34, BLACK, 0.25, 1.4, 0.92);
  p.push(part(cyl(0.08, 0.08, 0.18, 8), STEEL, 0.25, 1.4, 0.72, Math.PI / 2, 0, 0));
  add(0.3, 0.26, 0.24, OD_DARK, 0.3, 0.95, 0.7);
  add(0.06, 0.4, 0.1, 0x8a7a3a, 0.2, 1.2, 0.84, 0.3, 0, 0);
  // Two surfboards strapped along the left skid struts, Kilgore style.
  p.push(...board(0xf1ece0, 0xc8402a, 0.2, 0.95, -1.13));
  p.push(...board(0xf2c64a, 0x2d6fb0, 0.05, 1.05, -1.24));
  for (const x of [-0.55, 0.75]) add(0.08, 0.75, 0.32, BLACK, x, 1.0, -1.18);
  return merge(p);
}

// The minigun's six barrels round its axis, along +z, with the clamp at the muzzle end.
function minigunGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.push(part(cyl(0.03, 0.03, 1.15, 6), BLACK, Math.cos(a) * 0.07, Math.sin(a) * 0.07, 0.575, Math.PI / 2, 0, 0));
  }
  p.push(part(cyl(0.11, 0.11, 0.08, 8), STEEL, 0, 0, 0.9, Math.PI / 2, 0, 0));
  p.push(part(cyl(0.11, 0.11, 0.1, 8), STEEL, 0, 0, 0.1, Math.PI / 2, 0, 0));
  return merge(p);
}

function crateGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0) => p.push(part(box(w, h, d), c, x, y, z));
  add(0.9, 0.7, 0.9, 0x5d6234, 0, 0.35);
  for (const x of [-0.42, 0.42]) for (const z of [-0.42, 0.42]) add(0.1, 0.72, 0.1, 0x3e4222, x, 0.35, z);
  add(0.92, 0.1, 0.92, 0x3e4222, 0, 0.71);
  add(0.4, 0.2, 0.02, 0xe8e2c8, 0, 0.42, 0.46); // the stencilled panel
  add(0.96, 0.06, 0.12, 0xc8a24a, 0, 0.5); // a strap round it
  return merge(p);
}

function chuteGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  // A canopy of alternating panels, and the lines down to the crate.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    p.push(part(box(0.9, 0.12, 0.7), i % 2 ? 0xe9e2cc : 0x6b7a45, Math.cos(a) * 0.75, 2.6 - 0.12, Math.sin(a) * 0.75, 0, -a, 0.35));
  }
  p.push(part(box(0.9, 0.15, 0.9), 0xe9e2cc, 0, 2.75, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    p.push(part(box(0.03, 2.1, 0.03), 0x2a2a24, Math.cos(a) * 0.55, 1.65, Math.sin(a) * 0.55, Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4));
  }
  return merge(p);
}

// A flat rounded square, 2*half across with corners of radius r, h thick, standing on y = 0.
function roundSlab(half: number, r: number, h: number): THREE.BufferGeometry {
  const sh = new THREE.Shape(), a = half - r;
  sh.moveTo(-a, -half); sh.lineTo(a, -half); sh.absarc(a, -a, r, -Math.PI / 2, 0, false);
  sh.lineTo(half, a); sh.absarc(a, a, r, 0, Math.PI / 2, false);
  sh.lineTo(-a, half); sh.absarc(-a, a, r, Math.PI / 2, Math.PI, false);
  sh.lineTo(-half, -a); sh.absarc(-a, -a, r, Math.PI, Math.PI * 1.5, false);
  return new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: 6 }).rotateX(-Math.PI / 2);
}

// The helipad: a concrete slab half tiles out from its middle each way with rounded corners and
// a white edge line, a yellow ring and the H.
function padGeo(half: number): THREE.BufferGeometry {
  const p: Part[] = [part(roundSlab(half, 1.1, 0.06), 0x6e6d68), part(roundSlab(half - 0.2, 0.95, 0.07), 0xd8d4c6),
    part(roundSlab(half - 0.38, 0.8, 0.075), 0x7d7c76)];
  const r = half * 0.72, n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    p.push(part(box(0.26, 0.02, 2 * Math.PI * r / n + 0.02), 0xd8b23a, Math.cos(a) * r, 0.085, Math.sin(a) * r, 0, -a, 0));
  }
  const s = half / 2;
  p.push(part(box(0.24 * s, 0.02, 1.5 * s), 0xeeeae0, -0.5 * s, 0.09, 0), part(box(0.24 * s, 0.02, 1.5 * s), 0xeeeae0, 0.5 * s, 0.09, 0),
    part(box(1 * s, 0.02, 0.22 * s), 0xeeeae0, 0, 0.09, 0));
  return merge(p);
}

export class Helis {
  group = new THREE.Group();
  private mat = litMaterial();
  private bodyGeo = hueyBody();
  private rotorGeo = merge([part(box(10, 0.05, 0.36), 0x262624, 0, 0, 0), part(box(0.5, 0.15, 0.5), STEEL, 0, 0, 0)]);
  private tailGeo = merge([part(box(0.1, 1.5, 0.16), 0x262624, 0, 0, 0)]);
  private crateG = crateGeo();
  private gunG = minigunGeo();
  private chuteG = chuteGeo();
  private blurMat = new THREE.MeshBasicNodeMaterial({ color: 0x1a1a18, transparent: true, opacity: 0.07, depthWrite: false });
  private blurGeo = new THREE.CircleGeometry(5, 24).rotateX(-Math.PI / 2);
  private flights = new Map<string, Flight>();
  private grounded: THREE.Group[] = [];
  private serial = 0;
  private lastPuff = 0;
  // The evac Huey, made when it first shows; its pose in the frame before and the current one,
  // to ease between them; and the helipad, made for the pad it is on.
  private evac: Flight | null = null;
  private evacFrame = 0;
  private ev0 = { x: 0, y: 0, alt: 0, yaw: 0 }; private ev1 = { x: 0, y: 0, alt: 0, yaw: 0 };
  private pad: THREE.Mesh | null = null;
  private padAt = '';
  // The evac Huey's speed and turn rate between the last two frames, carried on into the outro;
  // when the outro began (0 before), and whether it has played out.
  private evacSpeed = 0; private evacTurn = 0; private outroAt = 0; private outroDone = false;

  constructor(scene: THREE.Scene, private fx: Effects) {
    scene.add(this.group);
    this.blurMat.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) }); // the blur is no crease
  }

  private make(x0: number, y0: number, x: number, y: number): Flight {
    const root = new THREE.Group(), body = new THREE.Group();
    root.add(body);
    root.scale.setScalar(SCALE);
    const hull = new THREE.Mesh(this.bodyGeo, this.mat);
    hull.castShadow = true;
    body.add(hull);
    const rotor = new THREE.Group();
    rotor.position.set(0.1, 3.18, 0);
    const blades = new THREE.Mesh(this.rotorGeo, this.mat);
    blades.castShadow = true;
    rotor.add(blades, new THREE.Mesh(this.blurGeo, this.blurMat));
    body.add(rotor);
    const tail = new THREE.Mesh(this.tailGeo, this.mat);
    tail.position.set(-6.4, 2.9, 0.26);
    body.add(tail);
    const gun = new THREE.Mesh(this.gunG, this.mat);
    gun.position.set(0.25, 1.4, 1.09);
    body.add(gun);
    const crate = new THREE.Group();
    const cm = new THREE.Mesh(this.crateG, this.mat);
    cm.castShadow = true;
    const chute = new THREE.Mesh(this.chuteG, this.mat);
    chute.visible = false;
    crate.add(cm, chute);
    this.group.add(root, crate);
    return { root, body, rotor, tail, crate, chute, gun, spin: 0, x0, y0, x, y, heading: -Math.atan2(y - y0, x - x0), seen: 0, landedAt: 0 };
  }

  update(game: Game, now: number, dt: number): void {
    const f = game.cur, t = now / 1000, serial = ++this.serial;
    const sinceFrame = Math.min(0.1, (performance.now() - game.frameAt) / 1000);
    const puff = t - this.lastPuff > 0.12;
    if (puff) this.lastPuff = t;
    for (let i = 0; i < f.nEffects; i++) {
      if (f.eKind[i] !== EffectKind.Drop) continue;
      const x0 = f.eX0[i], y0 = f.eY0[i], x = f.eX[i], y = f.eY[i];
      const key = `${x0.toFixed(1)},${y0.toFixed(1)},${x.toFixed(1)},${y.toFixed(1)}`;
      let fl = this.flights.get(key);
      if (!fl) { fl = this.make(x0, y0, x, y); this.flights.set(key, fl); }
      fl.seen = serial;
      const left = Math.max(0, f.eLeft[i] / 10 - sinceFrame), total = Math.max(HOVER_TIME + 1, f.eTotal[i] / 10);
      const k0 = Math.min(1, Math.max(0, (total - left) / (total - HOVER_TIME)));
      const k = 1 - (1 - k0) * (1 - k0);
      const hx = x0 + (x - x0) * k, hy = y0 + (y - y0) * k;
      const alt = HOVER + (CRUISE - HOVER) * (1 - k) + Math.sin(t * 2.1) * 0.12;
      this.pose(fl, hx, alt, hy, (1 - k0) * 0.22, t);
      // The crate rides under the Huey, then comes down under its chute.
      if (left > RELEASE) {
        fl.crate.position.set(hx, alt - 1.3, hy);
        fl.chute.visible = false;
      } else {
        const s = left / RELEASE;
        fl.crate.position.set(x, 0.02 + (alt - 1.3) * s, y);
        fl.chute.visible = true;
        fl.chute.scale.setScalar(Math.min(1, (1 - s) * 3));
      }
      fl.crate.rotation.y = fl.heading;
      // Rotor wash kicks up dust as it comes down into the hover.
      this.fx.rotorWash(game, hx, hy, Math.max(0, (k0 - 0.55) / 0.45) ** 1.5, dt);
    }
    // Gone from the frame: the crate is down; the Huey climbs away along its heading.
    for (const [key, fl] of this.flights) {
      if (fl.seen === serial) continue;
      if (!fl.landedAt) { fl.landedAt = t; this.group.remove(fl.crate); }
      const s = t - fl.landedAt;
      if (s > DEPART) { this.group.remove(fl.root); this.flights.delete(key); continue; }
      const dx = Math.cos(-fl.heading), dz = Math.sin(-fl.heading);
      const d = s * s * 1.6;
      this.pose(fl, fl.x + dx * d, HOVER + s * s * 0.35, fl.y + dz * d, Math.min(0.3, s * 0.15), t);
      // The wash follows it off, thinning as it climbs and pulls away.
      this.fx.rotorWash(game, fl.x + dx * d, fl.y + dz * d, Math.max(0, 1 - s / 2.5), dt);
    }
    this.updateEvac(game, now, t, dt);
    // The minigun spins up while its rounds go out, and winds down after.
    let firing = false;
    for (let i = 0; i < f.nTracers && !firing; i++) firing = f.tKind[i] === TRACER_HELI;
    for (const fl of this.evac ? [...this.flights.values(), this.evac] : this.flights.values()) {
      fl.spin += ((firing ? 45 : 0) - fl.spin) * Math.min(1, dt * (firing ? 8 : 1.5));
      fl.gun.rotation.z += fl.spin * dt;
    }
    // Crates on the ground, with green marker smoke.
    while (this.grounded.length < f.crates.length) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.crateG, this.mat);
      m.castShadow = true;
      const ch = new THREE.Mesh(this.chuteG, this.mat);
      ch.rotation.z = 1.35; ch.position.set(1.4, -0.2, 0.3); ch.scale.set(0.9, 0.35, 0.9);
      g.add(m, ch);
      this.group.add(g);
      this.grounded.push(g);
    }
    for (let i = 0; i < this.grounded.length; i++) {
      const g = this.grounded[i], c = f.crates[i];
      g.visible = !!c;
      if (!c) continue;
      g.position.set(c.x, 0.02, c.y);
      g.rotation.y = i * 1.3;
      if (puff) this.fx.crateSmoke(c.x, c.y);
    }
  }

  // Where the evac Huey is drawn, on the map, or null while it is not; the camera rides along
  // until it is gone.
  evacAt(): { x: number; y: number } | null {
    return this.evac && !this.outroAt ? { x: this.evac.root.position.x, y: this.evac.root.position.z } : null;
  }

  // Whether the evac Huey is lifting off or still flying away: the field report waits for it.
  leaving(game: Game): boolean {
    const st = game.cur.evac;
    return st === EvacStage.Departing || (st === EvacStage.Gone && !!this.evac && !this.outroDone);
  }

  // The helipad, and the evac Huey over it: hidden until its last flight in, eased between
  // frames, its skids on the pad while it is down.
  private updateEvac(game: Game, now: number, t: number, dt: number): void {
    const f = game.cur, ev = game.welcome?.evac;
    const at = ev ? `${ev.pad.x},${ev.pad.y}` : '';
    if (at !== this.padAt) {
      if (this.pad) { this.group.remove(this.pad); this.pad.geometry.dispose(); this.pad = null; }
      if (ev) {
        this.pad = new THREE.Mesh(padGeo(ev.half), this.mat);
        this.pad.receiveShadow = true;
        this.pad.position.set(ev.pad.x, 0, ev.pad.y);
        this.group.add(this.pad);
      }
      this.padAt = at;
    }
    if (this.pad) this.pad.visible = game.padKnown();
    // Gone: on past the edge of the map, climbing away, until it is out of sight.
    if (f.evac === EvacStage.Gone && this.evac && !this.outroDone) { this.outro(t, dt); return; }
    const flying = f.evac === EvacStage.Landed || f.evac === EvacStage.Departing ||
      (f.evac === EvacStage.Inbound && !!ev && f.evacLeft <= ev.flight);
    if (!flying) {
      this.drop();
      // A game joined after the Huey left has no outro to wait for.
      this.outroDone = f.evac === EvacStage.Gone;
      return;
    }
    if (!this.evac) {
      this.evac = this.make(f.evacX, f.evacY, f.evacX, f.evacY);
      this.group.remove(this.evac.crate);
      this.evacFrame = 0; this.outroAt = 0; this.outroDone = false;
    }
    if (this.evacFrame !== game.frames) {
      const fresh = this.evacFrame === 0;
      this.evacFrame = game.frames;
      Object.assign(this.ev0, fresh ? { x: f.evacX, y: f.evacY, alt: f.evacAlt, yaw: f.evacYaw } : this.ev1);
      Object.assign(this.ev1, { x: f.evacX, y: f.evacY, alt: f.evacAlt, yaw: f.evacYaw });
      const iv = game.interval / 1000, e0 = this.ev0, e1 = this.ev1;
      let turn = e1.yaw - e0.yaw;
      turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
      this.evacSpeed = Math.hypot(e1.x - e0.x, e1.y - e0.y) / iv;
      this.evacTurn += (turn / iv - this.evacTurn) * 0.3;
    }
    const a = game.alpha(now), e0 = this.ev0, e1 = this.ev1;
    const x = e0.x + (e1.x - e0.x) * a, y = e0.y + (e1.y - e0.y) * a, alt = e0.alt + (e1.alt - e0.alt) * a;
    let dy = e1.yaw - e0.yaw;
    dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
    const fl = this.evac, h = alt * CRUISE;
    fl.heading = -(e0.yaw + dy * a);
    // Nose down while it flies, the more the faster; banked into a turn; level as it settles
    // onto the pad.
    const pitch = Math.min(0.32, h * 0.025 + this.evacSpeed * 0.012);
    this.pose(fl, x, h + 1.1 * SCALE + (h > 0.05 ? Math.sin(t * 2.1) * 0.12 * Math.min(1, h) : 0), y, pitch, t, Math.max(-0.45, Math.min(0.45, this.evacTurn * 0.5)));
    this.fx.rotorWash(game, x, y, Math.max(0, 1 - h / 8) ** 1.5, dt);
  }

  // The Huey flies on along its heading at its last speed, climbing and levelling out.
  private outro(t: number, dt: number): void {
    const fl = this.evac!;
    if (!this.outroAt) this.outroAt = t;
    const s = t - this.outroAt, p = fl.root.position;
    if (s > OUTRO) { this.drop(); this.outroDone = true; return; }
    const sp = Math.max(this.evacSpeed, 12) * (1 + s * 0.4), yaw = -fl.heading;
    p.x += Math.cos(yaw) * sp * dt; p.z += Math.sin(yaw) * sp * dt; p.y += (2 + s * 3) * dt;
    this.evacTurn *= 1 - Math.min(1, dt * 2);
    fl.body.rotation.z = -Math.min(0.32, 0.12 + sp * 0.01);
    fl.body.rotation.x = this.evacTurn * 0.5;
    fl.rotor.rotation.y = t * 21;
    fl.tail.rotation.z = t * 40;
  }

  private drop(): void {
    if (this.evac) { this.group.remove(this.evac.root, this.evac.crate); this.evac = null; }
  }

  private pose(fl: Flight, x: number, alt: number, z: number, pitch: number, t: number, roll = 0): void {
    fl.root.position.set(x, alt - 1.1 * SCALE, z);
    fl.root.rotation.y = fl.heading;
    fl.body.rotation.z = -pitch;
    fl.body.rotation.x = Math.sin(t * 1.3) * 0.03 + roll;
    fl.rotor.rotation.y = t * 21;
    fl.tail.rotation.z = t * 40;
  }
}
