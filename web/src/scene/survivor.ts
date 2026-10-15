import { fixedColor, piece, type Dress, type Use } from './figures';
import { REGIONS, SLOTS } from './figures.gen';
import { Body, type Look, shade } from './look';

// A survivor as pieces of the Blender figure, dressed as the look the host dealt them: the
// body (male or female build), head and face, hands and boots; the outfit's layers over the
// shirt, its hat, what it carries; the person's hair, beard and glasses. The player's colour is
// the shirt, so teams read by colour; the archetype is the silhouette.

const slot = (n: (typeof SLOTS)[number]) => SLOTS.indexOf(n);
const region = (n: (typeof REGIONS)[number]) => 32 + REGIONS.indexOf(n);
const R = {
  torso: region('torso'), collar: region('collar'), belt: region('belt'), seat: region('seat'), uarm: region('uarm'),
  elbow: region('elbow'), farm: region('farm'), wrist: region('wrist'), neck: region('neck'), thigh: region('thigh'),
  shin: region('shin'), jaw: region('jaw'),
};

// Big hair lifts the hat.
const LIFT: Partial<Record<string, number>> = { afro: 0.1, curly: 0.035, mohawk: 0.04, locs: 0.015 };

export function survivor(L: Look, c: number): { uses: Use[]; dress: Dress } {
  const A = L.arch, g = L.body === Body.Fem ? 'f' : 'm';
  const uses: Use[] = [];
  const add = (name: string, at?: [number, number, number]) => { const p = piece(name); if (p) uses.push({ p, at }); };
  for (const n of ['trunk', 'arms', 'head', 'face', 'hands', 'boots']) add(`${n}_${g}`);
  if (A.over !== undefined && A.overKind) add(`over_${A.overKind}_${g}`);
  if (A.stripe !== undefined && A.name !== 'hunter') add(`${A.overKind === 'vest' ? 'vstripes' : 'stripes'}_${g}`);
  if (A.chest) add(`chest_${A.chest}_${g}`);
  if (A.back !== 'none') add(`pack_${A.back}_${g}`);
  if (L.style !== 'bald') { add(`hair_${L.style}`); add(`tail_${L.style}`); }
  if (A.hat !== 'none' && L.style !== 'headwrap') add(`hat_${A.hat}`, [0, LIFT[L.style] ?? 0, 0]);
  if (L.beard >= 2) add(`beard_${L.beard}`);
  if (L.glasses) add('glasses');

  const skin = L.skin, pants = A.pcLegs ? shade(c, 0.85) : A.legs;
  const sleeve = A.overKind === 'open' && A.over !== undefined ? A.over : c;
  const bare = (n: number) => A.sleeve === 'short' ? n >= 1 : A.sleeve === 'rolled' ? n >= 2 : false;
  const stubble = L.beard === 1 ? mix(skin, L.hair, 0.35) : skin;
  // Flannel: the hunter's shirt in a dark check.
  const plaid = (col: number, x: number, y: number, z: number) =>
    A.name === 'hunter' && ((Math.floor(y / 0.04) + Math.floor((z + x) / 0.04)) & 1) ? mix(col, A.stripe ?? 0, 0.45) : col;
  const brow = L.style === 'bald' || L.style === 'headwrap' ? 0x2a1c14 : shade(L.hair, 0.8);

  const dress: Dress = (k, x, y, z) => {
    if (k >= 64) return fixedColor(k);
    switch (k) {
      case slot('skin'): return skin;
      case slot('shirt'): return c;
      case slot('shirt2'): return shade(c, 0.72);
      case slot('pants'): return pants;
      case slot('boot'): return A.boots;
      case slot('hair'): return L.hair;
      case slot('hat'): return A.hatColor;
      case slot('over'): return A.over ?? c;
      case slot('stripe'): return A.stripe ?? 0xe8e8d8;
      case slot('eye'): return 0x141010;
      case slot('mouth'): return shade(skin, 0.45);
      case slot('sole'): return 0x1a1612;
      case slot('belt'): return 0x2a2018;
      case slot('wrap'): return L.wrap;
      case slot('brow'): return brow;
      case slot('lip'): return mix(shade(skin, 0.8), 0x9a4a40, 0.25);
      case R.torso: return plaid(c, x, y, z);
      case R.collar: return shade(c, 0.72);
      case R.belt: return A.overKind === 'bib' ? A.over! : A.pcLegs ? pants : 0x2a2018;
      case R.seat: case R.thigh: case R.shin: return pants;
      case R.uarm: return plaid(sleeve, x, y, z);
      case R.elbow: return bare(1) && sleeve === c ? skin : plaid(sleeve, x, y, z);
      case R.farm: return bare(2) && sleeve === c ? skin : plaid(sleeve, x, y, z);
      case R.wrist: return bare(3) && sleeve === c ? skin : shade(sleeve, 0.8);
      case R.neck: return skin;
      case R.jaw: return stubble;
    }
    return 0xff00ff;
  };
  return { uses, dress };
}

function mix(a: number, b: number, k: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
