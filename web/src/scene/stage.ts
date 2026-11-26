import * as THREE from 'three/webgpu';
import { dot, floor, fract, mix, positionWorld, sin, step, vec2, vec3 } from 'three/tsl';
import { painted } from './paint';
import { blend, PAL } from './palette';

// A lab's plain ground: a flat stage in the picture's ground colours, mottled in patches of a
// few scene pixels, for judging figures and light with no terrain in the way.
export function stage(x: number, z: number): THREE.Mesh {
  const mat = painted(new THREE.MeshLambertNodeMaterial());
  const hash = (p: THREE.Node<'vec2'>) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  // Smooth noise, k cells to a tile.
  const noise = (k: number, salt: number) => {
    const p = positionWorld.xz.mul(k).add(salt), i = floor(p), f = p.sub(i), u = f.mul(f).mul(f.mul(-2).add(3));
    return mix(mix(hash(i), hash(i.add(vec2(1, 0))), u.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x), u.y);
  };
  const lin = (hex: number) => { const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace); return vec3(c.r, c.g, c.b); };
  // Big damp and dry patches, and over them dabs a few scene pixels across, each one flat
  // colour: the picture's ground is a handful of olives and ochres, not a gradient.
  const big = noise(0.45, 3).mul(0.65).add(noise(1.3, 11).mul(0.35));
  const dab = noise(5, 5).mul(0.6).add(noise(13, 23).mul(0.4)).add(big.sub(0.5).mul(0.9));
  let c = mix(lin(blend(PAL.ground, PAL.groundDark, 0.8)), lin(PAL.ground), step(0.34, dab));
  c = mix(c, lin(PAL.groundLight), step(0.54, dab));
  c = mix(c, lin(blend(PAL.groundLight, PAL.groundDry, 0.7)), step(0.7, dab));
  c = mix(c, lin(blend(PAL.groundDark, PAL.groundDamp, 0.7)), step(dab, 0.2));
  c = mix(c, lin(blend(PAL.ground, PAL.grassDark, 0.6)), step(0.8, noise(9, 31)).mul(step(big, 0.45)));
  mat.colorNode = c;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0, z);
  m.receiveShadow = true;
  return m;
}
