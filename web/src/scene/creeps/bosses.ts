import * as THREE from 'three/webgpu';
import { box, dodeca, ico } from '../util';
import { J, rp, type RigPart } from '../rig';
import { PAL, blend, darker, stained } from '../palette';
import { rig, type CreepRig } from '../creepModels';

// The three bosses, built in metres against a 1.8 m survivor and stood at their true size:
// the abomination, several of the dead grown into one mass; the broodmother, a woman swollen
// round the brood she spills; the goliath, a giant of a man in what is left of a welder's and
// rigger's kit. Grounded body horror made of people and what they wore: dead skin, worn and
// bloodied clothes, one small true accent each, nothing that glows.
//
// The far model keeps the parts at least a tenth of the figure's height across (rig.ts
// farParts), so the big shapes here are few and cheap (open-ended prisms, plain boxes, one
// lump or two) and everything else stays under that size, a long thin thing (a vein, a strap,
// a limb that is not part of the silhouette) made of short pieces.
//
// A metre in world units: a survivor stands 1.8 tall in the world (heroes.ts builds one in
// metres).
const M = 1;

// Dead skin, from the picture: ashen, grey-green, the dark of the shaded side, blotched red.
const ASH = PAL.deadSkin, GREEN = PAL.deadSkinGreen, DUSK = PAL.deadSkinDark, PALE = PAL.deadSkinPale;
const BLOOD = PAL.blood, GORE = PAL.bloodFresh, CLOT = PAL.bloodDark;
const SOCKET = PAL.ink, MOUTH = 0x2a1410, STITCH = PAL.inkWarm;

type V3 = [number, number, number];
const Y = new THREE.Vector3(0, 1, 0);

// Parts hung on one joint at a time, with the shapes the bosses are made of.
class Kit {
  p: RigPart[] = [];
  j: number = J.CHEST;
  on(j: number): this { this.j = j; return this; }
  add(geo: THREE.BufferGeometry, c: number, m?: THREE.Matrix4): this {
    if (m) geo.applyMatrix4(m);
    this.p.push(rp(this.j, { geo, color: c }));
    return this;
  }
  // A box at (x, y, z), turned by (rx, ry, rz).
  box(w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0): this {
    return this.add(box(w, h, d), c, mat([x, y, z], rx, ry, rz));
  }
  // A limb or trunk from a to b, r0 thick at a and r1 at b, n-sided, its depth (x) `flat` of
  // its breadth; its ends open (they are inside a joint) unless capped: `cap` 1 closes the a
  // end, 2 the b end, 3 both.
  seg(a: V3, b: V3, r0: number, r1: number, c: number, n = 6, flat = 1, cap = 0): this {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const d = B.clone().sub(A), len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(Y, d.normalize());
    return this.add(prism(r0, r1, len, n, flat, cap), c, new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  }
  // The same in `k` pieces end to end: a limb too small to keep in the far model.
  limb(a: V3, b: V3, r0: number, r1: number, c: number, n = 5, k = 2): this {
    const at = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let i = 0; i < k; i++) this.seg(at(i / k), at((i + 1) / k), r0 + (r1 - r0) * i / k, r0 + (r1 - r0) * (i + 1) / k, c, n);
    return this;
  }
  // A lump of flesh: a dodecahedron (or, `small`, an icosahedron) stretched to (sx, sy, sz).
  blob(r: number, c: number, x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0, small = false): this {
    const g = small ? ico(r, 0) : dodeca(r);
    g.scale(sx, sy, sz);
    return this.add(g, c, mat([x, y, z], rx, ry, rz));
  }
  // A box laid on an ellipsoid's surface (centre o, radii r) at azimuth a (from +x towards
  // +z) and elevation e: w thick along the surface's normal, h along its upward line, d
  // across, turned `roll` about the normal, `sink` of it below the surface.
  on3(o: V3, r: V3, a: number, e: number, w: number, h: number, d: number, c: number, roll = 0, sink = 0.5): this {
    const dx = Math.cos(e) * Math.cos(a), dy = Math.sin(e), dz = Math.cos(e) * Math.sin(a);
    const n = new THREE.Vector3(dx / r[0], dy / r[1], dz / r[2]).normalize();
    const up = Y.clone().addScaledVector(n, -n.y);
    if (up.lengthSq() < 1e-4) up.set(-1, 0, 0);
    up.normalize();
    const across = new THREE.Vector3().crossVectors(n, up);
    const pos = new THREE.Vector3(o[0] + r[0] * dx, o[1] + r[1] * dy, o[2] + r[2] * dz).addScaledVector(n, w * (0.5 - sink));
    const g = box(w, h, d);
    g.rotateX(roll);
    return this.add(g, c, new THREE.Matrix4().makeBasis(n, up, across).setPosition(pos));
  }
  // A line of short boxes over an ellipsoid from (a0, e0) to (a1, e1): a vein, a seam, a
  // strip of cloth.
  line3(o: V3, r: V3, a0: number, e0: number, a1: number, e1: number, k: number, w: number, d: number, c: number, sink = 0.5): this {
    for (let i = 0; i < k; i++) {
      const t0 = i / k, t1 = (i + 1) / k, tm = (t0 + t1) / 2;
      const p = (t: number): THREE.Vector3 => {
        const a = a0 + (a1 - a0) * t, e = e0 + (e1 - e0) * t;
        return new THREE.Vector3(r[0] * Math.cos(e) * Math.cos(a), r[1] * Math.sin(e), r[2] * Math.cos(e) * Math.sin(a));
      };
      const len = p(t1).distanceTo(p(t0)) * 1.1;
      // The piece's lean against the surface's upward line, from where its ends are.
      const de = (e1 - e0) * r[1], da = (a1 - a0) * Math.max(r[0], r[2]) * Math.cos(e0 + (e1 - e0) * tm);
      this.on3(o, r, a0 + (a1 - a0) * tm, e0 + (e1 - e0) * tm, w, len, d, c, Math.atan2(da, de), sink);
    }
    return this;
  }
  // Parts built about the origin by f, then all moved by m: a head set at a slant.
  group(m: THREE.Matrix4, f: (k: Kit) => void): this {
    const k = new Kit().on(this.j);
    f(k);
    for (const q of k.p) { q.geo.applyMatrix4(m); this.p.push(q); }
    return this;
  }
}

// An n-sided prism along y, h long, r0 across at the bottom and r1 at the top, its x `flat` of
// its z; a closed end a fan of n - 2 triangles (three's cylinder spends n on it).
function prism(r0: number, r1: number, h: number, n: number, flat: number, cap: number): THREE.BufferGeometry {
  const ring = (r: number, y: number) => Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n + Math.PI / n;
    return [r * Math.cos(t) * flat, y, -r * Math.sin(t)];
  });
  const lo = ring(r0, -h / 2), hi = ring(r1, h / 2), out: number[] = [];
  const tri = (...v: number[][]) => { for (const p of v) out.push(p[0], p[1], p[2]); };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(lo[i], lo[j], hi[j]);
    tri(lo[i], hi[j], hi[i]);
  }
  for (let i = 1; i < n - 1; i++) {
    if (cap & 1) tri(lo[0], lo[i + 1], lo[i]);
    if (cap & 2) tri(hi[0], hi[i], hi[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

function mat(at: V3, rx = 0, ry = 0, rz = 0, s = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));
}

// A head of the dead about its neck's base at the origin, facing +x, 0.25 m tall at s = 1:
// the skull, a slack open jaw, sunk sockets, ears, what is left of the hair.
function head(k: Kit, skin: number, hair: number | null, s = 1, gape = 1, ears = true): void {
  const q = (v: number) => v * s, sh = darker(skin, 0.72);
  k.seg([0, 0, 0], [q(0.02), q(0.08), 0], q(0.055), q(0.05), sh, 5);
  k.blob(q(0.115), skin, q(0.02), q(0.155), 0, 1.02, 1.12, 0.86);
  k.box(q(0.12), q(0.06 + 0.02 * gape), q(0.12), sh, q(0.055), q(0.06), 0, 0, 0, -0.15 * gape);
  k.box(q(0.035), q(0.03), q(0.17), sh, q(0.115), q(0.175), 0);
  for (const z of [q(0.045), -q(0.045)]) {
    k.box(q(0.03), q(0.035), q(0.045), SOCKET, q(0.118), q(0.145), z);
    if (ears) k.box(q(0.05), q(0.07), q(0.03), sh, q(0.0), q(0.14), z * 2.35);
  }
  k.box(q(0.03), q(0.03 + 0.035 * gape), q(0.08), MOUTH, q(0.115), q(0.075 - 0.01 * gape), 0);
  k.box(q(0.02), q(0.07), q(0.035), BLOOD, q(0.12), q(0.03), q(0.03));
  if (hair !== null) {
    k.box(q(0.2), q(0.05), q(0.2), hair, q(0.0), q(0.255), 0, 0, 0, 0.1);
    k.box(q(0.07), q(0.15), q(0.19), hair, q(-0.085), q(0.18), 0);
  }
}

// The left limb joint and its right twin: the right is filled in by `rig` from the left.
const L = (s: number, l: number, r: number) => (s > 0 ? l : r);

// ---------------------------------------------------------------------------------------
// The abomination: four or five of the dead grown into one heap, hunched over two legs that
// were never the same person's. A man in a white shirt with bloody hand prints on it leads,
// leaning out of the front; a body in a flannel shirt is fused across its left side, one in a
// grey hoodie lies across its shoulders, a denim jacket's upside down in its back with a leg
// in jeans still kicking up out of it. Heads sunk into the shoulders, arms everywhere: two
// long ones it knuckles along on, one raised over the top, one grabbing out of its right
// flank, one hanging dead down its back in the sleeve of a nurse's teal scrubs, its one true
// colour.
export function abomination(): CreepRig {
  const k = new Kit();
  const SHIRT = stained(PAL.shirtWhite, BLOOD, 0.1), PLAID = PAL.plaid, PLAID2 = darker(PAL.plaid, 0.62);
  const JACKET = PAL.denim, JEANS = PAL.denimDark, KHAKI = PAL.khaki, HOODIE = PAL.shirtGrey;
  const FLESH = blend(GREEN, DUSK, 0.45), RAW = blend(DUSK, BLOOD, 0.35);
  const CORE: V3 = [-0.2, 1.95, 0], CR: V3 = [0.9, 0.82, 1.0], CS: V3 = [CR[0] * 0.84, CR[1] * 0.84, CR[2] * 0.84];
  const core = (a: number, e: number, w: number, h: number, d: number, c: number, roll = 0, sink = 0.55) => k.on3(CORE, CS, a, e, w, h, d, c, roll, sink);

  // Legs: on the left a man's in jeans and a boot, on the right a bigger one's in work
  // trousers torn off at the knee, bare to the foot.
  for (const s of [1, -1]) {
    const z = 0.5 * s;
    k.on(L(s, J.THIGH_L, J.THIGH_R));
    k.seg([0, 1.2, z], [0.06, 0.56, z], 0.34, 0.27, s > 0 ? JEANS : KHAKI, 5);
    k.on(L(s, J.SHIN_L, J.SHIN_R));
    if (s > 0) {
      k.seg([0.06, 0.6, z], [0.02, 0.18, z], 0.27, 0.23, JEANS, 5);
      k.box(0.32, 0.22, 0.32, PAL.leather, 0.06, 0.11, z);
      k.box(0.2, 0.18, 0.3, PAL.leather, 0.3, 0.09, z);
      k.box(0.3, 0.06, 0.32, PAL.rubber, 0.2, 0.03, z);
    } else {
      k.box(0.08, 0.14, 0.32, darker(KHAKI, 0.75), 0.25, 0.58, z, 0, 0, 0.2);
      k.seg([0.06, 0.6, z], [0.02, 0.1, z], 0.24, 0.19, FLESH, 5);
      k.box(0.32, 0.13, 0.28, FLESH, 0.1, 0.065, z);
      for (const dz of [-0.06, 0.06]) k.box(0.1, 0.06, 0.1, darker(FLESH, 0.8), 0.3, 0.03, z + dz);
      k.box(0.05, 0.2, 0.12, BLOOD, 0.24, 0.32, z);
    }
  }
  // The hips under it, more than one pair of them.
  k.on(-1);
  k.box(0.32, 0.3, 0.32, JEANS, 0, 1.15, 0.33);
  k.box(0.32, 0.3, 0.32, KHAKI, 0, 1.15, -0.28);

  // The heap: the flesh it is all grown into, blotched and split.
  k.on(J.CHEST);
  k.blob(1, FLESH, CORE[0], CORE[1], CORE[2], CR[0], CR[1], CR[2], 0, 0.3, 0);
  for (const [a, e, w] of [[1.2, 0.9, 0.3], [-1.0, 0.1, 0.3], [2.6, -0.1, 0.25], [-2.8, 0.9, 0.3], [0.5, 1.2, 0.25], [-0.4, -0.5, 0.3]]) core(a, e, 0.05, w, w * 0.8, a > 0 ? BLOOD : RAW, a);
  // The man in front, leaning out of it: the white shirt, a hand printed on it in blood.
  k.seg([0.3, 1.25, 0.05], [0.5, 2.3, 0.02], 0.5, 0.54, SHIRT, 6, 0.66);
  k.seg([0.5, 2.3, 0.02], [0.45, 2.55, 0.02], 0.54, 0.28, ASH, 6, 0.7, 2);
  for (const s of [1, -1]) k.box(0.08, 0.12, 0.3, SHIRT, 0.76, 2.12, 0.02 + 0.15 * s, 0, 0, -0.17);
  for (const [y, z, a] of [[1.78, 0.2, 0.2], [1.5, -0.18, -0.4]] as const) {
    k.box(0.04, 0.16, 0.13, GORE, 0.8, y, z, a, 0, -0.17);
    k.box(0.04, 0.1, 0.1, GORE, 0.815, y + 0.12, z + a * 0.08, a, 0, -0.17);
  }
  k.box(0.05, 0.3, 0.3, BLOOD, 0.74, 1.32, 0.15, 0, 0, -0.17);
  // The flannel body across the left side, on its back, the shirt split.
  k.seg([-0.35, 1.45, 0.72], [0.2, 2.3, 0.98], 0.44, 0.4, PLAID, 6, 0.72);
  for (const s of [1, -1]) k.box(0.06, 0.06, 0.3, PLAID2, -0.08 + 0.16 * s, 1.88, 0.85 + 0.12 * s, 0, 0.6 * s, 0);
  k.box(0.06, 0.3, 0.18, BLOOD, -0.05, 1.85, 1.2, 0.55, 0, 0.55);
  // The one in the hoodie, face down across its shoulders, hood up.
  k.seg([-0.35, 2.55, 0.75], [-0.25, 2.75, -0.55], 0.32, 0.3, HOODIE, 6, 0.8);
  k.box(0.24, 0.22, 0.24, darker(HOODIE, 0.8), -0.24, 2.78, -0.75, 0.3, 0, 0);
  k.box(0.08, 0.2, 0.2, darker(HOODIE, 0.6), -0.1, 2.72, -0.82, 0.3, 0, 0);
  // The denim jacket, upside down in its back, a leg in jeans still kicking up out of it.
  k.seg([-0.8, 2.45, -0.45], [-0.5, 1.6, -0.82], 0.42, 0.4, JACKET, 6, 0.7);
  for (const z of [-0.42, -0.82]) k.box(0.06, 0.08, 0.3, darker(JACKET, 0.7), -0.67, 2.2, z, 0.3, 0, 0.3);
  k.seg([-0.85, 2.6, -0.2], [-1.35, 3.05, -0.25], 0.2, 0.17, JEANS, 4);
  k.seg([-1.35, 3.05, -0.25], [-1.55, 2.6, -0.3], 0.17, 0.13, JEANS, 4);
  k.box(0.3, 0.16, 0.2, PAL.leatherDark, -1.6, 2.48, -0.3, 0, 0, -0.5);
  // Where one body grows into the next: raw seams, and a spine split open down the back.
  k.line3(CORE, CS, 1.7, -0.2, 2.2, 0.9, 3, 0.06, 0.1, CLOT);
  k.line3(CORE, CS, -1.6, -0.3, -2.3, 0.7, 3, 0.06, 0.1, CLOT);
  k.line3(CORE, CS, Math.PI + 0.1, -0.1, Math.PI + 0.15, 0.95, 4, 0.05, 0.26, BLOOD);
  for (let i = 0; i < 3; i++) core(Math.PI + 0.12, 0.1 + i * 0.3, 0.12, 0.08, 0.13, PAL.bone, 0, 0.4);
  // Heads sunk into the shoulders: one on the left, rolled over and gaping at the sky, one in
  // the back, only its crown and its eyes above the flesh.
  k.group(mat([0.05, 2.5, 0.72], 0.9, 0.3, 0.5, 1.15), (h) => head(h, PALE, PAL.hairBrown, 1, 1.5, false));
  k.group(mat([-0.75, 2.5, -0.05], 0, Math.PI * 0.85, 0.5, 1.15), (h) => head(h, ASH, PAL.hairBlack, 1, 0.5, false));
  // An arm hanging dead down its back, in what is left of a nurse's scrubs.
  k.seg([-0.82, 2.2, 0.6], [-0.88, 1.98, 0.65], 0.15, 0.14, PAL.teal, 5);
  k.limb([-0.82, 2.15, 0.6], [-1.05, 1.35, 0.8], 0.12, 0.1, PALE, 5, 4);
  k.limb([-1.05, 1.35, 0.8], [-1.0, 0.75, 0.86], 0.1, 0.085, PALE, 5, 3);
  k.box(0.14, 0.22, 0.09, PALE, -0.98, 0.62, 0.88);

  // The leader's head, sunk to the ears between its shoulders.
  k.on(J.HEAD).group(mat([0.55, 2.36, 0.02], 0, 0, -0.1, 1.3), (h) => head(h, ASH, PAL.hairBlack, 1, 1.2));

  // The arms it walks on: the left a thin man's in flannel, the right a big man's in denim.
  for (const s of [1, -1]) {
    const z = 1.0 * s, big = s < 0 ? 1.25 : 1, skin = s > 0 ? ASH : FLESH, cloth = s > 0 ? PLAID : JACKET;
    k.on(L(s, J.UARM_L, J.UARM_R));
    k.seg([0.45, 2.45, z], [0.6, 1.45, z + 0.1 * s], 0.2 * big, 0.16 * big, skin, 5);
    k.seg([0.45, 2.5, z], [0.53, 2.0, z + 0.04 * s], 0.25 * big, 0.23 * big, cloth, 5);
    k.box(0.04, 0.3, 0.05, STITCH, 0.6 + 0.04 * big, 1.8, z + 0.07 * s, 0, 0, 0.15);
    k.box(0.05, 0.2, 0.14, BLOOD, 0.55, 1.65, z - 0.12 * s, 0, 0, 0.15);
    k.on(L(s, J.FARM_L, J.FARM_R));
    k.seg([0.6, 1.45, z + 0.1 * s], [0.82, 0.42, z + 0.1 * s], 0.16 * big, 0.13 * big, skin, 5);
    k.box(0.06, 0.22, 0.12, BLOOD, 0.78, 0.85, z + 0.1 * s, 0, 0, 0.2);
    k.box(0.24 * big, 0.3, 0.2 * big, skin, 0.88, 0.27, z + 0.1 * s, 0, 0, 0.15);
    k.box(0.26 * big, 0.1, 0.22 * big, darker(skin, 0.8), 0.95, 0.06, z + 0.1 * s);
  }
  // One raised over the top, reaching ahead for whatever it is coming for.
  k.on(J.X);
  k.limb([-0.3, 2.65, 0.3], [0.05, 3.35, 0.42], 0.14, 0.12, PALE, 5, 4);
  k.limb([0.05, 3.35, 0.42], [0.62, 3.2, 0.48], 0.12, 0.09, PALE, 5, 3);
  k.box(0.2, 0.08, 0.16, PALE, 0.76, 3.16, 0.48, 0, 0, -0.5);
  k.box(0.16, 0.035, 0.1, darker(PALE, 0.85), 0.88, 3.08, 0.48, 0, 0, -1.0);
  k.box(0.05, 0.2, 0.08, GORE, 0.08, 3.28, 0.5, 0, 0, 0.6);
  // One grabbing out of its right flank.
  k.on(J.X2);
  k.limb([0.25, 1.65, -0.85], [0.85, 1.42, -1.1], 0.15, 0.12, DUSK, 5, 3);
  k.limb([0.85, 1.42, -1.1], [1.25, 1.42, -1.0], 0.12, 0.1, DUSK, 5, 2);
  k.box(0.18, 0.06, 0.16, DUSK, 1.38, 1.4, -1.0);
  k.box(0.14, 0.03, 0.12, darker(DUSK, 0.85), 1.5, 1.36, -1.0, 0, 0, -0.5);

  return rig(k.p, {
    [J.CHEST]: { p: [0, 1.05, 0], walk: [0.06, 0, 0.12, -0.08], flex: [0, 0, 0.16, 0.04], wind: [0.38, 0, 0.25, 0], strike: [-0.45, 0, -0.35, 0], die: [-0.5, 0.25, 0, 0], misc: [0.08, 0.15, 0, 0] },
    [J.HEAD]: { p: [0.55, 2.4, 0.02], walk: [0.1, 1, 0.2, 0.05], flex: [0, 0, 0, 0.12], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.4, 0.4, 0, 0], misc: [0.15, 0.3, 0, 0] },
    [J.UARM_L]: { p: [0.45, 2.45, 1.0], walk: [0.42, Math.PI, 0, 0], flex: [0, 0, 0, 0.04], wind: [1.9, -0.35, 0.5, 0], strike: [0.25, 0, -1.0, 0], die: [-0.4, -0.6, 0, 0], misc: [-0.1, 0.8, 1, 1] },
    [J.FARM_L]: { p: [0.6, 1.45, 1.1], walk: [0.25, Math.PI + 0.6, 0, 0], wind: [0.6, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [0.3, 0, 0, 0], misc: [0, 0.6, 1, 1] },
    [J.X]: { p: [-0.3, 2.65, 0.3], walk: [0.3, 0.5, 0, 0], flex: [0, 0, 0, 0.1], wind: [0.8, 0, 0, 0], strike: [-1.0, 0, 0, 0], die: [-1.2, 0, 0, 0], misc: [0, 0.8, 0, 1] },
    [J.X2]: { p: [0.25, 1.65, -0.85], walk: [0.3, Math.PI + 0.5, 0, 0], flex: [0, 0, 0, 0.1], wind: [0.9, 0, 0, 0], strike: [-0.6, 0, 0, 0], die: [-0.8, 0, 0, 0], misc: [0, 0.8, 0, 1] },
    [J.THIGH_L]: { p: [0, 1.1, 0.5], walk: [0.32, 0, 0, 0], wind: [-0.12, 0, 0, 0], strike: [0.22, 0, 0, 0], die: [1.0, 0, 0, 0], misc: [0, 0.2, 1, 2] },
    [J.SHIN_L]: { p: [0.06, 0.58, 0.5], flex: [-0.6, Math.PI / 2, 0, 0], die: [-1.6, 0, 0, 0], misc: [0, 0.2, 1, 2] },
  }, { stride: 2.0, bob: 0.06, drop: 0.32, turn: 2.5, flinch: 0.1, scale: M });
}

// ---------------------------------------------------------------------------------------
// The broodmother: a woman once, the top of her still a woman's, rising out of the front of a
// belly swollen to the ground and a back swollen behind it, and in both the small dead she
// carries pressing out under skin stretched thin: a hand, a face, a knee, a curled back. She
// goes on all fours on limbs that were hers, thin and too long for what they carry. The dress
// she died in is burst down the back and stretched in strips over the swell; its faded plum
// is her one colour. She rears back and heaves a sac up out of her throat; split open, the
// brood spills out of her.
export function broodmother(): CreepRig {
  const k = new Kit();
  const SKIN = blend(DUSK, GREEN, 0.4), LIMB = blend(GREEN, DUSK, 0.55), VEIN = darker(PAL.blood, 0.8), UNDER = darker(SKIN, 0.84);
  const DRESS = blend(PAL.purple, PAL.shirtGrey, 0.3), DRESS2 = darker(DRESS, 0.7), HAIR = PAL.hairBrown;
  const BELLY: V3 = [0.1, 0.98, 0], BR: V3 = [0.95, 0.8, 0.85], BS: V3 = [BR[0] * 0.86, BR[1] * 0.86, BR[2] * 0.86];
  const BACK: V3 = [-0.75, 1.5, 0], KR: V3 = [0.8, 0.62, 0.75], KS: V3 = [KR[0] * 0.86, KR[1] * 0.86, KR[2] * 0.86];
  const b = (a: number, e: number, w: number, h: number, d: number, c: number, roll = 0, sink = 0.45) => k.on3(BELLY, BS, a, e, w, h, d, c, roll, sink);
  const t = (a: number, e: number, w: number, h: number, d: number, c: number, roll = 0, sink = 0.45) => k.on3(BACK, KS, a, e, w, h, d, c, roll, sink);

  // Hind legs, folded under her like a woman crouched to give birth, the knees forward.
  for (const s of [1, -1]) {
    const z = 0.66 * s, zk = 0.72 * s;
    k.on(L(s, J.THIGH_L, J.THIGH_R));
    k.seg([-0.95, 1.4, z], [-0.45, 0.72, zk], 0.13, 0.09, LIMB, 5);
    k.box(0.14, 0.14, 0.12, darker(LIMB, 0.8), -0.45, 0.74, zk);
    k.box(0.1, 0.2, 0.18, DRESS2, -0.86, 1.25, z, 0, 0, -0.6);
    k.on(L(s, J.SHIN_L, J.SHIN_R));
    k.seg([-0.45, 0.72, zk], [-0.82, 0.08, zk], 0.08, 0.055, LIMB, 5);
    k.box(0.2, 0.06, 0.1, LIMB, -0.74, 0.03, zk);
    for (const dz of [-0.03, 0.03]) k.box(0.08, 0.04, 0.03, darker(LIMB, 0.85), -0.62, 0.02, zk + dz);
    k.box(0.05, 0.16, 0.08, BLOOD, -0.6, 0.45, zk);
  }
  // Forelimbs, her arms, the hands splayed flat.
  for (const s of [1, -1]) {
    const z = 0.4 * s, ze = 0.55 * s;
    k.on(L(s, J.UARM_L, J.UARM_R));
    k.seg([0.82, 2.18, z], [1.08, 1.12, ze], 0.085, 0.065, LIMB, 5);
    k.box(0.16, 0.18, 0.16, DRESS, 0.83, 2.12, z + 0.02 * s, 0, 0, -0.25);
    k.box(0.05, 0.14, 0.08, BLOOD, 1.02, 1.5, ze, 0, 0, -0.25);
    k.on(L(s, J.FARM_L, J.FARM_R));
    k.seg([1.08, 1.12, ze], [1.3, 0.1, ze], 0.065, 0.05, LIMB, 5);
    k.box(0.15, 0.05, 0.12, LIMB, 1.35, 0.04, ze);
    for (const [dz, a] of [[-0.05, -0.3], [0, 0], [0.05, 0.3]]) k.box(0.13, 0.03, 0.03, darker(LIMB, 0.85), 1.47, 0.02, ze + dz, 0, a, 0);
  }

  // The belly, slung between them almost to the ground, and the shapes under its skin.
  k.on(J.X);
  k.blob(1, SKIN, BELLY[0], BELLY[1], BELLY[2], BR[0], BR[1], BR[2], 0.2, 0.4, 0);
  // Veins over it.
  for (const [a0, e0, a1, e1] of [[0.3, -0.4, 0.5, 0.5], [-1.3, -0.2, -1.1, 0.6], [2.1, -0.3, 2.3, 0.5], [-2.2, -0.4, -2.4, 0.5]]) {
    k.line3(BELLY, BS, a0, e0, a1, e1, 3, 0.04, 0.05, VEIN, 0.4);
  }
  // A small hand pressed out from inside, a face, a knee, a curled back.
  b(0.55, 0.0, 0.08, 0.16, 0.12, UNDER, 0.3);
  for (const f of [-0.03, 0.03]) b(0.55 + f * 1.1, 0.13, 0.06, 0.1, 0.025, UNDER, 0.3);
  b(-0.35, 0.12, 0.1, 0.2, 0.16, UNDER);
  for (const f of [-0.07, 0.07]) b(-0.35 + f, 0.14, 0.05, 0.04, 0.035, SOCKET, 0, 0.1);
  b(-0.35, 0.05, 0.05, 0.05, 0.05, MOUTH, 0, 0.1);
  b(1.4, -0.25, 0.12, 0.18, 0.18, UNDER);
  b(-1.5, -0.15, 0.1, 0.2, 0.14, UNDER, 0.4);
  b(-1.5, 0.05, 0.1, 0.18, 0.14, UNDER, 0.2);
  b(2.4, 0.3, 0.1, 0.16, 0.2, UNDER);
  // Blotches, and a split, weeping.
  for (const [a, e] of [[0.05, -0.55], [1.9, 0.4], [-0.9, 0.5], [-2.7, -0.3], [2.8, 0.2], [0.4, 0.6]]) b(a, e, 0.05, 0.2, 0.17, a > 0 ? BLOOD : CLOT, a);
  b(-2.0, -0.4, 0.05, 0.2, 0.08, GORE, -0.3);
  b(-2.0, -0.2, 0.05, 0.2, 0.06, GORE, -0.1);

  // Her back, swollen as big again, sacs pushing out through the skin.
  k.on(J.X2);
  k.blob(1, SKIN, BACK[0], BACK[1], BACK[2], KR[0], KR[1], KR[2], 0, 0.5, 0.15);
  k.blob(0.1, UNDER, -0.95, 1.98, 0.3, 1, 0.85, 1, 0, 0, 0, true);
  k.blob(0.1, blend(SKIN, PAL.grassLit, 0.25), -1.2, 1.8, -0.32, 1, 0.9, 1, 0, 0, 0, true);
  k.blob(0.08, UNDER, -0.6, 2.05, -0.25, 1, 0.9, 1, 0, 0, 0, true);
  k.blob(0.08, blend(SKIN, PAL.grassLit, 0.25), -1.35, 1.55, 0.35, 1, 0.9, 1, 0, 0, 0, true);
  for (const [a0, e0, a1, e1] of [[1.8, -0.1, 2.0, 0.7], [-1.7, 0.1, -1.9, 0.8]]) k.line3(BACK, KS, a0, e0, a1, e1, 3, 0.04, 0.05, VEIN, 0.4);
  for (const [a, e] of [[3.0, -0.1], [2.0, 0.9], [-2.3, 0.6]]) t(a, e, 0.05, 0.2, 0.18, BLOOD, a);
  // The dress, burst down the back: strips of it still stretched across the swell.
  for (const a of [2.25, Math.PI, -2.25]) k.line3(BACK, KS, a, 0.15, a * 0.92, 1.05, 4, 0.04, 0.16, DRESS, 0.3);
  k.line3(BACK, KS, 1.4, -0.1, 1.9, 0.45, 4, 0.04, 0.16, DRESS2, 0.3);
  k.line3(BACK, KS, -1.4, -0.1, -1.9, 0.45, 4, 0.04, 0.16, DRESS2, 0.3);

  // What is left of the woman: hips in the dress's skirt, and rising out of the front of the
  // belly her starved chest and shoulders, the dress still on them.
  k.on(J.CHEST);
  k.seg([-1.15, 1.22, 0], [-0.7, 1.42, 0], 0.42, 0.46, DRESS2, 6, 0.85, 3);
  for (const s of [1, -1]) k.box(0.05, 0.2, 0.2, DRESS2, -1.32, 1.12, 0.2 * s, 0, 0, -0.2);
  k.seg([0.42, 1.55, 0], [0.8, 2.2, 0], 0.26, 0.3, DRESS, 6, 0.66, 2);
  for (const dz of [-0.08, 0, 0.08]) k.box(0.14, 0.025, 0.035, darker(LIMB, 0.75), 0.7, 1.72, dz, 0, 0, 1.0);
  k.box(0.08, 0.16, 0.2, LIMB, 0.86, 2.16, 0, 0, 0, -0.5);
  for (const s of [1, -1]) k.box(0.04, 0.2, 0.06, DRESS2, 0.74, 2.22, 0.18 * s, 0, 0, -0.4);

  // Her head, hung forward, the hair down round her face, the throat swollen with what is
  // coming up.
  k.on(J.HEAD);
  k.group(mat([0.88, 2.25, 0], 0, 0, -0.45, 1.1), (h) => head(h, LIMB, null, 1, 1.6));
  k.blob(0.08, SKIN, 0.98, 2.2, 0, 1.2, 0.9, 1.2, 0, 0, 0, true);
  k.box(0.08, 0.2, 0.26, HAIR, 0.82, 2.34, 0, 0, 0, -0.45);
  k.box(0.08, 0.2, 0.22, HAIR, 0.74, 2.16, 0, 0, 0, -0.2);
  k.box(0.2, 0.07, 0.22, HAIR, 0.96, 2.5, 0, 0, 0, -0.45);
  for (const s of [1, -1]) k.box(0.1, 0.2, 0.06, HAIR, 0.96, 2.28, 0.14 * s, 0, 0, -0.2);

  return rig(k.p, {
    [J.CHEST]: { p: [-0.95, 1.35, 0], walk: [0.03, 0, 0.08, 0], flex: [0, 0, 0.08, 0.03], wind: [0.38, 0, 0, 0], strike: [-0.25, 0, 0, 0], die: [-0.3, 0.45, 0, 0], misc: [0.06, 0.12, 0, 0] },
    [J.X]: { p: [0.05, 1.5, 0], walk: [0.04, 0.5, 0.06, 0], flex: [0, 0, 0, 0.03], wind: [0, 0, 0, 0.05], strike: [0, 0, 0, -0.06], die: [0.1, 0.2, 0, -0.08], misc: [0.05, 0.1, 0, 0] },
    [J.X2]: { p: [-0.75, 1.3, 0], walk: [0.03, 1.2, 0.05, 0], flex: [0, 0, 0, 0.04], wind: [-0.1, 0, 0, 0.04], strike: [0.1, 0, 0, -0.03], die: [0.15, 0, 0, -0.06], misc: [0.05, 0.1, 0, 0] },
    [J.HEAD]: { p: [0.86, 2.25, 0], walk: [0.06, 1, 0.12, 0], flex: [0, 0, 0, 0.08], wind: [0.9, 0, 0, 0], strike: [-0.9, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.1, 0.3, 0, 0] },
    [J.UARM_L]: { p: [0.82, 2.18, 0.4], walk: [0.3, Math.PI * 0.5, 0, 0], wind: [-0.6, -0.4, 0, 0], strike: [0.5, 0, 0, 0], die: [-0.3, -0.6, 0, 0], misc: [-0.1, 1.0, 1, 1] },
    [J.FARM_L]: { p: [1.08, 1.12, 0.55], walk: [0.18, Math.PI * 0.5 + 0.6, 0, 0], wind: [-0.6, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [0.9, 0, 0, 0], misc: [0, 0.8, 1, 1] },
    [J.THIGH_L]: { p: [-0.95, 1.4, 0.66], walk: [0.28, 0, 0, 0], wind: [0.15, 0, 0, 0], strike: [-0.1, 0, 0, 0], die: [0.6, 0.3, 0, 0], misc: [0, 0.3, 1, 2] },
    [J.SHIN_L]: { p: [-0.45, 0.72, 0.72], flex: [-0.5, Math.PI / 2, 0, 0], wind: [-0.25, 0, 0, 0], die: [-0.9, 0, 0, 0], misc: [0, 0.3, 1, 2] },
  }, { stride: 1.7, bob: 0.05, drop: 0.35, turn: 2.2, flinch: 0.15, scale: M });
}

// ---------------------------------------------------------------------------------------
// The goliath: a man nearly three times a survivor's height, still in what he wore to work: a
// faded blue work shirt burst off his shoulders, a welder's leather apron and gauntlet, a
// rigger's harness over it all, work trousers and steel-toed boots, the welding hood pushed
// up on his head with the one bit of colour he has, a yellow sticker. Stitched where he has
// split, a chain wound round his right fist and dragging. Slow and heavy, hunched, the arms
// hanging to his knees.
export function goliath(): CreepRig {
  const k = new Kit();
  const SKIN = blend(GREEN, DUSK, 0.5), SKD = darker(SKIN, 0.78);
  const TROUSERS = PAL.olive, SHIRT = stained(PAL.denimLight, PAL.dirtDark, 0.2), APRON = PAL.leather;
  const WEB = PAL.khaki, BOOT = PAL.leatherDark, STEEL = PAL.steel, CHAIN = PAL.steelDark, HOOD = PAL.wool;

  // Legs and the steel-toed boots.
  for (const s of [1, -1]) {
    const z = 0.38 * s;
    k.on(L(s, J.THIGH_L, J.THIGH_R));
    k.seg([0, 2.55, z], [0.04, 1.32, z], 0.3, 0.24, TROUSERS, 5);
    k.box(0.05, 0.24, 0.26, s > 0 ? SKIN : darker(TROUSERS, 0.7), 0.27, 1.45, z);
    k.box(0.05, 0.3, 0.18, darker(TROUSERS, 0.75), 0.27, 1.9, z - 0.04 * s);
    k.on(L(s, J.SHIN_L, J.SHIN_R));
    k.seg([0.04, 1.34, z], [0.01, 0.5, z], 0.25, 0.2, TROUSERS, 5);
    k.seg([0.01, 0.66, z], [0, 0.56, z], 0.23, 0.23, darker(TROUSERS, 0.75), 6);
    k.seg([0, 0.6, z], [0, 0.14, z], 0.21, 0.22, BOOT, 6);
    k.box(0.66, 0.26, 0.44, BOOT, 0.14, 0.15, z);
    k.box(0.16, 0.2, 0.42, PAL.steelDark, 0.43, 0.13, z);
    k.box(0.46, 0.07, 0.46, PAL.rubber, 0.2, 0.035, z);
    k.box(0.24, 0.07, 0.46, PAL.rubber, -0.13, 0.035, z);
  }
  // The seat of the trousers, the belt and the pouches on it, a hammer through its loop.
  k.on(-1);
  k.box(0.78, 0.55, 1.02, TROUSERS, 0, 2.55, 0);
  for (const s of [1, -1]) {
    k.box(0.43, 0.14, 0.4, PAL.leather, 0.21, 2.78, 0.33 * s);
    k.box(0.43, 0.14, 0.4, PAL.leather, -0.21, 2.78, 0.33 * s);
    k.box(0.26, 0.3, 0.16, PAL.leatherRed, -0.12, 2.6, 0.58 * s);
    k.box(0.27, 0.06, 0.17, darker(PAL.leatherRed, 0.7), -0.12, 2.74, 0.58 * s);
  }
  k.box(0.4, 0.14, 0.3, PAL.leather, 0.23, 2.78, 0);
  k.box(0.4, 0.14, 0.3, PAL.leather, -0.23, 2.78, 0);
  k.box(0.05, 0.12, 0.14, STEEL, 0.43, 2.78, 0);
  k.box(0.07, 0.4, 0.07, PAL.wood, -0.05, 2.42, 0.68);
  k.box(0.1, 0.1, 0.24, STEEL, -0.05, 2.66, 0.68);

  // The trunk: a belly, a barrel chest and shoulders bowed under their own weight, the shirt
  // torn open on them, the apron's bib and skirt hung in front, the harness over it all.
  k.on(J.CHEST);
  k.seg([0.05, 2.6, 0], [0.08, 3.25, 0], 0.56, 0.62, SHIRT, 6, 0.82);
  k.seg([0.08, 3.2, 0], [-0.05, 3.85, 0], 0.66, 0.64, SHIRT, 6, 0.74);
  k.seg([-0.06, 3.78, 0], [0.04, 4.08, 0], 0.62, 0.34, SKIN, 6, 0.72, 2);
  k.blob(0.42, SKIN, -0.3, 3.78, 0, 0.85, 0.75, 1.45, 0, 0, 0, true);
  for (const [x, y, z, a] of [[-0.62, 3.6, 0.3, 0.1], [-0.55, 3.2, -0.4, -0.2], [-0.4, 3.95, -0.4, 0.3]]) k.box(0.05, 0.22, 0.28, x > -0.6 ? BLOOD : CLOT, x, y, z, a, 0, 0.2);
  k.box(0.05, 0.42, 0.3, SKIN, 0.5, 3.0, -0.3, 0, 0, 0.1);
  k.box(0.05, 0.3, 0.04, STITCH, 0.53, 3.0, -0.3, 0, 0, 0.1);
  for (const s of [1, -1]) k.box(0.14, 0.12, 0.24, darker(SHIRT, 0.75), 0.36, 3.88, 0.24 * s, 0, 0.3 * s, -0.3);
  // The apron: the bib, and the skirt down to the knees, burnt and bloodied.
  k.box(0.06, 0.65, 0.9, APRON, 0.52, 3.38, 0, 0, 0, -0.06);
  k.box(0.07, 1.12, 1.02, APRON, 0.62, 2.35, 0, 0, 0, 0.06);
  k.box(0.02, 0.3, 0.3, darker(APRON, 0.6), 0.665, 2.1, 0.22, 0, 0, 0.06);
  k.box(0.02, 0.4, 0.2, GORE, 0.665, 2.55, -0.25, 0, 0, 0.06);
  k.box(0.02, 0.18, 0.4, BLOOD, 0.665, 1.9, -0.1, 0, 0, 0.06);
  for (const s of [1, -1]) k.box(0.05, 0.05, 0.06, STEEL, 0.55, 3.66, 0.4 * s);
  // The harness: shoulder straps down the front, a chest strap, the back's cross and D-ring,
  // and the lanyard hanging off it.
  for (const s of [1, -1]) {
    const z = 0.32 * s;
    k.box(0.06, 0.45, 0.12, WEB, 0.57, 3.62, z, 0, 0, -0.06);
    k.box(0.45, 0.06, 0.12, WEB, 0.32, 3.98, z, 0, 0, -0.2);
    k.box(0.06, 0.4, 0.12, WEB, 0.66, 3.0, z, 0, 0, 0.06);
    k.box(0.06, 0.4, 0.12, WEB, 0.66, 2.62, z, 0, 0, 0.06);
    k.box(0.06, 0.44, 0.12, WEB, -0.52, 3.55, z * 0.8, -0.5 * s, 0, 0);
    k.box(0.06, 0.4, 0.12, WEB, -0.5, 3.1, z * 1.3, 0.4 * s, 0, 0);
    k.box(0.06, 0.12, 0.38, WEB, 0.6, 3.38, 0.2 * s);
  }
  k.box(0.08, 0.14, 0.1, STEEL, 0.62, 3.38, 0);
  k.box(0.08, 0.16, 0.16, STEEL, -0.6, 3.75, 0);
  k.seg([-0.62, 3.7, 0], [-0.7, 3.25, 0.05], 0.035, 0.035, WEB, 4);
  k.seg([-0.7, 3.25, 0.05], [-0.62, 2.85, 0.1], 0.035, 0.035, WEB, 4);
  k.box(0.08, 0.16, 0.05, STEEL, -0.6, 2.75, 0.1);

  // Shoulders bare where the sleeves burst, arms hanging to the knees; a gauntlet on the left
  // hand, a chain wound round the right fist and dragging.
  for (const s of [1, -1]) {
    const z = 0.96 * s;
    k.on(L(s, J.UARM_L, J.UARM_R));
    k.blob(0.2, SKIN, 0, 3.8, z, 1.1, 1.0, 1.0, 0, 0, 0, true);
    k.seg([0.02, 3.72, z], [0.04, 2.7, z], 0.28, 0.23, SKIN, 5);
    k.box(0.04, 0.42, 0.04, STITCH, 0.28, 3.15, z, 0, 0, 0.05);
    k.box(0.05, 0.25, 0.2, BLOOD, 0.0, 3.0, z + 0.24 * s);
    k.box(0.05, 0.2, 0.2, CLOT, -0.24, 3.4, z + 0.05 * s, 0, 0, 0.1);
    k.on(L(s, J.FARM_L, J.FARM_R));
    k.seg([0.04, 2.74, z], [0.08, 1.75, z], 0.27, 0.19, SKIN, 5);
    k.box(0.05, 0.22, 0.16, BLOOD, 0.27, 2.4, z - 0.06 * s, 0, 0, 0.05);
    const hand = s > 0 ? APRON : SKD;
    if (s > 0) {
      k.seg([0.07, 2.1, z], [0.08, 1.7, z], 0.23, 0.22, APRON, 6);
      k.seg([0.07, 2.13, z], [0.07, 2.03, z], 0.235, 0.235, darker(APRON, 0.7), 6);
    } else {
      for (const y of [2.0, 1.9, 1.8]) k.seg([0.07, y + 0.035, z], [0.07, y - 0.035, z], 0.22, 0.22, CHAIN, 6);
    }
    k.box(0.34, 0.4, 0.28, hand, 0.1, 1.52, z);
    k.box(0.28, 0.26, 0.26, darker(hand, 0.85), 0.15, 1.24, z, 0, 0, -0.25);
    k.box(0.12, 0.2, 0.09, hand, 0.25, 1.5, z - 0.13 * s, 0, 0, -0.3);
    k.box(0.06, 0.12, 0.1, BLOOD, 0.28, 1.3, z, 0, 0, -0.25);
  }
  // The chain, hanging from the right fist to the ground and over it.
  k.on(J.FARM_R);
  for (let i = 0; i < 6; i++) {
    const y = 1.2 - i * 0.19, z = -0.96 + 0.01 * i;
    if (i % 2 === 0) k.box(0.1, 0.21, 0.035, CHAIN, 0.2 + 0.012 * i, y, z);
    else k.box(0.035, 0.21, 0.1, CHAIN, 0.2 + 0.012 * i, y, z);
  }
  k.box(0.07, 0.2, 0.07, STEEL, 0.32, 0.08, -0.88, 0, 0, 0.6);

  // The head: small for the body, bald, stitched over the crown, the jaw hanging; the welding
  // hood pushed up and back off his face.
  k.on(J.HEAD);
  k.seg([0.18, 3.92, 0], [0.34, 4.18, 0], 0.23, 0.22, SKIN, 5);
  k.group(mat([0.3, 4.02, 0], 0, 0, -0.12, 2.3), (h) => head(h, SKIN, null, 1, 0.9));
  k.box(0.42, 0.04, 0.05, STITCH, 0.32, 4.58, 0.08, 0, 0, -0.12);
  for (const x of [0.18, 0.3, 0.42]) k.box(0.04, 0.04, 0.12, STITCH, x, 4.58 - x * 0.12 + 0.04, 0.08);
  k.box(0.4, 0.06, 0.46, SKD, 0.28, 4.47, 0, 0, 0, -0.12);
  k.box(0.42, 0.08, 0.44, HOOD, 0.22, 4.68, 0, 0, 0, 0.55);
  for (const s of [1, -1]) k.box(0.34, 0.28, 0.06, HOOD, 0.2, 4.55, 0.25 * s, 0, 0, 0.55);
  k.box(0.18, 0.06, 0.22, PAL.ink, 0.32, 4.79, 0, 0, 0, 0.55);
  k.box(0.1, 0.06, 0.1, PAL.hardHat, 0.08, 4.62, 0.12, 0, 0, 0.55);

  return rig(k.p, {
    [J.CHEST]: { p: [0, 2.5, 0], walk: [0.03, 0, 0.08, -0.16], flex: [0, 0, 0.1, 0.03], wind: [0.35, 0, 0.3, 0], strike: [-0.55, 0, -0.25, 0], die: [-0.45, 0, 0.15, 0], misc: [0.06, 0.12, 0, 0] },
    [J.HEAD]: { p: [0.3, 4.0, 0], walk: [0.04, 1, 0.06, 0.12], flex: [0, 0, 0, 0.05], wind: [0.3, 0, 0, 0], strike: [-0.35, 0, 0, 0], die: [-0.5, 0.2, 0, 0], misc: [0.12, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0, 3.85, 0.96], walk: [0.26, Math.PI, -0.04, 0.05], flex: [0, 0, 0, 0.04], wind: [2.5, -0.5, 0, 0], strike: [0.6, 0.15, 0, 0], die: [-0.3, -0.35, 0, 0], misc: [-0.1, 0.6, 1, 1] },
    [J.FARM_L]: { p: [0.04, 2.72, 0.96], walk: [0.15, Math.PI + 0.5, 0, 0.25], wind: [0.9, 0, 0, 0], strike: [-0.15, 0, 0, 0], die: [0.1, 0, 0, 0], misc: [0, 0.5, 1, 1] },
    [J.THIGH_L]: { p: [0, 2.45, 0.38], walk: [0.34, 0, 0, 0], wind: [-0.12, 0, 0, 0], strike: [0.2, 0, 0, 0], die: [1.15, 0, 0, 0], misc: [0, 0.2, 1, 2] },
    [J.SHIN_L]: { p: [0.04, 1.33, 0.38], walk: [0, 0, 0, -0.04], flex: [-0.65, Math.PI / 2, 0, 0], strike: [-0.15, 0, 0, 0], die: [-1.9, 0, 0, 0], misc: [0, 0.2, 1, 2] },
  }, { stride: 3.6, bob: 0.09, drop: 0.55, turn: 3, flinch: 0.1, scale: M });
}
