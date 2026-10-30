import { CameraRig } from './camera';
import { Controller } from './controller';
import type { TdDemo } from './demo';
import type { DemoHost, DemoOptions } from './demo/host';
import { Hud } from './hud/hud';
import { Labels } from './hud/labels';
import { Splash } from './hud/splash';
import { DROP_HOLD, Input } from './input';
import { Kiosk } from './kiosk';
import type { Lab } from './lab';
import { type Handlers, type Transport, WsTransport } from './net';
import { EvacStage, PF_ALIVE, PF_ARMORY, Phase, PingKind, SiteKind, siteX, siteY, TTrack, TURRET_TRACKS, turretRange, type Welcome, wreck } from './protocol';
import { Creeps } from './scene/creeps';
import { Effects } from './scene/effects';
import { Helis } from './scene/heli';
import { Heroes } from './scene/heroes';
import { Portraits } from './scene/portraits';
import { Guns } from './scene/guns';
import { Loot } from './scene/loot';
import { Overlays } from './scene/overlays';
import { Routes } from './route';
import { K_CANNON, K_FROST, K_GATE, K_GUN, K_MISSILE, K_SNIPER, K_TESLA, Structs } from './scene/structs';
import { FogOfWar } from './scene/fow';
import { Terrain } from './scene/terrain';
import { Weather } from './scene/weather';
import { playerColor } from './scene/util';
import { Sound } from './sound/sound';
import { World } from './scene/world';
import { Game } from './state';

// #demo&vol=40&music=30&drop&fog&weather=3&down&corehp=0.3&creeps=5000&phase=build&cam=x,y,yawDeg,dist&build=5&armory&help&score&shot&f3&sel=struct:12&mouse=x,y&webgl
// A malformed escape is left as typed rather than failing the start.
function unescape(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

function params(): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of location.hash.slice(1).split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    m.set(i < 0 ? part : part.slice(0, i), i < 0 ? '' : unescape(part.slice(i + 1)));
  }
  return m;
}

// The demo and the lab are a script of their own, fetched for #demo and #lab only. A classic
// script, like app.js, so the demo still opens straight from disk.
function loadDemo(): Promise<TdDemo> {
  return new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'demo.js';
    sc.onload = () => ok((window as unknown as { tdDemo: TdDemo }).tdDemo);
    sc.onerror = () => fail(new Error('could not load demo.js'));
    document.head.append(sc);
  });
}

async function makeWorld(app: HTMLElement, forceWebGL: boolean): Promise<World> {
  const mk = () => {
    const c = document.createElement('canvas');
    c.className = 'view';
    c.tabIndex = 0;
    app.prepend(c);
    return c;
  };
  if (!forceWebGL && 'gpu' in navigator) {
    const canvas = mk();
    const w = new World(canvas, false);
    try { await w.init(); return w; } catch (e) {
      console.warn('taildefense: WebGPU init failed, falling back to WebGL2', e);
      w.renderer.dispose();
      canvas.remove();
    }
  }
  // A fresh canvas: one that already handed out a WebGPU context cannot give a WebGL one. Older
  // GPUs can refuse a multisampled WebGL2 context, so the last try goes without antialiasing.
  let err: unknown;
  for (const aa of [true, false]) {
    const canvas = mk();
    const w = new World(canvas, true, aa);
    try { await w.init(); return w; } catch (e) {
      console.warn(`taildefense: WebGL2 init failed (antialias ${aa})`, e);
      err = e;
      canvas.remove();
    }
  }
  throw new Error(probeWebGL2() ? `WebGL2 failed to start: ${(err as Error)?.message ?? err}` : NO_WEBGL2);
}

// NO_WEBGL2 explains a browser that gives no WebGL2 context at all, three.js's least backend.
const NO_WEBGL2 = 'This browser has no WebGL2. Use a current Chrome, Firefox or Safari (15 or newer) '
  + 'and turn on hardware acceleration (in Chrome: Settings, System, "Use graphics acceleration"; '
  + 'chrome://gpu shows what is blocked).';

function probeWebGL2(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return !!gl;
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const P = params();
  // The boot splash covers loading; #nosplash skips it, #splash=1.4 holds it at 1.4 s in.
  const splash = P.has('nosplash') ? null : new Splash(document.body, P.has('splash') ? Number(P.get('splash')) || 0 : -1);
  // #lab poses every creep and survivor animation side by side on the demo's world.
  const labMode = P.has('lab');
  let lab: Lab | null = null;
  let demoKit: TdDemo | null = null, demoHost: DemoHost | null = null;
  const demo = P.has('demo') || labMode;
  // The browser's shortcuts and menus kept off a real game; the demo, the lab and #dev keep
  // them, DevTools above all.
  const kiosk = demo || P.has('dev') ? null : new Kiosk();
  let lostBefore = false;
  try { lostBefore = sessionStorage.getItem('td.webgl') === '1'; } catch { /* storage blocked */ }
  splash?.progress(0.05);
  const world = await makeWorld(app, P.has('webgl') || lostBefore);
  splash?.progress(0.15);
  const canvas = world.renderer.domElement;
  const game = new Game();
  const terrain = new Terrain(world.scene);
  const structs = new Structs(world.scene);
  const creeps = new Creeps(world.scene);
  const heroes = new Heroes(world.scene);
  const loot = new Loot(world.scene);
  const guns = new Guns(world.scene);
  const effects = new Effects(world.scene);
  const helis = new Helis(world.scene, effects);
  const fow = new FogOfWar(world.scene);
  creeps.onBlow = (x, y, k, h, r) => effects.blow(x, y, k, h, r);
  creeps.onGib = (x, y) => effects.gib(x, y);
  const weather = new Weather(world.scene);
  world.look = weather.look;
  const overlays = new Overlays(world.scene, structs);
  const routes = new Routes();
  const rig = new CameraRig(world.camera, canvas);
  let transport: Transport | null = null;
  const send: Controller['send'] = (c) => transport?.send(c);
  const ctl = new Controller(game, send, rig, effects);
  const labels = new Labels(app);
  const hud = new Hud(app, ctl);
  hud.leaving = () => helis.leaving(game);
  // Reloading from the cover is the player's choice: no leave prompt for it.
  hud.cover.onReload = () => { if (kiosk) kiosk.armed = false; location.reload(); };
  const portraits = new Portraits(world.renderer, world.backend === 'WebGL2');
  hud.setPortraits(portraits);
  // Silent until the welcome says this machine's VOLUME; the demo takes #vol=N, else 70.
  const sound = new Sound(0);
  // The demo and the lab leave the sound engine where a browser test can read it.
  if (demo) (window as unknown as { tdSound: Sound }).tdSound = sound;
  const toast = (t: string, l: number) => { hud.toast(t, l); if (l === 2) sound.ui('radio_error', 0.45, 0.3); };
  ctl.onToast = toast;
  ctl.onCue = (c, x, y, key) => { const me = game.me(); if (me) sound.local(c, me, x, y, key); };
  hud.onVolume = (v, save) => { sound.synth.setVolume(v); if (save && !demo) send({ op: 'volume', v }); };
  hud.onMusic = (v, save) => { sound.music.setMusic(v); if (save && !demo) send({ op: 'music', v }); };
  const input = new Input(canvas, ctl, rig, hud);
  // A lost WebGPU device reloads once on WebGL2 (kept for this tab's session) instead of looping.
  world.onDeviceLost((msg) => {
    console.warn('taildefense: GPU device lost:', msg);
    hud.toast('GPU device lost; restarting on WebGL2', 2);
    try { sessionStorage.setItem('td.webgl', '1'); } catch { /* storage blocked */ }
    if (kiosk) kiosk.armed = false;
    setTimeout(() => location.reload(), 1200);
  });

  let centredOnHero = false;
  let hooksApplied = false;
  let warm = 0; // 0 not started, 1 building the shaders, 2 done
  let covered = !!splash;
  void splash?.done.then(() => { covered = false; });
  const turretHeight = (x: number, y: number) => {
    const s = game.structAtTile(Math.floor(x), Math.floor(y));
    const k = s >= 0 ? game.cur.sKind[s] : 0;
    return k === K_GUN ? 0.75 : k === K_CANNON ? 0.86 : k === K_FROST ? 1.5 : k === K_TESLA ? 1.6 : k === K_SNIPER ? 2.02 : k === K_MISSILE ? 0.95 : 1.0;
  };

  const handlers: Handlers = {
    onWelcome(w: Welcome) {
      splash?.progress(0.25);
      game.reset(w);
      sound.reset();
      const vol = w.volume ?? (P.has('vol') ? Number(P.get('vol')) : 70);
      sound.synth.setVolume(vol);
      hud.setVolume(sound.synth.volume);
      sound.music.setMusic(w.music ?? (P.has('music') ? Number(P.get('music')) : 50));
      hud.setMusic(sound.music.level);
      creeps.setup(w.creeps);
      structs.setup(w.structs);
      loot.setup(w.sites);
      heroes.clear();
      guns.clear();
      rig.setMap(w.w, w.h);
      rig.center(w.core.x, w.core.y);
      centredOnHero = false;
      ctl.sel = null;
      ctl.setMode({ k: 'none' });
      ctl.pending.length = 0;
      hud.buildCard = false;
      // A first game on this machine opens with the first steps; #firstrun shows them anyway.
      if (P.has('firstrun')) hud.showFirstRun(true);
      else if (!demo) hud.showFirstRun();
    },
    onTerrain(t) {
      game.setTerrain(t);
      terrain.build(game.tiles, game.w, game.h, game.welcome?.sites ?? []);
      splash?.progress(0.35);
    },
    onFrame(buf) {
      if (!game.welcome) return;
      const f = game.applyFrame(buf, performance.now());
      sound.onFrame(game);
      sound.music.onFrame(game);
      effects.onFrame(game, turretHeight, (x0, y0, x1, y1) => structs.onShot(game, x0, y0, x1, y1, performance.now()));
      for (const n of f.notes) hud.note(n.level, n.text);
      for (const g of f.pings) effects.teamPing(g.x, g.y, g.kind === PingKind.Danger ? 0xff5a3c : playerColor(g.player));
      ctl.tickArmory();
      if (!centredOnHero) {
        const me = game.me();
        if (me) { rig.center(me.x, me.y); centredOnHero = true; }
      }
    },
    onText(m) {
      if (m.t === 'toast') toast(m.text, m.level);
      else if (m.t === 'status') hud.status(m.text);
      else if (m.t === 'difficulty') game.setDifficulty(m.difficulty, m.dark, m.cone);
      else if (m.t === 'net') { game.rtt = m.rtt; game.rttAvg = Number.isNaN(game.rttAvg) ? m.rtt : game.rttAvg * 0.8 + m.rtt * 0.2; }
    },
    onConn(state, detail) {
      hud.setConn(state, detail);
      if (kiosk) kiosk.armed = state !== 'ended';
    },
  };

  if (demo) {
    const opt: DemoOptions = {
      creeps: labMode ? 0 : Math.max(0, Math.min(16000, Number(P.get('creeps') ?? 3000) || 0)),
      phase: labMode ? 'build' : (P.get('phase') as DemoOptions['phase']) || 'wave',
      wave: Number(P.get('wave') ?? 7) || 7,
      gold: Number(P.get('gold') ?? 2400) || 0,
      weather: P.has('weather') ? Number(P.get('weather')) : -1,
      down: P.has('down'),
      coreHp: P.has('corehp') ? Number(P.get('corehp')) : 1,
      drop: P.has('drop'),
      fog: P.has('fog'),
      evac: P.has('evac'),
    };
    demoKit = await loadDemo();
    // #lab=sound: the sound bench over the lab.
    if (labMode && P.get('lab') === 'sound') new demoKit.SoundLab(sound, document.body);
    demoHost = new demoKit.DemoHost(handlers, opt);
    transport = demoHost;
    // #demo&shot: the report's picture is kept on the page, for a look at it.
    if (P.has('shot')) hud.keepShot = async (png) => { (window as unknown as { shot: string }).shot = URL.createObjectURL(png); return 'the page'; };
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // The token is the hash's first part; testing flags may follow it after '&'.
    const token = location.hash.slice(1).split('&')[0];
    transport = new WsTransport(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`, handlers);
    hud.keepShot = async (png, wave) => {
      const r = await fetch(`/shot?token=${encodeURIComponent(token)}&wave=${wave}`, { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
      if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
      return ((await r.json()) as { path: string }).path;
    };
  }

  // Screenshot and testing hooks, applied once the first frame is in.
  const applyHooks = () => {
    hooksApplied = true;
    const cam = P.get('cam');
    if (cam) {
      const [x, y, yaw, d] = cam.split(',').map(Number);
      rig.follow = false;
      if (Number.isFinite(x) && Number.isFinite(y)) rig.center(x, y);
      if (Number.isFinite(yaw)) rig.setYaw(yaw * Math.PI / 180);
      if (Number.isFinite(d)) rig.setDist(d);
    }
    const mouse = P.get('mouse');
    if (mouse !== undefined || P.has('build')) {
      const [mx, my] = (mouse || '').split(',').map(Number);
      ctl.mx = Number.isFinite(mx) ? mx : window.innerWidth / 2;
      ctl.my = Number.isFinite(my) ? my : window.innerHeight / 2 - 60;
      ctl.mouseIn = true;
    }
    if (P.has('build')) { hud.buildCard = true; const k = Number(P.get('build')); if (k) ctl.startBuild(k); }
    if (P.has('armory')) ctl.openArmory(true);
    if (P.has('help')) hud.toggleHelp();
    if (P.has('score')) hud.showScore(true);
    if (P.has('menu')) hud.toggleMenu();
    if (P.has('f3')) hud.toggleStats();
    const sel = P.get('sel');
    if (sel) {
      const [t, id] = sel.split(':');
      if (t === 'struct' || t === 'creep' || t === 'hero') ctl.sel = { t, id: Number(id) };
      if (t === 'turret') {
        const f = game.cur;
        for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] >= K_GUN) { ctl.sel = { t: 'struct', id: i }; break; }
      }
      // kind:N, the first structure of kind N, with the view on it unless cam says otherwise.
      if (t === 'kind') {
        const f = game.cur;
        for (let i = 0; i < f.nStructs; i++) {
          if (!f.sAlive[i] || f.sKind[i] !== Number(id)) continue;
          ctl.sel = { t: 'struct', id: i };
          if (!cam) { rig.follow = false; rig.center(f.sX[i] + f.sW[i] / 2, f.sY[i] + f.sH[i] / 2); rig.setDist(14); }
          break;
        }
      }
    }
  };
  (window as unknown as { td: unknown }).td = { game, ctl, rig, hud, world, heroes, helis, sound, get transport() { return transport; } };

  // The 8-bit view: #px=N or the saved choice sets the block size, 0 turns it off, F4 toggles.
  let pixelPref = 'auto';
  try { pixelPref = localStorage.getItem('td.pixel') ?? 'auto'; } catch { /* storage blocked */ }
  if (P.has('px')) pixelPref = P.get('px') || 'auto';
  const pixelFor = (h: number) => (pixelPref === 'off' || pixelPref === '0' ? 0 : Number(pixelPref) > 0 ? Number(pixelPref) : World.autoPixel(h));
  input.onRetroToggle = () => {
    pixelPref = world.pixel > 0 ? 'off' : 'auto';
    try { localStorage.setItem('td.pixel', pixelPref); } catch { /* storage blocked */ }
    world.setPixel(pixelFor(window.innerHeight));
    hud.toast(world.pixel > 0 ? 'Pixel view on (F4)' : 'Pixel view off (F4)', 0);
  };
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    if (world.pixel !== pixelFor(h) || !world.retro) world.setPixel(pixelFor(h));
    world.resize(w, h);
    labels.resize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  let fpsAvg = 60, msAvg = 16;
  let hoverStruct = -1, hoverHero = -1, hoverLoot = false, hoverRevive = false;
  // A green "+" over a downed teammate (body.cur-revive too, should app.css want to style it).
  const REVIVE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M12 4h8v8h8v8h-8v8h-8v-8H4v-8h8z' fill='%2350ff80' stroke='%23000' stroke-width='2'/%3E%3C/svg%3E") 16 16, pointer`;
  const loop = () => {
    const now = performance.now();
    const rawDt = Math.max(0.0005, (now - last) / 1000);
    const dt = Math.min(0.1, rawDt);
    last = now;
    if (demoHost && !lab) demoHost.pump();
    const W = window.innerWidth, H = window.innerHeight;
    const wd = game.welcome;
    if (wd && game.frames > 1) {
      if (!hooksApplied && game.cur.nPlayers > 0) applyHooks();
      if (labMode && !lab) {
        lab = new demoKit!.Lab(game, wd.core.x, wd.core.y, P.has('gun') ? Number(P.get('gun')) : -1);
        demoHost!.halt();
        const [lx, ly] = lab.center(P.get('lab') ?? '');
        rig.follow = false; rig.center(lx, ly); rig.setDist(Number(P.get('dist')) || 26);
        if (P.has('yaw')) rig.setYaw(Number(P.get('yaw')) * Math.PI / 180);
      }
      if (lab) {
        if (lab.step(now)) effects.onFrame(game, turretHeight, (x0, y0, x1, y1) => structs.onShot(game, x0, y0, x1, y1, now));
      } else game.interpolate(now);
      const me = game.me();
      if (me && (me.flags & PF_ALIVE) && !lab) rig.track(game.prx[me.id], game.pry[me.id]);
      // Aboard the evac Huey, and for everyone as it lifts off, the camera rides with it, panned
      // away or not.
      const ride = me?.aboard || game.cur.evac === EvacStage.Departing ? helis.evacAt() : null;
      if (ride) rig.center(ride.x, ride.y, true);
    }
    input.update(dt, W, H);
    rig.update(dt);
    sound.listen(game, world.camera, rig.tx, rig.tz, rig.dist);
    world.followSun(rig.tx, rig.tz, rig.span());
    // Not while the shaders warm: every prop has to be drawn once for that.
    if (warm === 2) terrain.cull(world.camera);
    weather.update(game, dt, world.camera, rig.tx, rig.tz, rig.dist);
    world.setFog(rig.dist);
    if (wd) {
      // Waves are fought at dusk.
      const me = game.me();
      const goal = game.cur.phase === Phase.Wave || game.cur.phase === Phase.Evac ? 1 : 0;
      const m = world.night + (goal - world.night) * Math.min(1, dt * 0.6);
      const alive = !!me && (me.flags & PF_ALIVE) !== 0;
      world.setMood(m, me ? game.prx[me.id] : 0, me ? game.pry[me.id] : 0, me ? game.paim[me.id] : 0, alive && !me!.goggles, wd.core.x, wd.core.y);
      effects.dark = Math.min(1, Math.max(m, weather.look.dark));
    }
    ctl.updateMouse(W, H);

    if (wd) {
      // Hover highlight.
      const h = ctl.hover;
      const hs = hovered('struct'), hh = hovered('hero');
      if (hs !== hoverStruct) { structs.setHover(hoverStruct, false); structs.setHover(hs, true); hoverStruct = hs; }
      if (hh !== hoverHero) { heroes.setHover(hoverHero, false); heroes.setHover(hh, true); hoverHero = hh; }
      creeps.hovered = hovered('creep');
      const loots = ((h?.t === 'site' && !game.cur.siteSearched(h.id)) || h?.t === 'gun') && ctl.mode.k === 'none';
      guns.hovered = hovered('gun');
      if (loots !== hoverLoot) { document.body.classList.toggle('cur-loot', loots); hoverLoot = loots; }
      const revives = ctl.reviveTarget() >= 0;
      if (revives !== hoverRevive) { document.body.classList.toggle('cur-revive', revives); canvas.style.cursor = revives ? REVIVE_CURSOR : ''; hoverRevive = revives; }
      updateOverlays();
      creeps.update(game, now, dt, world.camera);
      structs.update(game, now, dt);
      heroes.update(game, now, dt, world.camera);
      loot.update(game, now);
      guns.update(game, now);
      effects.update(game, world.camera, dt);
      helis.update(game, now, dt);
      fow.update(game, dt, rig.tx, rig.tz);
    }
    // The shaders are built behind the splash once the first frame has filled the scene, and
    // nothing is drawn until they are: drawing would build what is left all at once.
    if (wd && game.frames > 1 && warm === 0) {
      warm = 1;
      splash?.progress(0.4);
      const p = world.warm((f) => splash?.progress(0.4 + 0.6 * f))
        .catch((e) => console.warn('taildefense: shader warm-up failed', e));
      // Should it hang, the game shows anyway, shaders or not.
      void Promise.race([p, new Promise((ok) => setTimeout(ok, 20000))]).then(() => { warm = 2; });
      splash?.holdFor(p);
    }
    // Before the game arrives only the empty world shows, and not behind the splash: drawing it
    // there would only build its shaders while the page waits.
    if (warm === 2 || (!wd && !covered)) world.render();
    if (wd) {
      const sel = ctl.sel;
      labels.draw(game, world.camera, {
        hoverStruct: hovered('struct'), selStruct: sel?.t === 'struct' ? sel.id : -1,
        hoverCreep: hovered('creep'), selCreep: sel?.t === 'creep' ? sel.id : -1,
        showAllBars: ctl.mode.k === 'build',
        hoverSite: hovered('site'), siteHint: ctl.hover?.t === 'site' ? ctl.siteHint(ctl.hover.id) : '',
        dropHold: ctl.dropAt ? Math.min(1, (now - ctl.dropAt) / DROP_HOLD) : 0,
        hoverGun: hovered('gun'), gunHint: ctl.hover?.t === 'gun' ? ctl.gunHint(ctl.hover.id) : '',
      }, now, rig.dist, (x, z) => fow.clarity(x, z));
      hud.minimap.draw(now, W, H);
      // The portraits share the renderer, which the shader warm-up has to itself.
      if (warm === 2) portraits.update(game, now, dt, rig.yaw);
      hud.update(now);
    }
    const ms = performance.now() - now;
    fpsAvg = fpsAvg * 0.9 + (1 / rawDt) * 0.1;
    msAvg = msAvg * 0.95 + ms * 0.05;
    if (hud.statsVisible()) {
      const info = world.renderer.info;
      hud.setStats([
        `${world.backend}`,
        `fps   ${fpsAvg.toFixed(0)}`,
        `cpu   ${msAvg.toFixed(1)} ms`,
        `creeps ${game.cur.nCreeps}`,
        `draws ${info.render.drawCalls}`,
        `tris  ${(info.render.triangles / 1000).toFixed(0)}k`,
        `frame ${game.cur.tick}  ${game.interval.toFixed(0)} ms`,
        `ping  ${Number.isNaN(game.rtt) ? '-' : `${game.rtt.toFixed(0)} ms  avg ${game.rttAvg.toFixed(0)}`}`,
        `sound ${sound.synth.readout()}`,
        sound.music.readout(),
      ].join('\n'));
    }
  };
  // The id of what the cursor is on, if it is of this kind.
  const hovered = (t: NonNullable<typeof ctl.hover>['t']) => (ctl.hover?.t === t ? ctl.hover.id : -1);

  const updateOverlays = () => {
    const wd = game.welcome!, f = game.cur, me = game.me();
    const m = ctl.mode;
    const hx = me ? game.prx[me.id] : 0, hy = me ? game.pry[me.id] : 0;
    // Build mode: radius and ghost.
    // The creeps' way in through the maze, while building or with a gate picked out: with
    // the ghost standing, and how much longer or shorter it makes their walk.
    let ghost: { tx: number; ty: number; w: number; h: number; floor?: boolean } | undefined;
    if (m.k === 'build' && ctl.groundOk) {
      const t = ctl.buildTile(m.kind), ok = ctl.canPlace(m.kind, t.tx, t.ty) === '';
      overlays.buildGhost(m.kind, t.tx, t.ty, t.w, t.h, ok);
      if (ok) ghost = { ...t, floor: wd.structs[m.kind]?.floor };
    } else overlays.buildGhost(-1);
    const gatePick = (ctl.sel?.t === 'struct' && f.sKind[ctl.sel.id] === K_GATE) || (ctl.hover?.t === 'struct' && f.sKind[ctl.hover.id] === K_GATE);
    if (m.k === 'build' || gatePick) {
      const { now, then } = routes.get(game, ghost);
      const r = then ?? now;
      overlays.route(r.paths, (i) => [routes.tileX(i), routes.tileY(i)], r.walk < 0 ? 0xff3020 : 0xff8a3a);
      const d = then && now.walk >= 0 && then.walk >= 0 ? Math.round(then.walk - now.walk) : 0;
      ctl.routeNote = r.walk < 0 ? (then && now.walk >= 0 ? 'this seals the base: the dead will break in through the walls' : 'the base is sealed: the dead break in through the walls')
        : `the dead walk ~${Math.round(r.walk)} tiles in${d ? ` (${d > 0 ? '+' : ''}${d})` : ''}`;
    } else { overlays.route(null); ctl.routeNote = ''; }
    overlays.ring('build', m.k === 'build', wd.core.x, wd.core.y, wd.buildRadius, 0xffd860, 0.7);
    // Aiming the grenade: its range around the hero and the blast at the cursor.
    if (m.k === 'ability' && me) {
      const a = ctl.ability(m.slot);
      const range = a?.range ?? 0;
      overlays.ring('range', range > 0, hx, hy, range, 0x80c8ff, 0.7);
      const inRange = range <= 0 || Math.hypot(ctl.ground.x - hx, ctl.ground.z - hy) <= range;
      overlays.areaPreview(ctl.groundOk && (a?.radius ?? 0) > 0, ctl.ground.x, ctl.ground.z, a?.radius ?? 1, inRange ? 0xff7040 : 0x808080);
    } else { overlays.ring('range', false); overlays.areaPreview(false); }
    // The outlines of what the creeps destroyed, to rebuild between waves.
    overlays.ruins(f);
    // What was just placed, until its frame comes in.
    ctl.prunePending(performance.now());
    overlays.pending(ctl.pending);
    // Selection and hover rings, and a turret's range.
    const ringFor = (p: typeof ctl.sel, name: 'sel' | 'hover') => {
      if (!p) { overlays.ring(name, false); return; }
      let x = 0, y = 0, r = 0.7, col = 0xffd860;
      if (p.t === 'creep') {
        const i = game.indexById[p.id];
        if (i < 0) { overlays.ring(name, false); return; }
        x = game.rx[i]; y = game.ry[i]; r = (wd.creeps[f.cKind[i]]?.radius ?? 0.45) + 0.25; col = 0xff4030;
      } else if (p.t === 'site') {
        const s = wd.sites[p.id];
        x = siteX(s); y = siteY(s); r = s.kind === SiteKind.Plane ? 6.2 : s.kind === SiteKind.Bus ? 1.7 : s.kind === SiteKind.Army || s.kind === SiteKind.Ambulance || s.kind === SiteKind.Fire || s.kind === SiteKind.Camper ? 1.3 : s.kind === SiteKind.Moto ? 0.7 : wreck(s.kind) ? 1.05 : 0.85; col = f.siteSearched(p.id) ? 0xa0a098 : 0xffd040;
      } else if (p.t === 'gun') {
        const k = f.guns.find((g) => g.id === p.id);
        if (!k) { overlays.ring(name, false); return; }
        x = k.x; y = k.y; r = 0.7; col = 0xffd040;
      } else if (p.t === 'hero') {
        x = game.prx[p.id]; y = game.pry[p.id]; r = 0.75; col = p.id === wd.you ? 0x50ff70 : 0x50c0ff;
      } else {
        x = f.sX[p.id] + f.sW[p.id] / 2; y = f.sY[p.id] + f.sH[p.id] / 2; r = Math.max(f.sW[p.id], f.sH[p.id]) * 0.75 + 0.1;
        col = me && f.sOwner[p.id] === me.id ? 0x50ff70 : f.sOwner[p.id] < 0 ? 0xffd860 : 0x50c0ff;
      }
      overlays.ring(name, true, x, y, r, col, name === 'sel' ? 0.95 : 0.5);
    };
    ringFor(ctl.sel, 'sel');
    ringFor(ctl.hover && (ctl.hover.t !== ctl.sel?.t || ctl.hover.id !== ctl.sel?.id) ? ctl.hover : null, 'hover');
    const tsel = ctl.sel?.t === 'struct' ? ctl.sel.id : ctl.hover?.t === 'struct' ? ctl.hover.id : -1;
    const td = tsel >= 0 ? wd.structs[f.sKind[tsel]] : undefined;
    const bk = m.k === 'build' ? m.kind : -1;
    const gd = bk >= 0 ? wd.structs[bk] : undefined;
    if (gd?.turret && ctl.groundOk) {
      const t = ctl.buildTile(bk);
      overlays.ring('turret', true, t.tx + t.w / 2, t.ty + t.h / 2, gd.range, 0xffffff, 0.45);
    } else if (td?.turret) overlays.ring('turret', true, f.sX[tsel] + 0.5 * f.sW[tsel], f.sY[tsel] + 0.5 * f.sH[tsel], turretRange(td, f.sLv[tsel * TURRET_TRACKS + TTrack.Range], f.sEvo[tsel]), 0xffffff, 0.45);
    else overlays.ring('turret', false);
    const arm = ctl.armoryCenter();
    overlays.ring('shop', !!arm && ctl.armoryOpen && !!me && !(me.flags & PF_ARMORY), arm?.x ?? 0, arm?.y ?? 0, wd.shopRadius, 0xe0b030, 0.6);
  };

  world.renderer.setAnimationLoop(loop);
}

main().catch((e) => {
  console.error(e);
  const d = document.createElement('div');
  d.className = 'cover';
  d.innerHTML = `<h1>taildefense</h1><div class="big bad">Could not start the 3D view</div><div class="what"></div><div class="row"><button class="primary">Try again</button></div>`;
  (d.querySelector('.what') as HTMLElement).textContent = String(e?.message ?? e);
  (d.querySelector('button') as HTMLButtonElement).onclick = () => location.reload();
  document.body.appendChild(d);
});
