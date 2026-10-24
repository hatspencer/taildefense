import type { Frame, Welcome } from '../protocol';
import { fmtGold } from './dom';
import { type ScoreRow, scoreRows, verdict } from './score';

// The field report drawn as a picture, to keep: td saves it in its install folder when a game
// ends. Drawn rather than captured, since a page cannot photograph itself, in the report's own
// palette and fonts.

const C = {
  black: '#07080a', soot: '#1c1e16', drab: '#2d3123', line: '#4d523c', khaki: '#938a66', bone: '#d9d1b3',
  moss: '#86a24c', amber: '#e0a63a', lit: '#f4c25c', dim: '#9c7a34', rust: '#b5472f', sore: '#d98a62', steel: '#86a2a6', screen: '#11160d',
};
const FONT = '"Fira Code", Menlo, Consolas, monospace';

const W = 1200, PAD = 40, CARD = 168;

export async function drawReport(wd: Welcome, f: Frame): Promise<Blob | null> {
  try {
    await Promise.all([`700 52px ${FONT}`, `30px ${FONT}`, `14px ${FONT}`].map((s) => document.fonts.load(s)));
  } catch { /* fall back to the stand-ins */ }
  const rows = scoreRows(wd, f);
  const top = 300, H = top + rows.length * (CARD + 14) + 70;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  if (!g) return null;

  // Backdrop and the sheet.
  const bg = g.createRadialGradient(W / 2, H * 0.45, 50, W / 2, H * 0.45, W * 0.8);
  bg.addColorStop(0, '#2a120a'); bg.addColorStop(1, '#050503');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const sx = 20, sy = 24, sw = W - 40, sh = H - 44;
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(sx + 6, sy + 6, sw, sh);
  g.fillStyle = C.soot; g.fillRect(sx, sy, sw, sh);
  g.strokeStyle = C.black; g.lineWidth = 2; g.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
  g.strokeStyle = C.line; g.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
  for (let y = sy; y < sy + sh; y += 3) { g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(sx, y, sw, 1); }

  // Tape, stamp, headline.
  const v = verdict(f), ink = v.ok ? C.moss : C.rust;
  g.save(); g.translate(PAD + 20, sy + 4); g.rotate(-0.02);
  g.fillStyle = ink; g.fillRect(0, -12, 150, 26);
  g.fillStyle = v.ok ? '#172010' : '#f4e6d4'; g.font = `700 16px ${FONT}`; g.textBaseline = 'middle'; g.fillText('Field report', 14, 1);
  g.restore();
  g.save(); g.translate(W - PAD - 130, sy + 70); g.rotate(-0.16);
  g.font = `700 38px ${FONT}`;
  const sw2 = Math.max(220, g.measureText(v.stamp.toUpperCase()).width + 40);
  g.strokeStyle = ink; g.lineWidth = 4; g.globalAlpha = 0.85; g.strokeRect(-sw2 / 2, -30, sw2, 56);
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(v.stamp.toUpperCase(), 0, 0);
  g.restore();
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.font = `700 52px ${FONT}`;
  g.fillStyle = C.black; g.fillText(v.head, PAD + 4, 108 + 4);
  g.fillStyle = C.bone; g.fillText(v.head, PAD, 108);
  const here = rows.filter((r) => !r.away).length;
  const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  g.font = `16px ${FONT}`; g.fillStyle = C.khaki;
  g.fillText(`${wd.difficulty.name} · ${here} ${here === 1 ? 'survivor' : 'survivors'} · map ${wd.seed} · ${when}`, PAD, 142);

  // The tally.
  const nt = v.evac ? 3 : 2, tw = (W - 2 * PAD - 16 * (nt - 1)) / nt;
  tally(g, PAD, 166, tw, String(f.best), f.best === 1 ? 'wave held' : 'waves held');
  tally(g, PAD + tw + 16, 166, tw, fmtGold(f.totalKills), 'creeps killed');
  if (v.evac) tally(g, PAD + 2 * (tw + 16), 166, tw, `${v.out}/${v.n}`, 'extracted');

  rows.forEach((r, i) => card(g, PAD, top + i * (CARD + 14), W - 2 * PAD, r));
  g.font = `13px ${FONT}`; g.fillStyle = C.khaki;
  g.fillText('taildefense', PAD, H - 34);
  return new Promise((ok) => cv.toBlob((b) => ok(b), 'image/png'));
}

function screen(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.fillStyle = C.screen; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(0,0,0,.28)';
  for (let yy = y; yy < y + h; yy += 3) g.fillRect(x, yy, w, 1);
  g.strokeStyle = C.black; g.lineWidth = 2; g.strokeRect(x, y, w, h);
}

function tally(g: CanvasRenderingContext2D, x: number, y: number, w: number, big: string, label: string): void {
  screen(g, x, y, w, 96);
  g.fillStyle = C.lit; g.font = `64px ${FONT}`; g.fillText(big, x + 18, y + 58);
  g.fillStyle = C.dim; g.font = `26px ${FONT}`; g.fillText(label, x + 18, y + 84);
}

function card(g: CanvasRenderingContext2D, x: number, y: number, w: number, r: ScoreRow): void {
  const p = r.p;
  g.globalAlpha = r.away ? 0.55 : 1;
  g.fillStyle = 'rgba(7,8,10,.35)'; g.fillRect(x, y, w, CARD);
  g.strokeStyle = C.line; g.lineWidth = 2; g.strokeRect(x, y, w, CARD);

  // Who, and their gold.
  g.fillStyle = C.black; g.fillRect(x + 14, y + 13, 14, 20);
  g.fillStyle = r.color; g.fillRect(x + 16, y + 15, 10, 16);
  g.font = `500 22px ${FONT}`; g.fillStyle = C.bone;
  let cx = x + 38;
  g.fillText(p.name, cx, y + 31); cx += g.measureText(p.name).width + 10;
  g.font = `16px ${FONT}`; g.fillStyle = C.khaki;
  const tag = `${r.you && p.name !== 'you' ? '(you) ' : ''}${r.arch}${r.aboard ? ' · extracted' : r.behind ? ' · left behind' : r.away ? ' · away' : ''}`;
  g.fillText(tag, cx, y + 31);
  g.font = `32px ${FONT}`; g.fillStyle = C.amber; g.textAlign = 'right';
  g.fillText(`${fmtGold(p.gold)}g`, x + w - 14, y + 33);
  g.textAlign = 'left';

  // The numbers, on glass.
  const ny = y + 46, nh = 62;
  screen(g, x + 14, ny, w - 28, nh);
  // Each column as wide as what it holds, the slack shared out; numbers too long for the glass
  // are set smaller rather than run into each other.
  const vals = r.nums.map((n) => fmtGold(n.v)), avail = w - 28, gap = 14;
  g.font = `14px ${FONT}`;
  const lw = r.nums.map((n) => g.measureText(n.label).width);
  let size = 34, cols: number[] = [];
  for (; size >= 20; size -= 2) {
    g.font = `${size}px ${FONT}`;
    cols = vals.map((v, i) => Math.max(g.measureText(v).width, lw[i]) + gap);
    if (cols.reduce((a, b) => a + b, 0) <= avail) break;
  }
  const extra = Math.max(0, avail - cols.reduce((a, b) => a + b, 0)) / cols.length;
  g.textAlign = 'center';
  let colX = x + 14;
  r.nums.forEach((n, i) => {
    const cw = cols[i] + extra, mx = colX + cw / 2;
    colX += cw;
    g.font = `${size}px ${FONT}`; g.fillStyle = n.bad ? C.sore : C.lit; g.fillText(vals[i], mx, ny + 32);
    g.font = `14px ${FONT}`; g.fillStyle = C.dim; g.fillText(n.label, mx, ny + 52);
  });
  g.textAlign = 'left';

  // What they carry.
  let kx = x + 14;
  const ky = y + CARD - 44;
  g.font = `15px ${FONT}`;
  for (const c of r.chips) {
    const tw = g.measureText(c.text).width, lw = c.lv ? g.measureText(c.lv).width + 6 : 0;
    const cw2 = tw + lw + 16;
    if (kx + cw2 > x + w - 14) break;
    g.fillStyle = C.drab; g.fillRect(kx, ky, cw2, 28);
    g.strokeStyle = c.held ? C.amber : C.line; g.lineWidth = c.held ? 2 : 1; g.strokeRect(kx + 0.5, ky + 0.5, cw2 - 1, 27);
    g.fillStyle = c.ab ? C.steel : C.bone; g.fillText(c.text, kx + 8, ky + 19);
    if (c.lv) { g.font = `600 15px ${FONT}`; g.fillStyle = C.amber; g.fillText(c.lv, kx + 8 + tw + 6, ky + 19); g.font = `15px ${FONT}`; }
    kx += cw2 + 6;
  }
  g.globalAlpha = 1;
}
