import * as THREE from 'three/webgpu';
import { Retro } from './retro';

// A dark, smoky haze: the edge of the view fades into it like a blackout town.
export const SKY = 0x2a2d26;
const DUSK_SKY = 0x161a20;

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
    this.lamp.position.set(cx, 3, cy);
    if (this.retro) this.retro.uNight.value = m * 0.35;
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
    f.near = dist * 1.1; f.far = dist * 2.6;
  }

  render(): void {
    if (this.retro && this.pixel > 0) this.retro.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
