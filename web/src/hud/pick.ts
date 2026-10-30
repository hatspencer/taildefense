import type { Controller } from '../controller';
import { OWNED_PICKING, type Player, type Welcome } from '../protocol';
import { el, esc, show } from './dom';
import { focusFirst } from './nav';

// A blades game's first choice: the crowbar, the katana or the greatsword, each with what it
// does on a swing, on F and on Q. It stays up until one is picked; 1, 2 and 3 pick too.
export class BladePick {
  root: HTMLElement;
  private built = false;

  constructor(parent: HTMLElement, private ctl: Controller) {
    const r = el('div', 'window panel pick hidden', parent);
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', 'Choose your blade');
    r.onkeydown = (e) => {
      const i = Number(e.key) - 1, k = this.ctl.game.welcome?.startBlades?.[i];
      if (k !== undefined) { e.preventDefault(); e.stopPropagation(); this.pick(k); }
    };
    this.root = r;
  }

  private build(wd: Welcome): void {
    this.built = true;
    this.root.innerHTML = `<h2><span class="tape">Choose your blade</span></h2>
      <p class="muted">No guns in this game. What you start with is yours; the rest is found.</p><div class="cards"></div>`;
    const cards = this.root.querySelector('.cards') as HTMLElement;
    (wd.startBlades ?? []).forEach((k, i) => {
      const w = wd.weapons[k];
      if (!w) return;
      const b = el('button', `card${w.legend ? ' legend' : ''}`, cards);
      b.innerHTML = `<kbd>${i + 1}</kbd><b class="wname">${esc(w.name)}</b>
        <span class="muted small">${w.legend ? 'legendary · ' : ''}reach ${w.range} · ${esc(w.special)}</span>
        <span><b>F</b> ${esc(w.art?.name ?? '')}: ${esc(w.art?.desc ?? '')}</span>
        <span><b>Q</b> ${esc(w.ult.name)}: ${esc(w.ult.desc)}</span>
        <span class="muted small">evolves into ${(w.evolve ?? []).map((e) => esc(e.name)).join(' or ')}</span>`;
      b.onclick = () => this.pick(k);
    });
  }

  private pick(k: number): void { this.ctl.send({ op: 'pickBlade', w: k }); }

  update(wd: Welcome, me: Player | undefined): void {
    const on = wd.mode === 'blades' && !!me && (me.owned & OWNED_PICKING) !== 0;
    if (on && !this.built) this.build(wd);
    if (on === this.visible) return;
    show(this.root, on);
    if (on) setTimeout(() => focusFirst(this.root), 0);
  }

  get visible(): boolean { return !this.root.classList.contains('hidden'); }
}
