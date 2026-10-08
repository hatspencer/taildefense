import type { CameraRig } from '../camera';
import { el } from './dom';

// North is the top of the map (tile y falls), east its right side, as on the minimap.
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// The compass point from one spot to another, in tiles.
export function bearing(dx: number, dy: number): string {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return POINTS[(Math.round(deg / 45) + 8) % 8];
}

// Where a spot is, said the way players say it: "at the base", or "NE of the base, 40 m".
// A tile is about a metre.
export function where(x: number, y: number, cx: number, cy: number): string {
  const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
  if (d < 12) return 'at the base';
  return `${bearing(dx, dy)} of the base, ${Math.round(d / 5) * 5} m`;
}

const PX_PER_DEG = 2.4;

// A strip across the top of the view that turns with the camera: the direction the view
// faces sits under the marker. Clicking it turns the view north up.
export class Compass {
  private track: HTMLElement;
  private last = NaN;

  constructor(parent: HTMLElement, private rig: CameraRig) {
    const root = el('div', 'compass', parent);
    root.title = 'The way the view faces · click to turn north up';
    const strip = el('div', 'strip', root);
    this.track = el('div', 'track', strip);
    // Three turns, so the strip is always full whichever way the view faces.
    for (let deg = -360; deg <= 720; deg += 15) {
      const a = ((deg % 360) + 360) % 360;
      const t = el('span', a === 0 ? 'mark main n' : a % 90 === 0 ? 'mark main' : a % 45 === 0 ? 'mark mid' : 'mark', this.track, a % 45 === 0 ? POINTS[a / 45] : '');
      t.style.left = `${deg * PX_PER_DEG}px`;
    }
    el('div', 'pin', root);
    root.onclick = () => rig.faceNorth();
  }

  update(): void {
    // The camera's azimuth turns the other way to a compass heading.
    const h = ((((-this.rig.yaw * 180) / Math.PI) % 360) + 360) % 360;
    if (Math.abs(h - this.last) < 0.05) return;
    this.last = h;
    this.track.style.transform = `translateX(${(-h * PX_PER_DEG).toFixed(1)}px)`;
  }
}
