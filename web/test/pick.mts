// The structure pick (src/pick.ts) with a sniper tower in front of a wall row, as the demo base
// has one: the camera 42° up (camera.ts TILT) looking north (towards -z), the tower at (166, 89), walls along
// row 85 behind it. Its deck, rifle and legs pick the tower; the wall picks the wall where the
// tower does not stand in front of it. Run by `npm run check`.
import { structOnRay, type Tall } from '../src/pick.ts';

const DECK = 2.78, HEAD = DECK + 0.6, TOP = HEAD + 0.3, LOW = 1.2;
const SNIPER = 1, WALL = 44;
const structAt = (tx: number, tz: number) => (tx === 166 && tz === 89 ? SNIPER : tz === 85 && tx >= 160 && tx <= 172 ? WALL : -1);
const tall = (id: number): Tall | null => (id === SNIPER ? { cx: 166.5, cz: 89.5, bands: [[DECK + 0.16, 0.5], [TOP, 0.7]] } : null);
// Each unit of height up the ray moves it this far south, towards the camera.
const run = 1 / Math.tan((42 * Math.PI) / 180);

// The struct under the point that is at (x, z) at height h, along the camera's ray.
function pick(x: number, z: number, h: number): number {
  return structOnRay((y) => [x, z + (y - h) * run], structAt, tall, LOW, TOP);
}

let bad = 0;
function want(what: string, got: number, id: number): void {
  if (got !== id) { console.error(`pick: ${what}: got ${got}, want ${id}`); bad++; }
}
want('the deck', pick(166.5, 89.5, DECK), SNIPER);
want('the deck\'s near edge', pick(166.5, 89.9, DECK), SNIPER);
want('the rifle', pick(166.5, 89.5, HEAD), SNIPER);
want('the rifle\'s top', pick(166.5, 89.5, TOP - 0.05), SNIPER);
want('the rifle out to one side', pick(167.1, 89.5, HEAD), SNIPER);
want('the legs, half way up', pick(166.2, 89.6, 1.4), SNIPER);
want('the legs at the foot', pick(166.5, 89.5, 0.1), SNIPER);
want('the wall, clear of the tower', pick(162.5, 85.5, 0.6), WALL);
want('the wall, behind the tower but under its top', pick(166.5, 85.9, 0.2), SNIPER);
want('the wall, behind and below the tower\'s reach', pick(166.5, 85.1, 0.9), WALL);
want('open ground', pick(150.5, 80.5, 0), -1);
if (bad) process.exit(1);
console.log('pick: a tall tower wins its silhouette over the wall behind it');
