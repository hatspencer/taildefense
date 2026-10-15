import * as THREE from 'three/webgpu';
import { Fn, Loop, atan, exp, cameraPosition, float, max, min, normalize, positionWorld, uniform, uniformArray, vec3 } from 'three/tsl';

// Gun flashes as light in the air. Three's lights only light surfaces, and the fog node then
// mixes the lit ground towards the fog colour, so in fog a shot lit nothing you could see. The
// last few flashes are kept here instead, and the fog node adds what each scatters towards the
// camera from the haze between it and the ground, and the warm pool it throws on the ground
// round it, after the haze: a shot glows in fog and at dusk, and lights the murk around it.
const N = 16;
// Only the bottom of the air holds fog: the camera looks down through clear air to it.
const LAYER = 5;

export class Glow {
  // x, y, z, intensity; and the colour, linear.
  private pos = Array.from({ length: N }, () => new THREE.Vector4());
  private col = Array.from({ length: N }, () => new THREE.Vector4(1, 0.6, 0.25, 0));
  private left = new Float32Array(N);
  private life = new Float32Array(N);
  private peak = new Float32Array(N);
  private uPos = uniformArray<'vec4'>(this.pos, 'vec4');
  private uCol = uniformArray<'vec4'>(this.col, 'vec4');
  // How thick the air is: fog most, rain some; a little smoke at dusk even in the clear.
  readonly uScatter = uniform(0);
  // How much of the ground pool to add on top of three's lights: the haze took that much away.
  readonly uPool = uniform(0);
  private next = 0;
  private c = new THREE.Color();

  add(x: number, y: number, z: number, peak: number, hex: number, life = 0.07): void {
    // The slot dimmest now, so a burst keeps its strongest flashes.
    let k = this.next, lo = Infinity;
    for (let i = 0; i < N; i++) {
      const v = this.left[i] > 0 ? this.peak[i] * this.left[i] / this.life[i] : 0;
      if (v < lo) { lo = v; k = i; }
    }
    this.next = (k + 1) % N;
    this.pos[k].set(x, y, z, 0);
    this.c.setHex(hex);
    this.col[k].set(this.c.r, this.c.g, this.c.b, 0);
    this.left[k] = life; this.life[k] = life; this.peak[k] = peak;
  }

  // Per render frame.
  update(dt: number, fog: number, rain: number, night: number): void {
    for (let i = 0; i < N; i++) {
      const left = this.left[i] = Math.max(0, this.left[i] - dt);
      // Full for most of its life, then gone: a flash, not a fade.
      this.pos[i].w = left > 0 ? this.peak[i] * Math.min(1, left / (this.life[i] * 0.4)) * (0.8 + Math.random() * 0.4) : 0;
    }
    this.uScatter.value = 0.012 * night + 0.09 * fog + 0.03 * rain;
    this.uPool.value = Math.min(1, fog * 1.2 + rain * 0.3);
  }

  // The light the flashes add at this fragment: the in-scatter along the view ray through the fog
  // layer, closed form for a point light in an even medium, and the pool on the ground under it.
  node(): THREE.Node<'vec3'> {
    const uPos = this.uPos, uCol = this.uCol, scatter = this.uScatter, pool = this.uPool;
    return Fn(() => {
      const sum = vec3(0).toVar();
      const ro = cameraPosition, d = positionWorld.sub(ro), L = d.length(), v = normalize(d);
      // Where the ray drops into the fog layer.
      const t0 = min(L, max(float(0), ro.y.sub(LAYER).div(max(v.y.negate(), 0.05))));
      Loop(N, ({ i }) => {
        const p = uPos.element(i);
        const s = p.xyz.sub(ro), b = s.dot(v);
        const h = max(s.dot(s).sub(b.mul(b)).sqrt(), 0.35);
        // The fog swallows light too: a halo a few metres across, not a glowing sky.
        const air = atan(L.sub(b).div(h)).sub(atan(t0.sub(b).div(h))).div(h).mul(exp(h.mul(-0.7)));
        const r = positionWorld.sub(p.xyz).length();
        const ground = float(1).div(r.mul(r).mul(0.6).add(1)).mul(exp(r.mul(-0.25))).mul(0.3);
        sum.addAssign(uCol.element(i).xyz.mul(p.w).mul(air.mul(scatter).add(ground.mul(pool))));
      });
      // Many flashes at once brighten towards white without blowing out the screen.
      return sum.div(sum.dot(vec3(0.3, 0.5, 0.2)).mul(0.6).add(1));
    })();
  }
}
