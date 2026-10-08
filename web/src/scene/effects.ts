import * as THREE from 'three/webgpu';
import {
  cameraPosition, clamp, cross, float, instancedDynamicBufferAttribute, length, mix, normalize, positionGeometry,
  abs, normalView, pow, sin, smoothstep, step, time, uniform, uv, vec3,
} from 'three/tsl';
import { BlastKind, EffectKind } from '../protocol';
import type { Game } from '../state';
import { K_TESLA } from './structs';
import { linInto, writeMatrix } from './util';

const STRIDE = 16;
type Mode = 'billboard' | 'streak' | 'mesh';

// Effect instances live entirely on the GPU: the CPU writes an instance once when it spawns
// (start, end or velocity, birth time, life, colour, sizes) and the TSL material computes
// motion and fade from the shared clock. Slots are reused as a ring.
//   0..3  p0.xyz, born      4..7  p1.xyz (end, or velocity), life
//   8..11 rgb, size0        12..15 size1, gravity, yScale, -
class FxPool {
  mesh: THREE.InstancedMesh;
  private data: Float32Array;
  private buf: THREE.InstancedInterleavedBuffer;
  private head = 0;
  private lo = Infinity; private hi = -1;

  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, private cap: number, mode: Mode, now: THREE.UniformNode<'float', number>,
    right: THREE.UniformNode<'vec3', THREE.Vector3>, up: THREE.UniformNode<'vec3', THREE.Vector3>, additive: boolean, soft: boolean, rim = false) {
    this.data = new Float32Array(cap * STRIDE);
    // Unused slots must not render: born far in the future.
    for (let i = 0; i < cap; i++) { this.data[i * STRIDE + 3] = 1e9; this.data[i * STRIDE + 7] = 1; }
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const a = instancedDynamicBufferAttribute<'vec4'>(this.buf, 'vec4', STRIDE, 0);
    const b = instancedDynamicBufferAttribute<'vec4'>(this.buf, 'vec4', STRIDE, 4);
    const c = instancedDynamicBufferAttribute<'vec4'>(this.buf, 'vec4', STRIDE, 8);
    const d = instancedDynamicBufferAttribute<'vec4'>(this.buf, 'vec4', STRIDE, 12);
    const age = now.sub(a.w);
    const t = clamp(age.div(b.w), 0, 1);
    const alive = step(0, age).mul(step(age, b.w));
    const g = positionGeometry;
    const mat = new THREE.MeshBasicNodeMaterial();
    let fade = pow(float(1).sub(t), 1.6);
    if (mode === 'billboard') {
      const center = a.xyz.add(b.xyz.mul(age)).add(vec3(0, d.y.mul(age).mul(age).mul(-0.5), 0));
      const size = mix(c.w, d.x, t).mul(alive);
      mat.positionNode = center.add(right.mul(g.x).add(up.mul(g.y)).mul(size));
    } else if (mode === 'streak') {
      // A bright segment travelling from p0 to p1, d.z of the path long.
      const headT = clamp(t.mul(1.3), 0, 1);
      const tailT = clamp(headT.sub(d.z), 0, 1);
      const p = mix(a.xyz, b.xyz, mix(tailT, headT, g.x.add(0.5)));
      const dir = normalize(b.xyz.sub(a.xyz).add(vec3(0.0001, 0, 0)));
      const side = normalize(cross(dir, cameraPosition.sub(p)));
      mat.positionNode = p.add(side.mul(g.y.mul(c.w).mul(alive)));
      fade = float(1).sub(smoothstep(0.6, 1, t));
    } else {
      const r = mix(c.w, d.x, float(1).sub(pow(float(1).sub(t), 2.5))).mul(alive);
      mat.positionNode = a.xyz.add(g.mul(vec3(r, r.mul(d.z), r)));
    }
    if (soft) {
      const q = length(uv().sub(0.5)).mul(2);
      fade = fade.mul(pow(clamp(float(1).sub(q), 0, 1), 1.5));
    }
    // Fireballs: glow where they face the camera, fade towards the silhouette.
    if (rim) fade = fade.mul(pow(abs(normalView.z), 1.8));
    // Ground decals hold, then fade out over the last part of their life.
    if (mode === 'mesh' && !additive) fade = float(1).sub(smoothstep(0.55, 1, t));
    mat.colorNode = c.xyz.mul(additive ? fade : float(1));
    mat.opacityNode = additive ? float(1) : fade.mul(d.w);
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = !additive;
    if (additive) mat.blending = THREE.AdditiveBlending;
    mat.side = THREE.DoubleSide;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = cap;
    this.mesh.renderOrder = additive ? 3 : 2;
    parent.add(this.mesh);
  }

  add(now: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, life: number,
    hex: number, size0: number, size1: number, gravity = 0, yScale = 1, alpha = 1, bright = 1): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    const o = i * STRIDE, d = this.data;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = z0; d[o + 3] = now;
    d[o + 4] = x1; d[o + 5] = y1; d[o + 6] = z1; d[o + 7] = life;
    linInto(d, o + 8, hex, bright); d[o + 11] = size0;
    d[o + 12] = size1; d[o + 13] = gravity; d[o + 14] = yScale; d[o + 15] = alpha;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
  }

  flush(): void {
    if (this.hi < 0) return;
    this.buf.clearUpdateRanges();
    this.buf.addUpdateRange(this.lo * STRIDE, (this.hi - this.lo + 1) * STRIDE);
    this.buf.needsUpdate = true;
    this.lo = Infinity; this.hi = -1;
  }
}

const TRACER: Record<number, number> = { 0: 0xffe9a0, 1: 0xffb060, 2: 0xfff0b0, 3: 0xa0f0ff, 4: 0xff7a20, 5: 0xffd860, 6: 0xffffff };
const TURRET: Record<number, number> = { 5: 0xfff0a0, 6: 0xffa040, 7: 0x9fe4ff, 8: 0xd8b0ff };
// Blood, dark and everywhere; the spitter bleeds bile.
const CREEP_GORE = [0x4a0c0a, 0x56100c, 0x3e0a08, 0x5a1410, 0x4a5a14, 0x3a0808];

// Tracers, muzzle flashes, explosions, pulses, corpses and the lasting effects.
export class Effects {
  group = new THREE.Group();
  private uNow = uniform(0);
  private uRight = uniform(new THREE.Vector3(1, 0, 0));
  private uUp = uniform(new THREE.Vector3(0, 1, 0));
  private glow: FxPool; private smoke: FxPool; private streaks: FxPool;
  private spheres: FxPool; private rings: FxPool; private decals: FxPool;
  private lasting: THREE.InstancedMesh; private lastingFire: THREE.InstancedMesh; private grenades: THREE.InstancedMesh;
  private t0 = performance.now();
  private sec = 0;
  private lastNapalm = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const n = this.uNow, r = this.uRight, u = this.uUp;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.glow = new FxPool(this.group, quad, 8192, 'billboard', n, r, u, true, true);
    this.smoke = new FxPool(this.group, quad, 2048, 'billboard', n, r, u, false, true);
    this.streaks = new FxPool(this.group, quad, 4096, 'streak', n, r, u, true, false);
    this.spheres = new FxPool(this.group, new THREE.IcosahedronGeometry(1, 3), 512, 'mesh', n, r, u, true, false, true);
    const ring = new THREE.RingGeometry(0.82, 1, 40); ring.rotateX(-Math.PI / 2);
    this.rings = new FxPool(this.group, ring, 512, 'mesh', n, r, u, true, false);
    const disc = new THREE.CircleGeometry(1, 9); disc.rotateX(-Math.PI / 2);
    this.decals = new FxPool(this.group, disc, 2048, 'mesh', n, r, u, false, false);
    this.decals.mesh.renderOrder = 1;

    // Lasting effects: re-laid every frame from the frame's effect list (few of them).
    const flatRing = new THREE.RingGeometry(0.9, 1, 48); flatRing.rotateX(-Math.PI / 2);
    const lm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    lm.colorNode = vec3(1, 0.15, 0.1).mul(sin(time.mul(10)).mul(0.35).add(0.75));
    lm.fog = false;
    this.lasting = new THREE.InstancedMesh(flatRing, lm, 64);
    const fd = new THREE.CircleGeometry(1, 20); fd.rotateX(-Math.PI / 2);
    const fm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    fm.colorNode = vec3(0.9, 0.32, 0.05).mul(sin(time.mul(13)).mul(0.15).add(0.55));
    fm.fog = false;
    this.lastingFire = new THREE.InstancedMesh(fd, fm, 64);
    const gm = new THREE.MeshLambertNodeMaterial({ color: 0x33402a });
    this.grenades = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 0), gm, 64);
    for (const m of [this.lasting, this.lastingFire, this.grenades]) {
      m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(m);
    }
    this.grenades.castShadow = true;
  }

  private now(): number { return (performance.now() - this.t0) / 1000; }

  // Spawns the per-tick events of the frame that just arrived.
  onFrame(game: Game, turretHeight: (x: number, y: number) => number, onTurretShot: (x0: number, y0: number, x1: number, y1: number) => void): void {
    const f = game.cur, t = this.now();
    let flashes = 0;
    for (let i = 0; i < f.nTracers; i++) {
      const k = f.tKind[i];
      const x0 = f.tX0[i], y0 = f.tY0[i], x1 = f.tX1[i], y1 = f.tY1[i];
      const dist = Math.hypot(x1 - x0, y1 - y0);
      if (k >= 32) {
        this.streaks.add(t, x0, 0.8, y0, x1, 0.9, y1, 0.35, 0x8cff3a, 0.2, 0, 0, 0.25, 1, 1.2);
        this.glow.add(t + 0.3, x1, 0.9, y1, 0, 0.5, 0, 0.25, 0x8cff3a, 0.6, 0.2);
        continue;
      }
      if (k >= 16) {
        const sk = k - 16;
        const h = turretHeight(x0, y0);
        onTurretShot(x0, y0, x1, y1);
        if (sk === K_TESLA) { this.arc(t, x0, h, y0, x1, 0.6, y1); continue; }
        const col = TURRET[sk] ?? 0xffffff;
        this.streaks.add(t, x0, h, y0, x1, 0.55, y1, 0.08 + dist * 0.006, col, 0.09, 0, 0, 0.45);
        if (flashes++ < 60) this.glow.add(t, x0 + (x1 - x0) / dist * 0.6, h, y0 + (y1 - y0) / dist * 0.6, 0, 0, 0, 0.07, 0xffd070, sk === 6 ? 1.2 : 0.6, 0.3);
        continue;
      }
      // Player weapons, from gun height.
      const col = TRACER[k] ?? 0xffffff;
      if (k === 4) {
        // Flamethrower: a gout of fire particles rather than a line.
        for (let j = 0; j < 3; j++) {
          const s = 0.35 + Math.random() * 0.6, l = 0.25 + Math.random() * 0.2;
          this.glow.add(t, x0, 1.0, y0, (x1 - x0) / l * s, 0.4, (y1 - y0) / l * s, l, j ? 0xff6a10 : 0xffc040, 0.25, 1.1, -1.5);
        }
        continue;
      }
      const w = k === 6 ? 0.16 : k === 3 ? 0.08 : 0.06;
      const life = k === 6 ? 0.25 + dist * 0.01 : 0.06 + dist * 0.004;
      this.streaks.add(t, x0, 1.12, y0, x1, 0.55, y1, life, col, w, 0, 0, k === 6 ? 0.25 : 0.4, 1, 1.4);
      if (k === 6) this.smoke.add(t, x0, 1.1, y0, 0, 0.6, 0, 0.8, 0x9a9a9a, 0.4, 1.2, 0, 1, 0.5);
      if (flashes++ < 80) this.glow.add(t, x0 + (x1 - x0) / dist * 0.4, 1.12, y0 + (y1 - y0) / dist * 0.4, 0, 0, 0, 0.06, 0xffe0a0, 0.55, 0.2);
      if (i % 2 === 0) this.glow.add(t + life * 0.8, x1, 0.55, y1, (Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3, 0.18, col, 0.18, 0.05, 9);
    }
    for (let i = 0; i < f.nBlasts; i++) this.blast(t, f.bX[i], f.bY[i], Math.max(0.5, f.bR[i]), f.bKind[i]);
    for (let i = 0; i < f.nDeaths; i++) {
      const k = f.dKind[i], def = game.welcome?.creeps[k];
      const r = def ? def.radius : 0.45;
      const x = f.dX[i], y = f.dY[i];
      this.decals.add(t, x + (Math.random() - 0.5) * 0.2, 0.07, y + (Math.random() - 0.5) * 0.2, 0, 0, 0, 30, CREEP_GORE[k % CREEP_GORE.length],
        r * (0.85 + Math.random() * 0.35), r * (1.0 + Math.random() * 0.35), 0, 1, 0.7);
      if (i < 120) {
        for (let j = 0; j < 3; j++) this.smoke.add(t, x, 0.5, y, (Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.4, CREEP_GORE[k % CREEP_GORE.length], 0.6 * r, 0.1, 12, 1, 0.9);
      }
    }
  }

  private arc(t: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    // A jagged bolt: a few segments with random kinks, plus a faint wide glow.
    const n = 5;
    let px = x0, py = y0, pz = z0;
    for (let s = 1; s <= n; s++) {
      const u = s / n;
      const j = s === n ? 0 : 0.45;
      const nx = x0 + (x1 - x0) * u + (Math.random() - 0.5) * j, ny = y0 + (y1 - y0) * u + (Math.random() - 0.5) * j, nz = z0 + (z1 - z0) * u + (Math.random() - 0.5) * j;
      this.streaks.add(t, px, py, pz, nx, ny, nz, 0.2, 0xe8d0ff, 0.07, 0, 0, 1.3, 1, 1.6);
      this.streaks.add(t, px, py, pz, nx, ny, nz, 0.2, 0x8a50ff, 0.3, 0, 0, 1.3, 1, 0.6);
      px = nx; py = ny; pz = nz;
    }
    this.glow.add(t, x1, y1, z1, 0, 0, 0, 0.15, 0xc8a0ff, 0.9, 0.3);
  }

  private blast(t: number, x: number, y: number, r: number, kind: number): void {
    switch (kind) {
      case BlastKind.Frost:
        this.rings.add(t, x, 0.12, y, 0, 0, 0, 0.6, 0x7fdcff, r * 0.2, r, 0, 1, 1, 1.2);
        this.spheres.add(t, x, 0.05, y, 0, 0, 0, 0.5, 0x2a6a90, r * 0.3, r, 0, 0.3);
        for (let j = 0; j < 8; j++) { const a = Math.random() * 6.28; this.glow.add(t, x + Math.cos(a) * r * 0.5, 0.4, y + Math.sin(a) * r * 0.5, Math.cos(a) * r, 0.5, Math.sin(a) * r, 0.5, 0xcff4ff, 0.3, 0.05); }
        return;
      case BlastKind.Tesla:
        this.glow.add(t, x, 0.7, y, 0, 0, 0, 0.18, 0xd0a8ff, r * 1.4, r * 0.4);
        for (let j = 0; j < 5; j++) this.glow.add(t, x, 0.7, y, (Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6, 0.22, 0xffffff, 0.12, 0.02, 10);
        return;
      case BlastKind.Concussion:
        this.rings.add(t, x, 0.15, y, 0, 0, 0, 0.45, 0xffe6b0, r * 0.3, r * 1.1, 0, 1, 1, 1.3);
        this.spheres.add(t, x, 0.1, y, 0, 0, 0, 0.35, 0x8a7a5a, r * 0.2, r, 0, 0.35);
        for (let j = 0; j < 6; j++) this.smoke.add(t, x + (Math.random() - 0.5) * r, 0.3, y + (Math.random() - 0.5) * r, (Math.random() - 0.5), 0.6, (Math.random() - 0.5), 1.1, 0xb8a888, 0.8, 1.8, 0, 1, 0.45);
        return;
      default: {
        const big = kind === BlastKind.Airstrike;
        this.spheres.add(t, x, 0.2, y, 0, 0, 0, big ? 0.6 : 0.42, 0xff8a20, r * 0.25, r, 0, 0.8, 1, 0.9);
        this.spheres.add(t, x, 0.3, y, 0, 0, 0, big ? 0.35 : 0.25, 0xfff0a0, r * 0.15, r * 0.6, 0, 0.9, 1, 0.8);
        this.rings.add(t, x, 0.12, y, 0, 0, 0, 0.4, 0xffb060, r * 0.4, r * 1.25, 0, 1, 1, 1.0);
        this.glow.add(t, x, 1.2, y, 0, 0, 0, 0.14, 0xffe0a0, r * 2.4, r * 1.2);
        const ns = big ? 16 : 9;
        for (let j = 0; j < ns; j++) {
          const a = Math.random() * 6.28, s = 3 + Math.random() * 5;
          this.glow.add(t, x, 0.4, y, Math.cos(a) * s, 3 + Math.random() * 5, Math.sin(a) * s, 0.5 + Math.random() * 0.3, j % 3 ? 0xffa030 : 0xffe080, 0.22, 0.05, 14);
        }
        for (let j = 0; j < (big ? 6 : 3); j++) {
          this.smoke.add(t + 0.1, x + (Math.random() - 0.5) * r * 0.6, 0.6, y + (Math.random() - 0.5) * r * 0.6, (Math.random() - 0.5) * 0.6, 1.2, (Math.random() - 0.5) * 0.6, 1.6 + Math.random(), big ? 0x2a2622 : 0x4a4440, r * 0.5, r * 1.3, 0, 1, 0.55);
        }
        this.decals.add(t, x, 0.065, y, 0, 0, 0, 14, 0x1e1a16, r * 0.8, r * 0.8, 0, 1, 0.75);
      }
    }
  }

  // Per render frame: the clock, billboard axes, and the lasting effects.
  update(game: Game, cam: THREE.Camera): void {
    const t = this.now();
    this.sec = t;
    this.uNow.value = t;
    this.uRight.value.setFromMatrixColumn(cam.matrixWorld, 0);
    this.uUp.value.setFromMatrixColumn(cam.matrixWorld, 1);

    const f = game.cur;
    let nr = 0, nf = 0, ng = 0;
    const ra = this.lasting.instanceMatrix.array as Float32Array, fa = this.lastingFire.instanceMatrix.array as Float32Array, ga = this.grenades.instanceMatrix.array as Float32Array;
    const sinceFrame = Math.min(0.1, (performance.now() - game.frameAt) / 1000);
    const spawnFire = t - this.lastNapalm > 0.05;
    if (spawnFire) this.lastNapalm = t;
    for (let i = 0; i < f.nEffects && i < 64; i++) {
      const k = f.eKind[i], r = Math.max(0.5, f.eR[i]);
      const left = Math.max(0, f.eLeft[i] / 10 - sinceFrame), total = Math.max(0.1, f.eTotal[i] / 10);
      if (k === EffectKind.Grenade) {
        const p = 1 - left / total;
        const x = f.eX0[i] + (f.eX[i] - f.eX0[i]) * p, z = f.eY0[i] + (f.eY[i] - f.eY0[i]) * p;
        const d = Math.hypot(f.eX[i] - f.eX0[i], f.eY[i] - f.eY0[i]);
        const y = 1.1 + 4 * p * (1 - p) * Math.max(1.5, d * 0.35) - p * 0.9;
        writeMatrix(ga, ng++ * 16, x, y, z, t * 9, 1);
        if (spawnFire) this.smoke.add(t, x, y, z, 0, 0.2, 0, 0.6, 0xc8c8c0, 0.15, 0.4, 0, 1, 0.5);
        writeMatrix(ra, nr++ * 16, f.eX[i], 0.1, f.eY[i], 0, r * 0.9);
      } else if (k === EffectKind.Napalm) {
        const s = r * Math.min(1, (total - left) * 4) * (left < 0.5 ? left * 2 : 1);
        writeMatrix(fa, nf++ * 16, f.eX[i], 0.08, f.eY[i], 0, s);
        if (spawnFire) {
          for (let j = 0; j < Math.ceil(r); j++) {
            const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * s;
            this.glow.add(t, f.eX[i] + Math.cos(a) * d, 0.2, f.eY[i] + Math.sin(a) * d, 0, 1.6 + Math.random(), 0, 0.5, Math.random() < 0.5 ? 0xff6a10 : 0xffb030, 0.5, 0.1, -1);
          }
          if (Math.random() < 0.3) this.smoke.add(t, f.eX[i] + (Math.random() - 0.5) * s, 0.8, f.eY[i] + (Math.random() - 0.5) * s, 0, 1.2, 0, 1.6, 0x302820, 0.6, 1.6, 0, 1, 0.35);
        }
      } else if (k === EffectKind.AirTarget) {
        const pulse = 1 + 0.06 * Math.sin(t * 12);
        writeMatrix(ra, nr++ * 16, f.eX[i], 0.12, f.eY[i], 0, r * pulse);
        writeMatrix(ra, nr++ * 16, f.eX[i], 0.12, f.eY[i], 0, r * (left / total) * 0.95 + 0.2);
      }
    }
    const done = (m: THREE.InstancedMesh, n: number) => { m.count = n; if (n) m.instanceMatrix.needsUpdate = true; };
    done(this.lasting, nr); done(this.lastingFire, nf); done(this.grenades, ng);
    for (const p of [this.glow, this.smoke, this.streaks, this.spheres, this.rings, this.decals]) p.flush();
  }

  // A one-off ground ping at a commanded point.
  ping(x: number, y: number, hex: number): void {
    const t = this.sec;
    this.rings.add(t, x, 0.1, y, 0, 0, 0, 0.5, hex, 0.9, 0.15, 0, 1, 1, 1.3);
    this.rings.add(t + 0.08, x, 0.1, y, 0, 0, 0, 0.42, hex, 0.6, 0.1, 0, 1, 1, 1.1);
  }
}
