import { render } from './bank';

// The sound bank's renderer, off the main thread: making a sound takes from a few to a few
// tens of milliseconds, which on the page's thread would be frames dropped.
self.onmessage = (e: MessageEvent<{ name: string; v: number; sr: number }>) => {
  const { name, v, sr } = e.data;
  const { d, rate } = render(name, v, sr);
  (self as unknown as Worker).postMessage({ name, v, d, rate }, [d.buffer]);
};
