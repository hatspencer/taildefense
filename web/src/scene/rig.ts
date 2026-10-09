import * as THREE from 'three/webgpu';
import { merge, type Part } from './util';

// The puppets' skeleton, shared by heroes and creeps. Heroes pose a tree of groups on the CPU;
// creeps are posed in the vertex shader, each vertex tagged with the chain of joints it hangs
// from, so a whole horde walks and swings at one draw call per kind.

// Joints, by index into a kind's tables. A chain lists a vertex's joints from its own out to
// the chest; the pelvis moves the whole figure and is not a joint.
export const J = {
  X2: 0, CHEST: 1, HEAD: 2, UARM_L: 3, FARM_L: 4, UARM_R: 5, FARM_R: 6,
  THIGH_L: 7, SHIN_L: 8, THIGH_R: 9, SHIN_R: 10, X: 11,
} as const;
export const JOINTS = 12;

const PARENT = [J.CHEST, -1, J.CHEST, J.CHEST, J.UARM_L, J.CHEST, J.UARM_R, -1, J.THIGH_L, -1, J.THIGH_R, J.CHEST];

// The chain from joint j outwards: [j, its parent, its grandparent], -1 past the root.
export function chain(j: number): [number, number, number] {
  const p = j < 0 ? -1 : PARENT[j], g = p < 0 ? -1 : PARENT[p];
  return [j, p, g];
}

// A part that moves with joint j (-1: with the pelvis only).
export interface RigPart extends Part { j: number }
export function rp(j: number, p: Part): RigPart { return { ...p, j }; }

// Merges rig parts into one flat geometry with a `rj` attribute: the chain of joints each
// vertex hangs from, as floats (-1 for none).
export function mergeRig(parts: RigPart[]): THREE.BufferGeometry {
  const geo = merge(parts);
  const n = geo.getAttribute('position').count;
  const rj = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const c = chain(p.j);
    const g = p.geo.index ? p.geo.index.count : p.geo.getAttribute('position').count;
    for (let i = 0; i < g; i++, o++) { rj[o * 3] = c[0]; rj[o * 3 + 1] = c[1]; rj[o * 3 + 2] = c[2]; }
  }
  geo.setAttribute('rj', new THREE.BufferAttribute(rj, 3));
  return geo;
}

// Critically damped-ish second-order motion towards a goal (after t3ssel8r): f is how fast it
// follows in Hz, z its damping (below 1 overshoots), r its response (above 1 anticipates,
// below 0 winds up the wrong way first).
export class Spring {
  y: number; v = 0;
  private xp: number;
  private k1: number; private k2: number; private k3: number;
  constructor(f: number, z: number, r: number, x0 = 0) {
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / ((2 * Math.PI * f) ** 2);
    this.k3 = (r * z) / (2 * Math.PI * f);
    this.y = x0; this.xp = x0;
  }
  update(dt: number, x: number): number {
    if (dt <= 0) return this.y;
    const xd = (x - this.xp) / dt;
    this.xp = x;
    // Sub-steps keep it stable when a frame is long.
    const k2 = Math.max(this.k2, dt * dt / 2 + dt * this.k1 / 2, dt * this.k1);
    this.y += dt * this.v;
    this.v += dt * (x + this.k3 * xd - this.y - this.k1 * this.v) / k2;
    return this.y;
  }
  // A kick, in units per second.
  kick(v: number): void { this.v += v; }
  reset(x: number): void { this.y = x; this.xp = x; this.v = 0; }
}

// The shortest signed turn from a to b.
export function wrapAngle(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }
// a turned towards b by at most k of the way.
export function turnTowards(a: number, b: number, k: number): number { return a + wrapAngle(b - a) * Math.min(1, k); }

const DOWN = new THREE.Vector3(0, -1, 0);
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();

// Two-bone IK for a limb hanging down its pivots' -y: points `upper` (pivot at the shoulder,
// in its parent's space) and `lower` (pivot at the elbow, child of upper, a down upper's -y)
// so the end of the lower bone, b below the elbow, reaches `target` (in upper's parent's
// space), the elbow bending towards `pole`.
export function ik2(upper: THREE.Object3D, lower: THREE.Object3D, a: number, b: number, target: THREE.Vector3, pole: THREE.Vector3): void {
  const s = upper.position;
  const d = v1.subVectors(target, s);
  const len = Math.min(Math.max(d.length(), 0.02), a + b - 0.002);
  const dn = d.normalize();
  const cosA = Math.min(1, Math.max(-1, (a * a + len * len - b * b) / (2 * a * len)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  // The pole, flattened onto the plane across the reach.
  const pn = v2.copy(pole).addScaledVector(dn, -pole.dot(dn));
  if (pn.lengthSq() < 1e-6) pn.set(-1, 0, 0).addScaledVector(dn, -(-dn.x));
  pn.normalize();
  const up = v3.copy(dn).multiplyScalar(cosA).addScaledVector(pn, sinA);
  // The elbow, and from it to the reach's end.
  const fore = v4.copy(dn).multiplyScalar(len).addScaledVector(up, -a).normalize();
  upper.quaternion.setFromUnitVectors(DOWN, up);
  q1.setFromUnitVectors(DOWN, fore);
  q2.copy(upper.quaternion).invert();
  lower.quaternion.copy(q2.multiply(q1));
}
