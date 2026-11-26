import * as THREE from 'three/webgpu';
import { groundMaterial } from './terrain';

// A lab's plain ground: a flat stage of the game's own open ground (terrain.ts), for judging
// figures and light with no terrain or props in the way.
export function stage(x: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMaterial());
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0, z);
  m.receiveShadow = true;
  return m;
}
