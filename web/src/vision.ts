import { PF_ALIVE, RIFLE, RIFLE_SIGHT, type Frame, type Welcome, Weather, turretRange, walled } from './protocol';

// Fog of war: what the team sees right now, and what it has ever seen, per tile. Vision is
// shared: every survivor and every structure lights a disc around itself. The host sends
// every creep; this is what decides which of them the client shows.
//
// Walled sites, the houses and outposts with guards inside, are dark rooms: no sight from
// outside reaches past their walls, and one survivor inside lights the whole room. What is
// in there, and how many, stays unknown until someone goes in.

export class Vision {
  // 1 where someone sees the tile this frame.
  now: Uint8Array;
  // 1 where someone has ever seen it.
  seen: Uint8Array;
  // Bumped whenever now changes, for the views that copy it.
  version = 0;
  // The walled site each tile is inside, walls excluded, -1 for open ground.
  private room: Int16Array;
  // Per site: 1 once a survivor has been inside.
  entered: Uint8Array;
  private rooms: { x: number; y: number; w: number; h: number }[];
  private sites: Welcome['sites'];
  private foundSite: Uint8Array;

  constructor(readonly w: number, readonly h: number, wd: Welcome) {
    this.now = new Uint8Array(w * h);
    this.seen = new Uint8Array(w * h);
    this.room = new Int16Array(w * h).fill(-1);
    this.entered = new Uint8Array(wd.sites.length);
    this.foundSite = new Uint8Array(wd.sites.length);
    this.sites = wd.sites;
    // At night the host keeps the ground the team has found, so a late joiner starts from it.
    if (wd.seen) {
      const b = atob(wd.seen);
      for (let i = 0; i < w * h && i >> 3 < b.length; i++) this.seen[i] = (b.charCodeAt(i >> 3) >> (i & 7)) & 1;
    }
    // The inside of the walls: the walls themselves show from outside like any ruin.
    this.rooms = wd.sites.map((s) => (walled(s.kind) ? { x: s.x + 1, y: s.y + 1, w: s.w - 2, h: s.h - 2 } : { x: 0, y: 0, w: 0, h: 0 }));
    this.rooms.forEach((s, i) => {
      for (let y = Math.max(0, s.y); y < Math.min(h, s.y + s.h); y++) this.room.fill(i, y * w + Math.max(0, s.x), y * w + Math.min(w, s.x + s.w));
    });
  }

  // Whether what is inside site i is known: always for open sites, for walled ones once
  // someone has been in.
  // Whether any of site i's ground has been seen; once it has, it stays found.
  found(i: number): boolean {
    if (this.foundSite[i]) return true;
    const s = this.sites[i];
    if (!s) return false;
    for (let y = Math.max(0, s.y); y < Math.min(this.h, s.y + s.h); y++) {
      for (let x = Math.max(0, s.x); x < Math.min(this.w, s.x + s.w); x++) if (this.seen[y * this.w + x]) { this.foundSite[i] = 1; return true; }
    }
    return false;
  }

  knows(i: number): boolean { return !(this.rooms[i]?.w > 0) || this.entered[i] === 1; }

  update(f: Frame, wd: Welcome): void {
    this.now.fill(0);
    // Weather fog shortens sight the way it shortens the guns.
    const mul = f.weather === Weather.Fog ? 1 - 0.25 * f.weatherAmt : 1;
    // At night (hard and brutal) a survivor sees only a small pool round them: the dead are on
    // you before you know it.
    const dark = wd.dark ?? 0, sight = dark || 12;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const r = this.roomAt(p.x, p.y);
      if (r >= 0) { this.entered[r] = 1; this.lightRoom(r); }
      // A rifle's scope sees twice as far.
      this.disc(p.x, p.y, (p.flags & PF_ALIVE ? sight * (p.cur === RIFLE ? RIFLE_SIGHT : 1) : 4) * mul, r);
    }
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const d = wd.structs[f.sKind[i]];
      // The generator keeps the whole base in sight, whatever the difficulty; turrets see a
      // little past what they shoot, night or day; walls and gates see just over themselves.
      // At night these follow the host's (discover.go), which decides what a shot can find.
      const r = f.sKind[i] === 1 ? wd.buildRadius
        : d?.turret ? turretRange(d, f.sLevel[i]) * mul + 2
        : f.sKind[i] === 2 ? (dark ? 7 : 9) : dark ? 2 : 3;
      this.disc(f.sX[i] + f.sW[i] / 2, f.sY[i] + f.sH[i] / 2, r, -1);
    }
    this.version++;
  }

  // Whether a point is in sight now.
  sees(x: number, y: number): boolean {
    const tx = Math.floor(x), ty = Math.floor(y);
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h && this.now[ty * this.w + tx] === 1;
  }

  private roomAt(x: number, y: number): number {
    const tx = Math.floor(x), ty = Math.floor(y);
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h ? this.room[ty * this.w + tx] : -1;
  }

  private lightRoom(r: number): void {
    const s = this.rooms[r], { w, now, seen } = this;
    for (let y = Math.max(0, s.y); y < Math.min(this.h, s.y + s.h); y++) {
      const a = y * w + Math.max(0, s.x), b = y * w + Math.min(w, s.x + s.w);
      now.fill(1, a, b); seen.fill(1, a, b);
    }
  }

  // Lights a disc of open ground, and of the room `inside` (-1: none) the source stands in.
  private disc(cx: number, cy: number, r: number, inside: number): void {
    const { w, h, now, seen, room } = this;
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.floor(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy, span = Math.sqrt(Math.max(0, r * r - dy * dy));
      const x0 = Math.max(0, Math.floor(cx - span + 0.5)), x1 = Math.min(w - 1, Math.floor(cx + span - 0.5));
      for (let i = y * w + x0; i <= y * w + x1; i++) {
        if (room[i] !== -1 && room[i] !== inside) continue;
        now[i] = 1; seen[i] = 1;
      }
    }
  }
}
