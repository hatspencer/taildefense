import * as THREE from 'three/webgpu';
import { BRDF_Lambert, diffuseColor, normalView, smoothstep } from 'three/tsl';

// Painted light: a lit material's diffuse light in three flat steps instead of a smooth
// falloff, the way the picture is shaded: a side is in the light, turned half away, or out of
// it, and a round limb shows a lit side and a shaded side with a soft pixel between, not a
// gradient. Shadows, the sky's light and coloured lights (the flashlight, the lamp) work as
// before; only how a surface's angle to a light counts is stepped.
//
// The steps: turned more than about 60 degrees from a light is the half tone, less is full
// light, away from it none. The edges are a few degrees wide so they do not
// crawl as a figure turns.
const HALF = 0.55;

class PaintedLight extends THREE.PhongLightingModel {
  constructor() { super(false); }

  override direct(data: THREE.LightingModelDirectInput): void {
    // Three's types leave a light's nodes untyped.
    const dir = data.lightDirection as THREE.Node<'vec3'>, light = data.lightColor as THREE.Node<'vec3'>;
    const diffuse = data.reflectedLight.directDiffuse as THREE.Node<'vec3'> & { addAssign(n: THREE.Node<'vec3'>): void };
    const d = normalView.dot(dir);
    const steps = smoothstep(0.02, 0.1, d).mul(HALF).add(smoothstep(0.44, 0.54, d).mul(1 - HALF));
    const brdf = BRDF_Lambert({ diffuseColor: diffuseColor.rgb }) as unknown as THREE.Node<'vec3'>;
    diffuse.addAssign(brdf.mul(light).mul(steps));
  }
}

// Makes a lit node material (Lambert or Phong) take the picture's stepped light. One call
// where the material is made: `const m = painted(new THREE.MeshLambertNodeMaterial())`.
export function painted<T extends THREE.NodeMaterial>(m: T): T {
  m.setupLightingModel = () => new PaintedLight();
  return m;
}
