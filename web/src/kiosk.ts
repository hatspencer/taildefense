// The browser kept out of the game's way: its own shortcuts (save, print, find, zoom, reload,
// history, DevTools…), the right-click menu, the mouse's back button and Ctrl+wheel zoom do
// nothing on the page, and leaving a running game asks first. Keys the browser keeps for
// itself (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Cmd+Q) never reach a page; the leave prompt is what
// catches those. The game's own keys still arrive: this only cancels the browser's default.

// Ctrl or Cmd with these is clipboard and undo, for the chat line and anything else; in a text
// field, with these it moves and deletes by word too.
const EDITING = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY']);
const WORDS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End']);

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

// browserKey is a key press the browser would act on: Ctrl or Cmd with anything but editing,
// Alt with an arrow (back and forward), and every function key but F11, which is the
// player's way in and out of full screen.
function browserKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey) {
    if (e.shiftKey && e.code === 'KeyC') return true; // the inspector
    return !EDITING.has(e.code) && !(typing(e.target) && WORDS.has(e.key));
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home')) return true;
  return /^F\d+$/.test(e.key) && e.key !== 'F11';
}

export class Kiosk {
  // armed: leaving the page asks first. On while connected to a game, off once it has ended
  // and before the page reloads itself.
  armed = false;

  constructor() {
    window.addEventListener('keydown', (e) => { if (browserKey(e)) e.preventDefault(); }, { capture: true });
    // A lone Alt shows the menu bar in Firefox when let go.
    window.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); }, { capture: true });
    window.addEventListener('contextmenu', (e) => { if (!typing(e.target)) e.preventDefault(); }, { capture: true });
    // The mouse's back and forward buttons navigate on release.
    const side = (e: MouseEvent) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
    window.addEventListener('mousedown', side, { capture: true });
    window.addEventListener('mouseup', side, { capture: true });
    // Ctrl+wheel, and a touchpad pinch, which arrives as one, zoom the page.
    window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { capture: true, passive: false });
    window.addEventListener('beforeunload', (e) => {
      if (!this.armed) return;
      e.preventDefault();
      e.returnValue = ''; // older Chromium and Safari ask only when this is set
    });
  }
}
