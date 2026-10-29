import * as THREE from 'three/webgpu';
import { color, positionWorld, sin, time } from 'three/tsl';
import type { Gun } from '../protocol';
import type { Game } from '../state';
import { gunParts } from './heroes';
import { litMaterial } from './structs';
import { merge, octa, playerColor, writeMatrix } from './util';

// How much bigger than in the hand a weapon on the ground is drawn, so it reads from the
// camera's height.
const SCALE = 1.6;

// Weapons survivors dropped for each other: the same model the hero carries, taped in the
// dropper's colour, lying on its side, with the loot sites' pulsing glint over it and a
// shimmer on it so it is not lost in the grass.
export class Guns {
  group = new THREE.Group();
  private mat = litMaterial();
  private glintMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private glints: THREE.InstancedMesh;
  private geos = new Map<string, THREE.BufferGeometry>();
  private meshes = new Map<number, THREE.Mesh>();
  private seen = new Set<number>();
  hovered = -1;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const pulse = sin(time.mul(3.2).add(positionWorld.x.mul(1.7)).add(positionWorld.z.mul(2.3))).mul(0.4).add(0.8);
    this.glintMat.colorNode = color(0xffc850).mul(pulse);
    this.glintMat.fog = false;
    this.glints = new THREE.InstancedMesh(octa(0.12), this.glintMat, 64);
    this.glints.frustumCulled = false;
    this.glints.count = 0;
    this.glints.renderOrder = 3;
    this.group.add(this.glints);
  }

  clear(): void {
    for (const m of this.meshes.values()) this.group.remove(m);
    this.meshes.clear();
  }

  private geo(kind: number, by: number, evo: number): THREE.BufferGeometry {
    const key = `${kind}:${by}:${evo}`;
    let g = this.geos.get(key);
    if (!g) {
      const p = gunParts(kind, playerColor(by), evo);
      g = merge([...p.body, ...p.spin, ...p.glow]);
      this.geos.set(key, g);
    }
    return g;
  }

  private make(g: Gun): THREE.Mesh {
    const m = new THREE.Mesh(this.geo(g.kind, g.by, g.evo), this.mat);
    m.castShadow = true;
    // On its side, the muzzle off at an angle of its own.
    const yaw = ((g.id * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
    m.rotation.set(Math.PI / 2, 0, 0);
    m.rotation.order = 'YXZ';
    m.rotation.y = yaw;
    m.scale.setScalar(SCALE);
    m.position.set(g.x, 0.1, g.y);
    this.group.add(m);
    return m;
  }

  update(game: Game, now: number): void {
    const f = game.cur, t = now / 1000;
    const seen = this.seen;
    seen.clear();
    if (this.glints.instanceMatrix.count < f.guns.length) {
      this.group.remove(this.glints);
      this.glints.dispose();
      this.glints = new THREE.InstancedMesh(this.glints.geometry, this.glintMat, f.guns.length * 2);
      this.glints.frustumCulled = false; this.glints.renderOrder = 3;
      this.group.add(this.glints);
    }
    const a = this.glints.instanceMatrix.array as Float32Array;
    let n = 0;
    for (const g of f.guns) {
      seen.add(g.id);
      const m = this.meshes.get(g.id) ?? this.make(g);
      this.meshes.set(g.id, m);
      const ph = (g.id * 0.618) % 1 * 6.28;
      m.userData.hl = g.id === this.hovered ? 1 : 0.3 + 0.25 * Math.sin(t * 3.2 + ph);
      const s = 1 + 0.18 * Math.sin(t * 3.2 + ph);
      writeMatrix(a, n++ * 16, g.x, 0.75 + Math.sin(t * 1.8 + ph) * 0.08, g.y, t * 1.5 + ph, s, s * 1.6);
    }
    this.glints.count = n;
    this.glints.instanceMatrix.needsUpdate = true;
    for (const [id, m] of this.meshes) {
      if (seen.has(id)) continue;
      this.group.remove(m);
      this.meshes.delete(id);
    }
  }
}
