import * as THREE from 'three/webgpu';

// World space: tile (x, y) maps to (x, height, y). Looking down from +Y with the camera on
// the +Z side, x runs right and tile y runs down the screen, like the minimap.

const tmpColor = new THREE.Color();

// A hex colour in linear space, as vertex and instance colours need it.
export function lin(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

export function linInto(out: Float32Array, o: number, hex: number, mul = 1): void {
  tmpColor.setHex(hex, THREE.SRGBColorSpace);
  out[o] = tmpColor.r * mul; out[o + 1] = tmpColor.g * mul; out[o + 2] = tmpColor.b * mul;
}

export const PLAYER_COLORS = [0x3d8bff, 0xff4d4d, 0x3ddc84, 0xffc53d, 0xc77dff, 0x2fd6d6, 0xff8c3d, 0xf06bb5];
export const BASE_COLOR = 0x8a8676;
export function playerColor(id: number): number {
  return id < 0 ? BASE_COLOR : PLAYER_COLORS[id % PLAYER_COLORS.length];
}
export function cssHex(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

// One coloured piece of a model, to be merged with others into one flat-shaded geometry.
export interface Part { geo: THREE.BufferGeometry; color: number }

export function part(geo: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): Part {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  geo.applyMatrix4(m);
  return { geo, color };
}

// Merges parts into one non-indexed geometry with flat normals and a colour attribute.
export function merge(parts: Part[]): THREE.BufferGeometry {
  let n = 0;
  const flat = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    n += g.getAttribute('position').count;
    return { g, color: p.color };
  });
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, color } of flat) {
    const a = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i++) {
      pos[(o + i) * 3] = a.getX(i); pos[(o + i) * 3 + 1] = a.getY(i); pos[(o + i) * 3 + 2] = a.getZ(i);
      linInto(col, (o + i) * 3, color);
    }
    o += a.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
export const cone = (r: number, h: number, seg = 6) => new THREE.ConeGeometry(r, h, seg);
export const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
export const dodeca = (r: number) => new THREE.DodecahedronGeometry(r, 0);
export const octa = (r: number) => new THREE.OctahedronGeometry(r, 0);
export const sphere = (r: number, ws = 8, hs = 6) => new THREE.SphereGeometry(r, ws, hs);
export const torus = (r: number, t: number, rs = 6, ts = 12) => new THREE.TorusGeometry(r, t, rs, ts);

// Writes a Y rotation + uniform scale + translation matrix into a column-major array.
export function writeMatrix(a: Float32Array, o: number, x: number, y: number, z: number, heading: number, s: number, sy = s): void {
  // heading 0 faces +x; positive turns towards +z (tile +y).
  const c = Math.cos(heading) * s, sn = Math.sin(heading) * s;
  a[o] = c; a[o + 1] = 0; a[o + 2] = sn; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = -sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}

// The rotation.y that makes a +x-facing model face heading (as writeMatrix does).
export function yaw(heading: number): number { return -heading; }

// NodeMaterial honours emissiveNode on every lit material; the typings only declare it on
// MeshStandardNodeMaterial.
export function setEmissive(mat: THREE.NodeMaterial, node: THREE.Node): void {
  (mat as unknown as { emissiveNode: THREE.Node }).emissiveNode = node;
}
