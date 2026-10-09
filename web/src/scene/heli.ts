import * as THREE from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { EffectKind } from '../protocol';
import type { Game } from '../state';
import type { Effects } from './effects';
import { litMaterial } from './structs';
import { box, cyl, merge, part, type Part, sphere } from './util';

// Supply drops: the Huey gunship that flies the crate in, with the surfboards strapped to its
// side (a nod to Kilgore in Apocalypse Now), the crate coming down under a chute, and the crates
// waiting on the ground with green smoke over them.

const OD = 0x4b5631, OD_DARK = 0x363e22, GLASS = 0x34505a, BLACK = 0x1c1c1a, STEEL = 0x55574f;
const CRUISE = 10, HOVER = 6.5; // flying height in, and over the drop zone
const HOVER_TIME = 3; // the host's dropHover: seconds over the zone before the crate is down
const RELEASE = 1.6; // seconds before landing that the crate is let go under its chute
const DEPART = 7; // seconds the Huey takes to fly off after the crate is down
const SCALE = 0.75; // a touch under life size, so it does not swallow the screen

interface Flight {
  root: THREE.Group; body: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; crate: THREE.Group; chute: THREE.Object3D;
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
  // The door gunner on the right, helmet and M60 out of the door.
  add(0.45, 0.65, 0.4, 0x5a5f3a, 0.1, 1.2, 0.62);
  p.push(part(sphere(0.2), 0x3d4426, 0.1, 1.7, 0.62));
  add(0.09, 0.09, 1.0, BLACK, 0.25, 1.4, 1.2);
  add(0.12, 0.18, 0.2, BLACK, 0.25, 1.3, 0.78);
  // Two surfboards strapped along the left skid struts, Kilgore style.
  p.push(...board(0xf1ece0, 0xc8402a, 0.2, 0.95, -1.13));
  p.push(...board(0xf2c64a, 0x2d6fb0, 0.05, 1.05, -1.24));
  for (const x of [-0.55, 0.75]) add(0.08, 0.75, 0.32, BLACK, x, 1.0, -1.18);
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

export class Helis {
  group = new THREE.Group();
  private mat = litMaterial();
  private bodyGeo = hueyBody();
  private rotorGeo = merge([part(box(10, 0.05, 0.36), 0x262624, 0, 0, 0), part(box(0.5, 0.15, 0.5), STEEL, 0, 0, 0)]);
  private tailGeo = merge([part(box(0.1, 1.5, 0.16), 0x262624, 0, 0, 0)]);
  private crateG = crateGeo();
  private chuteG = chuteGeo();
  private blurMat = new THREE.MeshBasicNodeMaterial({ color: 0x1a1a18, transparent: true, opacity: 0.07, depthWrite: false });
  private blurGeo = new THREE.CircleGeometry(5, 24).rotateX(-Math.PI / 2);
  private flights = new Map<string, Flight>();
  private grounded: THREE.Group[] = [];
  private serial = 0;
  private lastPuff = 0;

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
    const crate = new THREE.Group();
    const cm = new THREE.Mesh(this.crateG, this.mat);
    cm.castShadow = true;
    const chute = new THREE.Mesh(this.chuteG, this.mat);
    chute.visible = false;
    crate.add(cm, chute);
    this.group.add(root, crate);
    return { root, body, rotor, tail, crate, chute, x0, y0, x, y, heading: -Math.atan2(y - y0, x - x0), seen: 0, landedAt: 0 };
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

  private pose(fl: Flight, x: number, alt: number, z: number, pitch: number, t: number): void {
    fl.root.position.set(x, alt - 1.1 * SCALE, z);
    fl.root.rotation.y = fl.heading;
    fl.body.rotation.z = -pitch;
    fl.body.rotation.x = Math.sin(t * 1.3) * 0.03;
    fl.rotor.rotation.y = t * 21;
    fl.tail.rotation.z = t * 40;
  }
}
