import type { Controller } from '../controller';
import { CROWBAR, PF_ARMORY, Phase, weaponKey, type Player, type WeaponDef } from '../protocol';
import { el, esc, fmtGold, show } from './dom';

type Tab = 'weapons' | 'gear' | 'abilities';

// The armory window: weapons and their upgrade tracks, gear and medkits, and abilities.
export class Armory {
  private root: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private tab: Tab = 'weapons';
  private key = '';
  private tabs = new Map<Tab, HTMLButtonElement>();

  constructor(parent: HTMLElement, private ctl: Controller) {
    this.root = el('div', 'window panel armory hidden', parent);
    const h = el('h2', '', this.root);
    this.title = el('span', '', h);
    const x = el('button', 'x', h);
    x.innerHTML = 'Close <kbd>C</kbd>';
    x.onclick = () => ctl.openArmory(false);
    const tabs = el('div', 'tabs', this.root);
    for (const t of ['weapons', 'gear', 'abilities'] as Tab[]) {
      const b = el('button', '', tabs, t[0].toUpperCase() + t.slice(1));
      b.onclick = () => { this.tab = t; this.key = ''; };
      this.tabs.set(t, b);
    }
    this.body = el('div', '', this.root);
  }

  isOpen(): boolean { return !this.root.classList.contains('hidden'); }

  update(): void {
    const ctl = this.ctl, me = ctl.me(), wd = ctl.game.welcome;
    const open = ctl.armoryOpen && !!me && !!wd && ctl.game.cur.phase !== Phase.Over;
    show(this.root, open);
    if (!open || !me || !wd) return;
    const at = (me.flags & PF_ARMORY) !== 0;
    const key = [this.tab, at, Math.floor(me.gold), me.owned, me.cur, me.levels.join(','), me.evo.join(','), me.gear.join(','), me.abLevel.join(','), me.medkits].join('|');
    if (key === this.key) return;
    this.key = key;
    for (const [t, b] of this.tabs) b.classList.toggle('on', t === this.tab);
    this.title.innerHTML = `<span class="tape">Armory</span><span class="wallet crt">${fmtGold(me.gold)}g</span>`;
    this.title.style.display = 'contents';
    const b = this.body;
    b.innerHTML = '';
    if (!at) {
      const away = el('div', 'away', b);
      el('span', '', away, 'You are away from the armory. Browse from here, then walk over to buy and upgrade.');
      const go = el('button', 'primary', away, 'Walk there');
      go.onclick = () => ctl.walkToArmory();
    }
    const gold = me.gold;
    const btn = (parent: HTMLElement, html: string, cost: number, ok: boolean, onclick: () => void, cls = '') => {
      const e = el('button', cls, parent);
      e.innerHTML = html;
      e.disabled = !ok || !at || gold < cost;
      e.onclick = onclick;
      return e;
    };
    const pips = (n: number, max: number) => `<span class="pips">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;

    if (this.tab === 'weapons') {
      const t = el('table', '', b);
      t.innerHTML = `<tr><th>Weapon</th><th></th>${wd.tracks.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>`;
      wd.weapons.forEach((w, wi) => {
        const owned = (me.owned & (1 << wi)) !== 0;
        if ((wi === CROWBAR || w.legend) && !owned) return; // never sold
        if (this.ctl.game.welcome?.mode === 'blades' && w.fire !== 'melee') return; // no guns
        const tr = el('tr', w.legend ? 'legend' : '', t);
        const n = el('td', '', tr);
        n.innerHTML = w.legend
          ? `<span class="wname">${esc(w.name)}</span> <kbd>${weaponKey(wi)}</kbd><br><span class="muted small">legendary · reach ${w.range} · F: ${esc(w.art?.name ?? '')} · Q: ${esc(w.ult.name)}</span>`
          : `<span class="wname">${esc(w.name)}</span> <kbd>${weaponKey(wi)}</kbd><br><span class="muted small">${esc(w.fire)} · range ${w.range}${w.art ? ` · F: ${esc(w.art.name)}` : ''} · Q: ${esc(w.ult.name)}</span>`;
        const act = el('td', '', tr);
        if (!owned) btn(act, `Buy <span class="gold">${fmtGold(w.price)}g</span>`, w.price, true, () => ctl.send({ op: 'buyWeapon', w: wi }), 'primary');
        else if (me.cur === wi) el('span', 'muted', act, 'equipped');
        else { const e = el('button', '', act, 'Equip'); e.onclick = () => ctl.send({ op: 'select', w: wi }); }
        for (let track = 0; track < wd.tracks.length; track++) {
          const td = el('td', '', tr);
          const lvl = me.levels[wi * 4 + track];
          const max = lvl >= wd.maxLevel;
          const cost = w.costs[track]?.[lvl] ?? 0;
          const cur = w.values[track]?.[lvl] ?? '';
          const next = w.values[track]?.[lvl + 1] ?? '';
          const html = max
            ? `<span class="v">${esc(cur)}</span>max ${pips(lvl, wd.maxLevel)}`
            : `<span class="v">${esc(cur)} → ${esc(next)}</span><span class="c">${fmtGold(cost)}g</span> ${pips(lvl, wd.maxLevel)}`;
          btn(td, html, cost, owned && !max, () => ctl.send({ op: 'upgrade', w: wi, track }), 'up');
        }
        if (w.evolve) this.legendEvo(t, w, wi, me, btn);
      });
    } else if (this.tab === 'gear') {
      const t = el('table', '', b);
      t.innerHTML = '<tr><th>Gear</th><th>Each level</th><th>Level</th><th></th></tr>';
      wd.gear.forEach((g, gi) => {
        const lvl = me.gear[gi], max = lvl >= wd.maxLevel, cost = g.costs[lvl] ?? 0;
        const tr = el('tr', '', t);
        el('td', 'wname', tr, g.name);
        el('td', '', tr, g.info);
        el('td', '', tr).innerHTML = `${lvl}/${wd.maxLevel} ${pips(lvl, wd.maxLevel)}`;
        btn(el('td', '', tr), max ? 'max' : `Buy <span class="gold">${fmtGold(cost)}g</span>`, cost, !max, () => ctl.send({ op: 'gear', g: gi }), 'primary');
      });
      const m = wd.medkit;
      if (m) {
        const tr = el('tr', '', t), full = me.medkits >= m.max;
        el('td', 'wname', tr).innerHTML = 'Medkit <kbd>1</kbd>';
        el('td', '', tr, `+${Math.round(m.heal * 100)}% HP over ${m.time}s; a hit cuts it short`);
        el('td', '', tr).innerHTML = `${me.medkits}/${m.max} ${pips(me.medkits, m.max)}`;
        btn(el('td', '', tr), full ? 'full' : `Buy <span class="gold">${fmtGold(m.cost)}g</span>`, m.cost, !full, () => ctl.send({ op: 'buyMedkit' }), 'primary');
      }
      // Only where there is a night to see through.
      if (wd.goggles && wd.dark) {
        const tr = el('tr', '', t);
        el('td', 'wname', tr, 'Night vision goggles');
        el('td', '', tr, 'see as far by night as by day; worn instead of the flashlight');
        el('td', '', tr, me.goggles ? 'worn' : '');
        btn(el('td', '', tr), me.goggles ? 'worn' : `Buy <span class="gold">${fmtGold(wd.goggles)}g</span>`, wd.goggles, !me.goggles, () => ctl.send({ op: 'buyGoggles' }), 'primary');
      }
    } else {
      const t = el('table', '', b);
      t.innerHTML = '<tr><th>Key</th><th>Ability</th><th>Level</th><th></th></tr>';
      wd.abilities.forEach((a, si) => {
        const tr = el('tr', '', t);
        el('td', '', tr).innerHTML = `<kbd>${esc(a.key)}</kbd>`;
        if (si === 0) {
          const u = wd.weapons[me.cur]?.ult;
          el('td', '', tr).innerHTML = `<span class="wname">${esc(u?.name ?? a.name)}</span><br><span class="muted">${esc(u?.desc ?? a.desc)} · the equipped weapon's ultimate; fighting fills its meter</span>`;
          el('td', 'muted', tr, `${Math.floor(me.ult * 100)}%`);
          el('td', '', tr);
          return;
        }
        const lvl = me.abLevel[si], max = lvl >= a.costs.length, cost = a.costs[lvl] ?? 0;
        el('td', '', tr).innerHTML = `<span class="wname">${esc(a.name)}</span><br><span class="muted">${esc(a.desc)} · range ${a.range} · cooldown ${a.cool.join('/')}s</span>`;
        el('td', '', tr).innerHTML = `${lvl}/${a.costs.length} ${pips(lvl, a.costs.length)}`;
        btn(el('td', '', tr), max ? 'max' : `${lvl ? 'Upgrade' : 'Learn'} <span class="gold">${fmtGold(cost)}g</span>`, cost, !max, () => ctl.send({ op: 'buyAbility', slot: si }), 'primary');
      });
    }
  }

  // A blade's evolution row (a legendary's or the crowbar's): its two branches once its tracks
  // add up to evolveAt, or the one it took.
  private legendEvo(t: HTMLElement, w: WeaponDef, wi: number, me: Player,
    btn: (parent: HTMLElement, html: string, cost: number, ok: boolean, onclick: () => void, cls?: string) => HTMLButtonElement): void {
    const at = this.ctl.game.welcome?.tiers?.evolveAt ?? 12, evo = me.evo[wi];
    const tr = el('tr', 'legend evo', t);
    el('td', 'muted small', tr, evo ? 'evolved' : 'evolve');
    const td = el('td', '', tr);
    td.colSpan = 1 + (this.ctl.game.welcome?.tracks.length ?? 4);
    if (evo) {
      const e = w.evolve![evo - 1];
      td.innerHTML = `<b class="legend">${esc(e.name)}</b> <span class="muted small">${esc(e.desc)}</span>`;
      return;
    }
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += me.levels[wi * 4 + k];
    const cost = w.evoCost ?? 0;
    w.evolve!.forEach((e, k) => {
      btn(td, `<b>${esc(e.name)}</b> <span class="c">${fmtGold(cost)}g</span><br><span class="muted small">${esc(e.desc)}</span>`, cost, sum >= at,
        () => this.ctl.send({ op: 'evolveWeapon', w: wi, branch: k + 1 }), 'up evolve');
    });
    if (sum < at) el('div', 'muted small', td, `Evolves once its tracks add up to ${at} (${sum} now).`);
  }
}
