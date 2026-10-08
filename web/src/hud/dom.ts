export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

// Sets text only when it changed, so per-frame HUD updates do not touch the layout.
export function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

export function setClass(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

export function show(e: HTMLElement, on: boolean): void { setClass(e, 'hidden', !on); }

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function fmtGold(n: number): string { return Math.floor(n).toLocaleString('en-US'); }
