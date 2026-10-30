// Client-side prediction of this page's own survivor walking with WASD. The host is the only
// authority, but a steer takes a round trip to come back in a frame; the page instead walks
// its hero the instant a key goes down, with the host's own movement code ported here, and
// reconciles with every frame: from the frame's position (the host has applied the commands
// up to the last ack by then), it replays the inputs the host has yet to apply. When the port
// and the host agree, each replay lands where the last one did and nothing moves on screen.
//
// No imports, and only erasable TypeScript, so `node test/predict.mts` runs this
// file as it is (npm run check).

const f = Math.fround;

// The host's numbers, as float32 like its own: internal/game/commands.go PlayerRadius,
// world.go Speed (6 tiles a second, 8% more per pair of boots), weather.go playerSpeedMul (8%
// slower in full snow), noise.go's sprint and stamina, stun.go slowSpeed, abilities.go
// deadEyeWalk and the SMG ultimate's quarter more speed (orders.go stride), orders.go
// steerLapse.
const RADIUS = f(0.3);
const BASE_SPEED = f(6), BOOTS = f(0.08), SNOW_SLOW = f(0.08);
const SPRINT_MUL = f(1.6), SLOW_SPEED = f(0.5), DEAD_EYE_WALK = f(0.5), SMG_ULT = f(1.25);
// sprintDrain * Dt and staminaRegen * Dt are constants to Go, folded exactly and rounded
// once: by the tick, then.
const SPRINT_DRAIN = 1 / 6, STAMINA_REGEN = 1 / 8, WINDED_UNTIL = f(0.35);
const STEER_LAPSE = f(0.4);
// weather.go snowfall: how much each weather counts as heavy snow (Snow 4, HeavySnow 7).
const SNOWFALL = [0, 0, 0, 0, f(0.4), 0, 0, 1];
// A steer's angle travels in 256ths of a turn (internal/web/session.go), and the host turns
// it back with float32(a) * (2π/256).
const TURN256 = f((2 * Math.PI) / 256);
// Weapon kinds (game.WPistol, game.WSMG): Dead Eye's marking slows, Run and gun speeds up.
const W_PISTOL = 0, W_SMG = 2;
// The tile kind from which ground is solid (game.TWater), and the gear slot of boots.
const T_WATER = 4, GEAR_BOOTS = 1;

// steerTurns is the angle in radians as the host gets it: session.go's quantising of the
// page's float, which JSON delivers to it as a float32.
export function steerTurns(rad: number): number {
  let a = f(rad) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return Math.round((a / (2 * Math.PI)) * 256) & 255;
}

// steerDir is the unit vector Steer walks along for a turns angle, and the angle itself.
export function steerAngle(turns: number): number { return f(turns * TURN256); }

// What is in a survivor's way. blocked: solid ground, or a structure that is neither a gate
// nor laid flat; out of the map counts as rock. wreck: a survivor's middle at x, y would be
// inside a wreck, the plane, or a standing fuel pump or engine.
export interface Blocker {
  blocked(tx: number, ty: number): boolean;
  wreck(x: number, y: number): boolean;
}

// tileBlocked is Blocker.blocked from a terrain and a struct-kind lookup (-1 for none).
export function tileBlocked(tiles: Uint8Array, w: number, h: number, tx: number, ty: number, kindAt: (tx: number, ty: number) => number, passable: (kind: number) => boolean): boolean {
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
  if (tiles[ty * w + tx] >= T_WATER) return true;
  const k = kindAt(tx, ty);
  return k >= 0 && !passable(k);
}

const CORNERS = [-RADIUS, -RADIUS, RADIUS, -RADIUS, -RADIUS, RADIUS, RADIUS, RADIUS];

// canStand is commands.go CanStand.
export function canStand(b: Blocker, x: number, y: number): boolean {
  for (let i = 0; i < 8; i += 2) {
    if (b.blocked(Math.floor(f(x + CORNERS[i])), Math.floor(f(y + CORNERS[i + 1])))) return false;
  }
  return !b.wreck(x, y);
}

// move is commands.go Move: one axis at a time, so a survivor glides along walls. Into out.
export function move(b: Blocker, x: number, y: number, dx: number, dy: number, out: { x: number; y: number }): void {
  const nx = f(x + dx);
  if (canStand(b, nx, y)) x = nx;
  const ny = f(y + dy);
  if (canStand(b, x, ny)) y = ny;
  out.x = x; out.y = y;
}

// What a stride depends on besides the map, as the page knows it of its own survivor.
export interface Gait {
  boots: number; // pairs of boots (gear)
  weather: number; amt: number; // the frame's weather and how strongly it holds
  sprinting: boolean; // sprint held and not winded
  slowed: boolean; // a creep's blow still slowing
  marking: boolean; // Dead Eye's marking
  smgUlt: boolean; // the SMG's ultimate, in hand
}

// stride is orders.go stride: how far the survivor walks this tick, for dt = 1 / tickRate.
export function stride(g: Gait, dt: number): number {
  const speed = f(BASE_SPEED * f(1 + f(BOOTS * g.boots)));
  const snowy = f((SNOWFALL[g.weather] ?? 0) * f(g.amt));
  let s = f(f(speed * f(1 - f(SNOW_SLOW * snowy))) * dt);
  if (g.sprinting) s = f(s * SPRINT_MUL);
  if (g.slowed) s = f(s * SLOW_SPEED);
  if (g.marking) s = f(s * DEAD_EYE_WALK);
  if (g.smgUlt) s = f(s * SMG_ULT);
  return s;
}

// stamina is noise.go stepStamina: spent on a sprint that moved, recovered otherwise. Into out.
export function stamina(st: number, winded: boolean, sprinting: boolean, moved: boolean, smgUlt: boolean, dt: number, out: { stamina: number; winded: boolean }): void {
  if (sprinting && moved && !smgUlt) {
    st = f(st - f(SPRINT_DRAIN * dt));
    if (st <= 0) { st = 0; winded = true; }
  } else {
    st = Math.min(1, f(st + f(STAMINA_REGEN * dt)));
    if (winded && st >= WINDED_UNTIL) winded = false;
  }
  out.stamina = st; out.winded = winded;
}

// counting reports whether a timer of v seconds is still running n ticks on: the host takes
// dt off it in float32 before each tick's step (a slow, a buff) and acts while it is above 0.
export function counting(v: number, n: number, dt: number): boolean {
  let l = f(v);
  for (let i = 0; i < n && l > 0; i++) l = f(l - dt);
  return l > 0;
}

// lapseTicks is how many ticks a steer walks without a repeat: the host sets steerLeft to
// steerLapse and takes dt off it before each tick's step, walking while it stays above 0.
export function lapseTicks(dt: number): number {
  let left = STEER_LAPSE, n = 0;
  for (;;) { left = f(left - dt); if (left <= 0) return n; n++; }
}

// ---- wrecks ------------------------------------------------------------------------------

// What the welcome says of a site.
export interface SiteLike { kind: number; sx: number; sy: number; yaw?: number }

// Site kinds (protocol.ts SiteKind, game.SiteKind).
const S_CAR = 1, S_PICKUP = 4, S_ARMY = 8, S_PUMP = 10, S_FIRE = 11, S_MOTO = 14, S_PLANE = 15, S_TANK = 16;
// wreck.go wreckHalf: half a wreck's length and width, by kind from Pickup to Moto (Car and
// any other kind take the last pair).
const HALF: Record<number, [number, number]> = {
  4: [0.9, 0.46], 5: [0.84, 0.45], 6: [1, 0.47], 7: [1.55, 0.54], 8: [1.2, 0.5],
  11: [1.45, 0.52], 12: [1.05, 0.5], 13: [1.25, 0.52], 14: [0.5, 0.3],
};
const HALF_CAR: [number, number] = [0.82, 0.44];
// plane.go: the hull, and the tail broken off behind it.
const PLANE_HL = f(5.5), PLANE_HW = f(1.15), TAIL_X = f(-9.1), TAIL_Y = f(1.6), TAIL_TURN = f(0.5), TAIL_HL = f(2.4), TAIL_HW = f(0.85), PLANE_REACH = 13;
// station.go pumpBody and plane.go tankBody: a pump's and an engine's half width.
const PUMP_BODY = f(0.3), TANK_BODY = f(0.55);
const GRID_REACH = f(0.3 + 0.75);

function isWreck(k: number): boolean { return k === S_CAR || (k >= S_PICKUP && k <= S_ARMY) || (k >= S_FIRE && k <= S_MOTO); }

function boxDist(cx: number, cy: number, yaw: number, hl: number, hw: number, x: number, y: number): number {
  const c = f(Math.cos(yaw)), sn = f(Math.sin(yaw));
  const dx = f(x - cx), dy = f(y - cy);
  const u = Math.max(f(Math.abs(f(f(dx * c) + f(dy * sn))) - hl), 0);
  const v = Math.max(f(Math.abs(f(f(-dx * sn) + f(dy * c))) - hw), 0);
  return f(Math.sqrt(f(f(u * u) + f(v * v))));
}

// Wrecks is wreck.go's wreckAt over the welcome's sites: a grid of the tiles each wreck's box
// (grown by a survivor's radius) reaches into, then the box itself; and the standing pumps.
export class Wrecks {
  private grid: Int16Array;
  private pumps: number[] = [];
  private sx: Float32Array; private sy: Float32Array; private yaw: Float32Array;
  private hl: Float32Array; private hw: Float32Array; private kind: Uint8Array;
  private w: number; private h: number;

  constructor(sites: readonly SiteLike[], w: number, h: number) {
    this.w = w; this.h = h;
    const n = sites.length;
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.yaw = new Float32Array(n);
    this.hl = new Float32Array(n); this.hw = new Float32Array(n); this.kind = new Uint8Array(n);
    this.grid = new Int16Array(w * h);
    for (let i = 0; i < n; i++) {
      const s = sites[i], k = s.kind;
      this.kind[i] = k; this.sx[i] = s.sx; this.sy[i] = s.sy; this.yaw[i] = s.yaw ?? 0;
      const [hl, hw] = HALF[k] ?? HALF_CAR;
      this.hl[i] = hl; this.hw[i] = hw;
      if (k === S_PUMP || k === S_TANK) this.pumps.push(i);
    }
    for (let i = 0; i < n; i++) {
      const k = this.kind[i];
      if (!isWreck(k) && k !== S_PLANE) continue;
      const hl = k === S_PLANE ? PLANE_REACH : this.hl[i];
      const r = Math.trunc(f(hl + RADIUS)) + 1, sx = this.sx[i], sy = this.sy[i];
      for (let ty = Math.trunc(sy) - r; ty <= Math.trunc(sy) + r; ty++) {
        for (let tx = Math.trunc(sx) - r; tx <= Math.trunc(sx) + r; tx++) {
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          // The nearest point of the tile to the box decides.
          const nx = Math.min(Math.max(sx, tx), tx + 1), ny = Math.min(Math.max(sy, ty), ty + 1);
          if (this.dist(i, nx, ny) < GRID_REACH) this.grid[ty * w + tx] = i + 1;
        }
      }
    }
  }

  // wreckDist: how far x, y is from wreck i's box, 0 inside; for the plane, its hull or tail.
  private dist(i: number, x: number, y: number): number {
    const sx = this.sx[i], sy = this.sy[i], yaw = this.yaw[i];
    if (this.kind[i] !== S_PLANE) return boxDist(sx, sy, yaw, this.hl[i], this.hw[i], x, y);
    const d = boxDist(sx, sy, yaw, PLANE_HL, PLANE_HW, x, y);
    const c = f(Math.cos(yaw)), s = f(Math.sin(yaw));
    const tx = f(f(sx + f(TAIL_X * c)) - f(TAIL_Y * s)), ty = f(f(sy + f(TAIL_X * s)) + f(TAIL_Y * c));
    return Math.min(d, boxDist(tx, ty, f(yaw + TAIL_TURN), TAIL_HL, TAIL_HW, x, y));
  }

  // at is wreckAt; searched(i) says a pump or engine has gone up and is no longer there.
  at(x: number, y: number, searched: (i: number) => boolean): boolean {
    for (const i of this.pumps) {
      if (searched(i)) continue;
      const b = f((this.kind[i] === S_TANK ? TANK_BODY : PUMP_BODY) + RADIUS);
      if (Math.abs(f(x - this.sx[i])) < b && Math.abs(f(y - this.sy[i])) < b) return true;
    }
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    const i = this.grid[ty * this.w + tx];
    return i > 0 && this.dist(i - 1, x, y) < RADIUS;
  }
}

// ---- prediction and reconciliation -------------------------------------------------------

// What the page knows of its own survivor from a frame (protocol.ts Player).
export interface Me {
  x: number; y: number; stamina: number; winded: boolean; slow: number;
  buff: number; buffLeft: number; cur: number; gear: ArrayLike<number>;
  alive: boolean; stunned: boolean; held: boolean; airborne: boolean; aboard: boolean; art: number;
}

// The world for one reconcile: what is in the way and the weather.
export interface World extends Blocker { weather: number; amt: number }

// A survivor's walking state after a tick.
export interface Step { x: number; y: number; st: number; winded: boolean }

const gait: Gait = { boots: 0, weather: 0, amt: 0, sprinting: false, slowed: false, marking: false, smgUlt: false };
const mv = { x: 0, y: 0 }, sm = { stamina: 0, winded: false };

// walkTick is one host tick of survivor me's walk, n ticks after the frame me is from, from
// s into s: the slow and the buffs have counted down first, then the steer (turns, if
// steer) walks, then stamina is spent or recovered (orders.go act, noise.go stepStamina).
export function walkTick(me: Me, n: number, steer: boolean, turns: number, sprint: boolean, w: World, dt: number, s: Step): void {
  const buffOn = counting(me.buffLeft, n, dt);
  const smgUlt = buffOn && me.buff === W_SMG + 1 && me.cur === W_SMG;
  const sprinting = sprint && !s.winded;
  let moved = false;
  if (steer) {
    gait.boots = me.gear[GEAR_BOOTS] ?? 0; gait.weather = w.weather; gait.amt = w.amt;
    gait.sprinting = sprinting; gait.slowed = counting(me.slow, n, dt);
    gait.marking = buffOn && me.buff === W_PISTOL + 1; gait.smgUlt = smgUlt;
    const d = stride(gait, dt), ang = steerAngle(turns);
    move(w, s.x, s.y, f(f(Math.cos(ang)) * d), f(f(Math.sin(ang)) * d), mv);
    moved = mv.x !== s.x || mv.y !== s.y;
    s.x = mv.x; s.y = mv.y;
  }
  stamina(s.st, s.winded, sprinting, moved, smgUlt, dt, sm);
  s.st = sm.stamina; s.winded = sm.winded;
}

// An input the page sent: a steer (turns, on), a sprint (on), an order that replaces a
// steer on the host, or anything else, which only counts for its seq. t is when it was sent
// (performance.now()).
const IN_STEER = 0, IN_SPRINT = 1, IN_ORDER = 2, IN_OTHER = 3;
interface Input { seq: number; t: number; kind: number; turns: number; on: boolean }

// The page's commands that replace whatever order the survivor has, a steer included.
const ORDERS = new Set(['move', 'amove', 'attack', 'stop', 'hold', 'build', 'repair', 'loot', 'revive', 'pickup', 'board', 'gate']);

// The replayed state per host tick, in a ring.
const RING = 128;
// Positions travel as 1/8 tile: the host's position is within half of that of the frame's.
const POS_HALF = 1 / 16, STAMINA_HALF = 0.5 / 255;
// A correction bigger than this snaps rather than eases.
export const SNAP = 1.5;
// Corrections and input changes are let go with this time constant in ms.
const SMOOTH_MS = 100;
// After the last tick that walked, prediction holds the hero where it stopped for this long,
// so the interpolated view (drawn up to DELAY_MAX ms in the past) has caught up when it takes
// over again.
const HOLD_MS = 300;
// How quickly the estimate of the host's tick phase follows each ack's, and how far off one
// must be to be taken at once (the path changed).
const PHASE_GAIN = 0.2, PHASE_JUMP = 2;
// How far back the F3 readout looks, ms.
const STATS_MS = 10000;

export class Predictor {
  private tickMs = 50;
  private dt = f(1 / 20);
  private lapse = 7;
  // Inputs the host has yet to apply, oldest first, and the state of those it has.
  private inputs: Input[] = [];
  private bSteer = false; private bTurns = 0; private bSteerT = 0; private bSprint = false;
  // The host's ticks as this page's clock sees them: a command sent at t is applied before
  // host tick tickOf(t) + 1 (see tickOf). Each ack says which tick a command sent at a known
  // time made, which pins the phase to within a tick; a running mean of those settles it.
  private phase = 0;
  private hasPhase = false;
  // Acks waiting for their frame.
  private acks: { seq: number; tick: number }[] = [];
  // Replayed: per host tick, position, stamina, winded, whether it walked; valid from kLo to kTop.
  private rx = new Float32Array(RING); private ry = new Float32Array(RING); private rs = new Float32Array(RING);
  private rw = new Uint8Array(RING);
  private kLo = 0; private kTop = -1;
  // The frame this replay starts from: its tick and what the survivor was.
  private kf = 0;
  private me: Me | null = null;
  private world: World | null = null;
  private frameTick = -1;
  // The last tick that walked, and whether a reconcile happened at all since the last reset.
  private lastWalkK = -1e9;
  // Smoothing: the error still carried, and when it was last let go.
  private ex = 0; private ey = 0; private smoothAt = 0;
  // F3: corrections (size in tiles, when) and snaps over the last STATS_MS.
  private corr: { at: number; d: number; snap: boolean }[] = [];
  // What draw() found.
  x = 0; y = 0; aim = 0;
  // Prediction stopped because the survivor went down, aboard, stunned, held, thrown or into a
  // weapon art: the page snaps to the frames then rather than easing over.
  lost = false;

  reset(tickRate: number): void {
    this.tickMs = 1000 / (tickRate > 0 ? tickRate : 20);
    this.dt = f(1 / (tickRate > 0 ? tickRate : 20));
    this.lapse = lapseTicks(this.dt);
    this.inputs.length = 0; this.acks.length = 0;
    this.bSteer = false; this.bSprint = false; this.bTurns = 0; this.bSteerT = 0;
    this.hasPhase = false;
    this.me = null; this.world = null; this.frameTick = -1;
    this.invalidate();
  }

  private invalidate(): void {
    this.kTop = -1; this.kLo = 0;
    this.lastWalkK = -1e9;
    this.ex = 0; this.ey = 0;
  }

  // tickOf is the host tick last run at page time t, as far as a command from the page goes:
  // one sent at t is in the next tick's step.
  private tickOf(t: number): number { return Math.floor((t - this.phase) / this.tickMs); }

  // sent records a command the page sent, numbered seq, at now (performance.now()).
  sent(op: string, seq: number, now: number, x?: number, on?: boolean): void {
    let kind = IN_OTHER, turns = 0, o = false;
    if (op === 'steer') { kind = IN_STEER; o = !!on; turns = o ? steerTurns(x ?? 0) : 0; }
    else if (op === 'sprint') { kind = IN_SPRINT; o = !!on; }
    else if (ORDERS.has(op)) kind = IN_ORDER;
    // The hero must not jump when the input changes the step under way: carry the difference.
    const was = kind !== IN_OTHER && this.draw(now);
    const bx = this.x, by = this.y;
    this.inputs.push({ seq, t: now, kind, turns, on: o });
    if (this.inputs.length > 256) this.fold(this.inputs[0].seq);
    if (was && this.draw(now)) { this.ex += bx - this.x; this.ey += by - this.y; this.x = bx; this.y = by; }
  }

  // ack is the host's word that it applied the page's commands up to seq in the frame of tick.
  ack(seq: number | undefined, tick: number): void {
    if (seq === undefined) return;
    this.acks.push({ seq, tick });
    if (this.acks.length > 64) this.acks.shift();
    // Usually the ack comes right behind its frame: reconcile again, now knowing the offset.
    if (this.me && this.world && tick <= this.frameTick) this.reconcile(this.frameTick, this.me, this.world, performance.now(), false);
  }

  // Folds every input up to seq into the applied state.
  private fold(seq: number): void {
    let n = 0;
    for (const i of this.inputs) {
      if (i.seq > seq) break;
      n++;
      if (i.kind === IN_STEER) { this.bSteer = i.on; if (i.on) { this.bTurns = i.turns; this.bSteerT = i.t; } }
      else if (i.kind === IN_SPRINT) this.bSprint = i.on;
      else if (i.kind === IN_ORDER) this.bSteer = false;
    }
    this.inputs.splice(0, n);
  }

  // Whether the survivor is one prediction may move: up, on the ground and free.
  static usable(m: Me): boolean {
    return m.alive && !m.stunned && !m.held && !m.airborne && !m.aboard && m.art === 0;
  }

  // frame reconciles with a new frame of host tick tick, me being the page's survivor in it.
  frame(tick: number, me: Me, world: World, now: number): void {
    this.me = me; this.world = world; this.frameTick = tick;
    this.reconcile(tick, me, world, now, true);
  }

  // count: whether the correction goes into the F3 readout, once a frame.
  private reconcile(tick: number, me: Me, world: World, now: number, count: boolean): void {
    if (!Predictor.usable(me)) { this.invalidate(); this.lost = true; return; }
    this.lost = false;
    // The newest ack this frame already shows fixes the offset and drops what it covers.
    let a = -1;
    for (let i = 0; i < this.acks.length; i++) if (this.acks[i].tick <= tick) a = i;
    if (a >= 0) {
      const { seq, tick: at } = this.acks[a];
      this.acks.splice(0, a + 1);
      const inp = this.inputs.find((i) => i.seq === seq);
      if (inp) {
        // Sent at inp.t and in tick at's step: the phase lies within a tick, this the middle.
        const m = inp.t - at * this.tickMs + this.tickMs / 2;
        if (!this.hasPhase || Math.abs(m - this.phase) > PHASE_JUMP * this.tickMs) this.phase = m;
        else this.phase += (m - this.phase) * PHASE_GAIN;
        this.hasPhase = true;
      }
      this.fold(seq);
    }
    // Before the first ack, take the frame for now: prediction leads by nothing yet.
    if (!this.hasPhase) this.phase = now - tick * this.tickMs - this.tickMs / 2;
    const kf = tick, kNow = this.tickOf(now);
    // The host is within half a q8 step of the frame's position; where the last replay put
    // the survivor at that tick is kept if it lies inside, so a right prediction stays exact.
    let x = me.x, y = me.y, st = me.stamina;
    const had = this.kTop >= 0 && kf >= this.kLo && kf <= this.kTop && this.kTop - kf < RING;
    let snap = false;
    if (had) {
      const j = kf % RING, px = this.rx[j], py = this.ry[j];
      if (Math.abs(px - x) + Math.abs(py - y) > SNAP) snap = true;
      else {
        const cx = Math.min(Math.max(px, x - POS_HALF), x + POS_HALF), cy = Math.min(Math.max(py, y - POS_HALF), y + POS_HALF);
        if (canStand(world, cx, cy) || !canStand(world, x, y)) { x = cx; y = cy; }
        st = Math.min(Math.max(this.rs[j], st - STAMINA_HALF), st + STAMINA_HALF);
      }
    }
    const hadNow = this.kTop >= 0 && kNow >= this.kLo && kNow <= this.kTop;
    const ox = hadNow ? this.rx[kNow % RING] : 0, oy = hadNow ? this.ry[kNow % RING] : 0;
    const fresh = this.kTop < 0;
    this.kf = kf;
    const j = kf % RING;
    this.rx[j] = f(x); this.ry[j] = f(y); this.rs[j] = f(st); this.rw[j] = me.winded ? 1 : 0;
    this.kLo = kf; this.kTop = kf;
    this.advance(Math.max(kNow, kf));
    if (fresh) return;
    // Only while the hero is drawn from here: otherwise the frames walk it (a click's route)
    // and the replay merely follows.
    if (!this.active(kNow)) { this.ex = 0; this.ey = 0; return; }
    if (!hadNow || this.kTop !== kNow) return;
    const dx = ox - this.rx[kNow % RING], dy = oy - this.ry[kNow % RING], d = Math.hypot(dx, dy);
    if (snap || d > SNAP) { this.ex = 0; this.ey = 0; snap = true; }
    else { this.ex += dx; this.ey += dy; }
    if (!count) return;
    this.corr.push({ at: now, d: snap ? SNAP : d, snap });
    while (this.corr.length && now - this.corr[0].at > STATS_MS) this.corr.shift();
  }

  // The inputs' state at tick k, into st: steering (and its turns), sprint held.
  private st = { steer: false, turns: 0, sprint: false };
  private stateAt(k: number): void {
    let steer = this.bSteer, turns = this.bTurns, sk = this.tickOf(this.bSteerT) + 1, sprint = this.bSprint;
    for (const i of this.inputs) {
      // The host applies an input no sooner than the tick after the frame being replayed from.
      const ik = Math.max(this.tickOf(i.t) + 1, this.kf + 1);
      if (ik > k) break;
      if (i.kind === IN_STEER) { steer = i.on; if (i.on) { turns = i.turns; sk = ik; } }
      else if (i.kind === IN_SPRINT) sprint = i.on;
      else if (i.kind === IN_ORDER) steer = false;
    }
    this.st.steer = steer && k - sk < this.lapse;
    this.st.turns = turns; this.st.sprint = sprint;
  }

  // One tick k on from the replayed state at k - 1.
  private stepTo(k: number, out: { x: number; y: number; st: number; winded: boolean; walked: boolean }): void {
    const p = (k - 1) % RING;
    out.x = this.rx[p]; out.y = this.ry[p]; out.st = this.rs[p]; out.winded = this.rw[p] === 1;
    this.stateAt(k);
    walkTick(this.me!, k - this.kf, this.st.steer, this.st.turns, this.st.sprint, this.world!, this.dt, out);
    out.walked = this.st.steer;
  }
  private step = { x: 0, y: 0, st: 0, winded: false, walked: false };

  // Replays the ticks up to k.
  private advance(k: number): void {
    if (this.kTop < 0 || !this.me) return;
    // A page asleep for longer than the ring starts over from its last state.
    if (k - this.kTop >= RING) {
      const j = this.kTop % RING, nj = (k - 1) % RING;
      this.rx[nj] = this.rx[j]; this.ry[nj] = this.ry[j]; this.rs[nj] = this.rs[j]; this.rw[nj] = this.rw[j];
      this.kTop = k - 1; this.kLo = k - 1;
    }
    const s = this.step;
    while (this.kTop < k) {
      const n = this.kTop + 1;
      this.stepTo(n, s);
      const j = n % RING;
      this.rx[j] = s.x; this.ry[j] = s.y; this.rs[j] = s.st; this.rw[j] = s.winded ? 1 : 0;
      if (s.walked) this.lastWalkK = n;
      this.kTop = n;
      if (this.kTop - this.kLo >= RING) this.kLo = this.kTop - RING + 1;
    }
  }

  // draw works out where the hero is drawn at now, into x, y and aim (the steer's angle
  // while walking); false when prediction has nothing to say (the frame's own position, drawn
  // interpolated like everyone else's, is right then).
  draw(now: number): boolean {
    if (this.kTop < 0 || !this.me) return false;
    const t = (now - this.phase) / this.tickMs, k = Math.floor(t);
    this.advance(k);
    if (!this.active(k)) { this.ex = 0; this.ey = 0; this.smoothAt = 0; return false; }
    // Partway into the next tick: its step with the inputs so far, scaled by how far.
    const j = this.kTop % RING;
    let x = this.rx[j], y = this.ry[j];
    if (this.kTop === k) {
      const s = this.step;
      this.stepTo(k + 1, s);
      const fr = Math.min(1, Math.max(0, t - k));
      x += (s.x - x) * fr; y += (s.y - y) * fr;
    }
    const dt = this.smoothAt > 0 ? Math.min(100, Math.max(0, now - this.smoothAt)) : 0;
    this.smoothAt = now;
    const decay = Math.exp(-dt / SMOOTH_MS);
    this.ex *= decay; this.ey *= decay;
    this.x = x + this.ex; this.y = y + this.ey;
    this.stateAt(k + 1);
    if (this.st.steer) this.aim = steerAngle(this.st.turns);
    return true;
  }

  // Whether the hero is drawn predicted at tick k: walking with the keys (now or with
  // the inputs so far, from the next tick), or lately stopped.
  private active(k: number): boolean {
    this.stateAt(k + 1);
    return this.st.steer || (k - this.lastWalkK) * this.tickMs <= HOLD_MS;
  }

  // carry adds a difference to the error being let go: the page switching the hero from
  // interpolated to predicted eases from where it was drawn.
  carry(dx: number, dy: number): void {
    if (Math.abs(dx) + Math.abs(dy) > SNAP) return;
    this.ex += dx; this.ey += dy;
    this.x += dx; this.y += dy;
  }

  // F3: the mean correction over the last STATS_MS in tiles, and the snaps among them.
  stats(now: number): { err: number; snaps: number; n: number } {
    while (this.corr.length && now - this.corr[0].at > STATS_MS) this.corr.shift();
    let s = 0, snaps = 0;
    for (const c of this.corr) { s += c.d; if (c.snap) snaps++; }
    return { err: this.corr.length ? s / this.corr.length : 0, snaps, n: this.corr.length };
  }
}
