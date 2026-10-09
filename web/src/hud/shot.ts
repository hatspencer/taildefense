import type { Frame, Welcome } from '../protocol';
import { fmtGold } from './dom';
import { type ScoreRow, scoreRows } from './score';

// The field report drawn as a picture, to keep: td saves it in its install folder when a game
// ends. Drawn rather than captured, since a page cannot photograph itself, in the report's own
// palette and fonts.

const C = {
  black: '#07080a', soot: '#1c1e16', drab: '#2d3123', line: '#4d523c', khaki: '#938a66', bone: '#d9d1b3',
  amber: '#e0a63a', lit: '#f4c25c', dim: '#9c7a34', rust: '#b5472f', sore: '#d98a62', steel: '#86a2a6', screen: '#11160d',
};
const PIXEL = '"Pixelify Sans", "Lucida Console", monospace';
const CRT = 'VT323, "Lucida Console", monospace';
const SMALL = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

const W = 1200, PAD = 40, CARD = 168;

export async function drawReport(wd: Welcome, f: Frame): Promise<Blob | null> {
  try {
    await Promise.all([`700 52px ${PIXEL}`, `30px ${CRT}`, `14px ${SMALL}`].map((s) => document.fonts.load(s)));
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
  g.save(); g.translate(PAD + 20, sy + 4); g.rotate(-0.02);
  g.fillStyle = C.rust; g.fillRect(0, -12, 150, 26);
  g.fillStyle = '#f4e6d4'; g.font = `700 16px ${PIXEL}`; g.textBaseline = 'middle'; g.fillText('Field report', 14, 1);
  g.restore();
  g.save(); g.translate(W - PAD - 130, sy + 70); g.rotate(-0.16);
  g.strokeStyle = C.rust; g.lineWidth = 4; g.globalAlpha = 0.85; g.strokeRect(-110, -30, 220, 56);
  g.fillStyle = C.rust; g.font = `700 38px ${PIXEL}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('OVERRUN', 0, 0);
  g.restore();
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.font = `700 52px ${PIXEL}`;
  g.fillStyle = C.black; g.fillText('The generator has fallen', PAD + 4, 108 + 4);
  g.fillStyle = C.bone; g.fillText('The generator has fallen', PAD, 108);
  const here = rows.filter((r) => !r.away).length;
  const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  g.font = `16px ${PIXEL}`; g.fillStyle = C.khaki;
  g.fillText(`${wd.difficulty.name} · ${here} ${here === 1 ? 'survivor' : 'survivors'} · map ${wd.seed} · ${when}`, PAD, 142);

  // The tally.
  const tw = (W - 2 * PAD - 16) / 2;
  tally(g, PAD, 166, tw, String(f.best), f.best === 1 ? 'wave held' : 'waves held');
  tally(g, PAD + tw + 16, 166, tw, fmtGold(f.totalKills), 'creeps killed');

  rows.forEach((r, i) => card(g, PAD, top + i * (CARD + 14), W - 2 * PAD, r));
  g.font = `13px ${SMALL}`; g.fillStyle = C.khaki;
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
  g.fillStyle = C.lit; g.font = `64px ${CRT}`; g.fillText(big, x + 18, y + 58);
  g.fillStyle = C.dim; g.font = `26px ${CRT}`; g.fillText(label, x + 18, y + 84);
}

function card(g: CanvasRenderingContext2D, x: number, y: number, w: number, r: ScoreRow): void {
  const p = r.p;
  g.globalAlpha = r.away ? 0.55 : 1;
  g.fillStyle = 'rgba(7,8,10,.35)'; g.fillRect(x, y, w, CARD);
  g.strokeStyle = C.line; g.lineWidth = 2; g.strokeRect(x, y, w, CARD);

  // Who, and their gold.
  g.fillStyle = C.black; g.fillRect(x + 14, y + 13, 14, 20);
  g.fillStyle = r.color; g.fillRect(x + 16, y + 15, 10, 16);
  g.font = `500 22px ${PIXEL}`; g.fillStyle = C.bone;
  let cx = x + 38;
  g.fillText(p.name, cx, y + 31); cx += g.measureText(p.name).width + 10;
  g.font = `16px ${PIXEL}`; g.fillStyle = C.khaki;
  const tag = `${r.you && p.name !== 'you' ? '(you) ' : ''}${r.arch}${r.away ? ' · away' : ''}`;
  g.fillText(tag, cx, y + 31);
  g.font = `32px ${CRT}`; g.fillStyle = C.amber; g.textAlign = 'right';
  g.fillText(`${fmtGold(p.gold)}g`, x + w - 14, y + 33);
  g.textAlign = 'left';

  // The numbers, on glass.
  const ny = y + 46, nh = 62;
  screen(g, x + 14, ny, w - 28, nh);
  const cw = (w - 28) / r.nums.length;
  g.textAlign = 'center';
  r.nums.forEach((n, i) => {
    const mx = x + 14 + cw * (i + 0.5);
    g.font = `34px ${CRT}`; g.fillStyle = n.bad ? C.sore : C.lit; g.fillText(fmtGold(n.v), mx, ny + 32);
    g.font = `14px ${SMALL}`; g.fillStyle = C.dim; g.fillText(n.label, mx, ny + 52);
  });
  g.textAlign = 'left';

  // What they carry.
  let kx = x + 14;
  const ky = y + CARD - 44;
  g.font = `15px ${SMALL}`;
  for (const c of r.chips) {
    const tw = g.measureText(c.text).width, lw = c.lv ? g.measureText(c.lv).width + 6 : 0;
    const cw2 = tw + lw + 16;
    if (kx + cw2 > x + w - 14) break;
    g.fillStyle = C.drab; g.fillRect(kx, ky, cw2, 28);
    g.strokeStyle = c.held ? C.amber : C.line; g.lineWidth = c.held ? 2 : 1; g.strokeRect(kx + 0.5, ky + 0.5, cw2 - 1, 27);
    g.fillStyle = c.ab ? C.steel : C.bone; g.fillText(c.text, kx + 8, ky + 19);
    if (c.lv) { g.font = `600 15px ${SMALL}`; g.fillStyle = C.amber; g.fillText(c.lv, kx + 8 + tw + 6, ky + 19); g.font = `15px ${SMALL}`; }
    kx += cw2 + 6;
  }
  g.globalAlpha = 1;
}
