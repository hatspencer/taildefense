import { Vector3 } from 'three/webgpu';
import type { ConnState } from '../net';
import { CROWBAR, OWNED_DUAL, KATANA, dualIn, legendary, weaponKey, EvacStage, K_ARMORY, K_CORE, stickyKind, Emote, Order, PF_ALIVE, PF_CONNECTED, PF_READY, PF_RELOADING, Phase, type Player, TTrack, TURRET_TRACKS, type Welcome, repairCost, sellValue, turretRange, WEAPON_SLOTS, K_GATE, COMPASS, CX_ARMOURED, CX_FRENZY, CX_HASTY, CX_SAPPER, CX_SPLITTER } from '../protocol';
import { type Controller, KEYS } from '../controller';
import { cssHex, playerColor } from '../scene/util';
import { Armory } from './armory';
import { archetypeName } from '../scene/look';
import { CELL, type Portraits } from '../scene/portraits';
import { el, esc, fmtGold, patch, setClass, setText, show } from './dom';
import { iconFor, weatherIcon } from './icons';
import { awards, ending, scoreRows, verdict } from './score';
import { drawReport } from './shot';
import { Compass, where } from './compass';
import { Minimap } from './minimap';
import { wordmarkURL } from './splash';
import { Cover } from './cover';
import { FirstRun, firstRunSeen } from './firstrun';
import { BladePick } from './pick';
import { helpHTML } from './help';
import { linkBadge } from './link';
import type { PathMsg } from '../protocol';
import { Pad, focusFirst, navKey, step } from './nav';

const ORDER = ['idle', 'moving', 'attack-moving', 'attacking', 'holding', 'building', 'repairing', 'searching', 'reviving', 'walking'];

// One digit after the point below ten seconds, whole seconds above.
const secs = (s: number) => (s < 10 ? s.toFixed(1) : String(Math.ceil(s)));
const ROMAN = ['', 'I', 'II', 'III', 'IV'];
const HURT_V = new Vector3();
// Every tenth wave brings a boss, as the host has it; the top bar says so before it arrives.
const isBoss = (w: number) => w > 0 && w % 10 === 0;
const BOSS_TAG = '<span class="bosstag" title="A boss wave: bosses lead it, every tenth wave">BOSS</span>';

// A teammate's frame: their portrait, name, health and what they are doing.
interface Mate { root: HTMLElement; face: CanvasRenderingContext2D; resp: HTMLElement; fill: HTMLElement; what: HTMLElement }

interface Slot { root: HTMLElement; icon: HTMLElement; key: HTMLElement; lvl: HTMLElement; cool: HTMLElement; coolTxt: HTMLElement; name: string; pipsFor: number; wasCooling: boolean }

let mark = '';
// The finished wordmark, drawn once.
function markURL(): string { return mark || (mark = wordmarkURL(3)); }

// The HTML overlay: top bar, bottom console, the command card, windows and messages.
// change shows a value going from a to b without saying twice what stays the same:
// "195 dmg", "240 dmg" -> "195 → 240 dmg"; "every 2.9s", "every 2.5s" -> "every 2.9s → 2.5s".
function change(a: string, b: string): string {
  const x = a.split(' '), y = b.split(' ');
  if (x.length !== y.length) return `${a} → ${b}`;
  let i = 0, j = x.length - 1;
  while (i < x.length && x[i] === y[i]) i++;
  while (j > i && x[j] === y[j]) j--;
  if (i >= x.length) return a;
  return `${x.slice(0, j + 1).join(' ')} → ${y.slice(i).join(' ')}`;
}

// What the scouts say of a wave: its affixes, and the sides it comes from when told.
function forecast(wd: Welcome, affix: number, from: number): string {
  let s = '';
  const names = (wd.affixes ?? []).filter((_, i) => affix & (1 << i));
  if (names.length) s += `<span class="affix">${esc(names.join(' · ').toUpperCase())}</span>`;
  const sides = COMPASS.filter((_, i) => from & (1 << i)).map((n) => n.replace(/(north|south|east|west)/g, (m) => m[0].toUpperCase()));
  if (sides.length) s += `<span class="lbl">from ${sides.join(' ')}</span>`;
  return s;
}

export class Hud {
  root: HTMLElement;
  minimap: Minimap;
  private compass: Compass;
  armory: Armory;
  buildCard = false;
  // The generator's health, always in the top bar: the one number the game is lost on.
  private base: { root: HTMLElement; fill: HTMLElement; num: HTMLElement; lbl: HTMLElement; hp: number; hitUntil: number };
  private top: { wave: HTMLElement; diff: HTMLElement; weather: HTMLElement; kills: HTMLElement; fix: HTMLButtonElement; ready: HTMLButtonElement; readies: HTMLElement };
  private statusEl: HTMLElement;
  private linkEl!: HTMLElement;
  private pauseBtn!: HTMLElement;
  private face!: CanvasRenderingContext2D;
  private faceKey = '';
  private portraits: Portraits | null = null;
  private faceVer = -1;
  private teamEl: HTMLElement;
  private teamKey = '';
  private mates = new Map<number, Mate>();
  private paused!: { root: HTMLElement; sub: HTMLElement };
  private downed: { root: HTMLElement; sub: HTMLElement; bar: HTMLElement; fill: HTMLElement };
  private announceEl: HTMLElement;
  // The screen's edge: bleeds while health is low, flashes on a hit from the side it came from.
  private hurt: { root: HTMLElement; hp: number; until: number };
  private countEl!: { root: HTMLElement; wave: HTMLElement; n: HTMLElement };
  private toastsEl: HTMLElement;
  private chat: { root: HTMLElement; log: HTMLElement; input: HTMLInputElement };
  private hero: {
    portrait: HTMLElement; resp: HTMLElement; name: HTMLElement; hp: HTMLElement; hpBar: HTMLElement; hpTxt: HTMLElement; gold: HTMLElement;
    stam: HTMLElement; weapon: HTMLElement; ammoNum: HTMLElement; reload: HTMLButtonElement; ammo: HTMLElement; ammoBar: HTMLElement; ammoTxt: HTMLElement;
    order: HTMLElement; buff: HTMLElement;
  };
  private slots: Slot[] = [];
  private taunt: Slot & { cap: HTMLElement };
  private med!: HTMLElement;
  private wslots: HTMLElement[] = [];
  private card: HTMLElement;
  private cardKey = '';
  private modeEl: HTMLElement;
  private tip: HTMLElement;
  private tipFor: (() => string) | null = null;
  private tipEl: HTMLElement | null = null;
  private score: HTMLElement;
  private help: HTMLElement;
  private menu: HTMLElement;
  private over: HTMLElement;
  // Keeps a picture of the field report when a game ends; the page sets it when a td serves it.
  // Resolves to where the picture went.
  keepShot: ((png: Blob, wave: number) => Promise<string>) | null = null;
  // Whether the evac Huey is still lifting off or flying away: the screen is letterboxed for
  // it, and the field report waits until it is out of sight.
  leaving: () => boolean = () => false;
  private overBoard: HTMLElement | null = null;
  // The connection cover: connecting, reconnecting, and the end of the game for this tab.
  cover: Cover;
  private statsEl: HTMLElement;
  private chatTimer = 0;
  private lastSec = -1;
  private lastBoard = 0;

  constructor(parent: HTMLElement, private ctl: Controller) {
    const root = el('div', 'hud', parent);
    this.root = root;

    // Top bar.
    const top = el('div', 'top', root);
    const wave = el('div', 'wave crt', top);
    const base = el('div', 'chip base', top);
    base.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges"><path d="M3 5h10v10H3z" fill="#07080a"/><path d="M4 6h8v8H4z" fill="#5d604a"/><path d="M6 8h4v4H6z" fill="#e0a63a"/><path d="M7 1h2v4H7zM5 3h6v1H5z" fill="#86a2a6"/></svg><span class="lbl">base</span><span class="bbar"><i></i></span><span class="num crt"></span>';
    base.title = 'The generator: if it falls, the game is over. Click to look at it.';
    base.onclick = () => {
      const c = ctl.game.welcome?.core;
      if (!c) return;
      ctl.rig.follow = false; ctl.rig.center(c.x, c.y, false);
      const id = ctl.game.structAtTile(Math.floor(c.x), Math.floor(c.y));
      if (id >= 0) { this.buildCard = false; ctl.sel = { t: 'struct', id }; }
    };
    this.base = { root: base, fill: base.querySelector('.bbar i') as HTMLElement, num: base.querySelector('.num') as HTMLElement, lbl: base.querySelector('.lbl') as HTMLElement, hp: -1, hitUntil: 0 };
    const diff = el('div', 'chip diff', top);
    this.tipOn(diff, () => this.diffTip());
    // The host clicks through the difficulties, round to the easiest again.
    diff.onclick = () => {
      const wd = ctl.game.welcome;
      if (!wd) return;
      if (!wd.hosting) { this.toast('only the host can change the difficulty', 2); return; }
      ctl.send({ op: 'difficulty', kind: (wd.difficulty.id + 1) % wd.difficulties.length });
    };
    const weather = el('div', 'chip weather', top);
    this.tipOn(weather, () => this.weatherTip());
    // How packets reach the host, only while that costs: relayed through DERP, or slow.
    this.linkEl = el('div', 'chip link hidden', top);
    el('div', 'spacer', top);
    const kills = el('div', 'kills', top);
    kills.title = 'Creeps the team has killed this game';
    const readies = el('div', 'readies', top);
    // Between waves, while anything is destroyed or damaged: the base put back in one go.
    const fix = el('button', 'fix', top, 'Rebuild');
    fix.title = 'Rebuild everything the creeps destroyed and repair everything damaged (H)';
    fix.onclick = () => ctl.fixAll();
    const ready = el('button', 'ready', top, 'Ready');
    ready.title = 'Ready for the next wave (Y)';
    ready.onclick = () => ctl.toggleReady();
    const pauseBtn = el('button', '', top, 'Pause');
    pauseBtn.title = 'Pause or resume the game for everyone (P)';
    pauseBtn.onclick = () => ctl.send({ op: 'pause' });
    this.pauseBtn = pauseBtn;
    const chatBtn = el('button', '', top, 'Chat');
    chatBtn.title = 'Chat with the team (Enter)';
    chatBtn.onclick = () => this.openChat();
    const armBtn = el('button', '', top, 'Armory');
    armBtn.title = 'Armory (C)';
    armBtn.onclick = () => ctl.openArmory(!ctl.armoryOpen);
    const helpBtn = el('button', '', top, '?');
    helpBtn.title = 'Controls (F1)';
    helpBtn.onclick = () => this.toggleHelp();
    const menuBtn = el('button', '', top, 'Menu');
    menuBtn.title = 'Menu (F10)';
    menuBtn.onclick = () => this.toggleMenu();
    this.top = { wave, diff, weather, kills, fix, ready, readies };
    this.statusEl = el('div', 'status', root);
    this.compass = new Compass(root, ctl.rig);
    // Down the left: the team.
    this.teamEl = el('div', 'team', root);

    // You are down.
    const dn = el('div', 'downed hidden', root);
    el('div', 'dh', dn, 'You are down');
    const sub = el('div', 'ds', dn);
    const dbar = el('div', 'bar revive', dn);
    const dfill = el('div', 'fill', dbar);
    el('div', 'txt', dbar, 'being revived');
    this.downed = { root: dn, sub, bar: dbar, fill: dfill };
    const pz = el('div', 'downed paused hidden', root);
    el('div', 'dh', pz, 'Paused');
    this.paused = { root: pz, sub: el('div', 'ds', pz) };

    this.hurt = { root: el('div', 'hurt', root), hp: -1, until: 0 };
    // Under everything else the HUD shows.
    root.prepend(this.hurt.root);
    this.announceEl = el('div', 'announce', root);
    const cd = el('div', 'countdown hidden', root);
    this.countEl = { root: cd, wave: el('div', 'cw', cd), n: el('div', 'cn', cd) };
    this.toastsEl = el('div', 'toasts', root);
    this.modeEl = el('div', 'mode panel hidden', root);

    // Chat.
    const chat = el('div', 'chat', root);
    const log = el('div', 'log', chat);
    const input = el('input', 'hidden', chat);
    input.maxLength = 200;
    input.placeholder = 'Say something… Tab adds where you are · Enter sends · Esc closes';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') {
        e.preventDefault();
        const me = ctl.me(), wd = ctl.game.welcome;
        if (me && wd) {
          const at = `(${where(me.x, me.y, wd.core.x, wd.core.y)})`;
          const v = input.value.trimEnd();
          input.value = v ? `${v} ${at} ` : `${at} `;
        }
      } else if (e.key === 'Enter') {
        const t = input.value.trim();
        if (t) ctl.send({ op: 'chat', text: t });
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
    this.chat = { root: chat, log, input };

    // Bottom console: minimap, hero, abilities and weapons, the command card.
    const bottom = el('div', 'bottom', root);
    const mm = el('div', 'minimap panel', bottom);
    this.minimap = new Minimap(mm, ctl);
    const con = el('div', 'console panel', bottom);
    const hero = el('div', 'hero', con);
    const r1 = el('div', 'row', hero);
    const portrait = el('div', 'portrait', r1);
    const face = el('canvas', '', portrait) as HTMLCanvasElement;
    face.width = CELL; face.height = CELL;
    this.face = face.getContext('2d')!;
    const resp = el('div', 'resp', portrait);
    const nameCol = el('div', 'namecol', r1);
    const name = el('div', 'name', nameCol);
    const gold = el('div', 'goldline gold', nameCol);
    const hpBar = el('div', 'bar', nameCol);
    const hp = el('div', 'fill', hpBar);
    const hpTxt = el('div', 'txt', hpBar);
    // Stamina has its own bar under health: hold Space to sprint.
    const stamBar = el('div', 'bar stamina', nameCol);
    const stam = el('div', 'fill stam', stamBar);
    stamBar.title = 'Stamina, spent sprinting (hold Space)';
    const gun = el('div', 'gun', hero);
    const weapon = el('div', 'wname', gun);
    const ammoNum = el('div', 'ammo crt', gun);
    const reload = el('button', 'reload', gun);
    // The word gives way first on a narrow screen, so the weapon's name keeps its room.
    reload.innerHTML = '<span class="rl">Reload</span><kbd>R</kbd>';
    reload.setAttribute('aria-label', 'Reload (R)');
    reload.onclick = () => ctl.reload();
    this.tipOn(reload, () => '<b>Reload</b><kbd>R</kbd><br>Swap in a fresh magazine now instead of when it runs dry.');
    const ammoBar = el('div', 'bar ammo', hero);
    const ammo = el('div', 'fill', ammoBar);
    const ammoTxt = el('div', 'txt', ammoBar);
    const order = el('div', 'order', hero);
    const buff = el('div', 'buff', hero);
    this.hero = { portrait, resp, name, hp, hpBar, hpTxt, stam, gold, weapon, ammoNum, reload, ammo, ammoBar, ammoTxt, order, buff };

    const actions = el('div', 'actions', con);
    const abil = el('div', 'abilities', actions);
    const mkSlot = (cls: string, key: string): Slot => {
      const s = el('div', cls, abil);
      const icon = el('div', 'icon', s);
      const cool = el('div', 'cool', s);
      const coolTxt = el('div', 'cooltxt', s);
      const k = el('div', 'key', s, key);
      const lvl = el('div', 'lvl', s);
      return { root: s, icon, key: k, lvl, cool, coolTxt, name: '', pipsFor: -1, wasCooling: false };
    };
    for (let i = 0; i < 4; i++) {
      const s = mkSlot('slot', KEYS[i]);
      s.root.onclick = () => ctl.cast(i);
      this.tipOn(s.root, () => this.abilityTip(i));
      this.slots.push(s);
    }
    el('div', 'sep', abil);
    const ts = mkSlot('slot taunt', 'J');
    ts.icon.innerHTML = iconFor('taunt');
    const cap = el('div', 'cap', ts.root, 'taunt');
    ts.root.onclick = () => ctl.taunt();
    this.tipOn(ts.root, () => this.tauntTip());
    this.taunt = { ...ts, cap };

    const ws = el('div', 'weapons', actions);
    // The medkit comes first, on 1; the weapons follow on 2 to 7, the crowbar on 0.
    const med = el('div', 'wslot med', ws);
    el('span', 'key', med, '1');
    el('span', 'nm', med);
    med.onclick = () => { const me = ctl.me(); if (me && me.medkits > 0) ctl.medkit(); else ctl.openArmory(true); };
    this.tipOn(med, () => this.medkitTip());
    this.med = med;
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      const w = el('div', 'wslot', ws);
      el('span', 'key', w, weaponKey(i));
      if (legendary(i)) w.classList.add('legend');
      el('span', 'nm', w);
      w.onclick = () => { const me = ctl.me(); if (me && me.owned & (1 << i)) ctl.send({ op: 'select', w: i }); else ctl.openArmory(true); };
      this.tipOn(w, () => this.weaponTip(i));
      this.wslots.push(w);
    }
    this.card = el('div', 'card panel', bottom);

    this.armory = new Armory(root, ctl);
    this.score = el('div', 'window panel score hidden', root);
    // The give buttons, on pointerdown: the window is redrawn twice a second, which could take
    // the button away between the press and a click.
    this.score.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-give]') as HTMLButtonElement | null;
      if (!b || b.disabled || e.button !== 0) return;
      e.preventDefault();
      ctl.send({ op: 'give', p: Number(b.dataset.give), gold: Number(b.dataset.gold) });
    });
    this.help = el('div', 'window panel help hidden', root);
    this.buildHelp();
    this.menu = el('div', 'window panel menu hidden', root);
    this.buildMenu();
    this.over = el('div', 'over hidden', root);
    this.firstRun = new FirstRun(root, () => this.toggleHelp());
    this.pick = new BladePick(root, ctl);
    this.tip = el('div', 'tip panel hidden', root);
    this.cover = new Cover(el('div', 'cover', root), markURL);
    this.statsEl = el('div', 'stats panel hidden', root);
    this.cover.set('connecting');
  }

  // --- windows and messages ---

  private tipOn(e: HTMLElement, f: () => string): void {
    e.addEventListener('mouseenter', () => { this.tipFor = f; this.tipEl = e; this.placeTip(e); });
    e.addEventListener('mouseleave', () => { this.tipFor = null; this.tipEl = null; show(this.tip, false); });
  }

  // Above the element, or below it when there is no room (the top bar).
  private placeTip(e: HTMLElement): void {
    if (!this.tipFor) return;
    const html = this.tipFor();
    if (!html) { show(this.tip, false); return; }
    this.tip.innerHTML = html;
    show(this.tip, true);
    const r = e.getBoundingClientRect();
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tw - 4, r.left + r.width / 2 - tw / 2))}px`;
    const above = r.top - th - 10;
    this.tip.style.top = `${above >= 4 ? above : r.bottom + 10}px`;
  }

  private abilityTip(i: number): string {
    const a = this.ctl.ability(i);
    if (!a) return '';
    const lv = a.level > 0 ? `level ${a.level}${a.maxLevel > 1 ? '/' + a.maxLevel : ''}` : 'locked: buy it at the armory';
    const next = a.nextCost ? ` · next level <span class="c">${a.nextCost}g</span>` : '';
    return `<b>${esc(a.name)}</b><kbd>${a.key}</kbd><br>${esc(a.desc)}<br><span class="muted">${lv} · cooldown ${a.cool || '—'}s${a.range ? ' · range ' + a.range : ''}${next}</span>`;
  }

  private tauntTip(): string {
    const t = this.ctl.game.welcome?.taunt;
    if (!t) return '';
    return `<b>Taunt</b><kbd>J</kbd><br>Shout: every creep within ${t.radius} tiles comes for you for ${t.time}s. Pull them off a teammate or into your turrets.<br><span class="muted">cooldown ${t.cool}s</span>`;
  }

  private medkitTip(): string {
    const m = this.ctl.game.welcome?.medkit, me = this.ctl.me();
    if (!m || !me) return '';
    return `<b>Medkit</b><kbd>1</kbd><br>Heals ${Math.round(m.heal * 100)}% of your health over ${m.time}s. A hit cuts it short.<br><span class="muted">${me.medkits}/${m.max} carried · ${m.cost}g each at the armory · first-aid kits in the wild hold more</span>`;
  }

  private weaponTip(i: number): string {
    const wd = this.ctl.game.welcome, me = this.ctl.me();
    const w = wd?.weapons[i];
    if (!w || !me) return '';
    const owned = (me.owned & (1 << i)) !== 0;
    const reloading = (me.reloading & (1 << i)) !== 0;
    const lv = [0, 1, 2, 3].map((t) => `${wd!.tracks[t]} ${me.levels[i * 4 + t]}`).join(' · ');
    if (w.legend) {
      const evo = me.evo[i] ? w.evolve?.[me.evo[i] - 1] : undefined;
      return `<b class="legend">${esc(w.name)}</b><kbd>${weaponKey(i)}</kbd> <span class="muted">legendary</span><br><span class="muted">melee · reach ${w.range} · special ${esc(w.special)}</span><br>${i === KATANA && dualIn(me.owned, i) ? 'a pair: one in each hand, cutting 70% faster<br>' : ''}${evo ? `<b>${esc(evo.name)}</b>: ${esc(evo.desc)}<br>` : ''}${lv}<br>F: <b>${esc(w.art?.name ?? '')}</b> · ${esc(w.art?.desc ?? '')}<br><span class="muted">ultimate: ${esc(w.ult.name)}</span>`;
    }
    const evo = me.evo[i] ? w.evolve?.[me.evo[i] - 1] : undefined;
    const art = w.art ? `${evo ? `<b>${esc(evo.name)}</b>: ${esc(evo.desc)}<br>` : ''}F: <b>${esc(w.art.name)}</b> · ${esc(w.art.desc)}<br>` : '';
    return `<b>${esc(w.name)}</b><kbd>${weaponKey(i)}</kbd><br><span class="muted">${w.fire} · range ${w.range} · special ${esc(w.special)}</span><br>${i === 0 && me.owned & OWNED_DUAL ? 'dual pistols: twice the rounds a second and the magazine<br>' : ''}${owned ? lv : `not owned · <span class="c">${w.price}g</span> at the armory`}<br>${art}<span class="muted">ultimate: ${esc(w.ult.name)}${reloading ? ' · reloading' : ''}</span>`;
  }

  private diffTip(): string {
    const wd = this.ctl.game.welcome;
    if (!wd) return '';
    return `<b>${esc(wd.difficulty.name)}</b><br>The host's choice for this game. It sets creep health and wave size, gold drops, build time, how tough loot guards are and how long a downed survivor can be revived.<br><span class="muted">${wd.hosting ? 'Click for the next difficulty; it counts from here on, creeps already out keep their health.' : 'Only the host can change it.'}</span>`;
  }

  private weatherTip(): string {
    const wd = this.ctl.game.welcome, f = this.ctl.game.cur;
    const w = wd?.weathers[f.weather];
    if (!w) return '';
    const amt = Math.round(f.weatherAmt * 100);
    const state = f.weather === 0 ? '' : amt >= 98 ? '' : `<br><span class="muted">${amt < 50 && f.weatherAmt > 0 ? 'passing or rolling in' : 'building'} · ${amt}%</span>`;
    return `<b>${esc(w.name)}</b><br>${w.info ? esc(w.info) : 'No effect on the fight.'}${state}<br><span class="muted">Changes between waves.</span>`;
  }

  // Level 3 is a player's chat line, "name: text"; level 4 an upgrade, in the log only for a
  // moment; the others are the game's announcements.
  note(level: number, text: string): void {
    if (level === 3) { this.chatSaid(text); return; }
    if (level === 4) { this.chatLine(text, 4, 1000); return; }
    if (level >= 1) {
      const d = el('div', level === 1 ? 'good' : 'bad', this.announceEl, text);
      setTimeout(() => d.remove(), 4000);
      while (this.announceEl.children.length > 3) this.announceEl.firstChild!.remove();
    }
    this.chatLine(text, level);
  }

  private chatSaid(text: string): void {
    const i = text.indexOf(': ');
    const name = i > 0 ? text.slice(0, i) : '';
    const f = this.ctl.game.cur;
    let who: Player | undefined;
    for (let k = 0; k < f.nPlayers; k++) if (f.players[k].name === name) who = f.players[k];
    const d = this.chatLine(i > 0 ? text.slice(i + 2) : text, 3, 20000);
    if (i > 0) {
      const n = document.createElement('b');
      n.textContent = name + ': ';
      if (who) n.style.color = cssHex(playerColor(who.id));
      d.prepend(n);
    }
  }

  private chatLine(text: string, level: number, keep = 9000): HTMLElement {
    const d = el('div', `lvl${level}`, this.chat.log, text);
    setTimeout(() => d.classList.add('old'), keep);
    while (this.chat.log.children.length > 12) this.chat.log.firstChild!.remove();
    return d;
  }

  toast(text: string, level = 2): void {
    const d = el('div', level === 2 ? '' : 'info', this.toastsEl, text);
    setTimeout(() => d.remove(), 3000);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild!.remove();
  }

  flash(text: string): void { this.toast(text, 0); }

  status(text: string): void { setText(this.statusEl, text); }

  // The link badge, from the last path message and the average ping.
  link(p: PathMsg | null, rttAvg: number): void {
    const b = linkBadge(p, rttAvg), e = this.linkEl;
    show(e, b !== null);
    if (!b) return;
    setText(e, b.text);
    if (e.title !== b.tip) { e.title = b.tip; e.setAttribute('aria-label', `${b.text}: ${b.tip}`); }
  }

  chatOpen(): boolean { return !this.chat.input.classList.contains('hidden'); }
  openChat(): void {
    show(this.chat.input, true);
    setClass(this.chat.root, 'open', true);
    this.chat.input.focus();
    clearTimeout(this.chatTimer);
  }
  private closeChat(): void {
    this.chat.input.value = '';
    show(this.chat.input, false);
    setClass(this.chat.root, 'open', false);
    this.chat.input.blur();
  }

  // The game-over report carries its own scoreboard, so the window stays shut then.
  showScore(on: boolean): void {
    if (this.ctl.game.cur.phase === Phase.Over) on = false;
    show(this.score, on);
    if (on) this.renderScore();
  }
  toggleHelp(): void { this.toggle(this.help); }
  // Opens or closes a window; one opened has its first button in focus, for the keyboard.
  private toggle(w: HTMLElement): void {
    const on = w.classList.contains('hidden');
    show(w, on);
    if (on) setTimeout(() => focusFirst(w), 0);
    else if (w.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }
  firstRun: FirstRun;
  pick: BladePick;
  // The first steps, on a first game on this machine (or always, with force).
  showFirstRun(force = false): void { if (force || !firstRunSeen()) this.firstRun.open(); }

  // The window the keyboard and a controller move through: the topmost one open.
  private navRoot(): HTMLElement | null {
    for (const w of [this.firstRun.root, this.menu, this.help]) if (!w.classList.contains('hidden')) return w;
    return this.over.classList.contains('hidden') ? null : this.over;
  }
  // A key for the open window, before the game sees it; true when the window took it.
  navKey(e: KeyboardEvent): boolean {
    const r = this.navRoot();
    if (!r) return false;
    // Over the field report Enter is still the chat, for a last word, until the keyboard has
    // moved into the report: a stray Enter must not restart the game for everyone.
    if (r === this.over && !r.contains(document.activeElement) && e.key !== 'Tab' && !e.key.startsWith('Arrow')) return false;
    return navKey(e, r);
  }
  private pad = new Pad();
  private padPoll(now: number): void {
    const p = this.pad.poll(now);
    if (!p) return;
    const r = this.navRoot();
    if (p.menu && r !== this.over) { if (r && r !== this.menu) this.closeWindows(); this.toggleMenu(); return; }
    if (!r) return;
    if (p.up) step(r, -1);
    if (p.down) step(r, 1);
    if (p.ok) { const a = document.activeElement as HTMLElement | null; if (a && r.contains(a)) a.click(); else focusFirst(r); }
    if (p.back) this.closeWindows();
  }
  // onVolume hears the menu's volume slider; save is set once the player lets go of it.
  onVolume: (v: number, save: boolean) => void = () => {};
  private volEl!: HTMLInputElement;
  private volOut!: HTMLElement;
  setVolume(v: number): void {
    this.volEl.value = String(v);
    this.volOut.textContent = v === 0 ? 'off' : String(v);
  }
  // onMusic and setMusic are the same for the MUSIC setting's slider.
  onMusic: (v: number, save: boolean) => void = () => {};
  private musEl!: HTMLInputElement;
  private musOut!: HTMLElement;
  setMusic(v: number): void {
    this.musEl.value = String(v);
    this.musOut.textContent = v === 0 ? 'off' : String(v);
  }

  toggleMenu(): void { this.toggle(this.menu); }
  toggleStats(): void { show(this.statsEl, this.statsEl.classList.contains('hidden')); }
  statsVisible(): boolean { return !this.statsEl.classList.contains('hidden'); }
  setStats(s: string): void { setText(this.statsEl, s); }

  // Esc: closes the topmost window; false when none was open.
  closeWindows(): boolean {
    if (this.firstRun.visible) { this.firstRun.close(); return true; }
    for (const w of [this.menu, this.help, this.score]) if (!w.classList.contains('hidden')) { show(w, false); return true; }
    if (this.ctl.armoryOpen) { this.ctl.openArmory(false); return true; }
    if (this.minimap.expanded) { this.minimap.toggle(false); return true; }
    return false;
  }

  // A click in the world closes help and menu.
  closeTransient(): void { show(this.help, false); show(this.menu, false); if (this.firstRun.visible) this.firstRun.close(); }

  setConn(state: ConnState, detail = ''): void { this.cover.set(state, detail); }

  private buildHelp(): void {
    this.help.innerHTML = helpHTML();
    (this.help.querySelector('.x') as HTMLButtonElement).onclick = () => show(this.help, false);
  }

  private buildMenu(): void {
    const m = this.menu;
    el('h2', '', m).innerHTML = '<span class="tape">Menu</span>';
    const resume = el('button', '', m, 'Resume');
    resume.onclick = () => show(m, false);
    const help = el('button', '', m, 'Controls (F1)');
    help.onclick = () => { show(m, false); this.toggleHelp(); };
    const steps = el('button', '', m, 'First steps');
    steps.onclick = () => { show(m, false); this.firstRun.open(); };
    // The VOLUME setting: heard while dragging, saved to td's settings when let go.
    const vol = el('label', 'volume', m);
    el('span', '', vol, 'Volume');
    this.volEl = el('input', '', vol);
    Object.assign(this.volEl, { type: 'range', min: '0', max: '100', step: '5' });
    this.volOut = el('b', '', vol, '');
    this.volEl.oninput = () => { const v = Number(this.volEl.value); this.setVolume(v); this.onVolume(v, false); };
    this.volEl.onchange = () => this.onVolume(Number(this.volEl.value), true);
    // The MUSIC setting, a share of the volume, the same way.
    const mus = el('label', 'volume', m);
    el('span', '', mus, 'Music');
    this.musEl = el('input', '', mus);
    Object.assign(this.musEl, { type: 'range', min: '0', max: '100', step: '5' });
    this.musOut = el('b', '', mus, '');
    this.musEl.oninput = () => { const v = Number(this.musEl.value); this.setMusic(v); this.onMusic(v, false); };
    this.musEl.onchange = () => this.onMusic(Number(this.musEl.value), true);
    const leave = el('button', 'danger', m, 'Leave game');
    leave.onclick = () => this.leave();
    el('div', 'muted hint', m, '↑ ↓ to choose · Enter to press · Esc to close').id = 'menu-hint';
  }

  private leave(): void {
    const hosting = this.ctl.game.welcome?.hosting;
    if (hosting && !confirm('You are hosting: leaving ends the game for everyone. Leave?')) return;
    this.ctl.send({ op: 'leave' });
  }

  // One card per survivor: who they are, what they carry, and the game they have had; in the Tab
  // window (give), a teammate's also has buttons to send them gold.
  private scoreTable(give = false): string {
    const g = this.ctl.game, wd = g.welcome;
    if (!wd) return '';
    const mine = this.ctl.me()?.gold ?? 0;
    const giveRow = (id: number) => `<div class="give"><span class="lbl">give</span>${[50, 250, Math.floor(mine / 2)].map((n, i) =>
      `<button data-give="${id}" data-gold="${n}"${n < 1 || n > mine ? ' disabled' : ''}>${i === 2 ? `half · ` : ''}<span class="gold">${fmtGold(n)}g</span></button>`).join('')}</div>`;
    const cards = scoreRows(wd, g.cur).map((r) => {
      const p = r.p;
      const st = r.aboard ? '<span class="st out">extracted</span>' : r.away ? '<span class="st muted">away</span>'
        : r.behind ? '<span class="st down">left behind</span>' : r.down ? `<span class="st down">down ${p.respawn}s</span>` : '';
      const you = r.you && p.name !== 'you' ? ' <span class="muted">(you)</span>' : '';
      const nums = r.nums.map((n) => `<div class="n${n.bad ? ' bad' : ''}${n.v ? '' : ' zero'}"><b>${fmtGold(n.v)}</b><span>${n.label}</span></div>`).join('');
      const kit = r.chips.map((c) => `<span class="pchip${c.held ? ' held' : ''}${c.ab ? ' ab' : ''}" title="${esc(c.title)}">${esc(c.text)}${c.lv ? `<b>${esc(c.lv)}</b>` : ''}</span>`).join('');
      return `<div class="pcard${r.away ? ' away' : ''}">
        <div class="who"><span class="dot" style="background:${r.color}"></span><span class="name">${esc(p.name)}</span>${you} <span class="muted">${esc(r.arch)}</span>${st}<span class="gold" title="gold to spend"><span class="lbl">gold</span>${fmtGold(p.gold)}g</span></div>
        <div class="nums">${nums}</div>
        <div class="kit">${kit}</div>${give && !r.you && !r.away ? giveRow(p.id) : ''}
      </div>`;
    });
    return `<div class="scorecards">${cards.join('')}</div>`;
  }

  private renderScore(): void {
    const f = this.ctl.game.cur;
    // The team's gold, what everyone still in the game has to spend between them.
    let gold = 0;
    for (let i = 0; i < f.nPlayers; i++) if (f.players[i].flags & PF_CONNECTED) gold += f.players[i].gold;
    this.score.innerHTML = `<h2><span class="tape">Scoreboard</span><span class="muted">wave ${f.wave} · ${fmtGold(f.totalKills)} kills · team gold <span class="gold">${fmtGold(gold)}g</span></span></h2>${this.scoreTable(true)}`;
  }

  // --- per frame ---

  update(now: number): void {
    const ctl = this.ctl, g = ctl.game, wd = g.welcome, me = ctl.me();
    if (!wd) return;
    this.compass.update();
    this.padPoll(now);
    this.updateTop(wd, now);
    this.updateTeam(wd);
    if (me) this.updateHero(me, wd, now);
    this.updateDown(me);
    this.updatePause();
    this.updateCountdown(now);
    this.updateCard();
    this.updateMode();
    this.armory.update();
    this.pick.update(wd, me ?? undefined);
    if (this.tipFor && this.tipEl && now - this.lastSec > 250) { this.placeTip(this.tipEl); this.lastSec = now; }
    const tick = now - this.lastBoard > 500;
    if (tick) this.lastBoard = now;
    if (tick && !this.score.classList.contains('hidden')) this.renderScore();
    this.updateOver(tick);
  }

  setPortraits(p: Portraits): void { this.portraits = p; }

  // The teammates' frames, rebuilt when who is in the game changes. One who is down says
  // where, and the bar fills as someone revives them.
  private updateTeam(wd: Welcome): void {
    const ctl = this.ctl, f = ctl.game.cur, me = ctl.me();
    const over = f.phase === Phase.Over;
    const reviving = !!me && me.order === Order.Revive;
    const fog = ctl.game.fogged();
    const at = (p: Player) => fog ? 'somewhere in the fog' : where(p.x, p.y, wd.core.x, wd.core.y);
    const list: Player[] = [];
    for (let i = 0; i < f.nPlayers; i++) if (f.players[i].id !== wd.you) list.push(f.players[i]);
    const key = list.map((p) => `${p.id}:${p.look}:${p.name}`).join('|');
    if (key !== this.teamKey) {
      this.teamKey = key;
      this.teamEl.innerHTML = '';
      this.mates.clear();
      this.faceVer = -1;
      for (const p of list) {
        const root = el('div', 'mate', this.teamEl);
        root.style.setProperty('--pc', cssHex(playerColor(p.id)));
        const av = el('div', 'av', root);
        const cv = el('canvas', '', av) as HTMLCanvasElement;
        cv.width = CELL; cv.height = CELL;
        const resp = el('div', 'resp', av);
        const info = el('div', 'info', root);
        el('div', 'nm', info, p.name);
        const bar = el('div', 'mbar', info);
        const fill = el('i', '', bar);
        const what = el('div', 'what', info);
        const id = p.id;
        root.onclick = () => {
          const q = ctl.game.cur.player(id);
          if (!q) return;
          if (q.flags & PF_CONNECTED && !(q.flags & PF_ALIVE) && !q.aboard) ctl.send({ op: 'revive', p: id });
          else { ctl.rig.follow = false; ctl.rig.center(q.x, q.y, false); }
        };
        this.mates.set(id, { root, face: cv.getContext('2d')!, resp, fill, what });
      }
    }
    for (const p of list) {
      const m = this.mates.get(p.id)!;
      const here = (p.flags & PF_CONNECTED) !== 0, alive = (p.flags & PF_ALIVE) !== 0;
      const frac = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
      const down = here && !alive && !over && !p.aboard;
      m.fill.style.transform = `scaleX(${alive ? frac.toFixed(3) : down ? p.revived.toFixed(3) : 0})`;
      setClass(m.root, 'away', !here);
      setClass(m.root, 'dead', down);
      setClass(m.root, 'low', alive && frac < 0.3);
      setText(m.resp, here && !alive && !p.aboard ? `${p.respawn}` : '');
      const w = wd.weapons[p.cur]?.name ?? '';
      const what = p.aboard ? 'aboard the Huey' : !here ? 'away'
        : !alive ? (over ? 'down' : p.revived > 0 ? `being revived${reviving ? ' · stay close' : ''}` : `down ${at(p)}`)
        : p.order === Order.Revive && p.channel > 0 ? 'reviving'
        : p.order === Order.Loot && p.channel > 0 ? 'searching'
        : p.emote === Emote.Taunt && p.emoteLeft > 0 ? 'taunting'
        : p.flags & PF_RELOADING ? `${w} · reloading` : w;
      setText(m.what, what);
      m.root.title = !here ? `${p.name} is away` : down ? `${p.name} is down ${at(p)}: walk over and revive them (E on them), or click here` : `${p.name}, ${archetypeName(p.look)}: click to look at them`;
    }
  }

  private updateTop(wd: Welcome, now: number): void {
    const ctl = this.ctl, f = ctl.game.cur, me = ctl.me();
    let wave: string;
    if (f.phase === Phase.Build) {
      const left = Math.max(0, f.phaseLeft / 10 - (now - ctl.game.frameAt) / 1000);
      wave = `<span class="lbl">wave ${f.wave + 1} in</span><span class="phase">${Math.ceil(left)}s</span>${isBoss(f.wave + 1) ? BOSS_TAG : ''}${forecast(wd, f.nextAffix, f.nextFrom)}`;
    } else if (f.phase === Phase.Wave) wave = `<span class="lbl">wave</span>${f.wave}<span class="lbl">·</span><span class="phase">${fmtGold(f.left)}</span><span class="lbl">creeps left</span>${isBoss(f.wave) ? BOSS_TAG : ''}${forecast(wd, f.affix, 0)}`;
    else if (f.phase === Phase.Evac) {
      const left = Math.ceil(Math.max(0, f.evacLeft - (now - ctl.game.frameAt) / 1000));
      wave = f.evac === EvacStage.Inbound ? `<span class="lbl">evac · Huey lands in</span><span class="phase">${left}s</span><span class="lbl">· hold the helipad</span>`
        : f.evac === EvacStage.Landed ? `<span class="lbl">get to the choppa ·</span><span class="phase">${left}s</span><span class="lbl">to lift-off</span>`
        : `<span class="lbl">the Huey is lifting off</span>`;
    } else if (f.evac === EvacStage.Gone) wave = `<span class="lbl">evac · held</span><span class="phase">${f.best}</span><span class="lbl">waves</span>`;
    else wave = `<span class="lbl">overrun · held</span><span class="phase">${f.best}</span><span class="lbl">waves</span>`;
    if (this.top.wave.innerHTML !== wave) this.top.wave.innerHTML = wave;
    setClass(this.top.wave, 'boss', (f.phase === Phase.Wave && isBoss(f.wave)) || (f.phase === Phase.Build && isBoss(f.wave + 1)));

    this.updateBase(now);

    const di = Math.max(0, Math.min(wd.difficulties.length - 1, wd.difficulty.id));
    const diff = `<span class="pips">${wd.difficulties.map((_, i) => `<i class="${i <= di ? 'on' : ''}"></i>`).join('')}</span>${esc(wd.difficulty.name)}`;
    if (this.top.diff.innerHTML !== diff) this.top.diff.innerHTML = diff;

    const w = wd.weathers[f.weather] ?? wd.weathers[0];
    const amt = f.weather === 0 ? 1 : f.weatherAmt;
    const wh = `${weatherIcon(f.weather)}<span>${esc(w?.name ?? 'Clear')}</span>${w?.info && amt > 0.3 ? `<span class="info">${esc(w.info)}</span>` : ''}`;
    if (this.top.weather.innerHTML !== wh) this.top.weather.innerHTML = wh;
    this.top.weather.style.opacity = (0.4 + 0.6 * amt).toFixed(2);

    const kills = `<b>${fmtGold(f.totalKills)}</b><span class="lbl">kills</span>`;
    if (this.top.kills.innerHTML !== kills) this.top.kills.innerHTML = kills;
    const build = f.phase === Phase.Build;
    const fc = build ? this.ctl.fixCost() : null;
    show(this.top.fix, !!fc && (fc.ghosts > 0 || fc.damaged > 0));
    if (fc) {
      setText(this.top.fix, `Rebuild ${fmtGold(fc.gold)}g`);
      setClass(this.top.fix, 'short', !!me && me.gold < fc.gold);
    }
    show(this.top.ready, build);
    show(this.top.readies, build);
    setClass(this.top.ready, 'on', !!me && (me.flags & PF_READY) !== 0);
    setText(this.top.ready, me && me.flags & PF_READY ? 'Ready ✓' : 'Ready');
    if (build) {
      let dots = '';
      for (let i = 0; i < f.nPlayers; i++) {
        const p = f.players[i];
        dots += `<span class="${p.flags & PF_READY ? 'on' : ''}" style="background:${cssHex(playerColor(p.id))}" title="${esc(p.name)}${p.flags & PF_READY ? ' is ready' : ''}"></span>`;
      }
      if (this.top.readies.innerHTML !== dots) this.top.readies.innerHTML = dots;
    }
  }

  // The base chip: a segmented bar coloured by how much is left, flashing when it is hit and
  // pulsing once it is below a third.
  private updateBase(now: number): void {
    const f = this.ctl.game.cur, b = this.base;
    let hp = 0, max = 1;
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] === K_CORE) { hp = f.sHp[i]; max = Math.max(1, f.sMaxHp[i]); break; }
    if (b.hp >= 0 && hp < b.hp) b.hitUntil = now + 450;
    b.hp = hp;
    const frac = Math.max(0, Math.min(1, hp / max));
    b.fill.style.width = `${(frac * 100).toFixed(1)}%`;
    setText(b.num, `${Math.ceil(frac * 100)}%`);
    setText(b.lbl, f.tier > 1 ? `base ${ROMAN[f.tier]}` : 'base');
    setClass(b.root, 'overload', f.overloadReady);
    setClass(b.root, 'mid', frac <= 0.6 && frac > 0.3);
    setClass(b.root, 'low', frac <= 0.3);
    setClass(b.root, 'hit', now < b.hitUntil);
    b.root.title = `The generator, tier ${ROMAN[f.tier] ?? f.tier}: ${Math.ceil(hp)} / ${Math.ceil(max)}. If it falls, the game is over. Click for its card: pay into its next tier${f.overloadReady ? ', or set off its Overload' : ''}.`;
  }

  // The last seconds of a break count down big in the middle of the screen.
  private updateCountdown(now: number): void {
    const g = this.ctl.game, f = g.cur;
    const sec = (now - g.frameAt) / 1000;
    const evac = f.phase === Phase.Evac && f.evac === EvacStage.Landed && f.pausedBy < 0;
    const left = evac ? f.evacLeft - sec : f.phase === Phase.Build && f.pausedBy < 0 ? f.phaseLeft / 10 - sec : 0;
    // The Huey's last ten seconds on the pad; for one aboard, all of them.
    const on = left > 0 && left <= (evac ? (this.ctl.me()?.aboard ? 999 : 10) : 5);
    show(this.countEl.root, on);
    if (!on) return;
    setText(this.countEl.wave, !evac ? `${isBoss(f.wave + 1) ? 'boss ' : ''}wave ${f.wave + 1} incoming` : this.ctl.me()?.aboard ? 'aboard · lift-off in' : 'get to the choppa!');
    const n = String(Math.ceil(left));
    if (this.countEl.n.textContent !== n) {
      this.countEl.n.textContent = n;
      // Restart the pulse on every new number.
      this.countEl.n.classList.remove('tick'); void this.countEl.n.offsetWidth; this.countEl.n.classList.add('tick');
    }
  }

  // Anyone may pause; the banner names who did, and anyone may resume.
  private updatePause(): void {
    const f = this.ctl.game.cur, by = f.pausedBy;
    show(this.paused.root, by >= 0);
    this.pauseBtn.textContent = by >= 0 ? 'Resume' : 'Pause';
    if (by < 0) return;
    const p = f.player(by);
    const who = by === this.ctl.game.welcome?.you ? 'you' : p ? esc(p.name) : 'a player';
    const sub = `paused by ${who} · press <kbd>P</kbd> to resume`;
    if (this.paused.sub.innerHTML !== sub) this.paused.sub.innerHTML = sub;
  }

  // Your own downed banner. A teammate who is down shows in their frame.
  private updateDown(me: Player | null): void {
    const ctl = this.ctl, f = ctl.game.cur;
    const over = f.phase === Phase.Over;
    const down = !!me && !(me.flags & PF_ALIVE) && !over && !me.aboard;
    show(this.downed.root, down);
    if (down) {
      let mates = 0;
      for (let i = 0; i < f.nPlayers; i++) {
        const p = f.players[i];
        if (p.id !== me!.id && p.flags & PF_CONNECTED && p.flags & PF_ALIVE) mates++;
      }
      const sub = mates > 0
        ? `a teammate can revive you here · or respawn at base in<span class="n">${me!.respawn}s</span><br><span class="look">look around meanwhile: arrows, the screen edge or the map</span>`
        : `no teammate is standing · respawn at base in<span class="n">${me!.respawn}s</span><br><span class="look">look around meanwhile: arrows, the screen edge or the map</span>`;
      if (this.downed.sub.innerHTML !== sub) this.downed.sub.innerHTML = sub;
      show(this.downed.bar, me!.revived > 0);
      this.downed.fill.style.transform = `scaleX(${me!.revived.toFixed(3)})`;
    }
  }

  private updateOver(tick: boolean): void {
    const ctl = this.ctl, f = ctl.game.cur, wd = ctl.game.welcome!;
    const leaving = this.leaving();
    setClass(document.body, 'cine', leaving);
    const isOver = f.phase === Phase.Over && !leaving;
    show(this.over, isOver);
    if (!isOver) { delete this.over.dataset.shown; this.overBoard = null; return; }
    if (!this.over.dataset.shown) {
      this.over.dataset.shown = '1';
      show(this.score, false);
      const v = verdict(f), n = v.n;
      const cites = awards(scoreRows(wd, f)).map((a) => `<div class="award"><span class="t">${a.title}</span><span class="who" style="color:${a.row.color}">${esc(a.row.p.name)}${a.row.you && a.row.p.name !== 'you' ? ' (you)' : ''}</span><span class="why">${esc(a.why)}</span></div>`).join('');
      this.over.innerHTML = `<div class="sheet panel${v.ok ? ' out' : ''}" role="dialog" aria-labelledby="over-head">
        <span class="tape ${v.ok ? 'green' : 'red'}">Field report</span>
        <div class="stamp">${v.stamp}</div>
        <h1 id="over-head">${v.head}</h1>
        <p class="story">${esc(ending(wd, f))}</p>
        <div class="meta">${esc(wd.difficulty.name)} · ${n} ${n === 1 ? 'survivor' : 'survivors'} · map ${esc(wd.seed)}</div>
        <div class="tally">
          <div class="crt"><b>${f.best}</b><span>${f.best === 1 ? 'wave' : 'waves'} held</span></div>
          <div class="crt"><b>${fmtGold(f.totalKills)}</b><span>creeps killed</span></div>${v.evac ? `
          <div class="crt"><b>${v.out}/${n}</b><span>extracted</span></div>` : ''}
        </div>
        ${cites ? `<div class="awards">${cites}</div>` : ''}
        <h3 class="sect">The team</h3>
        <div class="board"></div>
        <div class="foot"><div class="row"></div>
        <div class="note">${wd.hosting ? 'Restart deals a new map to everyone in the game.' : 'Restart deals a new map to everyone in the game; leaving takes you back to the terminal.'}</div></div>
      </div>`;
      this.overBoard = this.over.querySelector('.board') as HTMLElement;
      const row = this.over.querySelector('.row') as HTMLElement;
      const rs = el('button', 'primary', row, 'Restart on a new map');
      rs.onclick = () => ctl.send({ op: 'restart' });
      const lv = el('button', 'danger', row, 'Leave game');
      lv.onclick = () => this.leave();
      tick = true;
      void this.saveReport();
    }
    if (tick && this.overBoard) this.overBoard.innerHTML = this.scoreTable();
  }

  // A picture of the report for td to keep, once the frame has the final tally.
  private async saveReport(): Promise<void> {
    const keep = this.keepShot, wd = this.ctl.game.welcome;
    if (!keep || !wd) return;
    try {
      const png = await drawReport(wd, this.ctl.game.cur);
      if (!png) return;
      const at = await keep(png, this.ctl.game.cur.best);
      this.toast(`Scoreboard saved to ${at}`, 1);
    } catch (e) {
      this.toast(`Could not save the scoreboard: ${e instanceof Error ? e.message : e}`, 2);
    }
  }

  private updateHero(me: Player, wd: Welcome, now: number): void {
    const h = this.hero;
    const alive = (me.flags & PF_ALIVE) !== 0;
    const fk = `${me.id}:${me.look}`;
    if (fk !== this.faceKey) {
      this.faceKey = fk;
      h.portrait.title = `You are ${archetypeName(me.look)}`;
    }
    const pt = this.portraits;
    if (pt && pt.version !== this.faceVer) {
      this.faceVer = pt.version;
      pt.draw(this.face, me.id);
      for (const [id, m] of this.mates) pt.draw(m.face, id);
    }
    setClass(h.portrait, 'low', alive && me.hp / Math.max(1, me.maxHp) < 0.3);
    setClass(h.portrait, 'dead', !alive && !me.aboard);
    setText(h.resp, alive || me.aboard ? '' : `${me.respawn}`);
    setText(h.name, me.name);
    setText(h.gold, `${fmtGold(me.gold)}`);
    const frac = me.hp / Math.max(1, me.maxHp);
    h.hp.style.transform = `scaleX(${frac})`;
    h.hp.style.background = frac > 0.5 ? '' : frac > 0.25 ? 'var(--amber)' : 'var(--rust)';
    // Low health is said in words and hatching as well as red, and the screen's edge bleeds.
    const lowHp = alive && frac < 0.3;
    setClass(h.hpBar, 'low', lowHp);
    setText(h.hpTxt, lowHp ? `LOW ${me.hp} / ${me.maxHp}` : `${me.hp} / ${me.maxHp}`);
    this.updateHurt(me, alive, lowHp, now);
    h.stam.style.transform = `scaleX(${me.stamina.toFixed(3)})`;
    setClass(h.stam, 'winded', me.winded);
    setClass(h.stam, 'full', me.stamina >= 0.999);
    const w = wd.weapons[me.cur];
    setText(h.weapon, w ? w.name : '');
    const reloading = (me.flags & PF_RELOADING) !== 0;
    // A melee weapon has no ammo: no count, no reload, and the bar stays full and quiet.
    const melee = w?.fire === 'melee';
    show(h.ammoNum, !melee);
    show(h.reload, !melee);
    setClass(h.ammoBar, 'reload', reloading);
    h.ammo.style.transform = `scaleX(${melee ? 1 : reloading ? 1 - me.reload : me.ammo / Math.max(1, me.mag)})`;
    // Low and empty magazines say so on the bar, with the key that fixes them.
    const lowAmmo = alive && !melee && !reloading && me.mag > 0 && me.ammo <= Math.max(1, me.mag * 0.2);
    setText(h.ammoTxt, reloading ? 'reloading' : !lowAmmo ? '' : me.ammo <= 0 ? 'EMPTY · R reload' : 'LOW AMMO · R');
    setClass(h.ammoBar, 'low', lowAmmo);
    const an = `${me.ammo}<i>/${me.mag}</i>`;
    if (h.ammoNum.innerHTML !== an) h.ammoNum.innerHTML = an;
    setClass(h.ammoNum, 'low', lowAmmo);
    const full = me.ammo >= me.mag;
    h.reload.disabled = !alive || full || reloading;
    setClass(h.reload, 'busy', reloading);
    h.reload.title = reloading ? 'Reloading' : full ? 'The magazine is full' : 'Reload now (R)';
    setText(h.order, alive ? (me.held ? 'caught' : me.airborne ? 'thrown' : me.stunned ? 'stunned' : me.emote === Emote.Taunt && me.emoteLeft > 0 ? `taunting · ${me.emoteLeft.toFixed(1)}s` : ORDER[me.order] ?? '') : `down · ${me.respawn}s`);
    setText(h.buff, me.buff && me.buffLeft > 0 ? `${wd.weapons[me.buff - 1]?.ult.name ?? 'ultimate'} · ${me.buffLeft.toFixed(1)}s` : '');

    const since = (now - this.ctl.game.frameAt) / 1000;
    const sweep = (s: Slot, left: number, cool: number) => {
      const cooling = cool > 0 && left >= 0.05;
      const deg = cooling ? Math.min(360, (left / cool) * 360) : 0;
      s.cool.style.setProperty('--a', `${deg.toFixed(1)}deg`);
      setText(s.coolTxt, cooling ? secs(left) : '');
      if (s.wasCooling && !cooling) { s.root.classList.remove('ready-flash'); void s.root.offsetWidth; s.root.classList.add('ready-flash'); }
      s.wasCooling = cooling;
    };
    for (let i = 0; i < 4; i++) {
      const s = this.slots[i], a = this.ctl.ability(i);
      if (!a) continue;
      if (s.name !== a.name) { s.name = a.name; s.icon.innerHTML = iconFor(a.name); }
      setClass(s.root, 'locked', a.level <= 0);
      if (i > 0) setClass(s.root, 'active', this.ctl.mode.k === 'ability' && this.ctl.mode.slot === i);
      setText(s.key, a.key);
      if (s.pipsFor !== a.level * 10 + a.maxLevel) {
        s.pipsFor = a.level * 10 + a.maxLevel;
        s.lvl.innerHTML = a.maxLevel > 1 ? Array.from({ length: a.maxLevel }, (_, k) => `<i class="${k < a.level ? 'on' : ''}"></i>`).join('') : '';
      }
      if (i === 0) {
        // The ultimate: the sweep is the meter still to fill; lit while full or running.
        const full = a.charge >= 1, on = a.running > 0;
        s.cool.style.setProperty('--a', `${(on || full ? 0 : (1 - a.charge) * 360).toFixed(1)}deg`);
        setText(s.coolTxt, on ? secs(Math.max(0, a.running - since)) : full ? '' : `${Math.floor(a.charge * 100)}%`);
        if (!s.wasCooling && full && !on) { s.root.classList.remove('ready-flash'); void s.root.offsetWidth; s.root.classList.add('ready-flash'); }
        s.wasCooling = full && !on;
        setClass(s.root, 'active', on);
        setClass(s.root, 'full', full && !on);
        continue;
      }
      // Cooldown sweep, interpolated between frames.
      sweep(s, Math.max(0, a.left - since), a.cool);
    }
    // Taunt: its cooldown, and lit while the shout is running.
    const t = this.taunt;
    sweep(t, Math.max(0, me.tauntCool - since), wd.taunt.cool);
    setClass(t.root, 'on', me.emote === Emote.Taunt && me.emoteLeft > 0);
    setClass(t.root, 'locked', !alive);
    setText(t.cap, me.tauntCool > 0 ? '' : 'taunt');

    for (let i = 0; i < WEAPON_SLOTS; i++) {
      const e = this.wslots[i], w2 = wd.weapons[i];
      // The crowbar is brutal's and a blades game's: its slot only shows for whoever carries
      // it. So are the legendaries, found and never sold; and in a blades game, no gun shows.
      const gun = wd.mode !== 'blades' && i !== CROWBAR && !legendary(i);
      show(e, !!w2 && (gun || (me.owned & (1 << i)) !== 0));
      if (!w2) continue;
      setClass(e, 'owned', (me.owned & (1 << i)) !== 0);
      setClass(e, 'cur', me.cur === i);
      setClass(e, 'reloading', (me.reloading & (1 << i)) !== 0);
      setText(e.children[1] as HTMLElement, dualIn(me.owned, i) ? `${w2.short}×2` : me.evo[i] ? `${w2.short}✦` : w2.short);
    }
    setClass(this.med, 'owned', me.medkits > 0);
    setClass(this.med, 'cur', me.heal > 0);
    setText(this.med.children[1] as HTMLElement, me.heal > 0 ? `heal ${me.heal.toFixed(1)}` : `med ×${me.medkits}`);
  }

  // A hit flashes the screen's edge for a moment, brightest on the side of the nearest creep,
  // which is most likely what landed it; low health keeps the edge red.
  private updateHurt(me: Player, alive: boolean, low: boolean, now: number): void {
    const t = this.hurt;
    if (alive && t.hp >= 0 && me.hp < t.hp) {
      t.until = now + 380;
      const g = this.ctl.game, f = g.cur;
      let best = 14 * 14, bx = 0, by = 0;
      for (let i = 0; i < f.nCreeps; i++) {
        const dx = f.cX[i] - me.x, dy = f.cY[i] - me.y, d = dx * dx + dy * dy;
        if (d < best) { best = d; bx = f.cX[i]; by = f.cY[i]; }
      }
      // Where on screen it is, from the player towards the creep, as a point on the edge.
      let ax = 50, ay = 50;
      if (best < 14 * 14) {
        const cam = this.ctl.rig.cam;
        const a = HURT_V.set(me.x, 0, me.y).project(cam), ox = a.x, oy = a.y;
        const b = HURT_V.set(bx, 0, by).project(cam);
        const dx = b.x - ox, dy = oy - b.y, m = Math.hypot(dx, dy);
        if (m > 1e-4) { ax = 50 + (dx / m) * 50; ay = 50 + (dy / m) * 50; }
      }
      t.root.style.setProperty('--hx', `${ax.toFixed(0)}%`);
      t.root.style.setProperty('--hy', `${ay.toFixed(0)}%`);
    }
    t.hp = alive ? me.hp : -1;
    setClass(t.root, 'hit', now < t.until);
    setClass(t.root, 'low', low);
  }

  // The right-hand command card: the build grid, or whatever is selected.
  private updateCard(): void {
    const ctl = this.ctl, g = ctl.game, f = g.cur, me = ctl.me();
    ctl.validate();
    let key: string;
    const s = ctl.sel;
    if (this.buildCard) key = `b:${ctl.mode.k === 'build' ? ctl.mode.kind : -1}:${me ? Math.floor(me.gold) : 0}`;
    else if (s?.t === 'struct') key = `s:${s.id}:${f.sKind[s.id]}:${f.sOwner[s.id]}:${f.sHp[s.id]}:${f.sMaxHp[s.id]}:${f.sLevel[s.id]}:${f.sOpen[s.id]}:${f.sEvo[s.id]}:${f.tier}:${f.tierPaid}:${f.tierCost}:${f.overloadReady}:${f.sLv.subarray(s.id * TURRET_TRACKS, (s.id + 1) * TURRET_TRACKS).join(',')}:${me ? Math.floor(me.gold) : 0}`;
    else if (s?.t === 'creep') { const i = g.indexById[s.id]; key = `c:${s.id}:${i >= 0 ? f.cHp[i] + ':' + f.cFlags[i] : ''}`; }
    else if (s?.t === 'hero') { const p = f.player(s.id); key = `h:${s.id}:${p?.hp}:${p?.maxHp}:${p?.cur}:${p?.kills}:${Math.floor(p?.damage ?? 0)}:${p?.order}:${p?.flags}:${p?.respawn}`; }
    else { const fc = ctl.fixCost(); key = `none:${f.phase}:${fc.gold}:${fc.ghosts + fc.damaged}:${me ? Math.floor(me.gold) : 0}`; }
    if (key === this.cardKey) return;
    this.cardKey = key;
    // Gold and HP change the card nearly every tick in a big wave: it is drawn afresh and patched
    // onto the one on screen, which keeps its buttons, so a click on one still lands.
    const c = el('div', this.card.className);
    this.drawCard(c);
    patch(this.card, c);
  }

  private drawCard(c: HTMLElement): void {
    const ctl = this.ctl, g = ctl.game, f = g.cur, wd = g.welcome!, me = ctl.me(), s = ctl.sel;
    const gold = me ? me.gold : 0;
    const head = (title: string, aside = '', cls = '') => {
      el('h3', '', c).innerHTML = `<span class="tape ${cls}">${title}</span>${aside ? `<span class="muted">${aside}</span>` : ''}`;
    };
    if (this.buildCard) {
      head('Build', 'B closes');
      const grid = el('div', 'grid build', c);
      for (const k of wd.buildable) {
        const d = wd.structs[k];
        const b = el('button', ctl.mode.k === 'build' && ctl.mode.kind === k ? 'sel' : '', grid);
        // Thirteen to a card, four to a row and tight to fit: the first word of the name, the whole of it on the title.
        const locked = (d.tier ?? 0) > f.tier;
        // The name has the button's whole width; the price and the keycap share the line under it.
        const short = !locked && gold < d.price;
        b.innerHTML = `<span class="n">${esc(d.name.split(' ')[0])}</span><span class="pk"><span class="p">${locked ? `tier ${ROMAN[d.tier!]}` : `${d.price}g`}</span><kbd>${esc(d.key)}</kbd></span>`;
        b.disabled = locked || short;
        b.title = `${d.name}: ${d.desc}${locked ? `\nNeeds the generator at tier ${ROMAN[d.tier!]}` : short ? `\nNeed ${fmtGold(Math.ceil(d.price - gold))}g more` : ''}`;
        if (locked) b.classList.add('locked');
        if (short) b.classList.add('short');
        b.onclick = () => ctl.startBuild(k);
      }
      // How to place is said by the placement prompt; the card is full with thirteen to build.
      return;
    }
    if (s?.t === 'struct') {
      const id = s.id, d = wd.structs[f.sKind[id]];
      const owner = f.sOwner[id] < 0 ? 'base' : f.player(f.sOwner[id])?.name ?? `player ${f.sOwner[id]}`;
      const evo = f.sEvo[id] ? d?.evolve?.[f.sEvo[id] - 1] : undefined;
      head(esc(evo ? `${evo.name} · ${d?.name}` : d?.name ?? '?'), esc(owner), evo ? `evo${f.sEvo[id]}` : '');
      const upg = d?.upgradable ?? d?.turret;
      const lv = (t: number) => f.sLv[id * TURRET_TRACKS + t];
      el('div', 'sub', c, `HP ${f.sHp[id]} / ${f.sMaxHp[id]}${upg && !d?.turret ? ` · level ${f.sLevel[id]}/${wd.maxStructLevel}` : ''}${d?.turret ? ` · range ${turretRange(d, lv(TTrack.Range), f.sEvo[id]).toFixed(1).replace(/\.0$/, '')}` : ''}`);
      // A turret's card is full with its tracks; its description goes on the title instead.
      if (d?.desc && !d.turret) el('div', 'sub', c, d.desc);
      if (d?.turret) {
        c.title = d.desc;
        // A turret goes up track by track, as a weapon does: each button shows what it gives
        // now and next, and what the next level costs.
        const grid = el('div', 'grid tracks', c);
        for (let t = 0; t < TURRET_TRACKS; t++) {
          const l = lv(t), max = l >= wd.maxLevel, cost = d.upgrade[l] ?? 0;
          const cur = d.values?.[t]?.[l] ?? '', next = d.values?.[t]?.[l + 1] ?? '';
          const b = el('button', '', grid);
          // The level a strip of pips along the foot of the button, so the price keeps its room.
          const pips = Array.from({ length: wd.maxLevel }, (_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('');
          const short = !max && gold < cost;
          b.innerHTML = `<span class="n">${esc(wd.turretTracks?.[t] ?? '')}<span class="p">${max ? 'max' : `${fmtGold(cost)}g`}</span></span><span class="v">${esc(max ? cur : change(cur, next))}</span><span class="pips" aria-label="level ${l} of ${wd.maxLevel}">${pips}</span>`;
          b.title = [`level ${l}/${wd.maxLevel}`, t === TTrack.Special && d.special ? `Each level: ${d.special}` : '', short ? `Need ${fmtGold(Math.ceil(cost - gold))}g more` : ''].filter(Boolean).join('\n');
          b.disabled = max || short;
          if (short) b.classList.add('short');
          if (max) b.classList.add('max');
          b.onclick = () => ctl.upgradeSel(t);
        }
        const tiers = wd.tiers;
        if (evo) el('div', 'sub', c, evo.desc);
        else if (d.evolve?.length && tiers) {
          // Two branches, once the generator is at its tier and the tracks add up.
          let sum = 0;
          for (let t = 0; t < TURRET_TRACKS; t++) sum += lv(t);
          if (f.tier < tiers.evolve || sum < tiers.evolveAt) {
            el('div', 'sub muted', c, `Evolves into a ${d.evolve.map((e) => e.name).join(' or a ')} once its tracks add up to ${tiers.evolveAt} (${sum} now)${f.tier < tiers.evolve ? ` and the generator is at tier ${ROMAN[tiers.evolve]}` : ''}.`);
          } else {
            const eg = el('div', 'grid evolve', c);
            d.evolve.forEach((e, k) => {
              const b = el('button', `evo${k + 1}`, eg);
              b.innerHTML = `<span class="n">${esc(e.name)}<span class="p">${fmtGold(d.price)}g</span></span><span class="v">${esc(e.desc)}</span>`;
              b.title = `Evolve into a ${e.name}, for good${gold < d.price ? `\nNeed ${fmtGold(Math.ceil(d.price - gold))}g more` : ''}`;
              b.disabled = gold < d.price;
              if (gold < d.price) b.classList.add('short');
              b.onclick = () => ctl.send({ op: 'evolve', s: id, track: k + 1 });
            });
          }
        }
      }
      if (f.sKind[id] === K_CORE && wd.tiers) {
        const tiers = wd.tiers;
        el('div', 'sub', c, f.tier < tiers.max
          ? `Tier ${ROMAN[f.tier]} · ${f.tierPaid} / ${f.tierCost}g paid in towards tier ${ROMAN[f.tier + 1]}, which ${f.tier + 1 === tiers.pylon ? 'unlocks the amplifier pylon' : 'unlocks turret evolutions and the Overload'}`
          : `Tier ${ROMAN[f.tier]}, the last · the Overload ${f.overloadReady ? 'is ready' : 'is spent or waits for a wave'}`);
        const tb = el('div', 'btns', c);
        if (f.tier < tiers.max) {
          const amt = Math.min(tiers.step, f.tierCost - f.tierPaid);
          const pi = el('button', 'primary', tb); pi.innerHTML = `Pay in <span class="gold">${amt}g</span>`;
          pi.title = 'The whole team pays into the generator; every tier makes it tougher';
          pi.disabled = gold < amt;
          if (gold < amt) { pi.classList.add('short'); pi.title += `\nNeed ${fmtGold(Math.ceil(amt - gold))}g more`; }
          pi.onclick = () => ctl.send({ op: 'payIn' });
        }
        if (f.tier >= tiers.overload) {
          const ov = el('button', 'primary', tb); ov.innerHTML = 'Overload';
          ov.title = `Shock and freeze every creep within ${tiers.overloadReach} tiles of the generator, once a wave`;
          ov.disabled = !f.overloadReady;
          ov.onclick = () => ctl.send({ op: 'overload' });
        }
      }
      const btns = el('div', 'btns', c);
      if (upg && !d?.turret) {
        const lvl = f.sLevel[id];
        const cost = d.upgrade[lvl] ?? 0;
        const up = el('button', 'primary', btns);
        up.innerHTML = lvl >= wd.maxStructLevel ? 'Max level' : `Upgrade <span class="gold">${cost}g</span> <kbd>U</kbd>`;
        up.disabled = lvl >= wd.maxStructLevel || gold < cost;
        if (lvl < wd.maxStructLevel && gold < cost) { up.classList.add('short'); up.title = `Need ${fmtGold(Math.ceil(cost - gold))}g more`; }
        up.onclick = () => ctl.upgradeSel();
      }
      if (f.sHp[id] < f.sMaxHp[id]) {
        const cost = d ? repairCost(d, f, id, wd.repairCostPerHP, wd.repairShare) : Math.ceil((f.sMaxHp[id] - f.sHp[id]) * wd.repairCostPerHP);
        const rp = el('button', '', btns); rp.innerHTML = `Repair <span class="gold">~${cost}g</span> <kbd>E</kbd>`;
        rp.onclick = () => ctl.repairSel();
      }
      if (f.sKind[id] > K_ARMORY) {
        const sl = el('button', '', btns);
        const refund = d ? sellValue(d, f, id, wd.sellFraction) : 0;
        sl.innerHTML = `Sell <span class="gold">+${refund}g</span> <kbd>Del</kbd>`;
        sl.onclick = () => ctl.sellSel();
      }
      if (f.sKind[id] === K_GATE) {
        const gt = el('button', 'primary', btns); gt.innerHTML = `${f.sOpen[id] ? 'Shut' : 'Open'} gate <kbd>E</kbd>`;
        gt.title = f.sOpen[id] ? 'The dead walk through an open gate; shut, it is a wall to them' : 'Open, the dead walk through it rather than break the walls; survivors pass either way';
        gt.onclick = () => ctl.swingGate(id);
      }
      if (f.sKind[id] === K_ARMORY) {
        const ar = el('button', 'primary', btns); ar.innerHTML = 'Open armory <kbd>C</kbd>';
        ar.onclick = () => ctl.openArmory(true);
      }
      return;
    }
    if (s?.t === 'creep') {
      const i = g.indexById[s.id];
      const d = i >= 0 ? wd.creeps[f.cKind[i]] : undefined;
      head(d ? esc(d.name[0].toUpperCase() + d.name.slice(1)) : 'Creep', '', 'red');
      if (d && i >= 0) {
        const fl = f.cFlags[i];
        el('div', 'sub', c, `HP ~${Math.round(f.cHp[i] / 255 * 100)}% · base HP ${d.hp} · speed ${d.speed}${d.ranged ? ' · ranged' : ''}`);
        el('div', 'sub', c, `bounty ${d.bounty}g${fl & 1 ? ' · burning' : ''}${fl & 2 ? ' · slowed' : ''}${fl & 4 ? ' · loot guard' : ''}${fl & 32 ? ' · asleep' : ''}${f.cFx[i] & CX_FRENZY ? ' · frenzied' : ''}${f.cFx[i] & CX_SAPPER ? ' · sapper' : ''}${f.cFx[i] & CX_SPLITTER ? ' · splitter' : ''}${f.cFx[i] & CX_ARMOURED ? ' · armoured' : ''}${f.cFx[i] & CX_HASTY ? ' · hasty' : ''}`);
        const btns = el('div', 'btns', c);
        const at = el('button', 'primary', btns, 'Attack');
        at.onclick = () => ctl.send({ op: 'attack', id: s.id });
      }
      return;
    }
    if (s?.t === 'hero') {
      const p = f.player(s.id);
      if (!p) return;
      const down = !(p.flags & PF_ALIVE);
      head(`<span style="display:inline-block;width:8px;height:10px;margin-right:6px;background:${cssHex(playerColor(p.id))};box-shadow:0 0 0 1px #000"></span>${esc(p.name)}`, down ? `down · ${p.respawn}s` : '', down ? 'red' : '');
      el('div', 'sub', c, `HP ${p.hp} / ${p.maxHp} · ${wd.weapons[p.cur]?.name ?? ''}`);
      el('div', 'sub', c, `${p.kills} kills · ${fmtGold(p.damage)} damage · ${ORDER[p.order] ?? ''}`);
      if (down && p.id !== wd.you) {
        const btns = el('div', 'btns', c);
        const rv = el('button', 'primary', btns, 'Revive');
        rv.title = 'Or E on them';
        rv.onclick = () => ctl.send({ op: 'revive', p: p.id });
      }
      return;
    }
    head('Orders');
    const btns = el('div', 'btns', c);
    const b1 = el('button', '', btns); b1.innerHTML = 'Build <kbd>B</kbd>'; b1.onclick = () => { this.buildCard = true; };
    const b2 = el('button', '', btns); b2.innerHTML = 'Armory <kbd>C</kbd>'; b2.onclick = () => ctl.openArmory(true);
    const b3 = el('button', '', btns); b3.innerHTML = 'Stop'; b3.onclick = () => ctl.send({ op: 'stop' });
    // What rebuilding everything costs, as on the top bar's button; between waves, when it can be done.
    const fc = ctl.fixCost(), fixing = f.phase === Phase.Build && fc.ghosts + fc.damaged > 0;
    const b4 = el('button', fixing && gold < fc.gold ? 'short' : '', btns);
    b4.innerHTML = `Rebuild all${fixing ? ` <span class="gold">${fmtGold(fc.gold)}g</span>` : ''} <kbd>H</kbd>`;
    b4.title = fixing ? `Rebuild ${fc.ghosts} destroyed and repair ${fc.damaged} damaged, for ${fmtGold(fc.gold)}g` : 'Nothing to rebuild or repair, or a wave is on';
    b4.onclick = () => ctl.fixAll();
    el('div', 'hint', c).innerHTML = '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk · <kbd>E</kbd> use · <kbd>Q</kbd> ultimate · <kbd>Shift</kbd> <kbd>F</kbd> <kbd>V</kbd> abilities · <kbd>F1</kbd> all controls';
  }

  private updateMode(): void {
    const m = this.ctl.mode;
    let s = '';
    if (m.k === 'ability') { const a = this.ctl.ability(m.slot); s = `${a?.name ?? 'Ability'}: left-click where to throw · Esc cancels`; }
    else if (m.k === 'build') {
      const d = this.ctl.game.welcome?.structs[m.kind];
      const sticky = stickyKind(m.kind);
      s = `Place ${d?.name ?? ''} (${d?.price ?? 0}g): left-click${sticky ? ', again for the next' : ' · Shift keeps placing'} · Esc stops`;
      if (this.ctl.routeNote) s += ` · ${this.ctl.routeNote}`;
    }
    show(this.modeEl, s !== '');
    setText(this.modeEl, s);
  }
}
