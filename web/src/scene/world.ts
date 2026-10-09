import * as THREE from 'three/webgpu';
import { Retro } from './retro';
import type { WeatherLook } from './weather';

// A dark, smoky haze: the edge of the view fades into it like a blackout town.
export const SKY = 0x2a2d26;
const DUSK_SKY = 0x161a20;
const RAIN_SKY = new THREE.Color(0x343a40), FOG_SKY = new THREE.Color(0x7a807c), SNOW_SKY = new THREE.Color(0xaab0b8);
const FLASH_SKY = new THREE.Color(0xd8e0ff), COOL_SUN = new THREE.Color(0xa8b8d0), WET_HEMI = new THREE.Color(0x9aa6b4);
const SNOW_GROUND = new THREE.Color(0xc8ccd2), GROUND = new THREE.Color(0x4a4632);

export interface Backend { name: 'WebGPU' | 'WebGL2'; }

// The renderer, scene, camera and lights. The sun's shadow camera follows the view target
// so the shadow map only covers what is on screen and stays crisp.
export class World {
  renderer: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.5, 400);
  sun = new THREE.DirectionalLight(0xffe2b8, 2.9);
  hemi = new THREE.HemisphereLight(0xc4cbc2, 0x4a4632, 1.4);
  // Lights that matter at dusk: the player's flashlight and the generator's lamp. They are
  // always in the scene, so switching mood never recompiles a shader.
  flashlight = new THREE.SpotLight(0xfff0c8, 0, 26, 0.5, 0.55, 1);
  lamp = new THREE.PointLight(0xffb060, 0, 16, 1.2);
  backend: Backend['name'] = 'WebGL2';
  retro: Retro | null = null;
  pixel = 0;
  night = 0;
  // The weather's look, eased; null for clear skies.
  look: WeatherLook | null = null;
  private shadowSpan = 40;
  private cssW = 1; private cssH = 1;

  constructor(canvas: HTMLCanvasElement, forceWebGL: boolean) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 70, 150);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    const sc = this.sun.shadow.camera;
    sc.near = 1; sc.far = 160;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.flashlight, this.flashlight.target, this.lamp);
  }

  // pixel: the size of one scene pixel in CSS pixels, 0 for the plain full-resolution view.
  setPixel(pixel: number): void {
    this.pixel = pixel;
    if (pixel > 0 && !this.retro) this.retro = new Retro(this.renderer, this.scene, this.camera);
    this.renderer.domElement.classList.toggle('pixelated', pixel > 0);
    this.resize(this.cssW, this.cssH);
  }

  // The automatic block size keeps about 320 scene pixels from top to bottom.
  static autoPixel(cssH: number): number { return Math.max(2, Math.round(cssH / 320)); }

  // m: 0 in daylight, 1 at dusk. hx/hy/aim place the flashlight; the lamp sits on the generator.
  setMood(m: number, hx: number, hy: number, aim: number, hero: boolean, cx: number, cy: number): void {
    this.night = m;
    const day = new THREE.Color(0xffe2b8), dusk = new THREE.Color(0xff9a58);
    this.sun.color.copy(day).lerp(dusk, m);
    this.sun.intensity = 2.9 - 1.2 * m;
    this.hemi.intensity = 1.4 - 0.4 * m;
    this.hemi.color.setHex(0xc4cbc2).lerp(new THREE.Color(0x8a9ab8), m);
    const bg = this.scene.background as THREE.Color;
    bg.setHex(SKY).lerp(new THREE.Color(DUSK_SKY), m);
    (this.scene.fog as THREE.Fog).color.copy(bg);
    this.flashlight.intensity = hero ? 70 * m : 0;
    this.flashlight.position.set(hx - Math.cos(aim) * 0.5, 3, hy - Math.sin(aim) * 0.5);
    this.flashlight.target.position.set(hx + Math.cos(aim) * 5, 0, hy + Math.sin(aim) * 5);
    this.lamp.intensity = 26 * m;
    this.lamp.position.set(cx, 3.2, cy);
    let tint = 0;
    const w = this.look;
    if (w) {
      // Rain and storms: darker and cooler. Fog: a grey wash. Snow: a pale sky and bright
      // ground bounce. Lightning lights everything for an instant.
      this.sun.intensity *= Math.max(0.3, 1 - 0.4 * w.rain - 0.2 * w.storm - 0.3 * w.fog);
      this.sun.color.lerp(COOL_SUN, 0.6 * w.rain);
      this.hemi.color.lerp(WET_HEMI, 0.6 * w.rain);
      this.hemi.intensity *= 1 - 0.2 * w.rain + 0.3 * w.snow;
      this.hemi.groundColor.copy(GROUND).lerp(SNOW_GROUND, 0.7 * w.snow);
      bg.lerp(RAIN_SKY, 0.7 * w.rain * (1 - m * 0.5)).lerp(FOG_SKY, 0.75 * w.fog * (1 - m * 0.6)).lerp(SNOW_SKY, 0.55 * w.snow * (1 - m * 0.5));
      if (w.flash > 0) {
        this.hemi.intensity += 4 * w.flash;
        this.sun.intensity += 1.5 * w.flash;
        bg.lerp(FLASH_SKY, 0.6 * w.flash);
      }
      (this.scene.fog as THREE.Fog).color.copy(bg);
      tint = 0.25 * w.rain + 0.1 * w.fog;
    }
    if (this.retro) this.retro.uNight.value = Math.min(0.5, m * 0.35 + tint);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    const be = this.renderer.backend as { isWebGPUBackend?: boolean };
    this.backend = be.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    console.info(`taildefense: rendering with ${this.backend}`);
  }

  // GPU device loss (WebGPU only). The host keeps the game, so a reload resumes it.
  onDeviceLost(cb: (msg: string) => void): void {
    const be = this.renderer.backend as { device?: { lost: Promise<{ reason: string; message: string }> } };
    be.device?.lost.then((info) => { if (info.reason !== 'destroyed') cb(info.message); });
  }

  resize(w: number, h: number): void {
    this.cssW = w; this.cssH = h;
    // Blocky pixels gain nothing from a dense drawing buffer; the browser scales the canvas up
    // without smoothing.
    this.renderer.setPixelRatio(this.pixel > 0 ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    if (this.retro && this.pixel > 0) this.retro.resize(w, h, this.pixel);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  // Keeps the sun and its shadow frustum over the view target; span grows with zoom.
  followSun(tx: number, tz: number, span: number): void {
    span = Math.ceil(span / 4) * 4;
    const sc = this.sun.shadow.camera;
    if (span !== this.shadowSpan) {
      this.shadowSpan = span;
      sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span;
      sc.updateProjectionMatrix();
    }
    // Snap to shadow texels so shadows do not shimmer while panning.
    const texel = (2 * span) / this.sun.shadow.mapSize.x;
    tx = Math.round(tx / texel) * texel; tz = Math.round(tz / texel) * texel;
    this.sun.position.set(tx - 30, 60, tz - 18);
    this.sun.target.position.set(tx, 0, tz);
  }

  setFog(dist: number): void {
    const f = this.scene.fog as THREE.Fog;
    const wf = this.look?.fog ?? 0;
    f.near = dist * 1.1 * (1 - 0.6 * wf); f.far = dist * 2.6 * (1 - 0.45 * wf);
  }

  // Builds the shaders ahead of the game, behind the splash. The first frame would otherwise
  // build every one at once, and the page would freeze for that long as the game starts.
  // Instead one object of each kind is drawn on its own, a few at a time with a frame
  // between, so the splash keeps moving: drawing builds the shadow passes too, which three's
  // compileAsync cannot, and it does not wait on each shader in turn as compileAsync does.
  // The pipelines are made off the main thread (see asyncPipelines), and waited for.
  // What is hidden or out of view now is drawn too, so it is ready when it shows.
  // onProgress hears how far it is, 0..1.
  async warm(onProgress?: (f: number) => void): Promise<void> {
    const scene = this.scene;
    // One object for each material and kind of geometry: the rest share its shaders. Three
    // builds every instanced mesh shaders of its own, so each of those is drawn.
    const reps: THREE.Object3D[] = [], seen = new Set<string>();
    const drawn: [THREE.Object3D, boolean, boolean][] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.material || !m.geometry) return;
      drawn.push([o, o.visible, o.frustumCulled]);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const g = m.geometry, inst = o as THREE.InstancedMesh;
      const key = [o.type, mats.map((x) => x.uuid).join(','), Object.keys(g.attributes).sort().join(','), g.index ? 'i' : '',
        inst.isInstancedMesh ? inst.uuid : '', o.castShadow, o.receiveShadow].join('|');
      if (!seen.has(key)) { seen.add(key); reps.push(o); }
    });
    const watchers = this.asyncPipelines();
    let made = 0, ready = 0;
    const track = (pr: Promise<void>) => { made++; const done = () => { ready++; }; void pr.then(done, done); };
    watchers.add(track);
    const report = (i: number) => onProgress?.(Math.min(1, 0.5 * (i / reps.length) + 0.5 * (made ? ready / made : i / reps.length)));
    const frame = () => new Promise<void>((ok) => { requestAnimationFrame(() => ok()); setTimeout(ok, 100); });
    // As many objects per frame as fit in about 10 ms of building.
    let batch = 4;
    try {
      for (let i = 0; i < reps.length;) {
        // A few pipelines compiling at a time: a long queue of them holds up the GPU, and
        // with it every frame of the splash.
        while (made - ready > 4) await frame();
        const t0 = performance.now();
        for (const [o] of drawn) { o.visible = false; o.frustumCulled = false; }
        for (const o of reps.slice(i, i + batch)) o.visible = true;
        this.render();
        i += batch;
        const dt = performance.now() - t0;
        batch = dt > 14 ? Math.max(1, batch >> 1) : dt < 6 ? Math.min(32, batch * 2) : batch;
        report(i);
        await frame();
      }
    } finally {
      for (const [o, v, f] of drawn) { o.visible = v; o.frustumCulled = f; }
    }
    // Then one real frame, for whatever drawing the objects together still lacks.
    this.render();
    // The pipelines still compiling finish off the main thread, while the splash plays on.
    while (ready < made) { report(reps.length); await frame(); }
    watchers.delete(track);
    report(reps.length);
  }

  // From the shader warm-up on, every new pipeline is made the way compileAsync makes them,
  // off the main thread (WebGPU's createRenderPipelineAsync, WebGL's
  // KHR_parallel_shader_compile), and what uses it is drawn once it is ready: a frame or two
  // late rather than with the page frozen while it builds. Drawn plainly, each WebGL program
  // would be linked while the page waits, half a second for a dozen. Three's pipeline cache
  // is reached past its private name (three is pinned). Returns the listeners that hear of
  // each pipeline started.
  private watchers: Set<(p: Promise<void>) => void> | null = null;
  private asyncPipelines(): Set<(p: Promise<void>) => void> {
    if (this.watchers) return this.watchers;
    const watchers = this.watchers = new Set<(p: Promise<void>) => void>();
    const pipes = (this.renderer as unknown as { _pipelines?: { getForRender(ro: unknown, p?: Promise<void>[] | null): unknown } })._pipelines;
    const getForRender = pipes?.getForRender;
    if (!pipes || !getForRender) return watchers;
    pipes.getForRender = function (ro, p) {
      const list = p ?? [], n = list.length, r = getForRender.call(this, ro, list);
      for (let i = n; i < list.length; i++) for (const w of watchers) w(list[i]);
      return r;
    };
    return watchers;
  }

  render(): void {
    if (this.retro && this.pixel > 0) this.retro.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
