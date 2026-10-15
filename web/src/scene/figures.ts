import * as THREE from 'three/webgpu';
import { type Enc, PALETTE, PIECES } from './figures.gen';
import { chain } from './rig';

// The figures' meshes, modelled in Blender by tools/blender/figures.py and shipped in
// figures.gen.ts. Each piece is a little indexed mesh: per triangle a code (a slot or body
// region the caller colours, or a fixed colour) and a tone that weathers it, per vertex the
// joint it moves with and, where a limb bends, a second joint it shades into.

export const PELVIS = 12;

export interface Piece {
  pos: Float32Array; idx: Uint16Array; code: Uint8Array; tone: Uint8Array; smooth: boolean;
  j0: Uint8Array; j1: Uint8Array; w: Float32Array;
}

const cache = new Map<string, Piece | null>();

function bytes(b64: string): Uint8Array {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function decode(e: Enc): Piece {
  const v = bytes(e.v), t = bytes(e.t);
  const raw = new Int16Array(v.buffer, v.byteOffset, v.byteLength / 2);
  const pos = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) pos[i] = raw[i] / 4096;
  const n = pos.length / 3;
  const j0 = new Uint8Array(n), j1 = new Uint8Array(n), w = new Float32Array(n);
  if (e.j) {
    const j = bytes(e.j);
    for (let i = 0; i < n; i++) { j0[i] = j[i * 3]; j1[i] = j[i * 3 + 1]; w[i] = j[i * 3 + 2] / 255; }
  } else { j0.fill(e.j0 ?? 0); j1.fill(e.j0 ?? 0); w.fill(1); }
  return { pos, idx: new Uint16Array(t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength)), code: bytes(e.c), tone: bytes(e.k), smooth: e.s === 1, j0, j1, w };
}

// A piece by name, or null if there is none.
export function piece(name: string): Piece | null {
  if (!cache.has(name)) cache.set(name, PIECES[name] ? decode(PIECES[name]) : null);
  return cache.get(name)!;
}

// A code's colour as the caller dresses it: slots (0–31) and regions (32–63) are theirs; from
// 64 on the palette's. tri is the triangle's centre, for patterns.
export type Dress = (code: number, cx: number, cy: number, cz: number) => number;

export interface Use { p: Piece; at?: [number, number, number]; joint?: number }

const tmp = new THREE.Color();

// The pieces as one non-indexed geometry: positions, normals (smooth across a piece where it
// is organic, flat where it is hard), colours with their tone, and for skinning the joints
// each vertex follows as skinIndex/skinWeight through bone(j); or for creeps the `rj` chain
// rig.ts poses in the shader, and a `tone` attribute for the colours the shader swaps.
// keep, if given, picks the triangles by their first vertex's joint; only, by their code and
// centre.
export function build(uses: Use[], dress: Dress, mode: {
  bone?: (j: number) => number; rj?: boolean; keep?: (j: number) => boolean; toneAttr?: boolean;
  only?: (code: number, cx: number, cy: number, cz: number) => boolean;
} = {}): THREE.BufferGeometry {
  let tris = 0;
  for (const u of uses) tris += u.p.idx.length / 3;
  const P = new Float32Array(tris * 9), N = new Float32Array(tris * 9), C = new Float32Array(tris * 9);
  const SI = mode.bone ? new Uint16Array(tris * 12) : null, SW = mode.bone ? new Float32Array(tris * 12) : null;
  const RJ = mode.rj ? new Float32Array(tris * 9) : null, TN = mode.toneAttr ? new Float32Array(tris * 3) : null;
  let o = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
  for (const u of uses) {
    const { pos, idx, code, tone } = u.p;
    const [ox, oy, oz] = u.at ?? [0, 0, 0];
    const n = pos.length / 3;
    let vn: Float32Array | null = null;
    if (u.p.smooth) {
      vn = new Float32Array(n * 3);
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
        a.fromArray(pos, i0); b.fromArray(pos, i1); c.fromArray(pos, i2);
        fn.subVectors(c, b).cross(b.clone().sub(a));
        for (const i of [i0, i1, i2]) { vn[i] += fn.x; vn[i + 1] += fn.y; vn[i + 2] += fn.z; }
      }
    }
    for (let t = 0; t < idx.length; t += 3) {
      const first = idx[t];
      const jt = u.joint ?? u.p.j0[first];
      if (mode.keep && !mode.keep(jt)) continue;
      a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
      fn.subVectors(c, b).cross(b.clone().sub(a)).normalize();
      const cx = (a.x + b.x + c.x) / 3 + ox, cy = (a.y + b.y + c.y) / 3 + oy, cz = (a.z + b.z + c.z) / 3 + oz;
      if (mode.only && !mode.only(code[t / 3], cx, cy, cz)) continue;
      const k = tone[t / 3] / 128;
      const hex = dress(code[t / 3], cx, cy, cz);
      tmp.setHex(hex, THREE.SRGBColorSpace);
      if (!TN) tmp.multiplyScalar(k);
      for (let q = 0; q < 3; q++) {
        const vi = idx[t + q], v3 = vi * 3, d = o * 3;
        P[d] = pos[v3] + ox; P[d + 1] = pos[v3 + 1] + oy; P[d + 2] = pos[v3 + 2] + oz;
        if (vn) { a.set(vn[v3], vn[v3 + 1], vn[v3 + 2]).normalize(); N[d] = a.x; N[d + 1] = a.y; N[d + 2] = a.z; }
        else { N[d] = fn.x; N[d + 1] = fn.y; N[d + 2] = fn.z; }
        C[d] = tmp.r; C[d + 1] = tmp.g; C[d + 2] = tmp.b;
        const ja = u.joint ?? u.p.j0[vi], jb = u.joint ?? u.p.j1[vi], w = u.joint !== undefined ? 1 : u.p.w[vi];
        if (SI && SW && mode.bone) {
          SI[o * 4] = mode.bone(ja); SI[o * 4 + 1] = mode.bone(jb);
          SW[o * 4] = w; SW[o * 4 + 1] = 1 - w;
        }
        if (RJ) { const ch = chain(ja === PELVIS ? -1 : ja); RJ[d] = ch[0]; RJ[d + 1] = ch[1]; RJ[d + 2] = ch[2]; }
        if (TN) TN[o] = k;
        o++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P.slice(0, o * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N.slice(0, o * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(C.slice(0, o * 3), 3));
  if (SI && SW) {
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI.slice(0, o * 4), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(SW.slice(0, o * 4), 4));
  }
  if (RJ) geo.setAttribute('rj', new THREE.BufferAttribute(RJ.slice(0, o * 3), 3));
  if (TN) geo.setAttribute('tone', new THREE.BufferAttribute(TN.slice(0, o), 1));
  geo.computeBoundingSphere();
  return geo;
}

// A fixed colour's hex, for codes from 64.
export function fixedColor(code: number): number { return PALETTE[code - 64] ?? 0xff00ff; }
