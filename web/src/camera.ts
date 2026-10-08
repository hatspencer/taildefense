import * as THREE from 'three/webgpu';
import CameraControls from 'camera-controls';

CameraControls.install({
  THREE: {
    Vector2: THREE.Vector2, Vector3: THREE.Vector3, Vector4: THREE.Vector4, Quaternion: THREE.Quaternion,
    Matrix4: THREE.Matrix4, Spherical: THREE.Spherical, Box3: THREE.Box3, Sphere: THREE.Sphere,
    Raycaster: THREE.Raycaster,
  },
});

// 55° above the horizon, as a polar angle from straight up.
const POLAR = (90 - 55) * Math.PI / 180;
export const MIN_DIST = 12, MAX_DIST = 75;

// The view: camera-controls orbiting a ground point with the tilt locked. Middle drag and
// Alt+wheel turn it, the wheel dollies. Left and right buttons stay free for the game.
// The target follows the hero until the player pans; Space resumes following.
export class CameraRig {
  controls: CameraControls;
  // Follow the hero (until a pan). locked: follow always, panning disabled.
  follow = true;
  locked = false;
  private mapW = 1; private mapH = 1;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private t = new THREE.Vector3();
  private pending = { x: 0, z: 0 };

  constructor(public cam: THREE.PerspectiveCamera, dom: HTMLElement) {
    const c = new CameraControls(cam, dom);
    const A = CameraControls.ACTION;
    c.mouseButtons.left = A.NONE;
    c.mouseButtons.right = A.NONE;
    c.mouseButtons.middle = A.ROTATE;
    c.mouseButtons.wheel = A.DOLLY;
    c.touches.one = A.NONE;
    c.touches.two = A.TOUCH_DOLLY_ROTATE;
    c.touches.three = A.NONE;
    c.minPolarAngle = c.maxPolarAngle = POLAR;
    c.minDistance = MIN_DIST; c.maxDistance = MAX_DIST;
    c.dollyToCursor = false;
    c.smoothTime = 0.12;
    c.draggingSmoothTime = 0.06;
    c.azimuthRotateSpeed = 0.8;
    c.restThreshold = 0.001;
    c.setLookAt(0, Math.cos(POLAR) * 34, Math.sin(POLAR) * 34, 0, 0, 0, false);
    this.controls = c;
    // Alt+wheel rotates. Capture phase on window runs before camera-controls' own handler.
    window.addEventListener('wheel', (e) => {
      if (!e.altKey || e.target !== dom) return;
      e.preventDefault(); e.stopPropagation();
      this.rotate(Math.sign(e.deltaY) * 0.18);
    }, { capture: true, passive: false });
  }

  get tx(): number { return this.controls.getTarget(this.t, false).x; }
  get tz(): number { return this.controls.getTarget(this.t, false).z; }
  get yaw(): number { return this.controls.azimuthAngle; }
  get dist(): number { return this.controls.distance; }

  setMap(w: number, h: number): void {
    this.mapW = w; this.mapH = h;
    this.controls.setBoundary(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(w, 0, h)));
  }

  // Moves the target to (x, z) keeping the camera's angle and distance.
  center(x: number, z: number, smooth = false): void {
    x = Math.min(this.mapW, Math.max(0, x)); z = Math.min(this.mapH, Math.max(0, z));
    void this.controls.moveTo(x, 0, z, smooth);
  }

  // Called every frame with the hero's position while following.
  track(x: number, z: number): void {
    if (this.follow || this.locked) this.center(x, z, true);
  }

  zoom(steps: number): void { void this.controls.dolly(-steps * 3, true); }
  setDist(d: number): void { void this.controls.dollyTo(Math.min(MAX_DIST, Math.max(MIN_DIST, d)), false); }
  rotate(rad: number): void { void this.controls.rotate(rad, 0, true); }
  setYaw(rad: number): void { void this.controls.rotateAzimuthTo(rad, false); }

  // Pans along the ground by screen-relative amounts in tiles: dx right, dy up the screen.
  // truck() would move along the tilted view plane and lift the target off the ground.
  pan(dx: number, dy: number): void {
    if (this.locked) return;
    this.follow = false;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.pending.x += dx * c - dy * s;
    this.pending.z += -dx * s - dy * c;
  }

  update(dt: number): void {
    if (this.pending.x || this.pending.z) {
      const t = this.controls.getTarget(this.t, true);
      this.center(t.x + this.pending.x, t.z + this.pending.z, false);
      this.pending.x = this.pending.z = 0;
    }
    this.controls.update(dt);
    this.cam.updateMatrixWorld();
  }

  // The ground point (at height h) under a screen pixel, or null when the ray misses.
  groundAt(px: number, py: number, w: number, hgt: number, h = 0, out = new THREE.Vector3()): THREE.Vector3 | null {
    this.setRay(px, py, w, hgt);
    this.plane.constant = -h;
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  setRay(px: number, py: number, w: number, h: number): THREE.Ray {
    this.ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    return this.ray.ray;
  }

  // The four ground corners of the view, for the minimap (tl, tr, br, bl).
  viewQuad(w: number, h: number): [number, number][] {
    const pts: [number, number][] = [];
    const corners: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]];
    for (const [x, y] of corners) {
      let p: THREE.Vector3 | null = null;
      for (let yy = y; yy <= h && !p; yy += h / 8) p = this.groundAt(x, yy, w, h, 0, this.hit);
      pts.push(p ? [p.x, p.z] : [this.tx, this.tz]);
    }
    return pts;
  }

  // Ground distance across the view, for sizing the shadow frustum.
  span(): number { return this.dist * 1.15; }
}
