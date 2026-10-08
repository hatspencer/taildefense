import type { ConnState } from '../net';
import { PF_ALIVE, PF_CONNECTED, PF_READY, PF_RELOADING, Phase, sellValue, turretRange } from '../protocol';
import type { Controller } from '../controller';
import { cssHex, playerColor } from '../scene/util';
import { Armory } from './armory';
import { el, esc, fmtGold, setClass, setText, show } from './dom';
import { iconFor } from './icons';
import { Minimap } from './minimap';

const ORDER = ['idle', 'moving', 'attack-moving', 'attacking', 'holding', 'building', 'repairing'];

// The HTML overlay: top bar, bottom console, the command card, windows and messages.
export class Hud {
  root: HTMLElement;
  minimap: Minimap;
  armory: Armory;
  buildCard = false;
  private top: { wave: HTMLElement; kills: HTMLElement; ready: HTMLButtonElement; readies: HTMLElement };
  private statusEl: HTMLElement;
  private announceEl: HTMLElement;
  private toastsEl: HTMLElement;
  private chat: { root: HTMLElement; log: HTMLElement; input: HTMLInputElement };
  private hero: { portrait: HTMLElement; resp: HTMLElement; name: HTMLElement; hp: HTMLElement; hpTxt: HTMLElement; gold: HTMLElement; weapon: HTMLElement; ammo: HTMLElement; ammoBar: HTMLElement; ammoTxt: HTMLElement; order: HTMLElement; buff: HTMLElement };
  private slots: { root: HTMLElement; icon: HTMLElement; key: HTMLElement; lvl: HTMLElement; cool: HTMLElement; coolTxt: HTMLElement; name: string; pipsFor: number }[] = [];
  private wslots: HTMLElement[] = [];
  private card: HTMLElement;
  private cardKey = '';
  private modeEl: HTMLElement;
  private tip: HTMLElement;
  private tipFor: (() => string) | null = null;
  private score: HTMLElement;
  private help: HTMLElement;
  private menu: HTMLElement;
  private over: HTMLElement;
  private cover: HTMLElement;
  private statsEl: HTMLElement;
  private conn: ConnState = 'connecting';
  private connDetail = '';
  private chatTimer = 0;
  private lastSec = -1;

  constructor(parent: HTMLElement, private ctl: Controller) {
    const root = el('div', 'hud', parent);
    this.root = root;

    // Top bar.
    const top = el('div', 'top', root);
    const wave = el('div', 'wave', top);
    el('div', 'spacer', top);
    const kills = el('div', 'kills', top);
    const readies = el('div', 'readies', top);
    const ready = el('button', 'ready', top, 'Ready');
    ready.title = 'Ready for the next wave (N)';
    ready.onclick = () => ctl.toggleReady();
    const armBtn = el('button', '', top, 'Armory');
    armBtn.title = 'Armory (G)';
    armBtn.onclick = () => ctl.openArmory(!ctl.armoryOpen);
    const helpBtn = el('button', '', top, '?');
    helpBtn.title = 'Help (F1)';
    helpBtn.onclick = () => this.toggleHelp();
    const menuBtn = el('button', '', top, 'Menu');
    menuBtn.title = 'Menu (F10)';
    menuBtn.onclick = () => this.toggleMenu();
    this.top = { wave, kills, ready, readies };
    this.statusEl = el('div', 'status', root);
    this.announceEl = el('div', 'announce', root);
    this.toastsEl = el('div', 'toasts', root);
    this.modeEl = el('div', 'mode panel hidden', root);

    // Chat.
    const chat = el('div', 'chat', root);
    const log = el('div', 'log', chat);
    const input = el('input', 'hidden', chat);
    input.maxLength = 200;
    input.placeholder = 'Say something… (Enter sends, Esc closes)';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
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
    const resp = el('div', 'resp', portrait);
    const nameCol = el('div', '', r1);
    const name = el('div', 'name', nameCol);
    const gold = el('div', 'goldline gold', nameCol);
    const hpBar = el('div', 'bar', hero);
    const hp = el('div', 'fill', hpBar);
    const hpTxt = el('div', 'txt', hpBar);
    const weapon = el('div', '', hero);
    const ammoBar = el('div', 'bar ammo', hero);
    const ammo = el('div', 'fill', ammoBar);
    const ammoTxt = el('div', 'txt', ammoBar);
    const order = el('div', 'order', hero);
    const buff = el('div', 'buff', hero);
    this.hero = { portrait, resp, name, hp, hpTxt, gold, weapon, ammo, ammoBar, ammoTxt, order, buff };

    const actions = el('div', 'actions', con);
    const abil = el('div', 'abilities', actions);
    for (let i = 0; i < 4; i++) {
      const s = el('div', 'slot', abil);
      const icon = el('div', 'icon', s);
      const cool = el('div', 'cool', s);
      const coolTxt = el('div', 'cooltxt', s);
      const key = el('div', 'key', s, 'QWER'[i]);
      const lvl = el('div', 'lvl', s);
      s.onclick = () => ctl.startAbility(i);
      this.tipOn(s, () => this.abilityTip(i));
      this.slots.push({ root: s, icon, key, lvl, cool, coolTxt, name: '', pipsFor: -1 });
    }
    const ws = el('div', 'weapons', actions);
    for (let i = 0; i < 7; i++) {
      const w = el('div', 'wslot', ws);
      el('span', 'key', w, String(i + 1));
      el('span', 'nm', w);
      w.onclick = () => { const me = ctl.me(); if (me && me.owned & (1 << i)) ctl.send({ op: 'select', w: i }); else ctl.openArmory(true); };
      this.tipOn(w, () => this.weaponTip(i));
      this.wslots.push(w);
    }
    this.card = el('div', 'card panel', bottom);

    this.armory = new Armory(root, ctl);
    this.tip = el('div', 'tip panel hidden', root);
    this.score = el('div', 'window panel score hidden', root);
    this.help = el('div', 'window panel help hidden', root);
    this.buildHelp();
    this.menu = el('div', 'window panel menu hidden', root);
    this.buildMenu();
    this.over = el('div', 'cover hidden', root);
    this.cover = el('div', 'cover', root);
    this.statsEl = el('div', 'stats panel hidden', root);
    this.renderCover();
  }

  // --- windows and messages ---

  private tipOn(e: HTMLElement, f: () => string): void {
    e.addEventListener('mouseenter', () => { this.tipFor = f; this.placeTip(e); });
    e.addEventListener('mouseleave', () => { this.tipFor = null; show(this.tip, false); });
  }

  private placeTip(e: HTMLElement): void {
    if (!this.tipFor) return;
    this.tip.innerHTML = this.tipFor();
    show(this.tip, true);
    const r = e.getBoundingClientRect();
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tw - 4, r.left + r.width / 2 - tw / 2))}px`;
    this.tip.style.top = `${Math.max(4, r.top - th - 8)}px`;
  }

  private abilityTip(i: number): string {
    const a = this.ctl.ability(i);
    if (!a) return '';
    const lv = a.level > 0 ? `level ${a.level}${a.maxLevel > 1 ? '/' + a.maxLevel : ''}` : 'locked: buy at the armory';
    const next = a.nextCost ? ` · next level <span class="c">${a.nextCost}g</span>` : '';
    return `<b>${esc(a.name)}</b> <kbd>${a.key}</kbd><br>${esc(a.desc)}<br><span class="muted">${lv} · cooldown ${a.cool || '—'}s${a.range ? ' · range ' + a.range : ''}${next}</span>`;
  }

  private weaponTip(i: number): string {
    const wd = this.ctl.game.welcome, me = this.ctl.me();
    const w = wd?.weapons[i];
    if (!w || !me) return '';
    const owned = (me.owned & (1 << i)) !== 0;
    const lv = [0, 1, 2, 3].map((t) => `${wd!.tracks[t]} ${me.levels[i * 4 + t]}`).join(' · ');
    return `<b>${esc(w.name)}</b> <kbd>${i + 1}</kbd><br><span class="muted">${w.fire} · range ${w.range} · special ${esc(w.special)}</span><br>${owned ? lv : `not owned · <span class="c">${w.price}g</span> at the armory`}<br><span class="muted">signature: ${esc(w.sig.name)}</span>`;
  }

  note(level: number, text: string): void {
    if (level >= 1) {
      const d = el('div', level === 1 ? 'good' : 'bad', this.announceEl, text);
      setTimeout(() => d.remove(), 4000);
      while (this.announceEl.children.length > 3) this.announceEl.firstChild!.remove();
    }
    this.chatLine(text, level);
  }

  private chatLine(text: string, level: number): void {
    const d = el('div', `lvl${level}`, this.chat.log, text);
    setTimeout(() => d.classList.add('old'), 9000);
    while (this.chat.log.children.length > 12) this.chat.log.firstChild!.remove();
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

  showScore(on: boolean): void { show(this.score, on); if (on) this.renderScore(); }
  toggleHelp(): void { show(this.help, this.help.classList.contains('hidden')); }
  toggleMenu(): void { show(this.menu, this.menu.classList.contains('hidden')); }
  toggleStats(): void { show(this.statsEl, this.statsEl.classList.contains('hidden')); }
  statsVisible(): boolean { return !this.statsEl.classList.contains('hidden'); }
  setStats(s: string): void { setText(this.statsEl, s); }

  // Esc: closes the topmost window; false when none was open.
  closeWindows(): boolean {
    for (const w of [this.menu, this.help, this.score]) if (!w.classList.contains('hidden')) { show(w, false); return true; }
    if (this.ctl.armoryOpen) { this.ctl.openArmory(false); return true; }
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
      c.innerHTML = `<h1>taildefense</h1><div class="big">The game is over for this tab</div><div class="muted">${esc(this.connDetail)}</div><div class="muted">You can close this tab; <kbd>td</kbd> is back in the terminal.</div>`;
    } else {
      c.innerHTML = `<h1>taildefense</h1><div class="spin"></div><div class="big">${this.conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</div><div class="muted">to the td running on this machine</div>`;
    }
  }

  private buildHelp(): void {
    const rows: [string, string][] = [
      ['Right-click', 'move · on a creep: attack · on a damaged structure: repair · on the armory: walk there'],
      ['<kbd>A</kbd> + left-click', 'attack-move (Shift keeps the mode)'],
      ['<kbd>S</kbd> / <kbd>H</kbd>', 'stop / hold position'],
      ['<kbd>Q</kbd> <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd>', 'abilities; point abilities then left-click to cast, right-click or Esc cancels'],
      ['<kbd>1</kbd>–<kbd>7</kbd>', 'equip an owned weapon'],
      ['<kbd>T</kbd>', 'reload'],
      ['<kbd>B</kbd>', 'build card; its hotkeys pick a structure, left-click places, Shift keeps placing'],
      ['Left-click', 'select a structure, creep or hero'],
      ['<kbd>U</kbd> / <kbd>X</kbd> / <kbd>F</kbd>', 'upgrade / sell / repair the selected structure'],
      ['<kbd>G</kbd>', 'armory window (opens by itself when you arrive)'],
      ['<kbd>N</kbd>', 'ready for the next wave'],
      ['Wheel', 'zoom · Alt+wheel or middle-drag: rotate'],
      ['Arrows / screen edge', 'pan · <kbd>Space</kbd> back to your hero, double <kbd>Space</kbd> locks the camera'],
      ['Minimap', 'left-click/drag: look there · right-click: move there'],
      ['<kbd>Enter</kbd>', 'chat'],
      ['<kbd>Tab</kbd>', 'scoreboard (hold)'],
      ['<kbd>F3</kbd>', 'performance readout'],
      ['<kbd>F4</kbd>', 'pixel view on or off'],
      ['<kbd>F10</kbd> / <kbd>Esc</kbd>', 'menu (Esc first cancels the current mode or window)'],
    ];
    this.help.innerHTML = `<h2>Controls <button class="x">Close</button></h2><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    (this.help.querySelector('.x') as HTMLButtonElement).onclick = () => show(this.help, false);
  }

  private buildMenu(): void {
    const m = this.menu;
    el('h2', '', m, 'Menu');
    const resume = el('button', '', m, 'Resume');
    resume.onclick = () => show(m, false);
    const help = el('button', '', m, 'Controls (F1)');
    help.onclick = () => { show(m, false); this.toggleHelp(); };
    const leave = el('button', '', m, 'Leave game');
    leave.onclick = () => {
      const hosting = this.ctl.game.welcome?.hosting;
      if (hosting && !confirm('You are hosting: leaving ends the game for everyone. Leave?')) return;
      this.ctl.send({ op: 'leave' });
    };
    el('div', 'muted', m, '').id = 'menu-hint';
  }

  private renderScore(): void {
    const g = this.ctl.game, f = g.cur;
    const rows = [];
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const st = !(p.flags & PF_CONNECTED) ? 'away' : !(p.flags & PF_ALIVE) ? `dead ${p.respawn}s` : '';
      rows.push(`<tr><td><span class="dot" style="background:${cssHex(playerColor(p.id))}"></span>${esc(p.name)}${p.id === g.welcome?.you && p.name !== 'you' ? ' (you)' : ''} <span class="muted">${st}</span></td><td>${p.kills}</td><td>${fmtGold(p.damage)}</td><td class="gold">${fmtGold(p.gold)}</td></tr>`);
    }
    this.score.innerHTML = `<h2>Scoreboard <span class="muted" style="font-size:12px;font-weight:400">wave ${f.wave} · ${fmtGold(f.totalKills)} kills</span></h2><table><tr><th>Player</th><th>Kills</th><th>Damage</th><th>Gold</th></tr>${rows.join('')}</table>`;
  }

  // --- per frame ---

  update(now: number): void {
    const ctl = this.ctl, g = ctl.game, f = g.cur, wd = g.welcome, me = ctl.me();
    if (!wd) return;
    // Wave line.
    let wave: string;
    if (f.phase === Phase.Build) wave = `Wave ${f.wave + 1} in <span class="phase">${Math.ceil(f.phaseLeft / 10)}s</span>`;
    else if (f.phase === Phase.Wave) wave = `Wave ${f.wave} · <span class="phase">${fmtGold(f.pending + f.nCreeps)}</span> creeps left`;
    else wave = `Game over · survived ${f.best} waves`;
    if (this.top.wave.innerHTML !== wave) this.top.wave.innerHTML = wave;
    setText(this.top.kills, `${fmtGold(f.totalKills)} kills`);
    const build = f.phase === Phase.Build;
    show(this.top.ready, build);
    show(this.top.readies, build);
    setClass(this.top.ready, 'on', !!me && (me.flags & PF_READY) !== 0);
    if (build) {
      let dots = '';
      for (let i = 0; i < f.nPlayers; i++) {
        const p = f.players[i];
        dots += `<span class="${p.flags & PF_READY ? 'on' : ''}" style="background:${cssHex(playerColor(p.id))};color:${cssHex(playerColor(p.id))}" title="${esc(p.name)}"></span>`;
      }
      if (this.top.readies.innerHTML !== dots) this.top.readies.innerHTML = dots;
    }

    if (me) this.updateHero(me, wd, now);
    this.updateCard();
    this.updateMode();
    this.armory.update();
    if (this.tipFor && now - this.lastSec > 250) { this.tip.innerHTML = this.tipFor(); this.lastSec = now; }
    if (!this.score.classList.contains('hidden') && Math.floor(now / 500) !== Math.floor((now - 17) / 500)) this.renderScore();

    // Game over screen.
    const isOver = f.phase === Phase.Over;
    show(this.over, isOver);
    if (isOver && !this.over.dataset.shown) {
      this.over.dataset.shown = '1';
      this.over.innerHTML = `<h1>The generator has fallen</h1><div class="big">You survived <b class="gold">${f.best}</b> waves · ${fmtGold(f.totalKills)} kills</div><div class="row"></div>`;
      const row = this.over.querySelector('.row') as HTMLElement;
      const rs = el('button', 'primary', row, 'Restart');
      rs.onclick = () => ctl.send({ op: 'restart' });
      const sc = el('button', '', row, 'Scoreboard');
      sc.onclick = () => this.showScore(this.score.classList.contains('hidden'));
      const lv = el('button', '', row, 'Leave');
      lv.onclick = () => ctl.send({ op: 'leave' });
    }
    if (!isOver) delete this.over.dataset.shown;
  }

  private updateHero(me: NonNullable<ReturnType<Controller['me']>>, wd: NonNullable<Controller['game']['welcome']>, now: number): void {
    const h = this.hero;
    const alive = (me.flags & PF_ALIVE) !== 0;
    h.portrait.style.setProperty('--pc', cssHex(playerColor(me.id)));
    setClass(h.portrait, 'dead', !alive);
    setText(h.resp, alive ? '' : `${me.respawn}`);
    setText(h.name, me.name);
    setText(h.gold, `${fmtGold(me.gold)} gold`);
    const frac = me.hp / Math.max(1, me.maxHp);
    h.hp.style.transform = `scaleX(${frac})`;
    h.hp.style.background = frac > 0.5 ? '' : frac > 0.25 ? 'linear-gradient(#f0d060,#b09020)' : 'linear-gradient(#ff6a50,#b02a18)';
    setText(h.hpTxt, `${me.hp} / ${me.maxHp}`);
    const w = wd.weapons[me.cur];
    setText(h.weapon, w ? w.name : '');
    const reloading = (me.flags & PF_RELOADING) !== 0;
    setClass(h.ammoBar, 'reload', reloading);
    h.ammo.style.transform = `scaleX(${reloading ? 1 - me.reload : me.ammo / Math.max(1, me.mag)})`;
    setText(h.ammoTxt, reloading ? 'reloading…' : `${me.ammo} / ${me.mag}`);
    setText(h.order, alive ? ORDER[me.order] ?? '' : `respawning in ${me.respawn}s`);
    setText(h.buff, me.buff && me.buffLeft > 0 ? `${wd.weapons[me.buff]?.sig.name ?? 'buff'} · ${me.buffLeft.toFixed(1)}s` : '');

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
      const left = Math.max(0, a.left - (now - this.ctl.game.frameAt) / 1000);
      const deg = a.cool > 0 && left >= 0.05 ? Math.min(360, (left / a.cool) * 360) : 0;
      s.cool.style.setProperty('--a', `${deg.toFixed(1)}deg`);
      setText(s.coolTxt, left >= 0.05 ? (left < 10 ? left.toFixed(1) : String(Math.ceil(left))) : '');
    }
    for (let i = 0; i < 7; i++) {
      const e = this.wslots[i], w2 = wd.weapons[i];
      show(e, !!w2);
      if (!w2) continue;
      setClass(e, 'owned', (me.owned & (1 << i)) !== 0);
      setClass(e, 'cur', me.cur === i);
      setText(e.children[1] as HTMLElement, w2.short);
    }
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
    else if (s?.t === 'hero') { const p = f.player(s.id); key = `h:${s.id}:${p?.hp}:${p?.cur}:${p?.kills}`; }
    else key = 'none';
    if (key === this.cardKey) return;
    this.cardKey = key;
    const c = this.card;
    c.innerHTML = '';
    const gold = me ? me.gold : 0;
    if (this.buildCard) {
      const h = el('h3', '', c); h.innerHTML = 'Build <span class="muted" style="font-weight:400;font-size:11px">B closes</span>';
      const grid = el('div', 'grid', c);
      for (const k of wd.buildable) {
        const d = wd.structs[k];
        const b = el('button', ctl.mode.k === 'build' && ctl.mode.kind === k ? 'sel' : '', grid);
        b.innerHTML = `${esc(d.name)}<span class="p">${d.price}g</span><span class="k">${esc(d.key)}</span>`;
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
      const h = el('h3', '', c); h.innerHTML = `${esc(d?.name ?? '?')} <span class="muted" style="font-weight:400">${esc(owner)}</span>`;
      el('div', 'sub', c, `HP ${f.sHp[id]} / ${f.sMaxHp[id]}${d?.turret ? ` · level ${f.sLevel[id]}/${wd.maxStructLevel} · range ${turretRange(d, f.sLevel[id]).toFixed(1).replace(/\.0$/, '')}` : ''}`);
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
        const rp = el('button', '', btns); rp.innerHTML = `Repair <span class="gold">~${cost}g</span> <kbd>F</kbd>`;
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
      el('h3', '', c, d ? d.name[0].toUpperCase() + d.name.slice(1) : 'creep');
      if (d && i >= 0) {
        const fl = f.cFlags[i];
        el('div', 'sub', c, `HP ~${Math.round(f.cHp[i] / 255 * 100)}% · base HP ${d.hp} · speed ${d.speed}${d.ranged ? ' · ranged' : ''}`);
        el('div', 'sub', c, `bounty ${d.bounty}g${fl & 1 ? ' · burning' : ''}${fl & 2 ? ' · slowed' : ''}`);
        const btns = el('div', 'btns', c);
        const at = el('button', 'primary', btns, 'Attack');
        at.onclick = () => ctl.send({ op: 'attack', id: s.id });
      }
      return;
    }
    if (s?.t === 'hero') {
      const p = f.player(s.id);
      if (!p) return;
      const h = el('h3', '', c); h.innerHTML = `<span style="color:${cssHex(playerColor(p.id))}">${esc(p.name)}</span>`;
      el('div', 'sub', c, `HP ${p.hp} / ${p.maxHp} · ${wd.weapons[p.cur]?.name ?? ''}`);
      el('div', 'sub', c, `${p.kills} kills · ${fmtGold(p.damage)} damage · ${ORDER[p.order] ?? ''}`);
      return;
    }
    el('h3', '', c, 'Commands');
    const btns = el('div', 'btns', c);
    const b1 = el('button', '', btns); b1.innerHTML = 'Build <kbd>B</kbd>'; b1.onclick = () => { this.buildCard = true; };
    const b2 = el('button', '', btns); b2.innerHTML = 'Armory <kbd>G</kbd>'; b2.onclick = () => ctl.openArmory(true);
    const b3 = el('button', '', btns); b3.innerHTML = 'Stop <kbd>S</kbd>'; b3.onclick = () => ctl.send({ op: 'stop' });
    const b4 = el('button', '', btns); b4.innerHTML = 'Hold <kbd>H</kbd>'; b4.onclick = () => ctl.send({ op: 'hold' });
    el('div', 'hint', c, 'Right-click to move or attack · A attack-move · F1 for all controls');
  }

  private updateMode(): void {
    const m = this.ctl.mode;
    let s = '';
    if (m.k === 'amove') s = 'Attack-move: left-click a point · Esc cancels';
    else if (m.k === 'ability') { const a = this.ctl.ability(m.slot); s = `${a?.name ?? 'Ability'}: left-click a target · right-click or Esc cancels`; }
    else if (m.k === 'build') { const d = this.ctl.game.welcome?.structs[m.kind]; s = `Place ${d?.name ?? ''} (${d?.price ?? 0}g): left-click · Shift keeps placing · Esc cancels`; }
    show(this.modeEl, s !== '');
    setText(this.modeEl, s);
  }
}
