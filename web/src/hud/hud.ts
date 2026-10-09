import type { ConnState } from '../net';
import { Emote, Order, PF_ALIVE, PF_CONNECTED, PF_READY, PF_RELOADING, Phase, type Player, type Welcome, sellValue, turretRange } from '../protocol';
import { type Controller, KEYS } from '../controller';
import { cssHex, playerColor } from '../scene/util';
import { Armory } from './armory';
import { archetypeName, readLook } from '../scene/look';
import { CELL, type Portraits } from '../scene/portraits';
import { K_TESLA } from '../scene/structs';
import { el, esc, fmtGold, setClass, setText, show } from './dom';
import { iconFor, weatherIcon } from './icons';
import { Compass, where } from './compass';
import { Minimap } from './minimap';
import { wordmarkURL } from './splash';

const ORDER = ['idle', 'moving', 'attack-moving', 'attacking', 'holding', 'building', 'repairing', 'searching', 'reviving', 'walking'];

// One digit after the point below ten seconds, whole seconds above.
const secs = (s: number) => (s < 10 ? s.toFixed(1) : String(Math.ceil(s)));

// A teammate's frame: their portrait, name, health and what they are doing.
interface Mate { root: HTMLElement; face: CanvasRenderingContext2D; resp: HTMLElement; fill: HTMLElement; what: HTMLElement }

interface Slot { root: HTMLElement; icon: HTMLElement; key: HTMLElement; lvl: HTMLElement; cool: HTMLElement; coolTxt: HTMLElement; name: string; pipsFor: number; wasCooling: boolean }

let mark = '';
// The finished wordmark, drawn once.
function markURL(): string { return mark || (mark = wordmarkURL(3)); }

// The HTML overlay: top bar, bottom console, the command card, windows and messages.
export class Hud {
  root: HTMLElement;
  minimap: Minimap;
  private compass: Compass;
  armory: Armory;
  buildCard = false;
  // The generator's health, always in the top bar: the one number the game is lost on.
  private base: { root: HTMLElement; fill: HTMLElement; num: HTMLElement; hp: number; hitUntil: number };
  private top: { wave: HTMLElement; diff: HTMLElement; weather: HTMLElement; kills: HTMLElement; ready: HTMLButtonElement; readies: HTMLElement };
  private statusEl: HTMLElement;
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
  private countEl!: { root: HTMLElement; wave: HTMLElement; n: HTMLElement };
  private toastsEl: HTMLElement;
  private chat: { root: HTMLElement; log: HTMLElement; input: HTMLInputElement };
  private hero: {
    portrait: HTMLElement; resp: HTMLElement; name: HTMLElement; hp: HTMLElement; hpTxt: HTMLElement; gold: HTMLElement;
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
  private overBoard: HTMLElement | null = null;
  private cover: HTMLElement;
  private statsEl: HTMLElement;
  private conn: ConnState = 'connecting';
  private connDetail = '';
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
    base.onclick = () => { const c = ctl.game.welcome?.core; if (c) { ctl.rig.follow = false; ctl.rig.center(c.x, c.y, false); } };
    this.base = { root: base, fill: base.querySelector('.bbar i') as HTMLElement, num: base.querySelector('.num') as HTMLElement, hp: -1, hitUntil: 0 };
    const diff = el('div', 'chip diff', top);
    this.tipOn(diff, () => this.diffTip());
    const weather = el('div', 'chip weather', top);
    this.tipOn(weather, () => this.weatherTip());
    el('div', 'spacer', top);
    const kills = el('div', 'kills', top);
    const readies = el('div', 'readies', top);
    const ready = el('button', 'ready', top, 'Ready');
    ready.title = 'Ready for the next wave (N)';
    ready.onclick = () => ctl.toggleReady();
    const pauseBtn = el('button', '', top, 'Pause');
    pauseBtn.title = 'Pause or resume the game for everyone (P)';
    pauseBtn.onclick = () => ctl.send({ op: 'pause' });
    this.pauseBtn = pauseBtn;
    const chatBtn = el('button', '', top, 'Chat');
    chatBtn.title = 'Chat with the team (T or Enter)';
    chatBtn.onclick = () => this.openChat();
    const armBtn = el('button', '', top, 'Armory');
    armBtn.title = 'Armory (G)';
    armBtn.onclick = () => ctl.openArmory(!ctl.armoryOpen);
    const helpBtn = el('button', '', top, '?');
    helpBtn.title = 'Controls (F1)';
    helpBtn.onclick = () => this.toggleHelp();
    const menuBtn = el('button', '', top, 'Menu');
    menuBtn.title = 'Menu (F10)';
    menuBtn.onclick = () => this.toggleMenu();
    this.top = { wave, diff, weather, kills, ready, readies };
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
    // Stamina runs along the foot of the health bar: hold Space to sprint.
    const stam = el('div', 'stam', hpBar);
    hpBar.title = 'Health · the strip along the bottom is stamina, spent sprinting (hold Space)';
    const gun = el('div', 'gun', hero);
    const weapon = el('div', 'wname', gun);
    const ammoNum = el('div', 'ammo crt', gun);
    const reload = el('button', 'reload', gun);
    reload.innerHTML = 'Reload <kbd>R</kbd>';
    reload.onclick = () => ctl.send({ op: 'reload' });
    this.tipOn(reload, () => '<b>Reload</b><kbd>R</kbd><br>Swap in a fresh magazine now instead of when it runs dry.');
    const ammoBar = el('div', 'bar ammo', hero);
    const ammo = el('div', 'fill', ammoBar);
    const ammoTxt = el('div', 'txt', ammoBar);
    const order = el('div', 'order', hero);
    const buff = el('div', 'buff', hero);
    this.hero = { portrait, resp, name, hp, hpTxt, stam, gold, weapon, ammoNum, reload, ammo, ammoBar, ammoTxt, order, buff };

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
      s.root.onclick = () => ctl.startAbility(i);
      this.tipOn(s.root, () => this.abilityTip(i));
      this.slots.push(s);
    }
    el('div', 'sep', abil);
    const ts = mkSlot('slot taunt', 'V');
    ts.icon.innerHTML = iconFor('taunt');
    const cap = el('div', 'cap', ts.root, 'taunt');
    ts.root.onclick = () => ctl.send({ op: 'taunt' });
    this.tipOn(ts.root, () => this.tauntTip());
    this.taunt = { ...ts, cap };

    const ws = el('div', 'weapons', actions);
    for (let i = 0; i < 7; i++) {
      const w = el('div', 'wslot', ws);
      el('span', 'key', w, String(i + 1));
      el('span', 'nm', w);
      w.onclick = () => { const me = ctl.me(); if (me && me.owned & (1 << i)) ctl.send({ op: 'select', w: i }); else ctl.openArmory(true); };
      this.tipOn(w, () => this.weaponTip(i));
      this.wslots.push(w);
    }
    // The medkit sits after the weapons on 8.
    const med = el('div', 'wslot med', ws);
    el('span', 'key', med, '8');
    el('span', 'nm', med);
    med.onclick = () => { const me = ctl.me(); if (me && me.medkits > 0) ctl.medkit(); else ctl.openArmory(true); };
    this.tipOn(med, () => this.medkitTip());
    this.med = med;
    this.card = el('div', 'card panel', bottom);

    this.armory = new Armory(root, ctl);
    this.score = el('div', 'window panel score hidden', root);
    this.help = el('div', 'window panel help hidden', root);
    this.buildHelp();
    this.menu = el('div', 'window panel menu hidden', root);
    this.buildMenu();
    this.over = el('div', 'over hidden', root);
    this.tip = el('div', 'tip panel hidden', root);
    this.cover = el('div', 'cover', root);
    this.statsEl = el('div', 'stats panel hidden', root);
    this.renderCover();
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
    return `<b>Taunt</b><kbd>V</kbd><br>Shout: every creep within ${t.radius} tiles comes for you for ${t.time}s. Pull them off a teammate or into your turrets.<br><span class="muted">cooldown ${t.cool}s</span>`;
  }

  private medkitTip(): string {
    const m = this.ctl.game.welcome?.medkit, me = this.ctl.me();
    if (!m || !me) return '';
    return `<b>Medkit</b><kbd>8</kbd><br>Heals ${Math.round(m.heal * 100)}% of your health over ${m.time}s. A hit cuts it short.<br><span class="muted">${me.medkits}/${m.max} carried · ${m.cost}g each at the armory · first-aid kits in the wild hold more</span>`;
  }

  private weaponTip(i: number): string {
    const wd = this.ctl.game.welcome, me = this.ctl.me();
    const w = wd?.weapons[i];
    if (!w || !me) return '';
    const owned = (me.owned & (1 << i)) !== 0;
    const reloading = (me.reloading & (1 << i)) !== 0;
    const lv = [0, 1, 2, 3].map((t) => `${wd!.tracks[t]} ${me.levels[i * 4 + t]}`).join(' · ');
    return `<b>${esc(w.name)}</b><kbd>${i + 1}</kbd><br><span class="muted">${w.fire} · range ${w.range} · special ${esc(w.special)}</span><br>${owned ? lv : `not owned · <span class="c">${w.price}g</span> at the armory`}<br><span class="muted">signature: ${esc(w.sig.name)}${reloading ? ' · reloading' : ''}</span>`;
  }

  private diffTip(): string {
    const wd = this.ctl.game.welcome;
    if (!wd) return '';
    return `<b>${esc(wd.difficulty.name)}</b><br>The host's choice for this game. It sets creep health and wave size, gold drops, build time, how tough loot guards are and how long a downed survivor can be revived.`;
  }

  private weatherTip(): string {
    const wd = this.ctl.game.welcome, f = this.ctl.game.cur;
    const w = wd?.weathers[f.weather];
    if (!w) return '';
    const amt = Math.round(f.weatherAmt * 100);
    const state = f.weather === 0 ? '' : amt >= 98 ? '' : `<br><span class="muted">${amt < 50 && f.weatherAmt > 0 ? 'passing or rolling in' : 'building'} · ${amt}%</span>`;
    return `<b>${esc(w.name)}</b><br>${w.info ? esc(w.info) : 'No effect on the fight.'}${state}<br><span class="muted">Changes between waves.</span>`;
  }

  // Level 3 is a player's chat line, "name: text"; the others are the game's announcements.
  note(level: number, text: string): void {
    if (level === 3) { this.chatSaid(text); return; }
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
  toggleHelp(): void { show(this.help, this.help.classList.contains('hidden')); }
  toggleMenu(): void { show(this.menu, this.menu.classList.contains('hidden')); }
  toggleStats(): void { show(this.statsEl, this.statsEl.classList.contains('hidden')); }
  statsVisible(): boolean { return !this.statsEl.classList.contains('hidden'); }
  setStats(s: string): void { setText(this.statsEl, s); }

  // Esc: closes the topmost window; false when none was open.
  closeWindows(): boolean {
    for (const w of [this.menu, this.help, this.score]) if (!w.classList.contains('hidden')) { show(w, false); return true; }
    if (this.ctl.armoryOpen) { this.ctl.openArmory(false); return true; }
    if (this.minimap.expanded) { this.minimap.toggle(false); return true; }
    return false;
  }

  // A click in the world closes help and menu.
  closeTransient(): void { show(this.help, false); show(this.menu, false); }

  setConn(state: ConnState, detail = ''): void {
    this.conn = state; this.connDetail = detail;
    this.renderCover();
  }

  private renderCover(): void {
    const c = this.cover;
    if (this.conn === 'open') { show(c, false); return; }
    show(c, true);
    if (this.conn === 'ended') {
      c.innerHTML = `<img class="mark" src="${markURL()}" alt="taildefense"><div class="big">The game is over for this tab</div><div class="muted">${esc(this.connDetail)}</div><div class="muted">You can close this tab; <kbd>td</kbd> is back in the terminal.</div>`;
    } else {
      c.innerHTML = `<img class="mark" src="${markURL()}" alt="taildefense"><div class="spin"></div><div class="big">${this.conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</div><div class="muted">to the td running on this machine</div>`;
    }
  }

  private buildHelp(): void {
    const rows: [string, string][] = [
      ['<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>', 'walk, the way the view faces; the camera follows while you walk. Your hero shoots the nearest creep on its own'],
      ['<kbd>E</kbd>', 'use: a downed teammate, loot site or supply crate right beside you first, else what is under the cursor, else the nearest thing. A downed teammate: revive them (stay close until the bar fills) · a loot site: search it · a damaged structure: repair · the armory: shop · a creep: focus your fire on it'],
      ['Right-click', "on a creep: focus fire on it; elsewhere: the weapon's signature, at the cursor"],
      ['<kbd>Shift</kbd> <kbd>F</kbd> <kbd>Q</kbd>', 'abilities: grenade, dash, airstrike; aim with the cursor, then left-click to cast, right-click or Esc cancels'],
      ['<kbd>Alt</kbd> + left-click, or <kbd>Z</kbd> then click', 'ping the spot for the whole team, in the world or on the map: on a creep it warns, on a loot site it marks loot, on a structure it calls to defend it'],
      ['<kbd>H</kbd>', 'hold position'],
      ['<kbd>V</kbd>', 'taunt: flip them off and shout, pulling every creep nearby onto you, then a cooldown'],
      ['<kbd>1</kbd>–<kbd>7</kbd>', 'equip an owned weapon'],
      ['<kbd>8</kbd>', 'use a medkit: heals over a few seconds unless a hit cuts it short; buy more at the armory'],
      ['<kbd>R</kbd> or Reload', 'reload now (the button sits next to your ammo)'],
      ['<kbd>B</kbd>', 'build card; its hotkeys pick a structure, left-click places, Shift keeps placing'],
      ['Left-click', 'select a structure, creep or hero'],
      ['<kbd>U</kbd> / <kbd>X</kbd>', 'upgrade / sell the selected structure'],
      ['<kbd>G</kbd>', 'armory window (opens by itself when you arrive)'],
      ['<kbd>N</kbd>', 'ready for the next wave'],
      ['Wheel', 'zoom · Alt+wheel or middle-drag: rotate'],
      ['<kbd>Space</kbd>', 'hold: sprint, until your stamina (the strip under your health) runs out · tap: back to your hero · double tap: lock the camera to it'],
      ['Arrows / screen edge', 'look around; walking brings the camera back'],
      ['Minimap', 'left-click/drag: look there · right-click: move there'],
      ['<kbd>P</kbd>', 'pause or resume the game, for everyone'],
      ['<kbd>M</kbd>', 'big map, and back; click it to look, right-click to walk there'],
      ['<kbd>T</kbd> / <kbd>Enter</kbd>', 'chat with the team · in the chat, <kbd>Tab</kbd> adds where you are'],
      ['Compass', 'the strip at the top shows which way the view faces; click it to turn north up'],
      ['<kbd>Tab</kbd>', 'scoreboard (hold)'],
      ['<kbd>F3</kbd>', 'performance readout'],
      ['<kbd>F4</kbd>', 'pixel view on or off'],
      ['<kbd>F10</kbd> / <kbd>Esc</kbd>', 'menu (Esc first cancels the current mode or window)'],
    ];
    this.help.innerHTML = `<h2><span class="tape">Controls</span><button class="x">Close</button></h2><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    (this.help.querySelector('.x') as HTMLButtonElement).onclick = () => show(this.help, false);
  }

  private buildMenu(): void {
    const m = this.menu;
    el('h2', '', m).innerHTML = '<span class="tape">Menu</span>';
    const resume = el('button', '', m, 'Resume');
    resume.onclick = () => show(m, false);
    const help = el('button', '', m, 'Controls (F1)');
    help.onclick = () => { show(m, false); this.toggleHelp(); };
    const leave = el('button', 'danger', m, 'Leave game');
    leave.onclick = () => this.leave();
    el('div', 'muted', m, '').id = 'menu-hint';
  }

  private leave(): void {
    const hosting = this.ctl.game.welcome?.hosting;
    if (hosting && !confirm('You are hosting: leaving ends the game for everyone. Leave?')) return;
    this.ctl.send({ op: 'leave' });
  }

  private scoreTable(): string {
    const g = this.ctl.game, f = g.cur;
    const rows = [];
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const st = !(p.flags & PF_CONNECTED) ? '<span class="st muted">away</span>' : !(p.flags & PF_ALIVE) ? `<span class="st down">down ${p.respawn}s</span>` : '';
      const you = p.id === g.welcome?.you && p.name !== 'you' ? ' <span class="muted">(you)</span>' : '';
      rows.push(`<tr><td><span class="dot" style="background:${cssHex(playerColor(p.id))}"></span>${esc(p.name)}${you} <span class="muted">${esc(readLook(p.look).arch.name)}</span>${st}</td><td>${p.kills}</td><td>${fmtGold(p.damage)}</td><td class="gold">${fmtGold(p.gold)}</td></tr>`);
    }
    return `<table class="scoretable"><tr><th>Survivor</th><th>Kills</th><th>Damage</th><th>Gold</th></tr>${rows.join('')}</table>`;
  }

  private renderScore(): void {
    const f = this.ctl.game.cur;
    this.score.innerHTML = `<h2><span class="tape">Scoreboard</span><span class="muted">wave ${f.wave} · ${fmtGold(f.totalKills)} kills</span></h2>${this.scoreTable()}`;
  }

  // --- per frame ---

  update(now: number): void {
    const ctl = this.ctl, g = ctl.game, wd = g.welcome, me = ctl.me();
    if (!wd) return;
    this.compass.update();
    this.updateTop(wd, now);
    this.updateTeam(wd);
    if (me) this.updateHero(me, wd, now);
    this.updateDown(me);
    this.updatePause();
    this.updateCountdown(now);
    this.updateCard();
    this.updateMode();
    this.armory.update();
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
          const q = ctl.game.cur.players.slice(0, ctl.game.cur.nPlayers).find((o) => o.id === id);
          if (!q) return;
          if (q.flags & PF_CONNECTED && !(q.flags & PF_ALIVE)) ctl.send({ op: 'revive', p: id });
          else { ctl.rig.follow = false; ctl.rig.center(q.x, q.y, false); }
        };
        this.mates.set(id, { root, face: cv.getContext('2d')!, resp, fill, what });
      }
    }
    for (const p of list) {
      const m = this.mates.get(p.id)!;
      const here = (p.flags & PF_CONNECTED) !== 0, alive = (p.flags & PF_ALIVE) !== 0;
      const frac = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
      const down = here && !alive && !over;
      m.fill.style.transform = `scaleX(${alive ? frac.toFixed(3) : down ? p.revived.toFixed(3) : 0})`;
      setClass(m.root, 'away', !here);
      setClass(m.root, 'dead', down);
      setClass(m.root, 'low', alive && frac < 0.3);
      setText(m.resp, here && !alive ? `${p.respawn}` : '');
      const w = wd.weapons[p.cur]?.name ?? '';
      const what = !here ? 'away'
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
      wave = `<span class="lbl">wave ${f.wave + 1} in</span><span class="phase">${Math.ceil(left)}s</span>`;
    } else if (f.phase === Phase.Wave) wave = `<span class="lbl">wave</span>${f.wave}<span class="lbl">·</span><span class="phase">${fmtGold(f.pending + f.nCreeps)}</span><span class="lbl">creeps left</span>`;
    else wave = `<span class="lbl">overrun · held</span><span class="phase">${f.best}</span><span class="lbl">waves</span>`;
    if (this.top.wave.innerHTML !== wave) this.top.wave.innerHTML = wave;

    this.updateBase(now);

    const di = Math.max(0, Math.min(wd.difficulties.length - 1, wd.difficulty.id));
    const diff = `<span class="pips">${wd.difficulties.map((_, i) => `<i class="${i <= di ? 'on' : ''}"></i>`).join('')}</span>${esc(wd.difficulty.name)}`;
    if (this.top.diff.innerHTML !== diff) this.top.diff.innerHTML = diff;

    const w = wd.weathers[f.weather] ?? wd.weathers[0];
    const amt = f.weather === 0 ? 1 : f.weatherAmt;
    const wh = `${weatherIcon(f.weather)}<span>${esc(w?.name ?? 'Clear')}</span>${w?.info && amt > 0.3 ? `<span class="info">${esc(w.info)}</span>` : ''}`;
    if (this.top.weather.innerHTML !== wh) this.top.weather.innerHTML = wh;
    this.top.weather.style.opacity = (0.4 + 0.6 * amt).toFixed(2);

    const kills = `<b>${fmtGold(f.totalKills)}</b> kills`;
    if (this.top.kills.innerHTML !== kills) this.top.kills.innerHTML = kills;
    const build = f.phase === Phase.Build;
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
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] === 1) { hp = f.sHp[i]; max = Math.max(1, f.sMaxHp[i]); break; }
    if (b.hp >= 0 && hp < b.hp) b.hitUntil = now + 450;
    b.hp = hp;
    const frac = Math.max(0, Math.min(1, hp / max));
    b.fill.style.width = `${(frac * 100).toFixed(1)}%`;
    setText(b.num, `${Math.ceil(frac * 100)}%`);
    setClass(b.root, 'mid', frac <= 0.6 && frac > 0.3);
    setClass(b.root, 'low', frac <= 0.3);
    setClass(b.root, 'hit', now < b.hitUntil);
    b.root.title = `The generator: ${Math.ceil(hp)} / ${Math.ceil(max)}. If it falls, the game is over. Click to look at it.`;
  }

  // The last seconds of a break count down big in the middle of the screen.
  private updateCountdown(now: number): void {
    const g = this.ctl.game, f = g.cur;
    const left = f.phase === Phase.Build && f.pausedBy < 0 ? f.phaseLeft / 10 - (now - g.frameAt) / 1000 : 0;
    const on = left > 0 && left <= 5;
    show(this.countEl.root, on);
    if (!on) return;
    setText(this.countEl.wave, `wave ${f.wave + 1} incoming`);
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
    const p = f.players.slice(0, f.nPlayers).find((q) => q.id === by);
    const who = by === this.ctl.game.welcome?.you ? 'you' : p ? esc(p.name) : 'a player';
    const sub = `paused by ${who} · press <kbd>P</kbd> to resume`;
    if (this.paused.sub.innerHTML !== sub) this.paused.sub.innerHTML = sub;
  }

  // Your own downed banner. A teammate who is down shows in their frame.
  private updateDown(me: Player | null): void {
    const ctl = this.ctl, f = ctl.game.cur;
    const over = f.phase === Phase.Over;
    const down = !!me && !(me.flags & PF_ALIVE) && !over;
    show(this.downed.root, down);
    if (down) {
      let mates = 0;
      for (let i = 0; i < f.nPlayers; i++) {
        const p = f.players[i];
        if (p.id !== me!.id && p.flags & PF_CONNECTED && p.flags & PF_ALIVE) mates++;
      }
      const sub = mates > 0
        ? `a teammate can revive you here · or respawn at base in<span class="n">${me!.respawn}s</span>`
        : `no teammate is standing · respawn at base in<span class="n">${me!.respawn}s</span>`;
      if (this.downed.sub.innerHTML !== sub) this.downed.sub.innerHTML = sub;
      show(this.downed.bar, me!.revived > 0);
      this.downed.fill.style.transform = `scaleX(${me!.revived.toFixed(3)})`;
    }
  }

  private updateOver(tick: boolean): void {
    const ctl = this.ctl, f = ctl.game.cur, wd = ctl.game.welcome!;
    const isOver = f.phase === Phase.Over;
    show(this.over, isOver);
    if (!isOver) { delete this.over.dataset.shown; this.overBoard = null; return; }
    if (!this.over.dataset.shown) {
      this.over.dataset.shown = '1';
      show(this.score, false);
      let n = 0;
      for (let i = 0; i < f.nPlayers; i++) if (f.players[i].flags & PF_CONNECTED) n++;
      this.over.innerHTML = `<div class="sheet panel">
        <span class="tape red">Field report</span>
        <div class="stamp">Overrun</div>
        <h1>The generator has fallen</h1>
        <div class="meta">${esc(wd.difficulty.name)} · ${n} ${n === 1 ? 'survivor' : 'survivors'} · map ${esc(wd.seed)}</div>
        <div class="tally">
          <div class="crt"><b>${f.best}</b><span>${f.best === 1 ? 'wave' : 'waves'} held</span></div>
          <div class="crt"><b>${fmtGold(f.totalKills)}</b><span>creeps killed</span></div>
        </div>
        <div class="board"></div>
        <div class="row"></div>
        <div class="note">${wd.hosting ? 'Restart deals a new map to everyone in the game.' : 'Restart deals a new map to everyone in the game; leaving takes you back to the terminal.'}</div>
      </div>`;
      this.overBoard = this.over.querySelector('.board') as HTMLElement;
      const row = this.over.querySelector('.row') as HTMLElement;
      const rs = el('button', 'primary', row, 'Restart on a new map');
      rs.onclick = () => ctl.send({ op: 'restart' });
      const lv = el('button', 'danger', row, 'Leave game');
      lv.onclick = () => this.leave();
      tick = true;
    }
    if (tick && this.overBoard) this.overBoard.innerHTML = this.scoreTable();
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
    setClass(h.portrait, 'dead', !alive);
    setText(h.resp, alive ? '' : `${me.respawn}`);
    setText(h.name, me.name);
    setText(h.gold, `${fmtGold(me.gold)}`);
    const frac = me.hp / Math.max(1, me.maxHp);
    h.hp.style.transform = `scaleX(${frac})`;
    h.hp.style.background = frac > 0.5 ? '' : frac > 0.25 ? 'var(--amber)' : 'var(--rust)';
    setText(h.hpTxt, `${me.hp} / ${me.maxHp}`);
    h.stam.style.transform = `scaleX(${me.stamina.toFixed(3)})`;
    setClass(h.stam, 'winded', me.winded);
    setClass(h.stam, 'full', me.stamina >= 0.999);
    const w = wd.weapons[me.cur];
    setText(h.weapon, w ? w.name : '');
    const reloading = (me.flags & PF_RELOADING) !== 0;
    setClass(h.ammoBar, 'reload', reloading);
    h.ammo.style.transform = `scaleX(${reloading ? 1 - me.reload : me.ammo / Math.max(1, me.mag)})`;
    setText(h.ammoTxt, reloading ? 'reloading' : '');
    const an = `${me.ammo}<i>/${me.mag}</i>`;
    if (h.ammoNum.innerHTML !== an) h.ammoNum.innerHTML = an;
    h.ammoNum.style.color = !reloading && me.ammo <= Math.max(1, me.mag * 0.2) ? 'var(--rust)' : '';
    const full = me.ammo >= me.mag;
    h.reload.disabled = !alive || full || reloading;
    setClass(h.reload, 'busy', reloading);
    h.reload.title = reloading ? 'Reloading' : full ? 'The magazine is full' : 'Reload now (T)';
    setText(h.order, alive ? (me.emote === Emote.Taunt && me.emoteLeft > 0 ? `taunting · ${me.emoteLeft.toFixed(1)}s` : ORDER[me.order] ?? '') : `down · ${me.respawn}s`);
    setText(h.buff, me.buff && me.buffLeft > 0 ? `${wd.weapons[me.buff]?.sig.name ?? 'buff'} · ${me.buffLeft.toFixed(1)}s` : '');

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
      setClass(s.root, 'active', this.ctl.mode.k === 'ability' && this.ctl.mode.slot === i);
      setText(s.key, a.key);
      if (s.pipsFor !== a.level * 10 + a.maxLevel) {
        s.pipsFor = a.level * 10 + a.maxLevel;
        s.lvl.innerHTML = a.maxLevel > 1 ? Array.from({ length: a.maxLevel }, (_, k) => `<i class="${k < a.level ? 'on' : ''}"></i>`).join('') : '';
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

    for (let i = 0; i < 7; i++) {
      const e = this.wslots[i], w2 = wd.weapons[i];
      show(e, !!w2);
      if (!w2) continue;
      setClass(e, 'owned', (me.owned & (1 << i)) !== 0);
      setClass(e, 'cur', me.cur === i);
      setClass(e, 'reloading', (me.reloading & (1 << i)) !== 0);
      setText(e.children[1] as HTMLElement, w2.short);
    }
    setClass(this.med, 'owned', me.medkits > 0);
    setClass(this.med, 'cur', me.heal > 0);
    setText(this.med.children[1] as HTMLElement, me.heal > 0 ? `heal ${me.heal.toFixed(1)}` : `med ×${me.medkits}`);
  }

  // The right-hand command card: the build grid, or whatever is selected.
  private updateCard(): void {
    const ctl = this.ctl, g = ctl.game, f = g.cur, wd = g.welcome!, me = ctl.me();
    ctl.validate();
    let key: string;
    const s = ctl.sel;
    if (this.buildCard) key = `b:${ctl.mode.k === 'build' ? ctl.mode.kind : -1}:${me ? Math.floor(me.gold) : 0}`;
    else if (s?.t === 'struct') key = `s:${s.id}:${f.sKind[s.id]}:${f.sHp[s.id]}:${f.sMaxHp[s.id]}:${f.sLevel[s.id]}:${me ? Math.floor(me.gold) : 0}`;
    else if (s?.t === 'creep') { const i = g.indexById[s.id]; key = `c:${s.id}:${i >= 0 ? f.cHp[i] + ':' + f.cFlags[i] : ''}`; }
    else if (s?.t === 'hero') { const p = f.player(s.id); key = `h:${s.id}:${p?.hp}:${p?.cur}:${p?.kills}:${p?.flags}:${p?.respawn}`; }
    else key = 'none';
    if (key === this.cardKey) return;
    this.cardKey = key;
    const c = this.card;
    c.innerHTML = '';
    const gold = me ? me.gold : 0;
    const head = (title: string, aside = '', cls = '') => {
      el('h3', '', c).innerHTML = `<span class="tape ${cls}">${title}</span>${aside ? `<span class="muted">${aside}</span>` : ''}`;
    };
    if (this.buildCard) {
      head('Build', 'B closes');
      const grid = el('div', 'grid', c);
      for (const k of wd.buildable) {
        const d = wd.structs[k];
        const b = el('button', ctl.mode.k === 'build' && ctl.mode.kind === k ? 'sel' : '', grid);
        b.innerHTML = `<span class="n">${esc(d.name)}</span><span class="p">${d.price}g</span><span class="k">${esc(d.key)}</span>`;
        b.disabled = gold < d.price;
        b.title = d.desc;
        b.onclick = () => ctl.startBuild(k);
      }
      el('div', 'hint', c, 'Left-click places · Shift keeps placing · right-click or Esc cancels');
      return;
    }
    if (s?.t === 'struct') {
      const id = s.id, d = wd.structs[f.sKind[id]];
      const owner = f.sOwner[id] < 0 ? 'base' : f.player(f.sOwner[id])?.name ?? `player ${f.sOwner[id]}`;
      head(esc(d?.name ?? '?'), esc(owner));
      el('div', 'sub', c, `HP ${f.sHp[id]} / ${f.sMaxHp[id]}${d?.turret ? ` · level ${f.sLevel[id]}/${wd.maxStructLevel} · range ${turretRange(d, f.sLevel[id]).toFixed(1).replace(/\.0$/, '')}${f.sKind[id] === K_TESLA ? ` · strikes ${2 * f.sLevel[id]}` : ''}` : ''}`);
      if (d?.desc) el('div', 'sub', c, d.desc);
      const btns = el('div', 'btns', c);
      if (d?.turret) {
        const lvl = f.sLevel[id];
        const cost = d.upgrade[lvl] ?? 0;
        const up = el('button', 'primary', btns);
        up.innerHTML = lvl >= wd.maxStructLevel ? 'Max level' : `Upgrade <span class="gold">${cost}g</span> <kbd>U</kbd>`;
        up.disabled = lvl >= wd.maxStructLevel || gold < cost;
        up.onclick = () => ctl.upgradeSel();
      }
      if (f.sHp[id] < f.sMaxHp[id]) {
        const cost = Math.ceil((f.sMaxHp[id] - f.sHp[id]) * wd.repairCostPerHP);
        const rp = el('button', '', btns); rp.innerHTML = `Repair <span class="gold">~${cost}g</span> <kbd>E</kbd>`;
        rp.onclick = () => ctl.repairSel();
      }
      if (f.sKind[id] > 2) {
        const sl = el('button', '', btns);
        const refund = d ? sellValue(d, f.sLevel[id], f.sHp[id], f.sMaxHp[id], wd.sellFraction) : 0;
        sl.innerHTML = `Sell <span class="gold">+${refund}g</span> <kbd>X</kbd>`;
        sl.onclick = () => ctl.sellSel();
      }
      if (f.sKind[id] === 2) {
        const ar = el('button', 'primary', btns); ar.innerHTML = 'Open armory <kbd>G</kbd>';
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
        el('div', 'sub', c, `bounty ${d.bounty}g${fl & 1 ? ' · burning' : ''}${fl & 2 ? ' · slowed' : ''}${fl & 4 ? ' · loot guard' : ''}${fl & 32 ? ' · asleep' : ''}`);
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
    const b2 = el('button', '', btns); b2.innerHTML = 'Armory <kbd>G</kbd>'; b2.onclick = () => ctl.openArmory(true);
    const b3 = el('button', '', btns); b3.innerHTML = 'Stop'; b3.onclick = () => ctl.send({ op: 'stop' });
    const b4 = el('button', '', btns); b4.innerHTML = 'Hold <kbd>H</kbd>'; b4.onclick = () => ctl.send({ op: 'hold' });
    el('div', 'hint', c, 'WASD to walk · E to use · right-click: signature · F1 for all controls');
  }

  private updateMode(): void {
    const m = this.ctl.mode;
    let s = '';
    if (m.k === 'ability') { const a = this.ctl.ability(m.slot); s = `${a?.name ?? 'Ability'}: left-click a target · right-click or Esc cancels`; }
    else if (m.k === 'build') { const d = this.ctl.game.welcome?.structs[m.kind]; s = `Place ${d?.name ?? ''} (${d?.price ?? 0}g): left-click · Shift keeps placing · Esc cancels`; }
    show(this.modeEl, s !== '');
    setText(this.modeEl, s);
  }
}
