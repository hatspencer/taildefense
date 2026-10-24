// Types only: demo.js must not carry a second copy of the sound engine and its recordings.
import type { Sound } from './sound/sound';
import type { Layers } from './sound/synth';

// #lab=sound: the sound bench. Every recipe in the bank and every set of recordings, listed as
// the engine has them, so a new recipe or a new category of recordings shows up here without
// a line changed. Click a name or press Enter to play it as the game would; s, r and b (or the
// buttons) play the recipe alone, the recording alone and both. At the level sound.ts plays it
// at (LOUD, else 0.6), through the master volume, set by the slider. Up and down move, typing
// in the box filters.

const CSS = `
.sndlab{position:fixed;top:12px;right:12px;bottom:12px;width:430px;z-index:60;display:flex;flex-direction:column;
  background:rgba(14,16,12,.94);color:#d8dcc4;border:1px solid #4a5038;font:12px 'Fira Code',ui-monospace,monospace}
.sndlab header{padding:8px 10px;border-bottom:1px solid #4a5038;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sndlab header b{font-weight:600;letter-spacing:.06em}
.sndlab input[type=search]{flex:1;min-width:120px;background:#1e2218;color:inherit;border:1px solid #4a5038;padding:3px 6px;font:inherit}
.sndlab .note{width:100%;color:#9aa184}
.sndlab ul{list-style:none;margin:0;padding:0;overflow:auto;flex:1}
.sndlab li{display:flex;align-items:center;gap:6px;padding:2px 10px;cursor:pointer}
.sndlab li[hidden]{display:none}
.sndlab li:hover,.sndlab li.sel{background:#2a3020}
.sndlab li .n{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sndlab li .t{color:#9aa184;font-size:11px}
.sndlab button{background:#262b1d;color:inherit;border:1px solid #4a5038;font:inherit;padding:1px 6px;cursor:pointer}
.sndlab button:hover,.sndlab button:focus-visible{border-color:#c8b46a;outline:none}
.sndlab button:disabled{opacity:.35;cursor:default}
.sndlab h3{margin:8px 10px 2px;font-size:11px;font-weight:600;color:#c8b46a;letter-spacing:.08em}
`;

interface Row { name: string; el: HTMLLIElement; sample: boolean }

export class SoundLab {
  private rows: Row[] = [];
  private sel = 0;
  private status: HTMLElement;
  private vol: HTMLInputElement;
  private volN: HTMLElement;

  constructor(private sound: Sound, parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const root = document.createElement('section');
    root.className = 'sndlab';
    root.setAttribute('aria-label', 'Sound lab');
    const head = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = 'SOUND LAB';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'filter';
    filter.setAttribute('aria-label', 'Filter sounds');
    const vol = this.vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = String(sound.synth.volume || 70);
    vol.setAttribute('aria-label', 'Volume');
    const volN = this.volN = document.createElement('span');
    volN.textContent = vol.value;
    vol.oninput = () => { sound.synth.setVolume(Number(vol.value)); volN.textContent = vol.value; };
    this.status = document.createElement('div');
    this.status.className = 'note';
    head.append(title, filter, vol, volN, this.status);
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    root.append(head, list);
    parent.append(root);

    const sets = new Map(sound.synth.samples().map((s) => [s.name, s]));
    const section = (label: string) => { const h = document.createElement('h3'); h.textContent = label; list.append(h); };
    const add = (name: string, tag: string) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      const n = document.createElement('span');
      n.className = 'n'; n.textContent = name;
      const t = document.createElement('span');
      t.className = 't'; t.textContent = tag;
      const sample = sets.has(name);
      const btn = (label: string, layers: Layers, on: boolean, hint: string) => {
        const b = document.createElement('button');
        b.textContent = label; b.disabled = !on; b.title = hint;
        b.onclick = (e) => { e.stopPropagation(); this.select(this.rows.indexOf(row)); this.play(name, layers); };
        return b;
      };
      li.append(n, t, btn('synth', 'synth', true, 'the recipe alone (s)'), btn('rec', 'sample', sample, 'the recording alone (r)'), btn('both', 'both', sample, 'both at once (b)'));
      const row: Row = { name, el: li, sample };
      li.onclick = () => { this.select(this.rows.indexOf(row)); this.play(name, 'auto'); };
      list.append(li);
      this.rows.push(row);
    };
    if (sets.size) section('RECORDINGS');
    for (const s of sets.values()) add(s.name, `${s.takes} take${s.takes === 1 ? '' : 's'} ${s.mode}`);
    section('RECIPES');
    for (const name of sound.synth.recipes()) add(name, sets.has(name) ? 'recorded' : '');

    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of this.rows) r.el.hidden = !!q && !r.name.toLowerCase().includes(q);
      this.select(this.rows.findIndex((r) => !r.el.hidden));
    };
    // Keys are the bench's while it is up, wherever the focus is: the game's own are not for it.
    // (Sound's own listener, which starts the sound, was added first and still hears them.)
    window.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const r = this.rows[this.sel];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.target === filter && e.key !== 'Enter') return;
      else if (!r) return;
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.play(r.name, 'auto'); }
      else if (e.key === 's') this.play(r.name, 'synth');
      else if (e.key === 'r' && r.sample) this.play(r.name, 'sample');
      else if (e.key === 'b' && r.sample) this.play(r.name, 'both');
    }, true);
    window.addEventListener('keyup', (e) => e.stopPropagation(), true);
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.select(0);
    filter.focus();
    setInterval(() => this.tick(), 500);
  }

  private move(d: number): void {
    for (let i = this.sel + d; i >= 0 && i < this.rows.length; i += d) if (!this.rows[i].el.hidden) { this.select(i); return; }
  }

  private select(i: number): void {
    this.rows[this.sel]?.el.classList.remove('sel');
    this.rows[this.sel]?.el.setAttribute('aria-selected', 'false');
    this.sel = Math.max(0, i);
    const r = this.rows[this.sel];
    if (!r) return;
    r.el.classList.add('sel');
    r.el.setAttribute('aria-selected', 'true');
    r.el.scrollIntoView({ block: 'nearest' });
  }

  // play waits for the sound to start (the click that asked for it is the one that starts it).
  private play(name: string, layers: Layers, tries = 20): void {
    const s = this.sound.synth;
    if (!s.ready) {
      if (tries > 0) setTimeout(() => this.play(name, layers, tries - 1), 50);
      return;
    }
    this.sound.audition(name, layers);
  }

  private tick(): void {
    const s = this.sound.synth, sets = s.samples();
    // The game sets the volume after the bench is up: follow it unless the slider is in hand.
    if (document.activeElement !== this.vol && this.vol.value !== String(s.volume)) { this.vol.value = String(s.volume); this.volN.textContent = this.vol.value; }
    const ready = sets.filter((x) => x.state === 'ready').length, failed = sets.filter((x) => x.state === 'failed').length;
    this.status.textContent = !s.ctx ? 'click or press a key to start the sound'
      : `${s.recipes().length} recipes, ${sets.length} recorded: ${ready} decoded${failed ? `, ${failed} failed (their recipes play)` : ''}  volume ${s.volume}`;
  }
}
