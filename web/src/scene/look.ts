// What a survivor looks like, read from the u32 the host deals each player on joining (see
// PROTOCOL.md). The archetype is the outfit, and so the silhouette you know a teammate by at a
// glance; the player's colour is always the main garment, so teams still read by colour.
// Everything else is the person in it: skin, body, build, height, hair, beard and glasses.

export const SKIN = [0x3e261c, 0x5a3826, 0x7a4c32, 0x9a6440, 0xb87a4e, 0xd09068, 0xe2a882, 0xf0bf98];
// Black and dark brown come up most, the way they do.
export const HAIR = [0x16120f, 0x16120f, 0x2e1f14, 0x4e3220, 0x7a3a1c, 0xc89c52, 0x8e8a82, 0xa85426];

// Headwraps come in their own cloth.
export const WRAP = [0x8a2a40, 0x2a5a6a, 0xc89040, 0x4a3a6a, 0xe0d8c8, 0x2a2a2a, 0x6a8a3a, 0xa04a20];

export const enum Body { Masc, Fem, Andro }

export type HairStyle =
  'bald' | 'buzz' | 'short' | 'crop' | 'afro' | 'curly' | 'locs' | 'braids' | 'cornrows' |
  'ponytail' | 'bun' | 'long' | 'bob' | 'mohawk' | 'sidecut' | 'headwrap';

const MASC: HairStyle[] = ['bald', 'buzz', 'short', 'crop', 'afro', 'curly', 'locs', 'cornrows', 'mohawk', 'sidecut', 'short', 'buzz', 'crop', 'curly', 'locs', 'bun'];
const FEM: HairStyle[] = ['long', 'ponytail', 'bun', 'bob', 'braids', 'afro', 'locs', 'headwrap', 'curly', 'short', 'sidecut', 'cornrows', 'long', 'ponytail', 'braids', 'buzz'];
const ANDRO: HairStyle[] = ['short', 'crop', 'bob', 'mohawk', 'sidecut', 'afro', 'locs', 'curly', 'buzz', 'bun', 'ponytail', 'braids', 'headwrap', 'cornrows', 'long', 'bald'];

export type Hat = 'none' | 'cap' | 'hardhat' | 'helmet' | 'straw' | 'bandana' | 'beanie' | 'nursecap';
export type Back = 'none' | 'medbag' | 'wrench' | 'pack' | 'bigpack' | 'toolbelt' | 'satchel' | 'bedroll';

export interface Archetype {
  name: string;
  legs: number;         // trousers
  boots: number;
  over?: number;        // a vest or bib over the shirt
  overKind?: 'vest' | 'bib' | 'plate' | 'open';
  stripe?: number;      // reflective or plaid bands across the torso
  hat: Hat; hatColor: number;
  back: Back;
  chest?: 'cross' | 'tie' | 'lanyard' | 'pocket';
  pcLegs?: boolean;     // overalls and scrubs: the trousers are the player's colour too
}

export const ARCHETYPES: Archetype[] = [
  { name: 'paramedic', legs: 0x272b38, boots: 0x16161a, stripe: 0xe8e8d8, hat: 'none', hatColor: 0, back: 'medbag', chest: 'cross' },
  { name: 'mechanic', legs: 0, boots: 0x2a2018, hat: 'bandana', hatColor: 0x8a2a20, back: 'wrench', chest: 'pocket', pcLegs: true },
  { name: 'hunter', legs: 0x585638, boots: 0x3e2c1c, stripe: 0x1c1a16, hat: 'cap', hatColor: 0xe0681c, back: 'bedroll' },
  { name: 'student', legs: 0x34445e, boots: 0xd8d4c8, hat: 'beanie', hatColor: 0x2c2c34, back: 'bigpack' },
  { name: 'builder', legs: 0x4a4036, boots: 0x6a4a22, over: 0xd6e03c, overKind: 'vest', stripe: 0xeeeee0, hat: 'hardhat', hatColor: 0xe8b818, back: 'toolbelt' },
  { name: 'nurse', legs: 0, boots: 0xe0dcd0, hat: 'nursecap', hatColor: 0xeeeae0, back: 'none', chest: 'lanyard', pcLegs: true },
  { name: 'biker', legs: 0x1e2128, boots: 0x141210, over: 0x221c1a, overKind: 'open', hat: 'bandana', hatColor: 0x1c1c22, back: 'none' },
  { name: 'farmer', legs: 0x3e5680, boots: 0x4a3420, over: 0x3e5680, overKind: 'bib', hat: 'straw', hatColor: 0xd4b868, back: 'none' },
  { name: 'ex-soldier', legs: 0x4e5238, boots: 0x22201a, over: 0x4a4e34, overKind: 'plate', hat: 'helmet', hatColor: 0x4a4e32, back: 'pack' },
  { name: 'office worker', legs: 0x262830, boots: 0x18140f, hat: 'none', hatColor: 0, back: 'satchel', chest: 'tie' },
];

export interface Look {
  arch: Archetype; archIndex: number;
  skin: number; hair: number; wrap: number; style: HairStyle;
  body: Body; beard: 0 | 1 | 2 | 3; // none, stubble, full, moustache
  width: number; height: number;  // shoulders and stature, about 1
  glasses: boolean;
}

export function readLook(v: number): Look {
  const bits = (at: number, n: number) => (v >>> at) & ((1 << n) - 1);
  const archIndex = bits(0, 4) % ARCHETYPES.length;
  const b = bits(7, 2);
  const body = b === 0 ? Body.Masc : b === 1 ? Body.Fem : Body.Andro;
  const styles = body === Body.Masc ? MASC : body === Body.Fem ? FEM : ANDRO;
  const build = bits(18, 2);
  return {
    arch: ARCHETYPES[archIndex], archIndex,
    skin: SKIN[bits(4, 3)], hair: HAIR[bits(13, 3)], wrap: WRAP[bits(13, 3)], style: styles[bits(9, 4)],
    body, beard: body === Body.Masc ? (bits(16, 2) as 0 | 1 | 2 | 3) : 0,
    width: [0.88, 1, 1.1, 1.2][build] * (body === Body.Fem ? 0.93 : 1),
    height: [0.93, 0.97, 1.01, 1.05][bits(20, 2)] * (body === Body.Fem ? 0.97 : 1),
    glasses: bits(22, 2) === 0,
  };
}

// "a paramedic", "an office worker".
export function archetypeName(v: number): string {
  const n = ARCHETYPES[(v & 15) % ARCHETYPES.length].name;
  return (/^[aeiou]/.test(n) ? 'an ' : 'a ') + n;
}

// A face a shade darker or lighter, for the shadowed jaw or the lit cheek.
export function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

// A 16×16 pixel-art bust of the survivor for the HUD, in the same colours as the model.
export function drawPortrait(c: CanvasRenderingContext2D, look: Look, pc: number): void {
  const css = (h: number) => '#' + h.toString(16).padStart(6, '0');
  const px = (x: number, y: number, w: number, h: number, col: number) => { c.fillStyle = css(col); c.fillRect(x, y, w, h); };
  const L = look, A = L.arch, hair = L.hair, skin = L.skin;
  c.clearRect(0, 0, 16, 16);
  px(0, 0, 16, 16, shade(pc, 0.32));
  px(0, 12, 16, 4, shade(pc, 0.26));
  // Behind the head: long hair, locs and braids fall to the shoulders.
  const s = L.style;
  if (s === 'long' || s === 'locs' || s === 'braids') px(4, 5, 8, s === 'long' ? 8 : 9, hair);
  if (s === 'headwrap') px(4, 3, 8, 8, L.wrap);
  if (s === 'afro') px(3, 1, 10, 8, hair);
  // Shoulders and garment.
  const sw = L.width > 1.05 ? 1 : 0;
  px(2 - sw, 12, 12 + 2 * sw, 4, pc);
  if (A.over !== undefined) {
    if (A.overKind === 'open') { px(2 - sw, 12, 4 + sw, 4, A.over); px(10, 12, 4 + sw, 4, A.over); }
    else if (A.overKind === 'bib') { px(5, 13, 6, 3, A.over); px(5, 12, 1, 1, A.over); px(10, 12, 1, 1, A.over); }
    else px(3, 12, 10, 4, A.over);
  }
  if (A.stripe !== undefined) px(2 - sw, 14, 12 + 2 * sw, 1, A.stripe);
  if (A.chest === 'cross') { px(10, 13, 3, 1, 0xd03030); px(11, 12, 1, 3, 0xd03030); }
  if (A.chest === 'tie') { px(6, 12, 4, 4, 0xe6e2d8); px(7, 12, 2, 4, 0x8a2a2a); }
  if (A.chest === 'lanyard') { px(6, 12, 1, 3, 0xe8e8e8); px(9, 12, 1, 3, 0xe8e8e8); px(7, 15, 2, 1, 0xe8e8e8); }
  // Neck and face.
  px(6, 10, 4, 2, shade(skin, 0.85));
  px(4, 4, 8, 7, skin);
  px(4, 9, 8, 2, shade(skin, 0.92));
  if (L.beard === 1) px(4, 9, 8, 2, shade(skin, 0.72));
  if (L.beard === 2) { px(4, 8, 1, 3, hair); px(11, 8, 1, 3, hair); px(5, 9, 6, 2, hair); }
  if (L.beard === 3) px(6, 8, 4, 1, hair);
  // Eyes, mouth, glasses.
  px(6, 6, 1, 1, 0x141010); px(9, 6, 1, 1, 0x141010);
  px(7, 9, 2, 1, shade(skin, 0.6));
  if (L.glasses) { px(5, 6, 3, 1, 0x2a2a30); px(8, 6, 3, 1, 0x2a2a30); px(6, 6, 1, 1, 0x9ab4c0); px(9, 6, 1, 1, 0x9ab4c0); }
  // Hair on top.
  switch (s) {
    case 'buzz': case 'cornrows': px(4, 3, 8, 1, hair); px(4, 4, 1, 1, hair); px(11, 4, 1, 1, hair); break;
    case 'short': case 'crop': px(4, 2, 8, 2, hair); px(4, 4, 1, 2, hair); px(11, 4, 1, 2, hair); break;
    case 'sidecut': px(4, 2, 8, 2, hair); px(4, 4, 3, 1, hair); break;
    case 'curly': px(3, 2, 10, 3, hair); px(3, 5, 1, 2, hair); px(12, 5, 1, 2, hair); break;
    case 'afro': px(3, 1, 10, 3, hair); break;
    case 'mohawk': px(7, 0, 2, 4, hair); break;
    case 'bun': px(4, 3, 8, 1, hair); px(6, 1, 4, 2, hair); break;
    case 'ponytail': px(4, 2, 8, 2, hair); px(12, 4, 2, 4, hair); break;
    case 'long': case 'locs': case 'braids': px(4, 2, 8, 2, hair); px(4, 4, 1, 5, hair); px(11, 4, 1, 5, hair); break;
    case 'bob': px(4, 2, 8, 2, hair); px(3, 4, 2, 5, hair); px(11, 4, 2, 5, hair); break;
    case 'headwrap': px(4, 2, 8, 3, L.wrap); px(4, 3, 8, 1, shade(L.wrap, 0.75)); break;
    case 'bald': px(5, 4, 3, 1, shade(skin, 1.12)); break;
  }
  // Headgear from the outfit.
  const hc = A.hatColor;
  switch (s === 'headwrap' ? 'none' : A.hat) {
    case 'cap': px(4, 2, 8, 2, hc); px(10, 4, 4, 1, hc); break;
    case 'hardhat': px(4, 1, 8, 3, hc); px(3, 4, 10, 1, hc); break;
    case 'helmet': px(3, 1, 10, 3, hc); px(3, 4, 1, 3, hc); px(12, 4, 1, 3, hc); break;
    case 'straw': px(5, 1, 6, 2, hc); px(1, 3, 14, 1, hc); px(5, 2, 6, 1, shade(hc, 0.7)); break;
    case 'bandana': px(4, 3, 8, 1, hc); px(4, 2, 7, 1, hc); break;
    case 'beanie': px(4, 1, 8, 3, hc); px(4, 3, 8, 1, shade(hc, 1.4)); break;
    case 'nursecap': px(5, 2, 6, 2, hc); px(7, 2, 2, 1, 0xd03030); break;
  }
}
