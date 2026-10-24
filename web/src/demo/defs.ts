import type { AbilityDef, CreepDef, StructDef, WeaponDef, Welcome } from '../protocol';

// Definitions for demo mode. They follow internal/game/defs.go where that exists and invent
// the rest (ultimates, abilities) the way the host is expected to send them.

export const CREEPS: CreepDef[] = [
  { name: 'walker', hp: 40, speed: 1.7, radius: 0.45, size: 1, ranged: false, bounty: 3, rate: 1, windup: 0.4 },
  { name: 'runner', hp: 24, speed: 3.6, radius: 0.4, size: 1, ranged: false, bounty: 3, rate: 1.6, windup: 0.28 },
  { name: 'swarmer', hp: 9, speed: 2.7, radius: 0.3, size: 1, ranged: false, bounty: 1, rate: 2, windup: 0.18 },
  { name: 'brute', hp: 280, speed: 1.5, radius: 0.9, size: 2, ranged: false, bounty: 15, rate: 0.7, windup: 0.65 },
  { name: 'spitter', hp: 55, speed: 1.5, radius: 0.45, size: 1, ranged: true, bounty: 6, rate: 0.5, windup: 0.5 },
  { name: 'abomination', hp: 3200, speed: 0.95, radius: 1.4, size: 3, ranged: false, bounty: 300, rate: 0.6, windup: 0.7 },
  { name: 'hurler', hp: 45, speed: 1.4, radius: 0.45, size: 1, ranged: true, bounty: 8, rate: 0.4, windup: 0.8 },
  { name: 'broodmother', hp: 2600, speed: 1.05, radius: 1.3, size: 3, ranged: false, bounty: 300, rate: 0.7, windup: 0.6 },
  { name: 'hound', hp: 20, speed: 5, radius: 0.38, size: 1, ranged: false, bounty: 2, rate: 2, windup: 0.22 },
  { name: 'mauler', hp: 420, speed: 2.6, radius: 1, size: 2, ranged: false, bounty: 30, rate: 0.8, windup: 0.5 },
  { name: 'goliath', hp: 3600, speed: 1.7, radius: 1.5, size: 3, ranged: false, bounty: 300, rate: 0.7, windup: 0.6 },
];

interface W0 { name: string; short: string; price: number; range: number; fire: string; special: string; dmg: number; rate: number; mag: number; reload: number; ult: WeaponDef['ult'] }
export const WEAPON_BASE: W0[] = [
  { name: 'Pistol', short: 'PST', price: 0, range: 14, fire: 'hitscan', special: '+1 pierce', dmg: 14, rate: 3, mag: 12, reload: 1.1,
    ult: { name: 'Dead Eye', desc: 'Mark every creep in sight for 1.5 seconds, walking slowly, then shoot each once: deadly to anything short of a brute.', time: 1.5, range: 0, radius: 0, target: 'self' } },
  { name: 'Shotgun', short: 'SHG', price: 250, range: 10, fire: 'hitscan', special: '+2 pellets', dmg: 13, rate: 1.3, mag: 6, reload: 1.8,
    ult: { name: 'Dragon\'s breath', desc: '8 seconds of incendiary loads at 2.5 times the rate with no reloading: every pellet sets its creep burning and pushes it back.', time: 8, range: 0, radius: 0, target: 'self' } },
  { name: 'SMG', short: 'SMG', price: 400, range: 12, fire: 'hitscan', special: '+1 pierce', dmg: 8, rate: 11, mag: 40, reload: 1.6,
    ult: { name: 'Run and gun', desc: '10 seconds of twice the fire rate with no reloading, a quarter more speed and sprinting that never tires.', time: 10, range: 0, radius: 0, target: 'self' } },
  { name: 'Rifle', short: 'RFL', price: 650, range: 28, fire: 'hitscan', special: '+2 pierce', dmg: 60, rate: 1.4, mag: 5, reload: 2,
    ult: { name: 'Railgun', desc: '10 seconds of every shot going through every creep in its line, without reloading.', time: 10, range: 0, radius: 0, target: 'self' } },
  { name: 'Minigun', short: 'MNG', price: 1400, range: 16, fire: 'hitscan', special: '+1 pierce, +burn', dmg: 9, rate: 22, mag: 150, reload: 3.5,
    ult: { name: 'Overdrive', desc: '10 seconds of 80% more fire rate, two more pierce, half the spread and no reloading, in red-hot rounds.', time: 10, range: 0, radius: 0, target: 'self' } },
  { name: 'Rocket launcher', short: 'RKT', price: 2000, range: 24, fire: 'rocket', special: '+blast radius', dmg: 140, rate: 0.8, mag: 4, reload: 2.6,
    ult: { name: 'Cluster MIRV', desc: 'One rocket to a point that splits over it into ten bomblets, each hitting like a rocket.', time: 0, range: 24, radius: 4.5, target: 'point' } },
  { name: 'Crowbar', short: 'BAR', price: 0, range: 1.9, fire: 'melee', special: '+wider swing', dmg: 34, rate: 1.8, mag: 1, reload: 0,
    ult: { name: 'Berserk', desc: '8 seconds of swinging twice as fast, every hit healing you, shrugging off slows and stuns.', time: 8, range: 0, radius: 0, target: 'self' } },
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
    return { name: w.name, short: w.short, price: w.price, range: w.range, fire: w.fire, special: w.special, costs, values, ult: w.ult };
  });
}

export const ABILITIES: AbilityDef[] = [
  { name: 'Ultimate', key: 'Q', desc: "The equipped weapon's ultimate, charged by fighting.", target: 'point', range: 0, cool: [0], costs: [0], always: true },
  { name: 'Grenade', key: 'Shift', desc: 'Lobbed at a point, bursts after a moment. Bigger, harder and sooner each level; from level 4 it leaves the ground burning.', target: 'point', range: 12, radius: [3, 3.5, 4, 4.5, 5], cool: [8, 7, 6, 5.5, 5], costs: [200, 400, 700, 1100, 1600], always: false },
  { name: 'Dash', key: 'F', desc: 'A short burst of speed towards the target point.', target: 'point', range: 5, cool: [10, 8, 6], costs: [300, 600, 1000], always: false },
  { name: 'Airstrike', key: 'V', desc: 'Call in a bombing run on the target after 3 seconds.', target: 'point', range: 40, cool: [60, 50, 40], costs: [600, 1100, 1800], always: false },
];

// Blast radii of the abilities, for the area preview: grenade, napalm, airstrike.
export const ABILITY_RADIUS = [0, 3, 0, 7];

const up = (price: number) => [0, 1, 2, 3, 4].map((l) => Math.round(price * 0.8 * l));

// A turret's base numbers, as in internal/game/defs.go, and what its special track does.
export interface TurretBase { dmg: number; rate: number; range: number; blast: number; slow: number; chains: number; pierce: number; salvo: number }
export const TURRET_BASE: Record<number, TurretBase> = {
  5: { dmg: 11, rate: 4, range: 9, blast: 0, slow: 0, chains: 0, pierce: 0, salvo: 0 },
  6: { dmg: 60, rate: 0.6, range: 11, blast: 2.2, slow: 0, chains: 0, pierce: 0, salvo: 0 },
  7: { dmg: 3, rate: 1, range: 6, blast: 0, slow: 1.6, chains: 0, pierce: 0, salvo: 0 },
  8: { dmg: 36, rate: 1.2, range: 8, blast: 0, slow: 0, chains: 2, pierce: 0, salvo: 0 },
  9: { dmg: 150, rate: 0.35, range: 22, blast: 0, slow: 0, chains: 0, pierce: 1, salvo: 0 },
  10: { dmg: 45, rate: 0.5, range: 14, blast: 2, slow: 0, chains: 0, pierce: 0, salvo: 3 },
};

// turretStats applies track levels (damage, rate, range, special) the way the host does.
export function turretStats(kind: number, lv: ArrayLike<number>): TurretBase & { hop: number } {
  const b = TURRET_BASE[kind], sp = lv[3];
  const s = { ...b, dmg: b.dmg * (1 + 0.3 * lv[0]), rate: b.rate * (1 + 0.15 * lv[1]), range: b.range * (1 + 0.08 * lv[2]), hop: 3.5 };
  if (kind === 5 || kind === 9) s.pierce += sp;
  else if (kind === 6) s.blast += 0.3 * sp;
  else if (kind === 7) s.slow += 0.4 * sp;
  else if (kind === 8) { s.chains += 2 * sp; s.hop += 0.5 * sp; }
  else if (kind === 10) s.salvo += sp;
  return s;
}

function turretValue(kind: number, t: number, l: number): string {
  const lv = [0, 0, 0, 0]; lv[t] = l;
  const s = turretStats(kind, lv);
  if (t === 0) return `${Math.round(s.dmg)} dmg`;
  if (t === 1) return s.rate < 1 ? `every ${(1 / s.rate).toFixed(1)}s` : `${s.rate.toFixed(1)}/s`;
  if (t === 2) return `${s.range.toFixed(1)} range`;
  if (kind === 6) return `${s.blast.toFixed(1)} blast`;
  if (kind === 7) return `${Math.round((0.45 + 0.06 * l) * 100)}% slow`;
  if (kind === 8) return `${s.chains + 1} creeps, ${s.hop.toFixed(1)} jump`;
  if (kind === 10) return `${s.salvo} missiles`;
  return `${s.pierce} pierce`;
}

function turret(kind: number, d: Omit<StructDef, 'turret' | 'upgrade' | 'upgradable' | 'w' | 'h' | 'range'>): StructDef {
  const lvls = [0, 1, 2, 3, 4, 5];
  return {
    ...d, w: 1, h: 1, turret: true, upgradable: true, range: TURRET_BASE[kind].range,
    upgrade: lvls.slice(0, 5).map((l) => Math.round(d.price * 0.3 * Math.pow(1.5, l))),
    ranges: lvls.map((l) => turretStats(kind, [0, 0, l, 0]).range),
    values: [0, 1, 2, 3].map((t) => lvls.map((l) => turretValue(kind, t, l))),
  };
}

export const STRUCTS: StructDef[] = [
  { name: 'none', price: 0, hp: 0, w: 1, h: 1, range: 0, turret: false, key: '', desc: '', upgrade: [] },
  { name: 'Generator', price: 0, hp: 2500, w: 5, h: 5, range: 0, turret: false, key: '', desc: 'Powers the base. If it falls, the game is over.', upgrade: [] },
  { name: 'Armory', price: 0, hp: 1200, w: 3, h: 3, range: 0, turret: false, key: '', desc: 'Buy and upgrade weapons, gear and abilities here.', upgrade: [] },
  { name: 'Wall', price: 20, hp: 320, w: 1, h: 1, range: 0, turret: false, key: '1', desc: 'Blocks creeps; they have to break through.', upgrade: up(20), upgradable: true },
  { name: 'Gate', price: 45, hp: 320, w: 1, h: 1, range: 0, turret: false, key: '2', desc: 'Players walk through, creeps break it down.', upgrade: up(45), upgradable: true },
  turret(5, { name: 'Gun turret', price: 120, hp: 220, key: '3', desc: 'Fast single shots at the nearest creep.', special: '+1 pierce' }),
  turret(6, { name: 'Cannon', price: 240, hp: 280, key: '4', desc: 'Slow, heavy shells that burst on a crowd.', special: '+blast radius' }),
  turret(7, { name: 'Frost tower', price: 180, hp: 220, key: '5', desc: 'Pulses cold, slowing everything around it.', special: '+deeper slow' }),
  turret(8, { name: 'Tesla coil', price: 280, hp: 220, key: '6', desc: 'Lightning that jumps from creep to creep.', special: '+2 jumps, further' }),
  turret(9, { name: 'Sniper tower', price: 380, hp: 200, key: '7', desc: 'A slow, heavy round from far off at the toughest creep it can see, tearing out a share of its health: the boss killer.', special: '+1 pierce' }),
  turret(10, { name: 'Missile battery', price: 420, hp: 260, key: '8', desc: 'A salvo of rockets with a wide blast, each at a different creep, coming down only near it.', special: '+1 missile' }),
];

export const WEATHERS = [
  { name: 'Clear', info: '' },
  { name: 'Fog', info: 'you see far less; you and your turrets reach 25% less far; creeps notice you later' },
  { name: 'Heavy rain', info: 'harder to see; fire burns half as hot; creeps 8% slower' },
  { name: 'Storm', info: 'heavy rain, and lightning strikes creeps out in the open' },
  { name: 'Snow', info: 'creeps 6% slower, survivors 3% slower' },
  { name: 'Drizzle', info: 'a little harder to see; fire burns a little cooler' },
  { name: 'Thunder shower', info: 'light rain; now and then lightning strikes a creep in the open' },
  { name: 'Heavy snow', info: 'creeps 15% slower, survivors 8% slower' },
];

export function demoWelcome(w: number, h: number): Welcome {
  return {
    t: 'welcome', proto: 4, version: 'demo', you: 0, w, h, seed: '424242', host: 'demo',
    hosting: true, hint: '', tickRate: 20, core: { x: w / 2, y: h / 2 }, buildRadius: 40,
    shopRadius: 4.5, maxLevel: 5, maxStructLevel: 5, repairCostPerHP: 0.1,
    tracks: ['damage', 'fire rate', 'handling', 'special'],
    turretTracks: ['damage', 'fire rate', 'range', 'special'],
    creeps: CREEPS, weapons: weaponDefs(),
    gear: [
      { name: 'Armor', info: '+25 max HP', costs: [90, 153, 260, 442, 752] },
      { name: 'Boots', info: '+8% speed', costs: [110, 187, 318, 540, 918] },
      { name: 'Vitamins', info: '+1.5 HP/s regen', costs: [130, 221, 376, 639, 1086] },
      { name: 'Scavenger', info: '+luck when searching', costs: [100, 170, 289, 491, 835] },
    ],
    abilities: ABILITIES, structs: STRUCTS, buildable: [3, 4, 5, 6, 7, 8, 9, 10],
    siteKinds: [{ name: 'Ruined house', search: 3 }, { name: 'Car wreck', search: 2 }, { name: 'Supply crate', search: 1.5 }, { name: 'Overrun outpost', search: 6 },
      { name: 'Pickup truck', search: 2.5 }, { name: 'Police cruiser', search: 2.5 }, { name: 'Ambulance', search: 3 }, { name: 'School bus', search: 4 }, { name: 'Army truck', search: 3.5 },
      { name: 'Gas station', search: 5 }, { name: 'Fuel pump', search: 0 }, { name: 'Fire engine', search: 3 }, { name: 'Armoured van', search: 4.5 },
      { name: 'Camper van', search: 3 }, { name: 'Motorbike', search: 1 }, { name: 'Crashed plane', search: 6 }, { name: 'Engine', search: 0 },
      { name: 'Church', search: 2.5 }],
    sites: [],
    difficulty: { id: 1, name: 'Normal' }, difficulties: ['Easy', 'Normal', 'Hard', 'Brutal'],
    weathers: WEATHERS,
    taunt: { cool: 12, radius: 12, time: 5 },
    medkit: { heal: 0.4, time: 3, max: 3, cost: 60 },
    revive: { reach: 1.6, time: 2.5, hp: 0.4 },
  };
}
