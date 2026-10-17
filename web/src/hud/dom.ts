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

// Makes `to` match `from` (attributes, click handlers, children) while keeping the elements it
// already has, so a redraw does not swap out a button under a press and swallow its click.
export function patch(to: HTMLElement, from: HTMLElement): void {
  for (const a of Array.from(to.attributes)) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
  for (const a of Array.from(from.attributes)) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
  to.onclick = from.onclick;
  const old = to.childNodes, now = Array.from(from.childNodes);
  for (let i = 0; i < now.length; i++) {
    const o = old[i], n = now[i];
    if (!o) to.appendChild(n);
    else if (o.nodeName !== n.nodeName) to.replaceChild(n, o);
    else if (n instanceof HTMLElement) patch(o as HTMLElement, n);
    else if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
  }
  while (old.length > now.length) to.lastChild!.remove();
}
