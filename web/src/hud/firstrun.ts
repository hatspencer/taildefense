import { el, show } from './dom';
import { focusFirst } from './nav';

// The first steps: four lines for a first game, what to keep alive and the few keys to do
// it with, shown once on a new machine and again from the menu. Everything else is in F1.

const SEEN = 'td.firstrun';

export function firstRunSeen(): boolean {
  try { return localStorage.getItem(SEEN) === '1'; } catch { return true; }
}

export class FirstRun {
  root: HTMLElement;

  constructor(parent: HTMLElement, onControls: () => void) {
    const r = el('div', 'window panel firstrun hidden', parent);
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', 'First steps');
    r.innerHTML = `<h2><span class="tape">First steps</span></h2>
      <ol>
        <li><b>Keep the generator standing.</b><span>The dead come in waves for the machine in the middle of the base. If it falls, the game is over.</span></li>
        <li><b>Walk with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>.</b><span>You shoot the nearest creep on your own; <kbd>Q</kbd> fires the weapon's ultimate when its meter fills.</span></li>
        <li><b>Between waves, build and shop.</b><span><kbd>B</kbd> walls and turrets, <kbd>C</kbd> the armory, <kbd>Y</kbd> when you are ready for the next wave.</span></li>
        <li><b><kbd>E</kbd> uses what is beside you.</b><span>Revive a downed teammate, search a wreck or a house for loot, pick up a weapon.</span></li>
      </ol>
      <div class="row"></div>`;
    const row = r.querySelector('.row') as HTMLElement;
    const ok = el('button', 'primary', row);
    ok.innerHTML = 'Got it <kbd>Enter</kbd>';
    ok.onclick = () => this.close();
    const all = el('button', '', row, 'All controls (F1)');
    all.onclick = () => { this.close(); onControls(); };
    this.root = r;
  }

  open(): void { show(this.root, true); setTimeout(() => focusFirst(this.root), 0); }

  // Closed is seen: it does not come back on its own.
  close(): void {
    show(this.root, false);
    try { localStorage.setItem(SEEN, '1'); } catch { /* storage blocked */ }
  }

  get visible(): boolean { return !this.root.classList.contains('hidden'); }
}
