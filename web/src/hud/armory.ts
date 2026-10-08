import type { Controller } from '../controller';
import { PF_ARMORY } from '../protocol';
import { el, esc, fmtGold, show } from './dom';

type Tab = 'weapons' | 'gear' | 'abilities';

// The armory window: weapons and their upgrade tracks, gear, and abilities W E R.
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
    this.title = el('span', '', h, 'Armory');
    const x = el('button', 'x', h, 'Close');
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
    show(this.root, ctl.armoryOpen && !!me && !!wd);
    if (!ctl.armoryOpen || !me || !wd) return;
    const at = (me.flags & PF_ARMORY) !== 0;
    const key = [this.tab, at, Math.floor(me.gold), me.owned, me.cur, me.levels.join(','), me.gear.join(','), me.abLevel.join(',')].join('|');
    if (key === this.key) return;
    this.key = key;
    for (const [t, b] of this.tabs) b.classList.toggle('on', t === this.tab);
    this.title.innerHTML = `Armory <span class="gold" style="font-size:14px">${fmtGold(me.gold)} gold</span>`;
    const b = this.body;
    b.innerHTML = '';
    if (!at) {
      const away = el('div', 'away', b);
      el('span', '', away, 'Walk to the armory to buy and upgrade. You can browse from here.');
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
        const tr = el('tr', '', t);
        const n = el('td', '', tr);
        n.innerHTML = `<span class="wname">${esc(w.name)}</span> <kbd>${wi + 1}</kbd><br><span class="muted" style="font-size:11px">${esc(w.fire)} · range ${w.range} · Q: ${esc(w.sig.name)}</span>`;
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
    } else {
      const t = el('table', '', b);
      t.innerHTML = '<tr><th>Key</th><th>Ability</th><th>Level</th><th></th></tr>';
      wd.abilities.forEach((a, si) => {
        const tr = el('tr', '', t);
        el('td', '', tr).innerHTML = `<kbd>${esc(a.key)}</kbd>`;
        if (si === 0) {
          const sig = wd.weapons[me.cur]?.sig;
          el('td', '', tr).innerHTML = `<span class="wname">${esc(sig?.name ?? a.name)}</span><br><span class="muted">${esc(sig?.desc ?? a.desc)} · changes with the equipped weapon</span>`;
          el('td', 'muted', tr, 'always');
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
}
