// Wire types and the binary frame decoder for web/PROTOCOL.md. Frames are decoded into
// preallocated typed arrays: nothing per creep is allocated while the game runs.

export const MAX_CREEPS = 16384;
export const MAX_PLAYERS = 8;

export const enum Tile { Grass = 0, Dirt = 1, Floor = 2, Sand = 3, Water = 4, Tree = 5, Rock = 6 }
export const enum Phase { Build = 0, Wave = 1, Over = 2 }

export const PF_CONNECTED = 1, PF_ALIVE = 2, PF_FIRING = 4, PF_READY = 8, PF_RELOADING = 16,
  PF_HURT = 32, PF_ARMORY = 64, PF_MOVING = 128;
export const CF_BURNING = 1, CF_SLOWED = 2, CF_GUARD = 4, CF_HUNTING = 8, CF_SIEGE = 16, CF_ASLEEP = 32, CF_WINDUP = 64, CF_STRIKE = 128;

export const enum Order { Idle = 0, Move, AMove, Attack, Hold, Build, Repair, Loot, Revive, Steer }
export const enum BlastKind { Explosion = 0, Frost, Tesla, Concussion, Airstrike, Loot, Ambush, Taunt, Lightning, Revived, GuardsWake }
export const enum Weather { Clear = 0, Fog, Rain, Storm, Snow, Drizzle, Thunder, HeavySnow }
export const enum Emote { None = 0, Taunt }
// What a ping means: picked from what is under the cursor when it is placed.
export const enum PingKind { Here = 0, Danger, Loot, Defend }
export const enum SiteKind { House = 0, Car, Crate, Outpost, Pickup, Police, Ambulance, Bus, Army }
// A building searched from inside, rather than a thing in the open.
export function walled(k: number): boolean { return k === SiteKind.House || k === SiteKind.Outpost; }
// Which prop a site shows: an outpost's stash looks like a house's.
export function propKind(k: number): number { return k === SiteKind.Outpost ? SiteKind.House : k > SiteKind.Outpost ? k - 1 : k; }
// A vehicle on the road: a car, pickup, cruiser, ambulance, bus or army truck.
export function wreck(k: number): boolean { return k === SiteKind.Car || k >= SiteKind.Pickup; }
// Drop: a Huey flying in from (x0, y0); its crate lands on (x, y) when left runs out.
export const enum EffectKind { Grenade = 1, Napalm = 2, AirTarget = 3, Drop = 4 }
// The door gunner's shots, from the Huey in the air.
export const TRACER_HELI = 34;

export interface CreepDef { name: string; hp: number; speed: number; radius: number; size: number; ranged: boolean; bounty: number; rate?: number; windup?: number }
export interface SigDef { name: string; desc: string; cool: number; range: number; radius?: number; cone?: number; target: string }
export interface WeaponDef {
  name: string; short: string; price: number; range: number; fire: string; special: string;
  costs: number[][]; values: string[][]; sig: SigDef;
}
export interface GearDef { name: string; info: string; costs: number[] }
export interface AbilityDef {
  name: string; key: string; desc: string; target: string; range: number; radius?: number[];
  cool: number[]; costs: number[]; always: boolean;
}
export interface StructDef {
  name: string; price: number; hp: number; w: number; h: number; range: number; ranges?: number[]; turret: boolean;
  key: string; desc: string; upgrade: number[];
}
export interface SiteKindDef { name: string; search: number }
// A loot site: the tiles it covers, the spot it is searched from, how far out it is, and how
// hard its guards are (0 none .. 3 a lair).
// yaw: a wreck's heading (radians, +x towards +y); the host blocks survivors with a box along it.
export interface SiteDef { kind: number; x: number; y: number; w: number; h: number; sx: number; sy: number; tier: number; guard: number; yaw?: number }
export interface WeatherDef { name: string; info: string }
// Where a site's loot stands: a house's search spot, the middle of a car's or crate's tile.
export function siteX(s: SiteDef): number { return walled(s.kind) ? s.sx : s.x + s.w / 2; }
export function siteY(s: SiteDef): number { return walled(s.kind) ? s.sy : s.y + s.h / 2; }
export interface Welcome {
  t: 'welcome'; proto: number; version: string; you: number; w: number; h: number; seed: string;
  host: string; hosting: boolean; hint: string; tickRate: number; core: { x: number; y: number };
  buildRadius: number; shopRadius: number; maxLevel: number; maxStructLevel: number;
  repairCostPerHP: number; sellFraction?: number; tracks: string[]; creeps: CreepDef[]; weapons: WeaponDef[];
  gear: GearDef[]; abilities: AbilityDef[]; structs: StructDef[]; buildable: number[];
  siteKinds: SiteKindDef[]; sites: SiteDef[];
  difficulty: { id: number; name: string }; difficulties: string[]; weathers: WeatherDef[];
  taunt: { cool: number; radius: number; time: number };
  revive: { reach: number; time: number; hp: number };
  // heal: the share of max HP one medkit gives back over time seconds; max carried; cost each.
  medkit?: { heal: number; time: number; max: number; cost: number };
}
// turretRange is a turret's reach at a level (1-based), from the per-level table when the
// host sends one.
export function turretRange(d: StructDef, level: number): number {
  return d.ranges?.[level - 1] ?? d.range;
}

// sellValue is what selling a structure returns, as the host works it out.
export function sellValue(d: StructDef, level: number, hp: number, maxHp: number, frac = 0.5): number {
  let spent = d.price;
  for (let l = 1; l < level; l++) spent += d.upgrade[l] ?? 0;
  return Math.floor(spent * frac * (maxHp > 0 ? hp / maxHp : 1));
}

export interface Toast { t: 'toast'; level: number; text: string }
export interface Status { t: 'status'; text: string }
export interface End { t: 'end'; reason: string }
export type TextMsg = Welcome | Toast | Status | End;

export type Command =
  | { op: 'move' | 'amove'; x: number; y: number }
  | { op: 'attack'; id: number }
  | { op: 'stop' } | { op: 'hold' } | { op: 'reload' } | { op: 'restart' } | { op: 'leave' } | { op: 'taunt' } | { op: 'sprint'; on: boolean } | { op: 'pause' }
  | { op: 'revive'; p: number }
  | { op: 'ability'; slot: number; x: number; y: number }
  | { op: 'build'; kind: number; tx: number; ty: number }
  | { op: 'repair' | 'upgradeStruct' | 'sell'; s: number }
  | { op: 'loot'; site: number }
  | { op: 'buyWeapon' | 'select'; w: number }
  | { op: 'upgrade'; w: number; track: number }
  | { op: 'gear'; g: number }
  | { op: 'buyAbility'; slot: number }
  | { op: 'ready'; on: boolean }
  | { op: 'chat'; text: string }
  | { op: 'ping'; x: number; y: number; kind: number }
  // x: the walking direction in radians, in map coordinates; on false lets go.
  | { op: 'steer'; x: number; on: boolean }
  | { op: 'medkit' } | { op: 'buyMedkit' };

export class Player {
  id = 0; flags = 0; x = 0; y = 0; aim = 0; hp = 0; maxHp = 1; cur = 0; ammo = 0; mag = 0;
  reload = 0; respawn = 0; gold = 0; kills = 0; damage = 0; owned = 0;
  levels = new Uint8Array(28); gear = new Uint8Array(4);
  // channel: the current search's (order Loot) or revive's (order Revive) progress, 0..1.
  // revived: for a downed survivor, how far someone's revive of them is, 0..1.
  order = 0; channel = 0; revived = 0; emote = 0; emoteLeft = 0; tauntCool = 0; stamina = 1; sprinting = false; winded = false; look = 0; buff = 0; buffLeft = 0;
  abLevel = new Uint8Array(4); abCool = new Float32Array(4);
  // Medkits carried, and seconds of a medkit's healing left.
  medkits = 0; heal = 0;
  // A bit per weapon with a reload running, the one in hand or not.
  reloading = 0;
  name = '';
  private nameBytes = new Uint8Array(0);

  setName(src: Uint8Array): void {
    const nb = this.nameBytes;
    if (nb.length === src.length) {
      let same = true;
      for (let i = 0; i < nb.length; i++) if (nb[i] !== src[i]) { same = false; break; }
      if (same) return;
    }
    this.nameBytes = src.slice();
    this.name = utf8.decode(src);
  }
  copyFrom(o: Player): void {
    this.id = o.id; this.flags = o.flags; this.x = o.x; this.y = o.y; this.aim = o.aim;
    this.hp = o.hp; this.maxHp = o.maxHp; this.cur = o.cur; this.ammo = o.ammo; this.mag = o.mag;
    this.reload = o.reload; this.respawn = o.respawn; this.gold = o.gold; this.kills = o.kills;
    this.damage = o.damage; this.owned = o.owned; this.levels.set(o.levels); this.gear.set(o.gear);
    this.order = o.order; this.channel = o.channel; this.revived = o.revived; this.emote = o.emote;
    this.emoteLeft = o.emoteLeft; this.tauntCool = o.tauntCool; this.stamina = o.stamina; this.sprinting = o.sprinting; this.winded = o.winded; this.look = o.look; this.buff = o.buff; this.buffLeft = o.buffLeft;
    this.abLevel.set(o.abLevel); this.abCool.set(o.abCool); this.medkits = o.medkits; this.heal = o.heal; this.reloading = o.reloading; this.name = o.name;
  }
}

const utf8 = new TextDecoder();

// Growable struct-of-arrays list, for the lists whose length has no tight bound.
function grow<T extends Uint8Array | Uint16Array | Int8Array | Float32Array>(a: T, n: number): T {
  if (a.length >= n) return a;
  const C = a.constructor as new (n: number) => T;
  const b = new C(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}

export class Frame {
  tick = 0; phase = 0; wave = 0; phaseLeft = 0; pending = 0; totalKills = 0; best = 0;
  // weatherAmt: 0..1, how strongly the weather shows right now.
  weather = 0; weatherAmt = 0;
  // The player who paused the game, or -1 while it runs.
  pausedBy = -1;

  nPlayers = 0;
  players: Player[] = [];

  // Per site: bit 7 searched, bits 0..6 guards still alive.
  nSites = 0;
  sites = new Uint8Array(128);

  nStructs = 0;
  sAlive = new Uint8Array(256); sKind = new Uint8Array(256);
  sX = new Uint16Array(256); sY = new Uint16Array(256);
  sW = new Uint8Array(256); sH = new Uint8Array(256);
  sHp = new Uint16Array(256); sMaxHp = new Uint16Array(256);
  sLevel = new Uint8Array(256); sOwner = new Int8Array(256);

  nCreeps = 0;
  cId = new Uint16Array(MAX_CREEPS); cX = new Float32Array(MAX_CREEPS); cY = new Float32Array(MAX_CREEPS);
  cKind = new Uint8Array(MAX_CREEPS); cHp = new Uint8Array(MAX_CREEPS); cFlags = new Uint8Array(MAX_CREEPS);
  // The hunted player's id for CF_HUNTING, else 255.
  cTarget = new Uint8Array(MAX_CREEPS);

  nTracers = 0;
  tX0 = new Float32Array(256); tY0 = new Float32Array(256); tX1 = new Float32Array(256); tY1 = new Float32Array(256);
  tKind = new Uint8Array(256);

  nBlasts = 0;
  bX = new Float32Array(64); bY = new Float32Array(64); bR = new Float32Array(64); bKind = new Uint8Array(64);

  nDeaths = 0;
  dX = new Float32Array(256); dY = new Float32Array(256); dKind = new Uint8Array(256);

  nEffects = 0;
  eKind = new Uint8Array(32); eX0 = new Float32Array(32); eY0 = new Float32Array(32);
  eX = new Float32Array(32); eY = new Float32Array(32); eR = new Float32Array(32);
  eLeft = new Uint8Array(32); eTotal = new Uint8Array(32);

  notes: { level: number; text: string }[] = [];
  // Supply crates down and not yet opened; open is how far opening one is, 0..1.
  crates: { x: number; y: number; open: number }[] = [];
  pings: { player: number; x: number; y: number; kind: number }[] = [];

  constructor() {
    for (let i = 0; i < 256; i++) this.players.push(new Player());
  }

  siteSearched(i: number): boolean {
    return i < this.nSites && (this.sites[i] & 0x80) !== 0;
  }

  // siteGuards is how many of site i's guards are alive; it cannot be searched until 0.
  siteGuards(i: number): number {
    return i < this.nSites ? this.sites[i] & 0x7f : 0;
  }

  player(id: number): Player | null {
    for (let i = 0; i < this.nPlayers; i++) if (this.players[i].id === id) return this.players[i];
    return null;
  }
}

const Q = 1 / 8;

// decodeFrame parses a type-1 message into f. Throws on a truncated message.
export function decodeFrame(buf: ArrayBuffer, f: Frame): void {
  const d = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 1;
  f.tick = d.getUint32(o, true); o += 4;
  f.phase = d.getUint8(o); o += 1;
  f.wave = d.getUint16(o, true); o += 2;
  f.phaseLeft = d.getUint16(o, true); o += 2;
  f.pending = d.getUint32(o, true); o += 4;
  f.totalKills = d.getUint32(o, true); o += 4;
  f.best = d.getUint16(o, true); o += 2;
  f.weather = d.getUint8(o); f.weatherAmt = d.getUint8(o + 1) / 255; f.pausedBy = d.getUint8(o + 2) - 1; o += 3;

  const np = d.getUint8(o); o += 1;
  f.nPlayers = np;
  for (let i = 0; i < np; i++) {
    const p = f.players[i];
    p.id = d.getUint8(o); p.flags = d.getUint8(o + 1);
    p.x = d.getUint16(o + 2, true) * Q; p.y = d.getUint16(o + 4, true) * Q;
    p.aim = d.getUint16(o + 6, true) / 65536 * Math.PI * 2;
    p.hp = d.getUint16(o + 8, true); p.maxHp = d.getUint16(o + 10, true);
    p.cur = d.getUint8(o + 12);
    p.ammo = d.getUint16(o + 13, true); p.mag = d.getUint16(o + 15, true);
    p.reload = d.getUint8(o + 17) / 255; p.respawn = d.getUint8(o + 18);
    p.gold = d.getUint32(o + 19, true); p.kills = d.getUint32(o + 23, true); p.damage = d.getUint32(o + 27, true);
    p.owned = d.getUint8(o + 31);
    o += 32;
    p.levels.set(bytes.subarray(o, o + 28)); o += 28;
    p.gear.set(bytes.subarray(o, o + 4)); o += 4;
    p.order = d.getUint8(o); p.channel = d.getUint8(o + 1) / 255; p.revived = d.getUint8(o + 2) / 255;
    p.emote = d.getUint8(o + 3); p.emoteLeft = d.getUint8(o + 4) / 10; p.tauntCool = d.getUint16(o + 5, true) / 10;
    p.stamina = d.getUint8(o + 7) / 255; const sp = d.getUint8(o + 8); p.sprinting = (sp & 1) !== 0; p.winded = (sp & 2) !== 0;
    p.look = d.getUint32(o + 9, true);
    p.buff = d.getUint8(o + 13); p.buffLeft = d.getUint8(o + 14) / 10; o += 15;
    for (let a = 0; a < 4; a++) {
      p.abLevel[a] = d.getUint8(o); p.abCool[a] = d.getUint16(o + 1, true) / 10; o += 3;
    }
    p.medkits = d.getUint8(o); p.heal = d.getUint8(o + 1) / 10; p.reloading = d.getUint8(o + 2); o += 3;
    const nl = d.getUint8(o); o += 1;
    p.setName(bytes.subarray(o, o + nl)); o += nl;
  }

  const nsite = d.getUint16(o, true); o += 2;
  f.sites = grow(f.sites, nsite);
  f.sites.set(bytes.subarray(o, o + nsite)); o += nsite;
  f.nSites = nsite;
  const ncr = bytes[o]; o += 1;
  f.crates.length = 0;
  for (let i = 0; i < ncr; i++, o += 5) f.crates.push({ x: d.getUint16(o, true) * Q, y: d.getUint16(o + 2, true) * Q, open: bytes[o + 4] / 255 });

  const ns = d.getUint16(o, true); o += 2;
  if (f.sAlive.length < ns) {
    f.sAlive = grow(f.sAlive, ns); f.sKind = grow(f.sKind, ns); f.sX = grow(f.sX, ns); f.sY = grow(f.sY, ns);
    f.sW = grow(f.sW, ns); f.sH = grow(f.sH, ns); f.sHp = grow(f.sHp, ns); f.sMaxHp = grow(f.sMaxHp, ns);
    f.sLevel = grow(f.sLevel, ns); f.sOwner = grow(f.sOwner, ns);
  }
  f.nStructs = ns;
  for (let i = 0; i < ns; i++) {
    f.sAlive[i] = d.getUint8(o); f.sKind[i] = d.getUint8(o + 1);
    f.sX[i] = d.getUint16(o + 2, true); f.sY[i] = d.getUint16(o + 4, true);
    f.sW[i] = d.getUint8(o + 6); f.sH[i] = d.getUint8(o + 7);
    f.sHp[i] = d.getUint16(o + 8, true); f.sMaxHp[i] = d.getUint16(o + 10, true);
    f.sLevel[i] = d.getUint8(o + 12); f.sOwner[i] = d.getInt8(o + 13);
    o += 14;
  }

  let nc = d.getUint16(o, true); o += 2;
  if (nc > MAX_CREEPS) nc = MAX_CREEPS;
  f.nCreeps = nc;
  const cId = f.cId, cX = f.cX, cY = f.cY, cKind = f.cKind, cHp = f.cHp, cFlags = f.cFlags, cTarget = f.cTarget;
  for (let i = 0; i < nc; i++) {
    cId[i] = d.getUint16(o, true);
    cX[i] = d.getUint16(o + 2, true) * Q;
    cY[i] = d.getUint16(o + 4, true) * Q;
    cKind[i] = bytes[o + 6]; cHp[i] = bytes[o + 7]; cFlags[i] = bytes[o + 8]; cTarget[i] = bytes[o + 9];
    o += 10;
  }

  const nt = d.getUint16(o, true); o += 2;
  if (f.tKind.length < nt) {
    f.tX0 = grow(f.tX0, nt); f.tY0 = grow(f.tY0, nt); f.tX1 = grow(f.tX1, nt); f.tY1 = grow(f.tY1, nt);
    f.tKind = grow(f.tKind, nt);
  }
  f.nTracers = nt;
  for (let i = 0; i < nt; i++) {
    f.tX0[i] = d.getUint16(o, true) * Q; f.tY0[i] = d.getUint16(o + 2, true) * Q;
    f.tX1[i] = d.getUint16(o + 4, true) * Q; f.tY1[i] = d.getUint16(o + 6, true) * Q;
    f.tKind[i] = bytes[o + 8];
    o += 9;
  }

  const nb = d.getUint16(o, true); o += 2;
  if (f.bKind.length < nb) {
    f.bX = grow(f.bX, nb); f.bY = grow(f.bY, nb); f.bR = grow(f.bR, nb); f.bKind = grow(f.bKind, nb);
  }
  f.nBlasts = nb;
  for (let i = 0; i < nb; i++) {
    f.bX[i] = d.getUint16(o, true) * Q; f.bY[i] = d.getUint16(o + 2, true) * Q;
    f.bR[i] = bytes[o + 4] * Q; f.bKind[i] = bytes[o + 5];
    o += 6;
  }

  const nd = d.getUint16(o, true); o += 2;
  if (f.dKind.length < nd) { f.dX = grow(f.dX, nd); f.dY = grow(f.dY, nd); f.dKind = grow(f.dKind, nd); }
  f.nDeaths = nd;
  for (let i = 0; i < nd; i++) {
    f.dX[i] = d.getUint16(o, true) * Q; f.dY[i] = d.getUint16(o + 2, true) * Q; f.dKind[i] = bytes[o + 4];
    o += 5;
  }

  const ne = d.getUint16(o, true); o += 2;
  if (f.eKind.length < ne) {
    f.eKind = grow(f.eKind, ne); f.eX0 = grow(f.eX0, ne); f.eY0 = grow(f.eY0, ne); f.eX = grow(f.eX, ne);
    f.eY = grow(f.eY, ne); f.eR = grow(f.eR, ne); f.eLeft = grow(f.eLeft, ne); f.eTotal = grow(f.eTotal, ne);
  }
  f.nEffects = ne;
  for (let i = 0; i < ne; i++) {
    f.eKind[i] = bytes[o];
    f.eX0[i] = d.getUint16(o + 1, true) * Q; f.eY0[i] = d.getUint16(o + 3, true) * Q;
    f.eX[i] = d.getUint16(o + 5, true) * Q; f.eY[i] = d.getUint16(o + 7, true) * Q;
    f.eR[i] = bytes[o + 9] * Q; f.eLeft[i] = bytes[o + 10]; f.eTotal[i] = bytes[o + 11];
    o += 12;
  }

  const nn = d.getUint8(o); o += 1;
  f.notes.length = 0;
  for (let i = 0; i < nn; i++) {
    const level = d.getUint8(o);
    const len = d.getUint16(o + 1, true); o += 3;
    f.notes.push({ level, text: utf8.decode(bytes.subarray(o, o + len)) });
    o += len;
  }

  const ng = d.getUint8(o); o += 1;
  f.pings.length = 0;
  for (let i = 0; i < ng; i++) {
    f.pings.push({ player: bytes[o], x: d.getUint16(o + 1, true) * Q, y: d.getUint16(o + 3, true) * Q, kind: bytes[o + 5] });
    o += 6;
  }
  if (o > buf.byteLength) throw new Error('frame truncated');
}
