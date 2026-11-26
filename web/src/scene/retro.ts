import * as THREE from 'three/webgpu';
import {
  abs, clamp, dot, float, floor, fract, length, luminance, max, mix, mrt, normalView, output, pass, perspectiveDepthToViewZ,
  renderOutput, sin, smoothstep, step, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';

// How the picture's line is drawn. An outline is what stands in front, a shade darker: LINE of
// its colour round a silhouette, INNER where one part of a figure overlaps another (an arm
// over the chest, a strap over a shirt), FOLD where a surface turns (a box's edge, a collar).
const LINE = 0.24, INNER = 0.46, FOLD = 0.74;
// The deepest dark a line falls towards (#18150f): a shade of its colour, never flat black.
const INK = vec3(0.094, 0.082, 0.059);

// The pixel look: the scene renders into a small target that is shown with nearest filtering,
// so each scene pixel is a block of screen pixels. One pass over it then draws the outlines
// (see above), grades towards the picture's palette (docs/art-direction.md: warm lights, olive
// brown shadows, no grey), cools and darkens for dusk and weather, and quantizes each channel
// gently behind a little noise, so flat light breaks into dabs rather than bands or a
// crosshatch.
export class Retro {
  readonly pipeline: THREE.RenderPipeline;
  private scenePass: ReturnType<typeof pass>;
  private uRes = uniform(new THREE.Vector2(1, 1));
  private uNear = uniform(0.5);
  private uFar = uniform(400);
  // The size of a scene pixel in the world, at the ground the camera looks at.
  private uPx = uniform(0.04);
  readonly uNight = uniform(0);
  private uLevels = uniform(40);
  px = 3;
  // The camera's distance from the ground it looks at, kept up by the world.
  reach = 60;

  // haze: how far the scene's fog node has faded a surface into the haze, 0..1 (fow.ts); it
  // rides in the normal target's alpha, so a line fades into the haze as its fill does.
  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, private camera: THREE.PerspectiveCamera, haze: THREE.Node<'float'> = float(0)) {
    const sp = pass(scene, camera, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    sp.setMRT(mrt({ output, normal: vec4(normalView, haze) }));
    this.scenePass = sp;
    const colT = sp.getTextureNode('output'), nT = sp.getTextureNode('normal'), dT = sp.getTextureNode('depth');
    const res = this.uRes;
    // Every sample is taken at a scene pixel's centre, so neighbours are exact.
    const lp = floor(uv().mul(res));
    const at = (dx: number, dy: number) => lp.add(vec2(dx + 0.5, dy + 0.5)).div(res);
    const dist = (dx: number, dy: number) => perspectiveDepthToViewZ(dT.sample(at(dx, dy)).r, this.uNear, this.uFar).negate();
    const nrm = (dx: number, dy: number) => nT.sample(at(dx, dy)).xyz;
    const hz = (dx: number, dy: number) => nT.sample(at(dx, dy)).w;
    const col = (dx: number, dy: number) => renderOutput(colT.sample(at(dx, dy))).rgb;

    const d0 = dist(0, 0), n0 = nrm(0, 0), c0 = col(0, 0);
    const px = this.uPx;
    // The four neighbours, each with the one opposite. A neighbour stands in front of this
    // pixel when it is nearer than this pixel's own surface would be there, going by the slope
    // from the opposite side (so sloping ground draws no line) by more than `gap`.
    const gap = px.mul(1.2).add(0.035);
    const dd = [dist(1, 0), dist(-1, 0), dist(0, 1), dist(0, -1)];
    const off = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let front: THREE.Node<'float'> = float(0), lineC: THREE.Node<'vec3'> = c0, fold: THREE.Node<'float'> = float(0);
    const h0 = hz(0, 0);
    let lineH: THREE.Node<'float'> = h0;
    for (let i = 0; i < 4; i++) {
      const di = dd[i], dj = dd[i ^ 1];
      const slope = clamp(d0.sub(dj), px.mul(-3), px.mul(3));
      const f = d0.add(slope).sub(di);
      const take = step(front, f);
      lineC = mix(lineC, col(off[i][0], off[i][1]), take);
      lineH = mix(lineH, hz(off[i][0], off[i][1]), take);
      front = max(front, f);
      // A fold: the surface turns to the right or below at about this depth. One side of it
      // only, so the line is one pixel wide.
      if (i === 0 || i === 3) {
        const ni = nrm(off[i][0], off[i][1]);
        const turn = float(1).sub(dot(n0, ni));
        fold = max(fold, smoothstep(0.25, 0.6, turn).mul(step(abs(di.sub(d0)), gap.add(px.mul(3)))).mul(step(0.5, length(ni))));
      }
    }
    // No normal here (smoke, dust, snow write none): no fold either.
    fold = fold.mul(step(0.5, length(n0)));

    // A line is a shade of what it outlines, and as far into the haze as that is: what the fog
    // has taken the fill of, it takes the line of too, so nothing is left as a drawing on it.
    const shade = (c: THREE.Node<'vec3'>, k: THREE.Node<'float'> | number, h: THREE.Node<'float'>) =>
      mix(c, mix(INK, c, k).mul(vec3(1, 0.985, 0.94)), float(1).sub(clamp(h, 0, 1)));
    let c: THREE.Node<'vec3'> = mix(c0, shade(c0, FOLD, h0), fold);
    // The line takes the colour of what it outlines; deep steps are silhouettes, shallow ones
    // the overlaps inside a figure.
    const deep = smoothstep(gap.mul(2), gap.mul(6).add(0.2), front);
    c = mix(c, shade(lineC, mix(float(INNER), float(LINE), deep), lineH), step(gap, front));

    // The grade. Colours are painted from the palette and lit to come out as painted, so this
    // is light: a little less saturation everywhere, blue taken out of the darks (olive brown
    // shadows), the lights a touch warmer.
    const l = luminance(c);
    c = mix(vec3(l), c, 0.95);
    c = c.mul(mix(vec3(1.0, 0.97, 0.88), vec3(1.01, 1.0, 0.97), smoothstep(0.03, 0.4, l)));
    // Dusk during waves, and wet weather: cold and dark.
    c = mix(c, c.mul(vec3(0.5, 0.6, 0.86)), this.uNight);
    // A faint vignette.
    const q = uv().sub(0.5);
    c = c.mul(float(1).sub(smoothstep(0.55, 1.1, length(q).mul(1.414)).mul(0.16)));
    // Quantized behind a little noise that differs from pixel to pixel with no pattern to it.
    const noise = fract(sin(dot(lp, vec2(12.9898, 78.233))).mul(43758.5453));
    const n = this.uLevels.sub(1);
    c = floor(c.mul(n).add(mix(float(0.5), noise, 0.7))).div(n);

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
    this.uPx.value = 2 * Math.tan(this.camera.fov * Math.PI / 360) * this.reach / this.uRes.value.y;
    this.pipeline.render();
  }
}
