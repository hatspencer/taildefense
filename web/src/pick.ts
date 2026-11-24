// Which structure the cursor is on, down the view ray from the camera's side. Most structures
// stand under `low` and are picked on their tile; a tall one (tall(id) not null) is picked
// anywhere on its silhouette, which on screen stands in front of whatever is on the tiles
// behind it, so it is tested first at every height. Kept free of three and the game state so a
// test can drive it (test/pick.mts).

// A tall structure's silhouette: its centre, and up to each height how far it reaches out from
// the centre either way, lowest first; above the last height there is nothing.
export interface Tall { cx: number; cz: number; bands: [height: number, reach: number][] }

// at(y): where the ray is at height y, as [x, z]. structAt(tx, tz): the structure on that tile,
// or -1. Returns the structure's id, or -1.
export function structOnRay(at: (y: number) => [number, number], structAt: (tx: number, tz: number) => number,
  tall: (id: number) => Tall | null, low: number, top: number, step = 0.1): number {
  const steps = Math.max(1, Math.ceil(top / step));
  for (let s = 0; s <= steps; s++) {
    const y = top - (top * s) / steps;
    const [x, z] = at(y);
    const tx = Math.floor(x), tz = Math.floor(z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const id = structAt(tx + dx, tz + dz);
      if (id < 0) continue;
      const t = tall(id);
      if (!t) continue;
      const band = t.bands.find(([h]) => y <= h);
      if (band && Math.abs(x - t.cx) <= band[1] && Math.abs(z - t.cz) <= band[1]) return id;
    }
    if (y <= low) {
      const id = structAt(tx, tz);
      if (id >= 0 && !tall(id)) return id;
    }
  }
  return -1;
}
