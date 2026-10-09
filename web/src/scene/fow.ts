import * as THREE from 'three/webgpu';
import { Fn, float, luminance, mix, output, positionWorld, rangeFogFactor, reference, texture, uniform, vec3, vec4 } from 'three/tsl';
import type { Game } from '../state';

// Fog of war on screen: the scene's fog node, which every lit material runs, darkens what
// the team cannot see by a per-tile texture (red: in sight now, green: seen before), eased
// so the edge of sight drifts rather than snaps. It also does the distance fog the scene's
// Fog would, since a fog node replaces it. With fog of war off the texture is never read.
export class FogOfWar {
  private tex: THREE.DataTexture;
  private node = texture(blank());
  private uSize = uniform(new THREE.Vector2(1, 1));
  private uOn = uniform(0);
  private shown = new Float32Array(0);
  private seen = new Float32Array(0);
  private vision: Game['vision'] = null;

  constructor(scene: THREE.Scene) {
    this.tex = this.node.value as THREE.DataTexture;
    const f = scene.fog as THREE.Fog;
    const color = reference('color', 'color', f), near = reference('near', 'float', f), far = reference('far', 'float', f);
    const t = this.node.sample(positionWorld.xz.div(this.uSize));
    scene.fogNode = Fn(() => {
      const lit = t.r, mem = t.g;
      // Never seen: near black. Seen before: dim and drained of colour, the way a map
      // remembers ground but not what walks on it. In sight: as it is.
      const shade = mix(mix(float(0.07), float(0.4), mem), float(1), lit);
      const sat = mix(float(0.3), float(1), lit);
      // Distance first, so far ground the team has never seen is dark, not haze.
      const c = mix(output.rgb, color, rangeFogFactor(near, far));
      const dark = mix(vec3(luminance(c)), c, sat).mul(shade);
      return vec4(mix(c, dark, this.uOn), output.a);
    })();
  }

  // Eases the texture towards the team's sight; call once a rendered frame.
  update(game: Game, dt: number): void {
    const v = game.vision;
    if (v !== this.vision) {
      this.vision = v;
      this.uOn.value = v ? 1 : 0;
      if (v) {
        this.tex.dispose();
        this.tex = new THREE.DataTexture(new Uint8Array(v.w * v.h * 4), v.w, v.h, THREE.RGBAFormat);
        this.tex.magFilter = THREE.LinearFilter; this.tex.minFilter = THREE.LinearFilter;
        this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
        this.node.value = this.tex;
        this.uSize.value.set(v.w, v.h);
        this.shown = new Float32Array(v.w * v.h);
        this.seen = new Float32Array(v.w * v.h);
        // The first look is instant: no fade in from black on joining.
        const px = this.tex.image.data as Uint8Array;
        for (let i = 0; i < v.now.length; i++) {
          this.shown[i] = v.now[i]; this.seen[i] = v.seen[i];
          px[i * 4] = v.now[i] * 255; px[i * 4 + 1] = v.seen[i] * 255; px[i * 4 + 3] = 255;
        }
        this.tex.needsUpdate = true;
      }
    }
    if (!v) return;
    const k = Math.min(1, dt * 6), now = v.now, seen = v.seen, sh = this.shown, se = this.seen;
    const px = this.tex.image.data as Uint8Array;
    let moved = false;
    for (let i = 0; i < now.length; i++) {
      const a = sh[i], b = se[i];
      const na = Math.abs(now[i] - a) < 0.004 ? now[i] : a + (now[i] - a) * k;
      const nb = Math.abs(seen[i] - b) < 0.004 ? seen[i] : b + (seen[i] - b) * k;
      if (na === a && nb === b) continue;
      sh[i] = na; se[i] = nb;
      px[i * 4] = na * 255; px[i * 4 + 1] = nb * 255;
      moved = true;
    }
    if (moved) this.tex.needsUpdate = true;
  }
}

function blank(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
