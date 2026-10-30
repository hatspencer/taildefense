// Replays internal/game/predict_test.go's walks (predict-fixture.json, written from the
// host's own movement code) through the page's port in src/predict.ts, tick by tick. Run by
// `npm run check` with Node's own TypeScript type stripping.
//
// The port is float32 throughout, like the host, and matches it to the bit. Go may still fuse
// a multiply and an add into one rounding on some machines where JavaScript rounds twice,
// moving a last bit now and then, so a tick passes within TOL tiles; the count to the bit says
// how close it is.
import { readFileSync } from 'node:fs';
import { type Me, type Step, type World, Wrecks, lapseTicks, tileBlocked, walkTick } from '../src/predict.ts';

interface Case {
  x: number; y: number; turns: number; ticks: number; repeat: number; boots: number; sprint: boolean; winded: boolean;
  stamina: number; slow: number; buff: number; buffLeft: number; cur: number; weather: number; amt: number;
  out: [number, number, number, number][];
}
interface Fixture {
  tickRate: number; w: number; h: number; tiles: number[]; structs: number[]; gate: number;
  sites: { kind: number; sx: number; sy: number; yaw: number; searched: boolean }[];
  cases: Case[];
}

const TOL = 1e-4;
const fx = JSON.parse(readFileSync(new URL('./predict-fixture.json', import.meta.url), 'utf8')) as Fixture;
const tiles = Uint8Array.from(fx.tiles);
const wrecks = new Wrecks(fx.sites, fx.w, fx.h);
const kindAt = (tx: number, ty: number) => fx.structs[ty * fx.w + tx];
const dt = Math.fround(1 / fx.tickRate), lapse = lapseTicks(dt);

let ticks = 0, exact = 0, worst = 0, failed = 0;
fx.cases.forEach((c, ci) => {
  const world: World = {
    blocked: (tx, ty) => tileBlocked(tiles, fx.w, fx.h, tx, ty, kindAt, (k) => k === fx.gate),
    wreck: (x, y) => wrecks.at(x, y, (i) => fx.sites[i].searched),
    weather: c.weather, amt: c.amt,
  };
  const me: Me = {
    x: c.x, y: c.y, stamina: c.stamina, winded: c.winded, slow: c.slow, buff: c.buff, buffLeft: c.buffLeft, cur: c.cur,
    gear: [0, c.boots, 0, 0], alive: true, stunned: false, held: false, airborne: false, aboard: false, art: 0,
  };
  const s: Step = { x: Math.fround(c.x), y: Math.fround(c.y), st: Math.fround(c.stamina), winded: c.winded };
  // Steer is sent before the first tick, and again every repeat ticks; the n-th tick is n
  // ticks after the state the case starts from.
  let sentAt = 1;
  for (let n = 1; n <= c.ticks; n++) {
    const t = n - 1;
    if (c.repeat > 0 && t > 0 && t % c.repeat === 0) sentAt = n;
    walkTick(me, n, n - sentAt < lapse, c.turns, c.sprint, world, dt, s);
    // JSON has the host's float32s in their shortest form: round them back to float32.
    const [x, y, st] = c.out[t].map(Math.fround), wd = c.out[t][3];
    const d = Math.max(Math.abs(s.x - x), Math.abs(s.y - y), Math.abs(s.st - st));
    ticks++;
    if (d === 0 && s.winded === (wd === 1)) exact++;
    worst = Math.max(worst, d);
    if (d > TOL || s.winded !== (wd === 1)) {
      failed++;
      console.error(`case ${ci} tick ${n}: port ${s.x} ${s.y} ${s.st} ${s.winded}, host ${x} ${y} ${st} ${wd === 1}`);
      break;
    }
    // Go on from the host's state, so one last-bit difference does not grow.
    s.x = x; s.y = y; s.st = st;
  }
});
console.log(`predict: ${fx.cases.length} walks, ${ticks} ticks, ${exact} to the bit, worst ${worst.toExponential(1)} tiles`);
if (failed) {
  console.error(`predict: ${failed} walks part from the host's; web/src/predict.ts must follow internal/game`);
  process.exit(1);
}
