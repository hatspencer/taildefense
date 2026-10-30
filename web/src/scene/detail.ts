import type { Creeps } from './creeps';
import type { World } from './world';

// Past this far from the camera a creep is drawn in its far model, at full detail.
export const FAR = 45;

// A step down in detail, and what it does. Each level keeps the ones before it.
interface Step { name: string; apply(s: Settings): void }
interface Settings { far: number; farShadows: boolean; nearShadows: boolean; dpr: number; shadowMap: number }

const FULL: Settings = { far: FAR, farShadows: true, nearShadows: true, dpr: 2, shadowMap: 2048 };
const STEPS: Step[] = [
  // Creeps past 30 in their far model, and those throwing no shadow.
  { name: 'far creeps', apply: (s) => { s.far = 30; s.farShadows = false; } },
  // A sharp screen's drawing buffer at 1.5 pixels a CSS pixel rather than 2.
  { name: 'dpr 1.5', apply: (s) => { s.dpr = 1.5; } },
  // The far model from 20, and no creep throws a shadow.
  { name: 'no creep shadows', apply: (s) => { s.far = 20; s.nearShadows = false; } },
  // One drawing-buffer pixel to a CSS pixel.
  { name: 'dpr 1', apply: (s) => { s.dpr = 1; } },
  // The sun's shadow map at a quarter of the pixels.
  { name: 'shadow map 1024', apply: (s) => { s.shadowMap = 1024; } },
];

// Over a window this long the frame time is judged, ms.
const WINDOW = 2500;
// Slower than this on average and detail steps down; this fast and it may step back up, ms.
const SLOW = 22, FAST = 18;
// How long frames must stay fast before a step back up, at first and at most, ms. A step up
// that is soon undone doubles the wait, so a machine on the edge does not see-saw.
const UP_WAIT = 8000, UP_WAIT_MAX = 64000;
// A step down that bought less than this share of the frame time is taken back, and nothing
// more is tried for a while, HOLD at first and twice as long each time after, up to HOLD_MAX:
// a machine held back by something detail does not touch (a display that runs at 30 Hz, a
// busy CPU) keeps its picture, and is not tried on every half minute.
const GAIN = 0.08, HOLD = 30000, HOLD_MAX = 480000;

// The detail governor: when the frames stay slower than the budget, detail comes down a step
// at a time, cheapest-looking first; when there is headroom again it goes back up. A machine
// that keeps up never leaves level 0, so its picture is the full one. #detail=N pins a level.
export class Detail {
  level = 0;
  readonly max = STEPS.length;
  private pinned: boolean;
  private sum = 0; private n = 0; private since = 0;
  private fastSince = -1;
  private upWait = UP_WAIT;
  private lastDown = -Infinity; private lastUp = -Infinity;
  // The frame time before the last step down, to see what it bought; 0 when none is pending.
  private before = 0;
  private holdUntil = 0;
  private hold = HOLD;
  // The last window's mean frame time, ms.
  mean = 0;

  private world: World;
  private creeps: Creeps;

  constructor(world: World, creeps: Creeps, pin?: number) {
    this.world = world;
    this.creeps = creeps;
    this.pinned = pin !== undefined && Number.isFinite(pin);
    if (this.pinned) this.set(Math.max(0, Math.min(this.max, Math.round(pin!))));
  }

  // One rendered frame, dtMs after the last. Long gaps (a hidden tab, a stall) say nothing
  // about the steady frame time and start the window afresh.
  frame(now: number, dtMs: number): void {
    if (this.pinned) return;
    if (dtMs > 200) { this.sum = 0; this.n = 0; this.since = now; return; }
    if (this.n === 0) this.since = now;
    this.sum += dtMs; this.n++;
    if (now - this.since < WINDOW) return;
    const mean = this.mean = this.sum / this.n;
    this.sum = 0; this.n = 0; this.since = now;
    if (this.before > 0) {
      // The window after a step down: did it help?
      const gained = 1 - mean / this.before;
      this.before = 0;
      if (gained < GAIN && this.level > 0) {
        this.set(this.up());
        this.holdUntil = now + this.hold;
        this.hold = Math.min(HOLD_MAX, this.hold * 2);
        return;
      }
    }
    if (mean > SLOW) {
      this.fastSince = -1;
      const down = this.down();
      if (down === this.level || now < this.holdUntil) return;
      // Undoing a step up soon after it: wait longer before the next.
      if (now - this.lastUp < 2 * WINDOW + 1000) this.upWait = Math.min(UP_WAIT_MAX, this.upWait * 2);
      this.before = mean;
      this.lastDown = now;
      this.set(down);
      return;
    }
    if (mean <= FAST && this.level > 0) {
      if (this.fastSince < 0) this.fastSince = now;
      if (now - this.fastSince >= this.upWait && now - this.lastDown >= this.upWait) {
        this.lastUp = now;
        this.fastSince = -1;
        this.set(this.up());
      }
      return;
    }
    this.fastSince = -1;
  }

  private settings(level: number): Settings {
    const s = { ...FULL };
    for (let i = 0; i < level; i++) STEPS[i].apply(s);
    return s;
  }

  // What a level does on this screen: a cap on the drawing buffer above the screen's own
  // pixels, or under the pixel view's one to one, does nothing, and the level is passed by.
  private effect(level: number): string {
    const s = this.settings(level), w = this.world;
    const dpr = w.pixel > 0 ? 1 : Math.min(window.devicePixelRatio, s.dpr);
    return [s.far, s.farShadows, s.nearShadows, dpr, s.shadowMap].join();
  }

  // The next level down that changes something, or this one when none does.
  private down(): number {
    const now = this.effect(this.level);
    for (let l = this.level + 1; l <= this.max; l++) if (this.effect(l) !== now) return l;
    return this.level;
  }

  // The next level up that changes something.
  private up(): number {
    const now = this.effect(this.level);
    let l = this.level - 1;
    while (l > 0 && this.effect(l) === now) l--;
    return Math.max(0, l);
  }

  private set(level: number): void {
    this.level = level;
    const s = this.settings(level);
    const c = this.creeps;
    c.farFrom = s.far; c.farShadows = s.farShadows; c.nearShadows = s.nearShadows;
    this.world.setDprCap(s.dpr);
    const map = this.world.sun.shadow.mapSize;
    if (map.x !== s.shadowMap) map.set(s.shadowMap, s.shadowMap);
  }

  // F3's line: the level, what the last step did, and the creeps in each model.
  readout(): string {
    const what = this.level ? STEPS[this.level - 1].name : 'full';
    return `detail ${this.level}/${this.max} ${this.pinned ? 'pinned' : 'auto'} · ${what} · creeps near ${this.creeps.drawnNear} far ${this.creeps.drawnFar} (from ${this.creeps.farFrom})`;
  }
}
