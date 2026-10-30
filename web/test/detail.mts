// The detail governor (src/scene/detail.ts) against made-up frame times: a machine that keeps
// up stays at full detail, one that is too slow steps down until it keeps up without
// see-sawing, and one that detail cannot help keeps its picture. Run by `npm run check`.
import { Detail } from '../src/scene/detail.ts';

(globalThis as unknown as { window: { devicePixelRatio: number } }).window = { devicePixelRatio: 2 };

function rig(pin?: number) {
  const creeps = { farFrom: 45, farShadows: true, nearShadows: true, drawnNear: 0, drawnFar: 0 };
  const size = { x: 2048, y: 2048, set(a: number, b: number) { this.x = a; this.y = b; } };
  const world = { pixel: 0, dpr: 2, sun: { shadow: { mapSize: size } }, setDprCap(c: number) { this.dpr = c; } };
  // The governor only reads and sets these fields; the casts stand in for the real classes.
  const d = new Detail(world as never, creeps as never, pin);
  return { d, creeps, world };
}

// Runs for secs of simulated time, each frame as long as ms(level) says; returns the share of
// frames spent at each level and the number of level changes.
function run(d: Detail, secs: number, ms: (level: number) => number) {
  let t = 0, changes = 0, last = d.level;
  const at = new Map<number, number>();
  let n = 0;
  while (t < secs * 1000) {
    const dt = ms(d.level);
    t += dt;
    d.frame(t, dt);
    at.set(d.level, (at.get(d.level) ?? 0) + 1); n++;
    if (d.level !== last) { changes++; last = d.level; }
  }
  for (const [k, v] of at) at.set(k, v / n);
  return { at, changes };
}

let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) { failed++; console.error(`detail: FAIL ${what}`); } };

{
  const { d } = rig();
  const r = run(d, 120, () => 16.7);
  check(d.level === 0 && r.changes === 0, `a machine at 60 fps stays at full detail (level ${d.level}, ${r.changes} changes)`);
}
{
  // 32 ms at full detail, 4 ms less a level: it keeps up from level 3.
  const { d, creeps, world } = rig();
  const r = run(d, 300, (l) => 32 - 4 * l);
  check(d.level >= 3, `a slow machine steps down until it keeps up (level ${d.level})`);
  if (process.env.VERBOSE) console.log('slow machine', d.level, r.changes, [...r.at]);
  check(r.changes <= 8, `and does not see-saw (${r.changes} changes in 5 minutes)`);
  check(creeps.farFrom < 45 && world.dpr < 2, 'its levels take effect');
}
{
  // 34 ms whatever the detail: a 30 Hz display, or a CPU held up elsewhere.
  const { d } = rig();
  const r = run(d, 600, () => 34);
  check((r.at.get(0) ?? 0) > 0.9, `a machine detail cannot help keeps full detail most of the time (${((r.at.get(0) ?? 0) * 100).toFixed(0)}%)`);
}
{
  // Slow for a minute (a big fight), then fast again: back to full detail.
  const { d } = rig();
  let t = 0;
  run(d, 300, (l) => { t += 1; return t < 2000 ? 32 - 4 * l : 12; });
  check(d.level === 0, `detail comes back once there is headroom (level ${d.level})`);
}
{
  const { d, creeps } = rig(3);
  run(d, 60, () => 50);
  check(d.level === 3 && creeps.nearShadows === false, `#detail=3 pins the level (level ${d.level})`);
}
{
  // The pixel view draws one to one already: the drawing-buffer steps are passed by.
  const { d, world } = rig();
  world.pixel = 3;
  const r = run(d, 300, (l) => 32 - 4 * l);
  check(d.level >= 3 && !r.at.has(2) && !r.at.has(4), `under the pixel view the drawing-buffer steps are passed by (levels ${[...r.at.keys()]})`);
  void world;
}
if (failed) process.exit(1);
console.log('detail: governor holds on 6 runs');
