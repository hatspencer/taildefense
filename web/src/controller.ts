import * as THREE from 'three/webgpu';
import type { CameraRig } from './camera';
import { lootable, walled, type Command, PF_ALIVE, PF_ARMORY, PF_CONNECTED, PF_READY, Phase, PingKind, SiteKind, siteX, siteY, Tile } from './protocol';
import type { Effects } from './scene/effects';
import type { Game } from './state';

export type Mode = { k: 'none' } | { k: 'ping' } | { k: 'ability'; slot: number } | { k: 'build'; kind: number };
// gun: a weapon on the ground, by its id.
export type Pick = { t: 'creep' | 'struct' | 'hero' | 'site' | 'gun'; id: number } | null;

export interface AbilityInfo { name: string; desc: string; key: string; range: number; radius: number; cool: number; target: string; level: number; maxLevel: number; left: number; nextCost: number }

// Area radius per ability name; the protocol carries no radius (see the report), so the
// preview falls back to these and draws nothing for unknown ones.
const RADIUS: Record<string, number> = {
  grenade: 3, airstrike: 7, 'fan the hammer': 2.5, concussion: 4, firewall: 2.5, barrage: 4, railshot: 0.6, 'piercing shot': 0.6,
};

// Ability slots: the weapon's signature on the right mouse button, Overwatch style, then the
// bought abilities; WASD walks.
export const KEYS = ['RMB', 'Shift', 'F', 'Q'];

// How far E reaches for something to use when nothing is under the cursor, in tiles.
const USE_REACH = 4;
const CRATE_REACH = 14; // tiles within which E walks to a supply crate

// What the player is doing with the mouse, what is selected and hovered, and every action
// the input handlers and the HUD buttons can trigger.
export class Controller {
  mode: Mode = { k: 'none' };
  sel: Pick = null;
  hover: Pick = null;
  ground = new THREE.Vector3();
  groundOk = false;
  mx = -1; my = -1; mouseIn = false;
  shift = false;
  armoryOpen = false;
  // When G went down to drop the weapon in hand, 0 while it is up (input.ts).
  dropAt = 0;
  private wasAtArmory = false;
  // Set by walkToArmory: the window opens on arrival, but not for walking past the shop.
  private toArmory = false;
  private g1 = new THREE.Vector3();
  onToast: (text: string, level: number) => void = () => {};
  onModeChange: () => void = () => {};

  constructor(public game: Game, public send: (c: Command) => void, public rig: CameraRig, public fx: Effects) {}

  me() { return this.game.me(); }

  setMode(m: Mode): void {
    this.mode = m;
    document.body.classList.toggle('cur-target', m.k === 'ability');
    document.body.classList.toggle('cur-ping', m.k === 'ping');
    document.body.classList.toggle('cur-build', m.k === 'build');
    this.onModeChange();
  }

  cancel(): boolean {
    if (this.mode.k === 'none') return false;
    this.setMode({ k: 'none' });
    return true;
  }

  // --- picking ---

  updateMouse(w: number, h: number): void {
    if (!this.mouseIn) { this.groundOk = false; this.hover = null; return; }
    this.groundOk = this.rig.groundAt(this.mx, this.my, w, h, 0, this.ground) !== null;
    if (!this.groundOk) { this.hover = null; return; }
    this.rig.groundAt(this.mx, this.my, w, h, 1.2, this.g1);
    this.hover = this.pick();
  }

  // What is under the cursor: tested along the view ray between the ground and head height,
  // so tall things can be clicked on their top, not just at their feet.
  private pick(): Pick {
    const g = this.game, f = g.cur, wd = g.welcome;
    if (!wd) return null;
    const ax = this.g1.x, az = this.g1.z, bx = this.ground.x, bz = this.ground.z;
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
    const segDist = (x: number, z: number) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const px = ax + dx * t - x, pz = az + dz * t - z;
      return Math.sqrt(px * px + pz * pz);
    };
    let best: Pick = null, bd = Infinity;
    const myId = wd.you;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      // The living, and downed teammates (lying flat, so a little wider) to revive.
      const alive = (p.flags & PF_ALIVE) !== 0;
      if (!alive && (!(p.flags & PF_CONNECTED) || p.id === myId)) continue;
      const d = segDist(g.prx[p.id], g.pry[p.id]) / (alive ? 0.6 : 0.85);
      if (d < 1 && d < bd) { bd = d; best = { t: 'hero', id: p.id }; }
    }
    // A quick box test first: most creeps are nowhere near the ray. A creep just off the
    // cursor is remembered: next to a loot site it still wins over the site.
    const minx = Math.min(ax, bx) - 3, maxx = Math.max(ax, bx) + 3, minz = Math.min(az, bz) - 3, maxz = Math.max(az, bz) + 3;
    let near: Pick = null, nd = Infinity;
    for (let i = 0; i < f.nCreeps; i++) {
      const x = g.rx[i], z = g.ry[i];
      if (x < minx || x > maxx || z < minz || z > maxz) continue;
      const r = (wd.creeps[f.cKind[i]]?.radius ?? 0.45) + 0.2;
      const d = segDist(x, z) / r;
      if (d < 1 && d < bd) { bd = d; best = { t: 'creep', id: f.cId[i] }; }
      if (d < nd) { nd = d; near = { t: 'creep', id: f.cId[i] }; }
    }
    if (best) return best;
    for (let s = 0; s <= 6; s++) {
      const t = s / 6;
      const sid = g.structAtTile(Math.floor(ax + dx * t), Math.floor(az + dz * t));
      if (sid >= 0) return { t: 'struct', id: sid };
    }
    // Weapons on the ground, then loot sites; either gives way to a creep almost under the cursor.
    let gun = -1, gd = 0.8;
    for (const k of f.guns) {
      const d = segDist(k.x, k.y);
      if (d < gd) { gd = d; gun = k.id; }
    }
    if (gun >= 0) return near && nd < 1.6 ? near : { t: 'gun', id: gun };
    // Loot sites: anywhere inside a house, or near a car or crate along the ray.
    let site = -1, sd = 0.9;
    for (let i = 0; i < wd.sites.length; i++) {
      const s = wd.sites[i];
      if (!lootable(s.kind) || g.unfound(i)) continue;
      if (walled(s.kind)) {
        if (bx >= s.x && bx < s.x + s.w && bz >= s.y && bz < s.y + s.h && site < 0) site = i;
        continue;
      }
      // The plane is picked anywhere along its hull.
      const d = s.kind === SiteKind.Plane ? Math.max(0, segDist(siteX(s), siteY(s)) - 4.5) : segDist(siteX(s), siteY(s));
      if (d < sd) { sd = d; site = i; }
    }
    if (site < 0) return null;
    // A guarded site can't be searched until its guards are dead, so a click near one means a
    // guard; any site gives way to a creep almost under the cursor.
    if (near && (nd < 1.6 || (f.siteGuards(site) > 0 && nd < 4))) return near;
    return { t: 'site', id: site };
  }

  // Selection still valid (the creep may have died)?
  validate(): void {
    const s = this.sel;
    if (!s) return;
    const f = this.game.cur;
    if (s.t === 'creep' && this.game.indexById[s.id] < 0) this.sel = null;
    else if (s.t === 'struct' && (s.id >= f.nStructs || !f.sAlive[s.id])) this.sel = null;
    else if (s.t === 'hero' && !f.player(s.id)) this.sel = null;
    else if (s.t === 'gun' && !f.guns.some((g) => g.id === s.id)) this.sel = null;
  }

  // What hovering a loot site says: its name and whether it can be searched yet (the HUD's
  // tag adds the guard count underneath).
  siteHint(i: number): string {
    const wd = this.game.welcome, s = wd?.sites[i];
    if (!s) return '';
    const name = wd.siteKinds[s.kind]?.name ?? 'Loot site';
    const f = this.game.cur;
    if (s.kind === SiteKind.Church) return `${name} · ${f.siteSearched(i) ? 'the bell is still swinging' : 'ring the bell: every creep on the map comes'}`;
    const wary = this.game.guardsLeft(i) === -2 ? (s.guard ?? 0) > 0 : f.siteGuards(i) > 0;
    return `${name} · ${f.siteSearched(i) ? 'searched' : wary ? 'search, if you dare' : 'search'}`;
  }

  // The downed teammate under the cursor that E would revive, or -1. For the
  // cursor and the HUD; only while alive myself and not in a targeting mode.
  reviveTarget(): number {
    const h = this.hover, me = this.me();
    if (h?.t !== 'hero' || this.mode.k !== 'none' || !me || !(me.flags & PF_ALIVE) || h.id === me.id) return -1;
    const p = this.game.cur.player(h.id);
    return p && !(p.flags & PF_ALIVE) ? h.id : -1;
  }

  taunt(): void {
    const me = this.me();
    if (me && me.flags & PF_ALIVE) this.send({ op: 'taunt' });
  }

  // --- clicks ---

  leftClick(alt = false): void {
    if (!this.groundOk) return;
    const x = this.ground.x, y = this.ground.z;
    if (alt || this.mode.k === 'ping') {
      this.pingAt(x, y);
      if (this.mode.k === 'ping' && !this.shift) this.setMode({ k: 'none' });
      return;
    }
    switch (this.mode.k) {
      case 'ability':
        this.castAt(this.mode.slot, x, y);
        return;
      case 'build':
        this.placeBuild(this.mode.kind, this.shift);
        return;
    }
    this.sel = this.hover?.t === 'site' || this.hover?.t === 'gun' ? null : this.hover;
    if (this.sel?.t === 'struct' && this.game.cur.sKind[this.sel.id] === 2) this.openArmory(true);
  }

  // Right-click: on a creep, focus fire on it; anywhere else, the weapon's signature, at the
  // cursor for a targeted one. It also backs out of a targeting mode.
  rightClick(): void {
    if (this.cancel()) return;
    const info = this.ability(0), me = this.me();
    if (!info || !me) return;
    if (!(me.flags & PF_ALIVE)) return;
    if (this.hover?.t === 'creep' && this.useAt(this.hover)) return;
    if (info.left > 0) { this.onToast(`${info.name} is not ready (${info.left.toFixed(1)}s)`, 2); return; }
    if (info.target !== 'point') { this.send({ op: 'ability', slot: 0, x: me.x, y: me.y }); return; }
    if (this.groundOk) this.castAt(0, this.ground.x, this.ground.z);
  }

  // What hovering a weapon on the ground says: what it is, its upgrades, who dropped it, and
  // whether E picks it up.
  gunHint(id: number): string {
    const g = this.game.cur.guns.find((k) => k.id === id), wd = this.game.welcome, me = this.me();
    if (!g || !wd) return '';
    const name = wd.weapons[g.kind]?.name ?? 'Weapon';
    const lv = g.lv.some((l) => l > 0) ? ' ' + g.lv.join('/') : '';
    const by = this.game.cur.player(g.by)?.name;
    const mine = me && me.owned & (1 << g.kind);
    return `${name}${lv}${by ? ` · ${by}'s` : ''} · ${mine ? 'you carry one' : 'pick up'}`;
  }

  // Why G can't drop the weapon in hand, said before the hold starts rather than after it
  // fills; '' when it can. The host checks again.
  dropRefusal(): string {
    const me = this.me();
    if (me && !(me.owned & ~(1 << me.cur))) return `the ${this.game.welcome?.weapons[me.cur]?.name ?? 'weapon'} is the only weapon you have`;
    return '';
  }

  // Puts the weapon in hand on the ground for a teammate, upgrades and all.
  dropWeapon(): void {
    const me = this.me();
    if (me && me.flags & PF_ALIVE) this.send({ op: 'drop', w: me.cur });
  }

  // E: whatever is right at hand comes first (a downed teammate, a weapon on the ground, a
  // loot site, a supply crate),
  // so a hero out looting searches the wreck beside them whatever is selected or under the
  // cursor. Then what is under the cursor (walking there first), then the nearest usable
  // thing (a damaged structure, the armory), then a supply crate further off. On a creep under
  // the cursor it focuses fire on it.
  interact(): void {
    const me = this.me();
    if (!me || !(me.flags & PF_ALIVE)) return;
    if (this.useAt(this.nearestUsable(me.x, me.y, true))) return;
    const close = this.nearestCrate(me.x, me.y, USE_REACH);
    if (close) { this.toCrate(close); return; }
    if (this.mouseIn && this.groundOk && this.useAt(this.hover)) return;
    if (this.useAt(this.nearestUsable(me.x, me.y))) return;
    const crate = this.nearestCrate(me.x, me.y, CRATE_REACH);
    if (crate) { this.toCrate(crate); return; }
    this.onToast('nothing to use here', 1);
  }

  private nearestCrate(x: number, y: number, reach: number): { x: number; y: number; d: number } | null {
    let best: { x: number; y: number; d: number } | null = null;
    for (const k of this.game.cur.crates) {
      const d = Math.hypot(k.x - x, k.y - y);
      if (d < (best?.d ?? reach)) best = { x: k.x, y: k.y, d };
    }
    return best;
  }

  // Walks up to a supply crate; standing by it opens it.
  private toCrate(c: { x: number; y: number; d: number }): void {
    this.toArmory = false;
    if (c.d > 1) this.moveTo(c.x, c.y);
  }

  // The nearest usable thing in reach; atHand keeps to downed teammates and loot sites.
  private nearestUsable(x: number, y: number, atHand = false): Pick {
    const g = this.game, f = g.cur, wd = g.welcome, me = this.me();
    if (!wd || !me) return null;
    let best: Pick = null, bd = USE_REACH;
    const take = (p: Pick, px: number, py: number, slack = 0) => {
      const d = Math.hypot(px - x, py - y) - slack;
      if (d < bd) { bd = d; best = p; }
    };
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      if (p.id !== me.id && !(p.flags & PF_ALIVE) && p.flags & PF_CONNECTED) take({ t: 'hero', id: p.id }, g.prx[p.id], g.pry[p.id]);
    }
    for (let i = 0; i < wd.sites.length; i++) {
      // Guarded too: guards don't forbid a search, they only make it harder.
      const s = wd.sites[i];
      if (f.siteSearched(i) || !lootable(s.kind)) continue;
      take({ t: 'site', id: i }, siteX(s), siteY(s));
    }
    // A weapon on the ground comes before a site beside it: it is the quicker grab.
    for (const k of f.guns) if (!(me.owned & (1 << k.kind))) take({ t: 'gun', id: k.id }, k.x, k.y, 0.5);
    if (atHand) return best;
    for (let s = 0; s < f.nStructs; s++) {
      if (!f.sAlive[s]) continue;
      const cx = f.sX[s] + f.sW[s] / 2, cy = f.sY[s] + f.sH[s] / 2, slack = Math.max(f.sW[s], f.sH[s]) / 2;
      const mine = f.sOwner[s] === me.id || f.sOwner[s] === -1;
      if (f.sKind[s] === 2 || (mine && f.sHp[s] < f.sMaxHp[s])) take({ t: 'struct', id: s }, cx, cy, slack);
    }
    return best;
  }

  // Carries out E on one thing; false when there is nothing to do with it.
  private useAt(h: Pick): boolean {
    const me = this.me();
    const g = this.game, f = g.cur;
    if (!h || !me) return false;
    if (h.t === 'hero') {
      const p = f.player(h.id);
      if (!p || p.flags & PF_ALIVE || h.id === me.id) return false;
      this.toArmory = false;
      this.send({ op: 'revive', p: h.id });
      this.fx.ping(g.prx[h.id], g.pry[h.id], 0x50ff80);
      return true;
    }
    if (h.t === 'creep') {
      this.send({ op: 'attack', id: h.id });
      const i = g.indexById[h.id];
      if (i >= 0) this.fx.ping(g.rx[i], g.ry[i], 0xff4a3a);
      return true;
    }
    if (h.t === 'struct') {
      const s = h.id, kind = f.sKind[s];
      if (kind === 2) {
        if (me.flags & PF_ARMORY) this.openArmory(!this.armoryOpen); else this.walkToArmory();
        return true;
      }
      const mine = f.sOwner[s] === me.id || f.sOwner[s] === -1;
      if (!mine || f.sHp[s] >= f.sMaxHp[s]) return false;
      this.send({ op: 'repair', s });
      this.fx.ping(f.sX[s] + f.sW[s] / 2, f.sY[s] + f.sH[s] / 2, 0x40c0ff);
      return true;
    }
    if (h.t === 'gun') {
      const k = f.guns.find((g) => g.id === h.id);
      if (!k) return false;
      if (me.owned & (1 << k.kind)) { this.onToast(`you already carry a ${g.welcome?.weapons[k.kind]?.name ?? 'weapon'} like it`, 2); return true; }
      this.toArmory = false;
      this.send({ op: 'pickup', id: h.id });
      this.fx.ping(k.x, k.y, 0xffd040);
      return true;
    }
    if (h.t === 'site' && !f.siteSearched(h.id)) {
      const s = g.welcome!.sites[h.id];
      this.toArmory = false;
      this.send({ op: 'loot', site: h.id });
      this.fx.ping(siteX(s), siteY(s), 0xffd040);
      return true;
    }
    return false;
  }

  medkit(): void {
    const me = this.me();
    if (me && me.flags & PF_ALIVE) this.send({ op: 'medkit' });
  }

  // Marks a spot for the whole team. Its meaning comes from what is under the cursor: a creep
  // is danger, an unsearched site loot, a structure "defend this", anything else "here".
  pingAt(x: number, y: number, fromMap = false): void {
    const h = fromMap ? null : this.hover, f = this.game.cur;
    let kind = PingKind.Here;
    if (h?.t === 'creep') {
      kind = PingKind.Danger;
      const i = this.game.indexById[h.id];
      if (i >= 0) { x = this.game.rx[i]; y = this.game.ry[i]; }
    } else if (h?.t === 'site' && !f.siteSearched(h.id)) {
      kind = PingKind.Loot;
      const s = this.game.welcome!.sites[h.id];
      x = siteX(s); y = siteY(s);
    } else if (h?.t === 'gun') {
      const k = f.guns.find((g) => g.id === h.id);
      if (k) { kind = PingKind.Loot; x = k.x; y = k.y; }
    } else if (h?.t === 'struct') {
      kind = PingKind.Defend;
      x = f.sX[h.id] + f.sW[h.id] / 2; y = f.sY[h.id] + f.sH[h.id] / 2;
    }
    this.send({ op: 'ping', x, y, kind });
  }

  moveTo(x: number, y: number): void {
    this.toArmory = false;
    this.send({ op: 'move', x, y });
    this.fx.ping(x, y, 0x50ff70);
  }

  armoryCenter(): { x: number; y: number } | null {
    const f = this.game.cur;
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] === 2) return { x: f.sX[i] + f.sW[i] / 2, y: f.sY[i] + f.sH[i] / 2 };
    return null;
  }

  // Walks to a free spot beside the armory, on the side facing the hero.
  walkToArmory(): void {
    const a = this.armoryCenter();
    if (!a || !this.walkBeside(a.x, a.y, Math.min((this.game.welcome?.shopRadius ?? 4) * 0.6, 2.2))) return;
    this.toArmory = true;
  }

  // Walks back to the generator, to a free spot beside it on the side facing the hero.
  walkToCore(): boolean {
    const c = this.game.welcome?.core;
    return !!c && this.walkBeside(c.x, c.y, 3.6);
  }

  // Walks to a free spot r from x,y on the hero's side, trying either way round.
  private walkBeside(cx: number, cy: number, r: number): boolean {
    const me = this.me();
    if (!me || !(me.flags & PF_ALIVE)) return false;
    let dx = me.x - cx, dy = me.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    for (let k = 0; k < 8; k++) {
      const ang = Math.atan2(dy, dx) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.7;
      const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      const t = this.game.tile(Math.floor(x), Math.floor(y));
      if (t < Tile.Water && this.game.structAtTile(Math.floor(x), Math.floor(y)) < 0) { this.moveTo(x, y); return true; }
    }
    this.moveTo(cx + dx * r, cy + dy * r);
    return true;
  }

  // --- abilities ---

  ability(slot: number): AbilityInfo | null {
    const wd = this.game.welcome, me = this.me();
    if (!wd || !me) return null;
    const a = wd.abilities[slot];
    if (!a) return null;
    if (slot === 0) {
      const sig = wd.weapons[me.cur]?.sig;
      if (!sig) return null;
            return { name: sig.name, desc: sig.desc, key: a.key || KEYS[slot], range: sig.range, radius: sig.radius ?? RADIUS[sig.name.toLowerCase()] ?? 0,
        cool: sig.cool, target: sig.target, level: Math.max(1, me.abLevel[0]), maxLevel: 1, left: me.abCool[0], nextCost: 0 };
    }
    const lvl = me.abLevel[slot];
    return { name: a.name, desc: a.desc, key: a.key || KEYS[slot], range: a.range, radius: a.radius?.[Math.max(0, lvl - 1)] ?? RADIUS[a.name.toLowerCase()] ?? 0,
      cool: a.cool[Math.max(0, lvl - 1)] ?? 0, target: a.target, level: lvl, maxLevel: a.costs.length, left: me.abCool[slot],
      nextCost: lvl < a.costs.length ? a.costs[lvl] : 0 };
  }

  startAbility(slot: number): void {
    const info = this.ability(slot), me = this.me();
    if (!info || !me) return;
    if (!(me.flags & PF_ALIVE)) { this.onToast('you are dead', 2); return; }
    if (info.level <= 0) { this.onToast(`${info.name} is locked: buy it at the armory`, 2); return; }
    if (info.left > 0) { this.onToast(`${info.name} is not ready (${info.left.toFixed(1)}s)`, 2); return; }
    if (info.target !== 'point') { this.send({ op: 'ability', slot, x: me.x, y: me.y }); return; }
    if (this.mode.k === 'ability' && this.mode.slot === slot) { this.setMode({ k: 'none' }); return; }
    this.setMode({ k: 'ability', slot });
  }

  castAt(slot: number, x: number, y: number): void {
    this.send({ op: 'ability', slot, x, y });
    this.fx.ping(x, y, 0xffd040);
    if (!this.shift) this.setMode({ k: 'none' });
  }

  // --- building ---

  startBuild(kind: number): void {
    const wd = this.game.welcome;
    if (!wd || !wd.buildable.includes(kind)) return;
    this.setMode({ k: 'build', kind });
  }

  buildTile(kind: number): { tx: number; ty: number; w: number; h: number } {
    const d = this.game.welcome!.structs[kind];
    const w = d?.w ?? 1, h = d?.h ?? 1;
    return { tx: Math.floor(this.ground.x - w / 2 + 0.5), ty: Math.floor(this.ground.z - h / 2 + 0.5), w, h };
  }

  // The client-side guess of whether the host will accept the placement.
  canPlace(kind: number, tx: number, ty: number): string {
    const g = this.game, wd = g.welcome, me = this.me();
    if (!wd || !me) return 'not in game';
    const d = wd.structs[kind];
    if (me.gold < d.price) return `not enough gold: need ${d.price}`;
    if (Math.hypot(tx + d.w / 2 - wd.core.x, ty + d.h / 2 - wd.core.y) > wd.buildRadius) return 'outside the build radius';
    for (let y = ty; y < ty + d.h; y++) for (let x = tx; x < tx + d.w; x++) {
      if (g.tile(x, y) >= Tile.Water) return 'blocked terrain';
      if (g.structAtTile(x, y) >= 0) return 'occupied';
    }
    return '';
  }

  placeBuild(kind: number, keep: boolean): void {
    const { tx, ty } = this.buildTile(kind);
    const err = this.canPlace(kind, tx, ty);
    if (err) { this.onToast(err, 2); return; }
    this.send({ op: 'build', kind, tx, ty });
    if (!keep) this.setMode({ k: 'none' });
  }

  // --- selection actions ---

  selectedStruct(): number { return this.sel?.t === 'struct' ? this.sel.id : -1; }

  // Upgrades the selected wall or gate, or one track of the selected turret.
  upgradeSel(track?: number): void {
    const s = this.selectedStruct();
    if (s < 0) return;
    if (track === undefined && this.game.welcome?.structs[this.game.cur.sKind[s]]?.turret) {
      this.onToast('a turret goes up a track at a time: pick one on its card', 0);
      return;
    }
    this.send({ op: 'upgradeStruct', s, track: track ?? 0 });
  }

  sellSel(): void {
    const s = this.selectedStruct();
    if (s >= 0) { this.send({ op: 'sell', s }); this.sel = null; }
  }

  repairSel(): void {
    const s = this.selectedStruct();
    if (s >= 0) this.send({ op: 'repair', s });
  }

  toggleReady(): void {
    const me = this.me();
    if (!me || this.game.cur.phase !== Phase.Build) return;
    this.send({ op: 'ready', on: !(me.flags & PF_READY) });
  }

  openArmory(on: boolean): void { this.armoryOpen = on; }

  // Opens the armory on arrival, once per visit.
  tickArmory(): void {
    const me = this.me();
    const at = !!me && (me.flags & PF_ARMORY) !== 0;
    if (at && !this.wasAtArmory && this.toArmory) { this.armoryOpen = true; this.toArmory = false; }
    this.wasAtArmory = at;
  }
}
