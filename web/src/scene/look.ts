import { PAL } from './palette';

// What a survivor looks like, read from the u32 the host deals each player on joining (see
// PROTOCOL.md). The archetype is the outfit, and so the silhouette you know a teammate by at a
// glance; the player's colour is always the main garment, so teams still read by colour.
// Everything else is the person in it: skin, body, build, height, hair, beard and glasses.

// Skin, darkest to fairest, warm and a little dusty as the picture's people are.
export const SKIN = [0x3e2a1e, 0x573a28, 0x714c34, 0x8a6446, 0xa07a56, 0xb48f67, 0xc29c74, 0xcca986];
// Black and dark brown come up most, the way they do.
export const HAIR = [0x1c1812, 0x1c1812, 0x2e2016, 0x46301e, 0x6a3a1e, 0xa88a52, 0x8a8678, 0x8e4a24];

// Headwraps come in their own cloth.
const WRAP = [0x7a2e3a, 0x2e5660, 0xa8803e, 0x4a3e5e, 0xc8c0a8, 0x2e2a26, 0x5e7034, 0x8e4a24];

export const enum Body { Masc, Fem, Andro }

type HairStyle =
  'bald' | 'buzz' | 'short' | 'crop' | 'afro' | 'curly' | 'locs' | 'braids' | 'cornrows' |
  'ponytail' | 'bun' | 'long' | 'bob' | 'mohawk' | 'sidecut' | 'headwrap';

const MASC: HairStyle[] = ['bald', 'buzz', 'short', 'crop', 'afro', 'curly', 'locs', 'cornrows', 'mohawk', 'sidecut', 'short', 'buzz', 'crop', 'curly', 'locs', 'bun'];
const FEM: HairStyle[] = ['long', 'ponytail', 'bun', 'bob', 'braids', 'afro', 'locs', 'headwrap', 'curly', 'short', 'sidecut', 'cornrows', 'long', 'ponytail', 'braids', 'buzz'];
const ANDRO: HairStyle[] = ['short', 'crop', 'bob', 'mohawk', 'sidecut', 'afro', 'locs', 'curly', 'buzz', 'bun', 'ponytail', 'braids', 'headwrap', 'cornrows', 'long', 'bald'];

export type Hat = 'none' | 'cap' | 'hardhat' | 'helmet' | 'straw' | 'bandana' | 'beanie' | 'scrubcap';
// The shirt next to the skin: a work shirt with a collar and pockets, a crew-neck tee, a scrub
// top's V, or a hoodie's bunched hood.
export type Shirt = 'collar' | 'tee' | 'vneck' | 'hoodie';
// What goes over it: overalls (a bib and straps, the legs the same cloth), an open jacket with
// its lining showing, a leather vest, a hi-vis vest, a plate carrier.
export type Over = 'overalls' | 'jacket' | 'vest' | 'hivis' | 'carrier';
// What hangs on the belt.
export type Belt = 'plain' | 'medic' | 'tools' | 'hunter' | 'chain' | 'thin' | 'fanny';
// What is carried on the back or at the side.
export type Back = 'none' | 'daypack' | 'rucksack' | 'bigpack' | 'satchel' | 'assault';
export type Neck = 'none' | 'scarf' | 'stethoscope' | 'tie' | 'bandana';

export interface Archetype {
  name: string;
  shirt: Shirt;
  sleeve: 'long' | 'rolled' | 'short';
  shirtColor?: number;   // set when the player's colour is on the layer over it instead
  over?: Over;
  overColor?: number;    // unset: the over layer is the player's colour
  lining?: number;       // an open jacket's lining
  legs?: number;         // trousers; unset: the player's colour (overalls, scrubs)
  cargo?: boolean;       // pockets on the thighs
  knees?: number;        // knee pads or patches
  shoes: 'boot' | 'sneaker' | 'shoe' | 'wellie';
  shoeColor: number;
  sole: number;
  gloves?: number;
  hat: Hat; hatColor: number;
  hatMark?: number;      // a cross on the front of the cap
  hatPatch?: number;     // a badge on the front of the cap
  stripe?: number;       // a reflective band round the shirt
  sleeveMark?: boolean;  // a cross on the sleeve
  belt: Belt; beltColor: number;
  back: Back; backColor: number;
  neck: Neck; neckColor?: number;
}

// The four of the picture's top row first (paramedic, mechanic, hunter, hiker), then six more
// with as much on them. The player's colour is the shirt, the overalls or the jacket: the
// biggest piece of cloth.
const ARCHETYPES: Archetype[] = [
  { name: 'paramedic', shirt: 'collar', sleeve: 'long', legs: PAL.denimDark, cargo: true, knees: 0x2a2a24, shoes: 'boot', shoeColor: PAL.leather, sole: PAL.leatherDark,
    gloves: 0x2e2a24, hat: 'cap', hatColor: 0x353d4e, hatMark: PAL.medWhite, sleeveMark: true, stripe: 0xa8a48a, belt: 'medic', beltColor: PAL.webbing, back: 'daypack', backColor: PAL.olive, neck: 'none' },
  { name: 'mechanic', shirt: 'tee', sleeve: 'rolled', shirtColor: PAL.shirtWhite, over: 'overalls', knees: 0x2e2a22, shoes: 'boot', shoeColor: PAL.leatherDark, sole: PAL.ink,
    gloves: PAL.leather, hat: 'cap', hatColor: PAL.capOrange, hatPatch: 0xd0c8a8, belt: 'tools', beltColor: PAL.leather, back: 'none', backColor: 0, neck: 'none' },
  { name: 'hunter', shirt: 'collar', sleeve: 'long', shirtColor: PAL.wool, over: 'jacket', lining: PAL.plaid, legs: PAL.denimDark, knees: PAL.leatherDark, shoes: 'boot', shoeColor: PAL.leather, sole: PAL.leatherDark,
    hat: 'beanie', hatColor: 0x47453e, belt: 'hunter', beltColor: PAL.leather, back: 'rucksack', backColor: 0x5a4630, neck: 'scarf', neckColor: PAL.khaki },
  { name: 'student', shirt: 'hoodie', sleeve: 'long', legs: 0x55603e, knees: 0x4a4a32, shoes: 'boot', shoeColor: 0x6e4c2a, sole: PAL.leatherDark,
    hat: 'beanie', hatColor: 0x66303a, belt: 'thin', beltColor: PAL.leatherDark, back: 'bigpack', backColor: 0xc8a03a, neck: 'none' },
  { name: 'builder', shirt: 'tee', sleeve: 'short', over: 'hivis', overColor: PAL.hiVis, legs: PAL.denim, shoes: 'boot', shoeColor: 0x7a5a32, sole: PAL.leatherDark,
    gloves: 0x8a7a50, hat: 'hardhat', hatColor: PAL.hardHat, belt: 'tools', beltColor: PAL.leather, back: 'none', backColor: 0, neck: 'none' },
  { name: 'nurse', shirt: 'vneck', sleeve: 'short', shoes: 'sneaker', shoeColor: PAL.medWhite, sole: 0xa8a290,
    hat: 'scrubcap', hatColor: 0, belt: 'fanny', beltColor: 0x2e3238, back: 'none', backColor: 0, neck: 'stethoscope' },
  { name: 'biker', shirt: 'tee', sleeve: 'long', over: 'vest', overColor: PAL.leatherDark, legs: PAL.denim, shoes: 'boot', shoeColor: PAL.rubber, sole: PAL.ink,
    gloves: PAL.leatherDark, hat: 'bandana', hatColor: 0x2a2626, belt: 'chain', beltColor: PAL.leatherDark, back: 'none', backColor: 0, neck: 'none' },
  { name: 'farmer', shirt: 'collar', sleeve: 'rolled', over: 'overalls', overColor: PAL.denim, legs: PAL.denim, knees: PAL.denimDark, shoes: 'wellie', shoeColor: 0x3e4630, sole: PAL.rubber,
    hat: 'straw', hatColor: 0xa8905a, belt: 'plain', beltColor: PAL.leather, back: 'none', backColor: 0, neck: 'bandana', neckColor: 0x8a3424 },
  { name: 'ex-soldier', shirt: 'collar', sleeve: 'rolled', over: 'carrier', overColor: PAL.olive, legs: PAL.khaki, cargo: true, knees: PAL.oliveDark, shoes: 'boot', shoeColor: 0x3a2e20, sole: PAL.ink,
    gloves: PAL.oliveDark, hat: 'helmet', hatColor: PAL.olive, belt: 'plain', beltColor: PAL.webbing, back: 'assault', backColor: PAL.oliveDark, neck: 'none' },
  { name: 'office worker', shirt: 'collar', sleeve: 'rolled', legs: 0x2e3036, shoes: 'shoe', shoeColor: 0x2a1c14, sole: PAL.ink,
    hat: 'none', hatColor: 0, belt: 'thin', beltColor: 0x2a1c14, back: 'satchel', backColor: PAL.leather, neck: 'tie', neckColor: 0x6a2626 },
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
    width: [0.92, 1, 1.07, 1.14][build] * (body === Body.Fem ? 0.95 : 1),
    height: [0.94, 0.98, 1.01, 1.04][bits(20, 2)] * (body === Body.Fem ? 0.97 : 1),
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
