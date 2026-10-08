import type { AbilityDef, CreepDef, StructDef, WeaponDef, Welcome } from '../protocol';

// Definitions for demo mode. They follow internal/game/defs.go where that exists and invent
// the rest (signatures, abilities) the way the host is expected to send them.

export const CREEPS: CreepDef[] = [
  { name: 'walker', hp: 40, speed: 1.7, radius: 0.45, size: 1, ranged: false, bounty: 3 },
  { name: 'runner', hp: 24, speed: 3.6, radius: 0.4, size: 1, ranged: false, bounty: 3 },
  { name: 'swarmer', hp: 9, speed: 2.7, radius: 0.3, size: 1, ranged: false, bounty: 1 },
  { name: 'brute', hp: 280, speed: 1.15, radius: 0.9, size: 2, ranged: false, bounty: 15 },
  { name: 'spitter', hp: 55, speed: 1.5, radius: 0.45, size: 1, ranged: true, bounty: 6 },
  { name: 'abomination', hp: 3200, speed: 0.95, radius: 1.4, size: 3, ranged: false, bounty: 300 },
];

interface W0 { name: string; short: string; price: number; range: number; fire: string; special: string; dmg: number; rate: number; mag: number; reload: number; sig: WeaponDef['sig'] }
export const WEAPON_BASE: W0[] = [
  { name: 'Pistol', short: 'PST', price: 0, range: 14, fire: 'hitscan', special: '+1 pierce', dmg: 14, rate: 3, mag: 12, reload: 1.1,
    sig: { name: 'Fan the hammer', desc: 'Empty the magazine in a burst towards the target point.', cool: 8, range: 14, target: 'point' } },
  { name: 'Shotgun', short: 'SHG', price: 250, range: 9, fire: 'cone', special: '+2 pellets', dmg: 9, rate: 1.3, mag: 6, reload: 1.8,
    sig: { name: 'Concussion', desc: 'A point-blank blast that knocks creeps back and stuns them.', cool: 10, range: 7, target: 'point' } },
  { name: 'SMG', short: 'SMG', price: 400, range: 12, fire: 'hitscan', special: '+1 pierce', dmg: 8, rate: 11, mag: 40, reload: 1.6,
    sig: { name: 'Bullet hose', desc: 'Double fire rate for 5 seconds.', cool: 18, range: 0, target: 'self' } },
  { name: 'Rifle', short: 'RFL', price: 650, range: 28, fire: 'hitscan', special: '+2 pierce', dmg: 60, rate: 1.4, mag: 5, reload: 2,
    sig: { name: 'Piercing shot', desc: 'One shot that pierces everything along its line.', cool: 12, range: 40, target: 'point' } },
  { name: 'Flamethrower', short: 'FLM', price: 900, range: 6.5, fire: 'cone', special: '+range, +burn', dmg: 6, rate: 12, mag: 80, reload: 2.5,
    sig: { name: 'Napalm', desc: 'Lays a pool of burning fuel at the target.', cool: 14, range: 9, target: 'point' } },
  { name: 'Minigun', short: 'MNG', price: 1400, range: 16, fire: 'hitscan', special: '+1 pierce, +burn', dmg: 9, rate: 22, mag: 150, reload: 3.5,
    sig: { name: 'Overdrive', desc: 'No spread and +50% damage for 6 seconds.', cool: 20, range: 0, target: 'self' } },
  { name: 'Rocket launcher', short: 'RKT', price: 2000, range: 24, fire: 'rocket', special: '+blast radius', dmg: 140, rate: 0.8, mag: 4, reload: 2.6,
    sig: { name: 'Barrage', desc: 'Four rockets spread around the target point.', cool: 16, range: 24, target: 'point' } },
];

function upgradeCost(price: number, level: number): number {
  return Math.round((60 + price * 0.25) * Math.pow(1.55, level));
}

function weaponDefs(): WeaponDef[] {
  return WEAPON_BASE.map((w) => {
    const costs: number[][] = [];
    const values: string[][] = [];
    for (let t = 0; t < 4; t++) {
      const c: number[] = [], v: string[] = [];
      for (let l = 0; l < 5; l++) c.push(upgradeCost(w.price, l));
      for (let l = 0; l <= 5; l++) {
        if (t === 0) v.push(`${Math.round(w.dmg * (1 + 0.22 * l))} dmg`);
        else if (t === 1) v.push(`${(w.rate * (1 + 0.13 * l)).toFixed(1)}/s`);
        else if (t === 2) v.push(`${Math.round(w.mag * (1 + 0.25 * l))} mag, ${(w.reload * (1 - 0.11 * l)).toFixed(1)}s reload`);
        else v.push(l === 0 ? 'base' : `${w.special} ×${l}`);
      }
      costs.push(c); values.push(v);
    }
    return { name: w.name, short: w.short, price: w.price, range: w.range, fire: w.fire, special: w.special, costs, values, sig: w.sig };
  });
}

export const ABILITIES: AbilityDef[] = [
  { name: 'Signature', key: 'Q', desc: "the equipped weapon's own ability", target: 'point', range: 0, cool: [0, 0, 0], costs: [0, 0, 0], always: true },
  { name: 'Grenade', key: 'W', desc: 'Lob a frag grenade that explodes after a short flight.', target: 'point', range: 11, cool: [9, 8, 7], costs: [200, 450, 800], always: false },
  { name: 'Dash', key: 'E', desc: 'A short burst of speed towards the target point.', target: 'point', range: 5, cool: [10, 8, 6], costs: [300, 600, 1000], always: false },
  { name: 'Airstrike', key: 'D', desc: 'Call in a bombing run on the target after 3 seconds.', target: 'point', range: 40, cool: [60, 50, 40], costs: [600, 1100, 1800], always: false },
];

// Blast radii of the abilities, for the area preview: grenade, napalm, airstrike.
export const ABILITY_RADIUS = [0, 3, 0, 7];

const up = (price: number) => [0, 1, 2, 3, 4].map((l) => Math.round(price * 0.8 * l));

export const STRUCTS: StructDef[] = [
  { name: 'none', price: 0, hp: 0, w: 1, h: 1, range: 0, turret: false, key: '', desc: '', upgrade: [] },
  { name: 'Generator', price: 0, hp: 2500, w: 5, h: 5, range: 0, turret: false, key: '', desc: 'Powers the base. If it falls, the game is over.', upgrade: [] },
  { name: 'Armory', price: 0, hp: 1200, w: 3, h: 3, range: 0, turret: false, key: '', desc: 'Buy and upgrade weapons, gear and abilities here.', upgrade: [] },
  { name: 'Wall', price: 20, hp: 320, w: 1, h: 1, range: 0, turret: false, key: 'W', desc: 'Blocks creeps; they have to break through.', upgrade: [] },
  { name: 'Gate', price: 45, hp: 320, w: 1, h: 1, range: 0, turret: false, key: 'G', desc: 'Players walk through, creeps break it down.', upgrade: [] },
  { name: 'Gun turret', price: 120, hp: 220, w: 1, h: 1, range: 9, turret: true, key: 'T', desc: 'Fast, cheap single-target fire.', upgrade: up(120) },
  { name: 'Cannon', price: 240, hp: 280, w: 1, h: 1, range: 11, turret: true, key: 'C', desc: 'Slow shells that explode in an area.', upgrade: up(240) },
  { name: 'Frost tower', price: 180, hp: 220, w: 1, h: 1, range: 6, turret: true, key: 'F', desc: 'Pulses cold that slows everything around it.', upgrade: up(180) },
  { name: 'Tesla coil', price: 320, hp: 220, w: 1, h: 1, range: 8, turret: true, key: 'L', desc: 'Lightning that chains between creeps.', upgrade: up(320) },
];

export const WEATHERS = [
  { name: 'Clear', info: '' },
  { name: 'Fog', info: 'everyone sees and shoots 25% less far; creeps notice you later' },
  { name: 'Rain', info: 'burning does half the damage; creeps 8% slower' },
  { name: 'Storm', info: 'rain, and lightning strikes creeps out in the open' },
  { name: 'Snow', info: 'creeps 15% slower, survivors 8% slower' },
];

export function demoWelcome(w: number, h: number): Welcome {
  return {
    t: 'welcome', proto: 4, version: 'demo', you: 0, w, h, seed: '424242', host: 'demo',
    hosting: true, hint: '', tickRate: 20, core: { x: w / 2, y: h / 2 }, buildRadius: 28,
    shopRadius: 4.5, maxLevel: 5, maxStructLevel: 5, repairCostPerHP: 0.1,
    tracks: ['damage', 'fire rate', 'handling', 'special'],
    creeps: CREEPS, weapons: weaponDefs(),
    gear: [
      { name: 'Armor', info: '+25 max HP', costs: [90, 153, 260, 442, 752] },
      { name: 'Boots', info: '+8% speed', costs: [110, 187, 318, 540, 918] },
      { name: 'Medkit', info: '+1.5 HP/s regen', costs: [130, 221, 376, 639, 1086] },
      { name: 'Scavenger', info: '+luck when searching', costs: [100, 170, 289, 491, 835] },
    ],
    abilities: ABILITIES, structs: STRUCTS, buildable: [3, 4, 5, 6, 7, 8],
    siteKinds: [{ name: 'Ruined house', search: 3 }, { name: 'Car wreck', search: 2 }, { name: 'Supply crate', search: 1.5 }, { name: 'Overrun outpost', search: 6 },
      { name: 'Pickup truck', search: 2.5 }, { name: 'Police cruiser', search: 2.5 }, { name: 'Ambulance', search: 3 }, { name: 'School bus', search: 4 }, { name: 'Army truck', search: 3.5 }],
    sites: [],
    difficulty: { id: 1, name: 'Normal' }, difficulties: ['Easy', 'Normal', 'Hard', 'Brutal'],
    weathers: WEATHERS,
    taunt: { cool: 12, radius: 12, time: 5 },
    revive: { reach: 1.6, time: 2.5, hp: 0.4 },
  };
}
