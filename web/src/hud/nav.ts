// Moving through a window's buttons without the mouse: the arrow keys and Tab step through
// them, Enter and Space press the one in focus, and a controller does the same with its
// d-pad or left stick, A to press, B to go back and Start for the menu. Only the windows
// (the menu, the controls, the first steps, the field report) take it; the game itself is
// played on the keyboard and mouse.

const FOCUSABLE = 'button:not(:disabled):not(.hidden), input:not(:disabled), [tabindex="0"]';

function items(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e.offsetParent !== null);
}

// Moves the focus by step within root, round from the end; nothing in focus yet starts at the first.
export function step(root: HTMLElement, by: number): void {
  const list = items(root);
  if (!list.length) return;
  const i = list.indexOf(document.activeElement as HTMLElement);
  const n = i < 0 ? (by > 0 ? 0 : list.length - 1) : (i + by + list.length) % list.length;
  list[n].focus({ preventScroll: false });
}

// The first button in root, in focus: what a window opens with.
export function focusFirst(root: HTMLElement): void {
  const first = root.querySelector<HTMLElement>('button.primary:not(:disabled)') ?? items(root)[0];
  first?.focus({ preventScroll: true });
}

// A key for the window root, the topmost open; true when it was the window's. A range input in
// focus keeps Left and Right for its own value.
export function navKey(e: KeyboardEvent, root: HTMLElement): boolean {
  const a = document.activeElement as HTMLElement | null;
  const inside = !!a && root.contains(a);
  const slider = inside && a instanceof HTMLInputElement && a.type === 'range';
  switch (e.key) {
    case 'ArrowDown': step(root, 1); break;
    case 'ArrowUp': step(root, -1); break;
    case 'ArrowRight': case 'ArrowLeft':
      if (slider) return true; // the browser moves the slider
      step(root, e.key === 'ArrowRight' ? 1 : -1); break;
    case 'Tab': step(root, e.shiftKey ? -1 : 1); break;
    case 'Enter': case ' ':
      if (!inside || slider) { if (!inside) focusFirst(root); break; }
      a!.click(); break;
    default: return false;
  }
  e.preventDefault();
  return true;
}

// The controller: pressed edges of the buttons the windows use, read once a frame.
export interface PadPress { up: boolean; down: boolean; ok: boolean; back: boolean; menu: boolean }

export class Pad {
  private was = 0;
  private stickAt = 0;

  poll(now: number): PadPress | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    let held = 0;
    let y = 0;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const b = (i: number) => (p.buttons[i]?.pressed ? 1 : 0);
      held |= b(12) << 0 | b(13) << 1 | b(0) << 2 | b(1) << 3 | b(9) << 4 | b(14) << 0 | b(15) << 1;
      if (Math.abs(p.axes[1] ?? 0) > Math.abs(y)) y = p.axes[1] ?? 0;
    }
    const edge = held & ~this.was;
    this.was = held;
    // The stick repeats while held, a step every 220 ms.
    let su = false, sd = false;
    if (Math.abs(y) > 0.6) {
      if (now - this.stickAt > 220) { this.stickAt = now; su = y < 0; sd = y > 0; }
    } else this.stickAt = 0;
    if (!edge && !su && !sd) return null;
    return { up: !!(edge & 1) || su, down: !!(edge & 2) || sd, ok: !!(edge & 4), back: !!(edge & 8), menu: !!(edge & 16) };
  }
}
