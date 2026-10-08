import * as THREE from 'three/webgpu';
import { color, positionWorld, sin, time } from 'three/tsl';
import { propKind, type SiteDef, SiteKind, siteX, siteY, walled } from '../protocol';
import type { Game } from '../state';
import { box, cyl, lin, merge, octa, part, writeMatrix, type Part } from './util';

function hash(i: number, s: number): number {
  let h = Math.imul(i * 374761393 + s * 668265263, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Car paint, faded: tints over a light grey body.
const PAINT = [0x7d8c99, 0x8f5a48, 0x6d7a58, 0xb2a88c, 0x9a9890, 0x5e6a78];
const CAR_BODY = 0xc8c8c8;
const GLINT_Y = [1.65, 1.35, 1.05];

// Props face +x and stand on y = 0. Each kind comes closed (still worth a search) and opened.
function houseProp(open: boolean): Part[] {
  const p: Part[] = [
    // A fridge, a kitchen cabinet and a stack of moving boxes.
    part(box(0.5, 1.1, 0.5), 0xd2cebe, 0, 0.55, 0),
    part(box(0.52, 0.04, 0.52), 0x9a968a, 0, 0.72, 0),
    part(box(0.42, 0.62, 0.72), 0x7a5a3a, 0.02, 0.31, 0.66),
    part(box(0.48, 0.05, 0.78), 0x5a4028, 0.02, 0.64, 0.66),
  ];
  if (open) p.push(
    // The fridge door hangs open on a dark, empty inside; a drawer is pulled; the boxes are tipped.
    part(box(0.02, 1.0, 0.44), 0x2e2c28, 0.26, 0.55, 0),
    part(box(0.48, 1.0, 0.04), 0xc4c0b0, 0.42, 0.55, -0.42, 0, -0.5, 0),
    part(box(0.3, 0.14, 0.62), 0x8a6a46, 0.32, 0.45, 0.66),
    part(box(0.36, 0.3, 0.36), 0x9a7e52, 0.32, 0.15, -0.62, 0, 0.6, 1.3),
    part(box(0.3, 0.02, 0.3), 0xa88a5a, 0.55, 0.02, -0.35, 0, 0.3, 0),
    part(box(0.26, 0.24, 0.26), 0xb89a68, 0.05, 0.12, -0.85, 0, 0.2, 0),
  );
  else p.push(
    part(box(0.02, 1.0, 0.46), 0xb8b4a4, 0.26, 0.55, 0),
    part(box(0.04, 0.26, 0.04), 0x55524a, 0.28, 0.82, 0.17),
    part(box(0.04, 0.03, 0.3), 0x55524a, 0.24, 0.46, 0.66),
    part(box(0.36, 0.3, 0.36), 0xa88a5a, 0.3, 0.15, -0.55, 0, 0.3, 0),
    part(box(0.38, 0.02, 0.06), 0xc8b890, 0.3, 0.305, -0.55, 0, 0.3, 0),
    part(box(0.3, 0.26, 0.3), 0xb89a68, 0.32, 0.43, -0.52, 0, -0.2, 0),
  );
  return p;
}

function carProp(open: boolean): Part[] {
  const dark = 0x24282a, rust = 0x6a3a22;
  const p: Part[] = [
    part(box(1.6, 0.34, 0.86), CAR_BODY, 0, 0.36, 0),
    part(box(0.86, 0.3, 0.78), CAR_BODY, -0.12, 0.68, 0),
    part(box(0.7, 0.17, 0.8), dark, -0.12, 0.7, 0),
    part(box(0.03, 0.22, 0.7), dark, 0.32, 0.68, 0, 0, 0, 0.5),
    part(box(0.03, 0.2, 0.7), dark, -0.56, 0.68, 0, 0, 0, -0.4),
    part(box(0.06, 0.1, 0.88), 0x6a6a64, 0.81, 0.27, 0),
    part(box(0.06, 0.1, 0.88), 0x6a6a64, -0.81, 0.27, 0),
    part(box(0.03, 0.06, 0.16), 0xb8b090, 0.81, 0.4, 0.3),
    part(box(0.03, 0.06, 0.16), 0x5a2a20, -0.81, 0.4, -0.3),
    // Rust on the roof, the boot and down one flank.
    part(box(0.26, 0.02, 0.22), rust, -0.3, 0.835, 0.16, 0, 0.3, 0),
    part(box(0.34, 0.02, 0.5), rust, -0.62, 0.535, -0.1),
    part(box(0.45, 0.2, 0.02), rust, 0.2, 0.32, 0.435),
    // Flat tyres.
    ...[[0.5, 0.4], [0.5, -0.4], [-0.5, 0.4], [-0.5, -0.4]].map(([x, z]) => part(cyl(0.18, 0.18, 0.12, 8), 0x1c1c1c, x, 0.14, z, Math.PI / 2, 0, 0, 1, 1, 0.8)),
  ];
  if (open) p.push(
    // Bonnet up over a dark engine bay; the driver's door hangs open.
    part(box(0.5, 0.03, 0.84), CAR_BODY, 0.48, 0.82, 0, 0, 0, 1.0),
    part(box(0.46, 0.04, 0.74), 0x2a2826, 0.56, 0.53, 0),
    part(box(0.18, 0.1, 0.2), 0x4a4a46, 0.6, 0.57, 0.15),
    part(box(0.5, 0.3, 0.03), CAR_BODY, 0.2, 0.5, 0.62, 0, -0.75, 0),
    part(box(0.48, 0.03, 0.04), dark, 0.2, 0.62, 0.66, 0, -0.75, 0),
  );
  else p.push(
    part(box(0.5, 0.03, 0.84), CAR_BODY, 0.55, 0.545, 0),
    part(box(0.45, 0.24, 0.02), 0x8a8a84, -0.12, 0.42, 0.435),
  );
  return p;
}

function crateProp(open: boolean): Part[] {
  const green = 0x4e5a34, band = 0xc8b674;
  const p: Part[] = [
    part(box(0.92, 0.06, 0.72), 0x7a6040, 0, 0.1, 0),
    ...[-0.3, 0, 0.3].map((z) => part(box(0.92, 0.07, 0.1), 0x6a5034, 0, 0.035, z)),
    part(box(0.8, 0.46, 0.56), green, 0, 0.36, 0),
    part(box(0.82, 0.08, 0.58), band, 0, 0.42, 0),
    // Stencilled marks on the front and a rope handle each end.
    part(box(0.02, 0.06, 0.22), 0xded6b4, 0.41, 0.25, -0.08),
    part(box(0.02, 0.06, 0.08), 0xded6b4, 0.41, 0.25, 0.15),
    part(box(0.08, 0.05, 0.03), 0x2a2a22, 0, 0.5, 0.29),
    part(box(0.08, 0.05, 0.03), 0x2a2a22, 0, 0.5, -0.29),
  ];
  if (open) p.push(
    // The lid leans against the side; the crate stands empty and dark.
    part(box(0.72, 0.02, 0.48), 0x1a1c14, 0, 0.585, 0),
    part(box(0.84, 0.05, 0.6), 0x445030, 0, 0.34, -0.42, 1.25, 0, 0),
    part(box(0.2, 0.08, 0.12), 0x8a7a50, 0.55, 0.04, 0.3, 0, 0.5, 0),
  );
  else p.push(
    part(box(0.84, 0.06, 0.6), 0x445030, 0, 0.62, 0),
    part(box(0.86, 0.02, 0.08), band, 0, 0.655, 0),
  );
  return p;
}

const PROPS = [houseProp, carProp, crateProp];

// Loot sites: a prop per site, instanced per kind and state, and a pulsing glint over the
// ones nobody has searched yet.
export class Loot {
  group = new THREE.Group();
  private mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  private glintMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private geos: THREE.BufferGeometry[] = [];
  // [kind * 2 + opened]
  private meshes: THREE.InstancedMesh[] = [];
  private glints: THREE.InstancedMesh;
  private sites: SiteDef[] = [];
  // Per site: where the prop stands and which way it faces.
  private px = new Float32Array(0); private pz = new Float32Array(0); private yaw = new Float32Array(0);
  private sig = '';

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    for (const mk of PROPS) for (const open of [false, true]) this.geos.push(merge(mk(open)));
    const pulse = sin(time.mul(3.2).add(positionWorld.x.mul(1.7)).add(positionWorld.z.mul(2.3))).mul(0.4).add(0.8);
    this.glintMat.colorNode = color(0xffc850).mul(pulse);
    this.glintMat.fog = false;
    this.glints = new THREE.InstancedMesh(octa(0.15), this.glintMat, 1);
    this.glints.frustumCulled = false;
    this.glints.count = 0;
    this.glints.renderOrder = 3;
    this.group.add(this.glints);
  }

  setup(sites: SiteDef[]): void {
    for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
    this.meshes = [];
    this.sites = sites;
    this.sig = '';
    const n = sites.length;
    this.px = new Float32Array(n); this.pz = new Float32Array(n); this.yaw = new Float32Array(n);
    const counts = [0, 0, 0];
    sites.forEach((s, i) => {
      counts[propKind(s.kind)] = (counts[propKind(s.kind)] ?? 0) + 1;
      if (!walled(s.kind)) {
        this.px[i] = siteX(s); this.pz[i] = siteY(s);
        this.yaw[i] = s.kind === SiteKind.Car ? hash(i, 1) * 6.28 : (Math.floor(hash(i, 1) * 4) + (hash(i, 2) - 0.5) * 0.4) * Math.PI / 2;
        return;
      }
      // Beside the searcher, towards the roomiest side of the house, facing back at the spot.
      const room = [s.x + s.w - 1 - s.sx, s.y + s.h - 1 - s.sy, s.sx - s.x - 1, s.sy - s.y - 1];
      let k = 0;
      for (let d = 1; d < 4; d++) if (room[d] > room[k]) k = d;
      const off = Math.max(0, Math.min(0.75, room[k] - 0.6));
      const a = k * Math.PI / 2;
      this.px[i] = s.sx + Math.cos(a) * off; this.pz[i] = s.sy + Math.sin(a) * off;
      this.yaw[i] = a + Math.PI;
    });
    for (let k = 0; k < 6; k++) {
      const cap = Math.max(1, counts[k >> 1] ?? 0);
      const m = new THREE.InstancedMesh(this.geos[k], this.mat, cap);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.meshes.push(m);
      this.group.add(m);
    }
    if (this.glints.instanceMatrix.count < n) {
      this.group.remove(this.glints);
      this.glints.dispose();
      this.glints = new THREE.InstancedMesh(this.glints.geometry, this.glintMat, Math.max(1, n));
      this.glints.frustumCulled = false; this.glints.renderOrder = 3; this.glints.count = 0;
      this.group.add(this.glints);
    }
  }

  // Re-lays the props when a site changes state.
  private lay(game: Game): void {
    const f = game.cur;
    const fill = [0, 0, 0, 0, 0, 0];
    const c = new THREE.Color();
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const pk = propKind(s.kind);
      if (pk < 0 || pk > 2) continue;
      const open = f.siteSearched(i);
      const k = pk * 2 + (open ? 1 : 0), m = this.meshes[k], j = fill[k]++;
      writeMatrix(m.instanceMatrix.array as Float32Array, j * 16, this.px[i], 0, this.pz[i], this.yaw[i], 1);
      if (s.kind === SiteKind.Car) c.copy(lin(PAINT[Math.floor(hash(i, 3) * PAINT.length)])).multiplyScalar(1 / lin(CAR_BODY).r);
      else c.setRGB(1, 1, 1);
      // Searched props sit a shade darker, picked over and dusty.
      const b = (open ? 0.72 : 1) * (0.9 + hash(i, 4) * 0.2);
      (m.instanceColor!.array as Float32Array).set([c.r * b, c.g * b, c.b * b], j * 3);
    }
    this.meshes.forEach((m, k) => {
      m.count = fill[k];
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    });
  }

  update(game: Game, now: number): void {
    const f = game.cur;
    if (!this.sites.length) { this.glints.count = 0; return; }
    let sig = '' + f.nSites;
    for (let i = 0; i < f.nSites; i++) sig += ',' + f.sites[i];
    if (sig !== this.sig) { this.sig = sig; this.lay(game); }
    // Glints bob and turn; each its own phase.
    const t = now / 1000, a = this.glints.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.sites.length; i++) {
      if (f.siteSearched(i)) continue;
      const k = propKind(this.sites[i].kind), ph = hash(i, 5) * 6.28;
      const s = 1 + 0.18 * Math.sin(t * 3.2 + ph);
      writeMatrix(a, n++ * 16, this.px[i], (GLINT_Y[k] ?? 1.2) + Math.sin(t * 1.8 + ph) * 0.08, this.pz[i], t * 1.5 + ph, s, s * 1.6);
    }
    this.glints.count = n;
    this.glints.instanceMatrix.needsUpdate = true;
  }
}
