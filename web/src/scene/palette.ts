// The picture's colours (docs/artdirection.png, sampled; docs/art-direction.md has the table),
// and a few helpers to bring any other colour to sit beside them. Colours are sRGB hex, as
// everything a model is built from; the light and the grade (world.ts, retro.ts) are tuned so
// that a surface painted with one of these comes out on screen near its lit value in the sun
// and near its shaded value out of it. Models should take their colours from here.

export const PAL = {
  // The ground.
  ground: 0x5e512a, groundLight: 0x62552c, groundDry: 0x6b5a2e, groundDark: 0x4d4325, groundDamp: 0x453824,
  dirt: 0x5a4628, dirtDark: 0x43331f, mud: 0x3a2e1c,
  grass: 0x5b5f3e, grassLit: 0x6c7a3a, grassDark: 0x444a2a, stone: 0x6f6a58, stoneDark: 0x4a4638,
  shadow: 0x342d1a, shadowDeep: 0x272315,
  // The deepest dark: folds, the inside of a boot, a gun's bore. Never pure black.
  ink: 0x18150f, inkWarm: 0x1c1812,

  // The living.
  skin: 0xb48f67, skinShade: 0x8a6a48, skinDark: 0x5e4630, skinPale: 0xc9a67e, skinDeep: 0x6a4a32,
  hairBlack: 0x1c1812, hairBrown: 0x3a2a1a, hairFair: 0x8a6a3a, hairGrey: 0x77715f,
  // The dead: ashen and grey-green skin, blotched dark red.
  deadSkin: 0xa1845c, deadSkinGreen: 0x898c66, deadSkinDark: 0x6c5d40, deadSkinPale: 0xb9ad8a,
  blood: 0x62381e, bloodFresh: 0x8a2a1a, bloodDark: 0x3e2014, bone: 0xc8c2a0,

  // Cloth and kit, worn.
  denim: 0x3a4450, denimDark: 0x26291e, denimLight: 0x56646e,
  leather: 0x4e3621, leatherRed: 0x62381e, leatherDark: 0x2e2116,
  webbing: 0x5b5f3e, canvas: 0x766038, canvasLight: 0x8f7a4c, khaki: 0x7d7048,
  olive: 0x4a4c30, oliveDark: 0x33351f,
  shirtWhite: 0xb9b196, shirtGrey: 0x7a7868, plaid: 0x6a3a2a, wool: 0x3c3a34,
  wood: 0x6a4526, woodDark: 0x432c18, steel: 0x5a5c58, steelDark: 0x2e302e, steelLit: 0x8a8c84,
  rust: 0x7a3e1c, concrete: 0x7c786a, rubber: 0x24221e,

  // The accents: small and saturated, the only true colours in the picture.
  medRed: 0xa8321e, medWhite: 0xd8d2b8, capOrange: 0xc8642a, hardHat: 0xd8a82a, packYellow: 0xab8344,
  teal: 0x2f7a66, purple: 0x5a3e62, hiVis: 0xd0642a, hiVisBand: 0xc8c2a0,
} as const;

export type PalName = keyof typeof PAL;

const ch = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const pack = (r: number, g: number, b: number): number => {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
};

// a towards b by t (0..1), channel by channel.
export function blend(a: number, b: number, t: number): number {
  const [ar, ag, ab] = ch(a), [br, bg, bb] = ch(b);
  return pack(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

// A darker shade of a colour the way the picture darkens: towards the warm ink, never towards
// grey or black. k is how much of the colour is left: 0.7 for the shaded side of a part made
// of two colours, 0.45 for a fold or a seam.
export function darker(hex: number, k: number): number {
  const [r, g, b] = ch(hex), [ir, ig, ib] = ch(PAL.ink);
  // Blue falls first, so shadows go olive brown.
  return pack(ir + (r - ir) * k, ig + (g - ig) * k, ib + (b - ib) * k * 0.94);
}

// A lighter, sun-warmed shade: for a lit edge, a worn knee, a highlight of one pixel.
export function lighter(hex: number, k: number): number {
  const [r, g, b] = ch(hex);
  return pack(r + (236 - r) * k, g + (218 - g) * k, b + (170 - b) * k * 0.8);
}

// Any colour brought into the picture: its saturation pulled to `sat` of what it was, its
// brightness held within what worn cloth has (nothing in the picture is lighter than the
// hi-vis bands or darker than the ink), and a little of the ground's dust on it. With the
// defaults a player's flat primary becomes the worn garment the art direction asks for; the
// hue, and so the team's read, stays.
export function mute(hex: number, sat = 0.55, dust = 0.12): number {
  let [r, g, b] = ch(hex);
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
  // Into the range the picture's cloth lives in: about 40 to 190 of 255.
  const m = Math.max(r, g, b, 1), top = 190, low = 40;
  if (m > top) { const k = top / m; r *= k; g *= k; b *= k; }
  const l2 = 0.299 * r + 0.587 * g + 0.114 * b;
  if (l2 < low) { const up = low - l2; r += up; g += up; b += up * 0.8; }
  return blend(pack(r, g, b), PAL.canvas, dust);
}

// A player's colour as the main garment: muted and worn (the default of mute).
export function garment(playerColor: number): number { return mute(playerColor); }

// A colour stained by another (mud on a hem, blood on a sleeve): `stain` over it by t.
export function stained(hex: number, stain: number, t: number): number { return blend(hex, darker(stain, 0.9), t); }
