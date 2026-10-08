import * as THREE from 'three/webgpu';
import { color, sin, time, uniform, vertexColor, vec3 } from 'three/tsl';
import type { StructDef } from '../protocol';
import type { Game } from '../state';
import { box, cyl, ico, merge, octa, part, playerColor, setEmissive, torus, writeMatrix, type Part } from './util';

export const K_CORE = 1, K_ARMORY = 2, K_WALL = 3, K_GATE = 4, K_GUN = 5, K_CANNON = 6, K_FROST = 7, K_TESLA = 8;

// Highlight of what is under the cursor, set per object through userData.hl.
const hl = uniform(0).onObjectUpdate((frame) => (frame.object?.userData.hl as number | undefined) ?? 0);

export function litMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial();
  m.colorNode = vertexColor().rgb;
  setEmissive(m, vec3(0.32, 0.3, 0.18).mul(hl));
  return m;
}

function glowMaterial(hex: number, pulse = 0): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = pulse ? color(hex).mul(sin(time.mul(pulse)).mul(0.25).add(1.05)) : color(hex);
  return m;
}

interface Model { body: Part[]; head?: Part[]; headY?: number; glow?: { parts: Part[]; color: number; pulse: number }; spin?: Part[]; spinY?: number }

// Models face +x and stand on y = 0, centred on their footprint.
function modelFor(kind: number): Model {
  switch (kind) {
    case K_CORE: return {
      // The generator everyone is defending: a mustard diesel set on a slab, fuel cans, a lamp post.
      body: [
        part(box(2.9, 0.2, 2.9), 0x77736a, 0, 0.1, 0),
        part(box(1.9, 0.95, 1.2), 0xa08a3a, 0, 0.67, 0),
        part(box(1.95, 0.1, 1.25), 0x6a5c28, 0, 1.18, 0),
        part(box(0.05, 0.6, 0.9), 0x2a2a26, 0.98, 0.7, 0),
        ...[-0.3, -0.1, 0.1, 0.3].map((z) => part(box(0.06, 0.5, 0.05), 0x55524a, 1.0, 0.7, z)),
        part(box(0.5, 0.5, 1.0), 0x4e4c46, -0.7, 0.45, 0),
        part(cyl(0.07, 0.07, 0.8, 6), 0x3a3834, -0.6, 1.5, 0.35),
        part(cyl(0.1, 0.07, 0.12, 6), 0x2a2826, -0.6, 1.92, 0.35),
        part(box(0.3, 0.4, 0.18), 0x8a2a20, -1.15, 0.4, 1.0),
        part(box(0.3, 0.4, 0.18), 0x8a2a20, -0.8, 0.4, 1.15, 0, 0.4, 0),
        part(cyl(0.3, 0.3, 0.25, 8), 0x6a4a2c, 1.0, 0.33, 1.05, Math.PI / 2, 0, 0),
        part(cyl(0.04, 0.05, 2.0, 5), 0x4a3a2a, 1.25, 1.0, -1.25),
        part(box(0.5, 0.05, 0.05), 0x4a3a2a, 1.1, 1.95, -1.25),
      ],
      glow: { parts: [
        part(box(0.16, 0.12, 0.16), 0, 0.9, 1.86, -1.25),
        part(box(0.12, 0.1, 0.12), 0, 0.5, 1.3, 0.35),
      ], color: 0xffc070, pulse: 2 },
    };
    case K_ARMORY: return {
      // A plank shed with a tin roof, crates by the door.
      body: [
        part(box(1.9, 0.12, 1.9), 0x6e675c, 0, 0.06, 0),
        part(box(1.6, 1.0, 1.5), 0x7e6446, 0, 0.6, 0),
        ...[-0.45, -0.15, 0.15, 0.45].map((z) => part(box(1.62, 0.04, 0.04), 0x5a4630, 0, 0.6 + z, 0.76)),
        part(box(1.85, 0.08, 1.0), 0x6a6e70, 0, 1.3, 0.38, 0.38, 0, 0),
        part(box(1.85, 0.08, 1.0), 0x5a5e60, 0, 1.3, -0.38, -0.38, 0, 0),
        part(box(0.06, 0.7, 0.55), 0x3a2a1a, 0.81, 0.45, 0),
        part(box(0.08, 0.08, 0.6), 0xa08a3a, 0.84, 0.88, 0),
        part(box(0.4, 0.35, 0.4), 0x8a6a3a, 1.1, 0.25, 0.65, 0, 0.3, 0),
        part(box(0.32, 0.28, 0.32), 0x5a6038, 1.15, 0.6, 0.6, 0, -0.2, 0),
        part(box(0.36, 0.3, 0.36), 0x8a6a3a, 1.1, 0.2, -0.7),
      ],
    };
    case K_GUN: return {
      // A sandbag nest with a machine gun.
      body: [
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => part(box(0.32, 0.2, 0.2), i % 2 ? 0x9a8c66 : 0x8a7c58, Math.cos(i * Math.PI / 4) * 0.38, 0.1, Math.sin(i * Math.PI / 4) * 0.38, 0, -i * Math.PI / 4 + Math.PI / 2, 0)),
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => part(box(0.3, 0.18, 0.2), i % 2 ? 0x8a7c58 : 0xa49670, Math.cos((i + 0.5) * Math.PI / 4) * 0.36, 0.28, Math.sin((i + 0.5) * Math.PI / 4) * 0.36, 0, -(i + 0.5) * Math.PI / 4 + Math.PI / 2, 0)),
        part(cyl(0.06, 0.08, 0.4, 5), 0x2c2c2a, 0, 0.4, 0),
      ],
      head: [
        part(box(0.36, 0.18, 0.2), 0x3a3c34, 0, 0, 0),
        part(box(0.22, 0.1, 0.14), 0x4a4c40, -0.24, -0.02, 0),
        part(cyl(0.04, 0.04, 0.6, 5), 0x1e1e1c, 0.45, 0.02, 0, 0, 0, Math.PI / 2),
        part(box(0.12, 0.14, 0.08), 0x5a5a2a, 0.02, -0.04, 0.14),
      ],
      headY: 0.66,
    };
    case K_CANNON: return {
      // A mortar pit: a low wall of crates, an olive tube on a baseplate.
      body: [
        part(box(0.9, 0.3, 0.9), 0x6a5a40, 0, 0.15, 0),
        part(box(0.7, 0.06, 0.7), 0x3e3a30, 0, 0.32, 0),
        part(cyl(0.3, 0.34, 0.2, 8), 0x4a4c3a, 0, 0.45, 0),
      ],
      head: [
        part(box(0.36, 0.26, 0.4), 0x4e5636, 0, 0, 0),
        part(cyl(0.12, 0.14, 0.75, 7), 0x3e4430, 0.42, 0.08, 0, 0, 0, Math.PI / 2),
        part(cyl(0.15, 0.15, 0.1, 7), 0x2a2c24, 0.8, 0.08, 0, 0, 0, Math.PI / 2),
        part(box(0.1, 0.06, 0.1), 0xd0c060, -0.1, 0.16, 0.12),
      ],
      headY: 0.75,
    };
    case K_FROST: return {
      body: [
        part(cyl(0.3, 0.42, 0.25, 6), 0x6e7a84, 0, 0.12, 0),
        part(cyl(0.18, 0.28, 0.85, 6), 0xb4c0c8, 0, 0.67, 0),
        part(cyl(0.3, 0.2, 0.1, 6), 0xa8c0d8, 0, 1.12, 0),
      ],
      glow: { parts: [part(octa(0.25), 0, 0, 0, 0, 0, 0, 0, 1, 1.7, 1)], color: 0x9fe4ff, pulse: 2 },
      spinY: 1.5,
    };
    case K_TESLA: return {
      body: [
        part(cyl(0.36, 0.44, 0.3, 8), 0x4d4a55, 0, 0.15, 0),
        part(cyl(0.1, 0.14, 1.2, 6), 0x6a6070, 0, 0.9, 0),
        part(torus(0.26, 0.06, 5, 12), 0xc07a3a, 0, 0.55, 0, Math.PI / 2, 0, 0),
        part(torus(0.22, 0.06, 5, 12), 0xc07a3a, 0, 0.8, 0, Math.PI / 2, 0, 0),
        part(torus(0.18, 0.06, 5, 12), 0xc07a3a, 0, 1.05, 0, Math.PI / 2, 0, 0),
      ],
      glow: { parts: [part(ico(0.2, 1), 0, 0, 1.6, 0)], color: 0xd8b0ff, pulse: 9 },
    };
  }
  return { body: [part(box(0.9, 0.8, 0.9), 0x888888, 0, 0.4, 0)] };
}

interface Built { body: THREE.BufferGeometry; head?: THREE.BufferGeometry; headY: number; glow?: THREE.BufferGeometry; glowMat?: THREE.Material; spin?: THREE.BufferGeometry; spinY: number }

interface Obj {
  kind: number; x: number; y: number; level: number; owner: number;
  group: THREE.Group; head: THREE.Object3D | null; spin: THREE.Object3D | null; glow: THREE.Object3D | null;
  aim: number; aimGoal: number; recoil: number; lastShot: number;
}

// Walls and gates: an instanced post per tile and an instanced arm towards each connected
// neighbour, so lines of walls read as one wall.
class WallSet {
  posts: THREE.InstancedMesh; arms: THREE.InstancedMesh; gposts: THREE.InstancedMesh; garms: THREE.InstancedMesh;
  constructor(group: THREE.Group, mat: THREE.Material, cap: number) {
    const mk = (g: THREE.BufferGeometry) => {
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
      group.add(m);
      return m;
    };
    // Walls are log-and-plank barricades; gates are chain-link on a steel frame.
    this.posts = mk(merge([
      part(box(0.34, 1.35, 0.34), 0x5a4430, 0, 0.67, 0),
      part(box(0.38, 0.06, 0.38), 0x3e3022, 0, 1.36, 0),
      part(box(0.7, 0.1, 0.5), 0x8a8478, 0, 0.05, 0),
    ]));
    this.arms = mk(merge([
      part(box(0.52, 0.24, 0.12), 0x8a6a46, 0.25, 0.28, 0.05),
      part(box(0.52, 0.24, 0.12), 0x7a5c3c, 0.25, 0.58, -0.04),
      part(box(0.52, 0.24, 0.12), 0x92724c, 0.25, 0.88, 0.04),
      part(box(0.52, 0.2, 0.12), 0x6e5236, 0.25, 1.15, -0.02, 0.1, 0, 0),
      part(box(0.04, 0.04, 0.14), 0x2a2a2a, 0.12, 0.58, 0.02),
    ]));
    this.gposts = mk(merge([part(box(0.14, 1.2, 0.14), 0x5a5c5a, 0, 0.6, 0), part(box(0.5, 0.08, 0.5), 0x8a8478, 0, 0.04, 0)]));
    this.garms = mk(merge([
      part(box(0.5, 0.95, 0.03), 0x7a7e7c, 0.25, 0.55, 0),
      part(box(0.5, 0.05, 0.08), 0x4a4c4a, 0.25, 1.04, 0),
      part(box(0.5, 0.05, 0.08), 0x4a4c4a, 0.25, 0.1, 0),
      part(box(0.04, 0.95, 0.06), 0x4a4c4a, 0.47, 0.55, 0),
    ]));
  }
  ensure(n: number): void {
    for (const m of [this.posts, this.arms, this.gposts, this.garms]) {
      if (m.instanceMatrix.count >= n * 4) continue;
      const cap = n * 8;
      m.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      (m as unknown as { count: number }).count = 0;
    }
  }
}

export class Structs {
  group = new THREE.Group();
  private objs = new Map<number, Obj>();
  private built = new Map<number, Built>();
  private mat = litMaterial();
  private pipMat = litMaterial();
  private walls: WallSet;
  private version = -1;
  private defs: StructDef[] = [];
  private pipGeo: THREE.BufferGeometry[] = [];
  private ringGeo = new Map<number, THREE.BufferGeometry>();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.walls = new WallSet(this.group, this.mat, 512);
  }

  setup(defs: StructDef[]): void {
    this.defs = defs;
    for (const o of this.objs.values()) this.group.remove(o.group);
    this.objs.clear();
    this.version = -1;
  }

  private buildKind(kind: number): Built {
    let b = this.built.get(kind);
    if (b) return b;
    const m = modelFor(kind);
    b = { body: merge(m.body), headY: m.headY ?? 0, spinY: m.spinY ?? 0 };
    if (m.head) b.head = merge(m.head);
    if (m.glow) { b.glow = merge(m.glow.parts); b.glowMat = glowMaterial(m.glow.color, m.glow.pulse); }
    if (m.spin) b.spin = merge(m.spin);
    this.built.set(kind, b);
    return b;
  }

  private pips(level: number): THREE.BufferGeometry {
    if (!this.pipGeo[level]) {
      const p: Part[] = [];
      for (let i = 0; i < level; i++) p.push(part(box(0.11, 0.11, 0.11), 0xd8b040, 0.47, 0.12 + i * 0.14, 0));
      this.pipGeo[level] = merge(p.length ? p : [part(box(0.001, 0.001, 0.001), 0)]);
    }
    return this.pipGeo[level];
  }

  private ring(owner: number, w: number): THREE.BufferGeometry {
    const key = owner * 16 + w;
    let g = this.ringGeo.get(key);
    if (!g) {
      const r = w * 0.5 + 0.02;
      g = merge([
        part(box(r * 2, 0.06, 0.07), playerColor(owner), 0, 0.03, r), part(box(r * 2, 0.06, 0.07), playerColor(owner), 0, 0.03, -r),
        part(box(0.07, 0.06, r * 2), playerColor(owner), r, 0.03, 0), part(box(0.07, 0.06, r * 2), playerColor(owner), -r, 0.03, 0),
      ]);
      this.ringGeo.set(key, g);
    }
    return g;
  }

  private make(game: Game, i: number): Obj {
    const f = game.cur;
    const kind = f.sKind[i], b = this.buildKind(kind);
    const g = new THREE.Group();
    const w = f.sW[i], h = f.sH[i];
    g.position.set(f.sX[i] + w / 2, 0, f.sY[i] + h / 2);
    const body = new THREE.Mesh(b.body, this.mat);
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    let head: THREE.Object3D | null = null, spin: THREE.Object3D | null = null, glow: THREE.Object3D | null = null;
    if (b.head) {
      head = new THREE.Mesh(b.head, this.mat);
      head.position.y = b.headY;
      head.castShadow = true;
      g.add(head);
    }
    if (b.glow) {
      glow = new THREE.Mesh(b.glow, b.glowMat);
      if (kind === K_FROST) glow.position.y = b.spinY;
      g.add(glow);
    }
    if (b.spin) { spin = new THREE.Mesh(b.spin, this.mat); spin.position.y = b.spinY; g.add(spin); }
    const def = this.defs[kind];
    if (def?.turret) {
      const pm = new THREE.Mesh(this.pips(f.sLevel[i]), this.pipMat);
      g.add(pm);
    }
    if (kind !== K_WALL && kind !== K_GATE) g.add(new THREE.Mesh(this.ring(f.sOwner[i], w), this.mat));
    const aim = Math.random() * 6.28;
    return { kind, x: f.sX[i], y: f.sY[i], level: f.sLevel[i], owner: f.sOwner[i], group: g, head, spin, glow, aim, aimGoal: aim, recoil: 0, lastShot: 0 };
  }

  private sync(game: Game): void {
    const f = game.cur;
    const seen = new Set<number>();
    let nw = 0;
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const k = f.sKind[i];
      if (k === K_WALL || k === K_GATE) { nw++; continue; }
      seen.add(i);
      const o = this.objs.get(i);
      if (o && o.kind === k && o.x === f.sX[i] && o.y === f.sY[i] && o.level === f.sLevel[i] && o.owner === f.sOwner[i]) continue;
      if (o) this.group.remove(o.group);
      const n = this.make(game, i);
      if (o && o.kind === k) { n.aim = o.aim; n.aimGoal = o.aimGoal; }
      this.objs.set(i, n);
      this.group.add(n.group);
    }
    for (const [i, o] of this.objs) if (!seen.has(i)) { this.group.remove(o.group); this.objs.delete(i); }
    this.syncWalls(game, nw);
  }

  private syncWalls(game: Game, n: number): void {
    const f = game.cur, ws = this.walls;
    ws.ensure(n);
    const isWall = (x: number, y: number) => {
      const s = game.structAtTile(x, y);
      return s >= 0 && (f.sKind[s] === K_WALL || f.sKind[s] === K_GATE);
    };
    let np = 0, na = 0, gp = 0, ga = 0;
    const pa = ws.posts.instanceMatrix.array as Float32Array, aa = ws.arms.instanceMatrix.array as Float32Array;
    const gpa = ws.gposts.instanceMatrix.array as Float32Array, gaa = ws.garms.instanceMatrix.array as Float32Array;
    const dirs = [[1, 0, 0], [0, 1, Math.PI / 2], [-1, 0, Math.PI], [0, -1, -Math.PI / 2]];
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const k = f.sKind[i];
      if (k !== K_WALL && k !== K_GATE) continue;
      const x = f.sX[i], y = f.sY[i], cx = x + 0.5, cz = y + 0.5;
      const gate = k === K_GATE;
      writeMatrix(gate ? gpa : pa, (gate ? gp++ : np++) * 16, cx, 0, cz, 0, 1);
      for (const [dx, dy, a] of dirs) {
        if (!isWall(x + dx, y + dy)) continue;
        writeMatrix(gate ? gaa : aa, (gate ? ga++ : na++) * 16, cx, 0, cz, a, 1);
      }
    }
    const set = (m: THREE.InstancedMesh, c: number) => { m.count = c; m.instanceMatrix.needsUpdate = true; };
    set(ws.posts, np); set(ws.arms, na); set(ws.gposts, gp); set(ws.garms, ga);
  }

  // A turret fired from (x0, y0) at (x1, y1): turn its head that way.
  onShot(game: Game, x0: number, y0: number, x1: number, y1: number, now: number): void {
    const s = game.structAtTile(Math.floor(x0), Math.floor(y0));
    const o = this.objs.get(s);
    if (!o) return;
    o.aimGoal = Math.atan2(y1 - y0, x1 - x0);
    o.recoil = 1;
    o.lastShot = now;
  }

  setHover(id: number, on: boolean): void {
    const o = this.objs.get(id);
    if (o) o.group.traverse((c) => { c.userData.hl = on ? 1 : 0; });
  }

  update(game: Game, now: number, dt: number): void {
    if (game.structsVersion !== this.version) { this.version = game.structsVersion; this.sync(game); }
    const t = now / 1000;
    for (const o of this.objs.values()) {
      if (o.head) {
        // Idle turrets scan slowly.
        if (now - o.lastShot > 2500) o.aimGoal += dt * 0.4;
        let d = o.aimGoal - o.aim;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        o.aim += d * Math.min(1, dt * 14);
        o.head.rotation.y = -o.aim;
        o.recoil = Math.max(0, o.recoil - dt * 8);
        o.head.position.x = -Math.cos(o.aim) * o.recoil * 0.08;
        o.head.position.z = -Math.sin(o.aim) * o.recoil * 0.08;
      }
      if (o.spin) o.spin.rotation.y = t * 0.8;
      if (o.glow && o.kind === K_FROST) { o.glow.rotation.y = t * 1.2; o.glow.position.y = 1.5 + Math.sin(t * 2) * 0.06; }
    }
  }

  // A translucent copy of a struct for build placement.
  ghost(kind: number, mat: THREE.Material): THREE.Group {
    const g = new THREE.Group();
    if (kind === K_WALL || kind === K_GATE) {
      g.add(new THREE.Mesh(kind === K_WALL ? this.walls.posts.geometry : this.walls.gposts.geometry, mat));
      return g;
    }
    const b = this.buildKind(kind);
    g.add(new THREE.Mesh(b.body, mat));
    if (b.head) { const h = new THREE.Mesh(b.head, mat); h.position.y = b.headY; g.add(h); }
    if (b.glow) { const h = new THREE.Mesh(b.glow, mat); if (kind === K_FROST) h.position.y = b.spinY; g.add(h); }
    return g;
  }
}

