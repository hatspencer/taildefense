import * as THREE from 'three/webgpu';
import {
  dot, float, floor, fract, length, luminance, min, mix, mrt, normalView, output, pass, perspectiveDepthToViewZ,
  renderOutput, smoothstep, step, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';

// The 8-bit look: the scene renders into a small target that is shown with nearest
// filtering, so each scene pixel is a block of screen pixels. One pass over it then draws
// dark outlines on silhouettes, softens creases, grades towards a washed-out, dusty palette,
// darkens the corners and quantizes each channel with an ordered (Bayer) dither.
export class Retro {
  readonly pipeline: THREE.RenderPipeline;
  private scenePass: ReturnType<typeof pass>;
  private uRes = uniform(new THREE.Vector2(1, 1));
  private uNear = uniform(0.5);
  private uFar = uniform(400);
  readonly uNight = uniform(0);
  private uLevels = uniform(12);
  px = 3;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    const sp = pass(scene, camera, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    sp.setMRT(mrt({ output, normal: normalView }));
    this.scenePass = sp;
    const colT = sp.getTextureNode('output'), nT = sp.getTextureNode('normal'), dT = sp.getTextureNode('depth');
    const res = this.uRes;
    // Every sample is taken at a scene pixel's centre, so neighbours are exact.
    const lp = floor(uv().mul(res));
    const at = (dx: number, dy: number) => lp.add(vec2(dx + 0.5, dy + 0.5)).div(res);
    const dist = (dx: number, dy: number) => perspectiveDepthToViewZ(dT.sample(at(dx, dy)).r, this.uNear, this.uFar).negate();
    const nrm = (dx: number, dy: number) => nT.sample(at(dx, dy)).xyz;

    const d0 = dist(0, 0), n0 = nrm(0, 0);
    let edge: THREE.Node<'float'> = float(0), crease: THREE.Node<'float'> = float(0);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const dd = dist(dx, dy).sub(d0);
      // A neighbour well behind this pixel: this pixel is the near side of a silhouette.
      edge = edge.add(step(d0.mul(0.035).add(0.06), dd));
      // A face turning away at about the same depth: a crease.
      crease = crease.add(float(1).sub(dot(n0, nrm(dx, dy))).mul(step(dd, d0.mul(0.02))));
    }

    let c = renderOutput(colT.sample(at(0, 0))).rgb.mul(1.2);
    c = mix(c, c.mul(0.82), step(0.5, crease));
    c = mix(c, vec3(0.07, 0.06, 0.05), min(edge, 1).mul(0.8));
    // Dusty grade: pull saturation down, warm the highlights, keep the shadows olive.
    const l = luminance(c);
    c = mix(vec3(l), c, 0.74);
    c = c.mul(mix(vec3(0.86, 0.92, 0.82), vec3(1.06, 1.0, 0.86), smoothstep(0.1, 0.8, l)));
    // Dusk during waves: cold and dark.
    c = mix(c, c.mul(vec3(0.62, 0.7, 0.92)), this.uNight);
    // Vignette.
    const q = uv().sub(0.5);
    c = c.mul(float(1).sub(smoothstep(0.45, 1.05, length(q).mul(1.414)).mul(0.5)));
    // The ordered dither and quantization.
    const b2 = (a: THREE.Node<'vec2'>) => fract(a.x.mul(0.5).add(a.y.mul(a.y).mul(0.75)));
    const bayer = b2(floor(lp.mul(0.5))).mul(0.25).add(b2(lp));
    const n = this.uLevels.sub(1);
    c = floor(c.mul(n).add(bayer)).div(n);

    this.pipeline = new THREE.RenderPipeline(renderer, vec4(c, 1));
    this.pipeline.outputColorTransform = false;
  }

  // Width and height are the drawing buffer's; px is the size of one scene pixel on screen.
  resize(w: number, h: number, px: number): void {
    this.px = px;
    this.scenePass.setResolutionScale(1 / px);
    this.uRes.value.set(Math.max(1, Math.floor(w / px)), Math.max(1, Math.floor(h / px)));
  }

  render(): void {
    this.uNear.value = this.camera.near;
    this.uFar.value = this.camera.far;
    this.pipeline.render();
  }
}
