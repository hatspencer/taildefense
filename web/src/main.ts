import { CameraRig } from './camera';
import { Controller } from './controller';
import { DemoHost, type DemoOptions } from './demo/host';
import { Hud } from './hud/hud';
import { Labels } from './hud/labels';
import { Splash } from './hud/splash';
import { Input } from './input';
import { Lab } from './lab';
import { type Handlers, type Transport, WsTransport } from './net';
import { PF_ALIVE, PF_ARMORY, Phase, PingKind, SiteKind, siteX, siteY, turretRange, type Welcome, wreck } from './protocol';
import { Creeps } from './scene/creeps';
import { Effects } from './scene/effects';
import { Helis } from './scene/heli';
import { Heroes } from './scene/heroes';
import { Portraits } from './scene/portraits';
import { Loot } from './scene/loot';
import { Overlays } from './scene/overlays';
import { K_CANNON, K_FROST, K_GUN, K_TESLA, Structs } from './scene/structs';
import { FogOfWar } from './scene/fow';
import { Terrain } from './scene/terrain';
import { Weather } from './scene/weather';
import { playerColor } from './scene/util';
import { World } from './scene/world';
import { Game } from './state';

// #demo&drop&fog&weather=3&down&corehp=0.3&creeps=5000&phase=build&cam=x,y,yawDeg,dist&build=5&armory&help&score&shot&f3&sel=struct:12&mouse=x,y&webgl
function params(): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of location.hash.slice(1).split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    m.set(i < 0 ? part : part.slice(0, i), i < 0 ? '' : decodeURIComponent(part.slice(i + 1)));
  }
  return m;
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
  // A fresh canvas: one that already handed out a WebGPU context cannot give a WebGL one.
  const w = new World(mk(), true);
  await w.init();
  return w;
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const P = params();
  // The boot splash covers loading; #nosplash skips it, #splash=1.4 holds it at 1.4 s in.
  const splash = P.has('nosplash') ? null : new Splash(document.body, P.has('splash') ? Number(P.get('splash')) || 0 : -1);
  // #lab poses every creep and survivor animation side by side on the demo's world.
  const labMode = P.has('lab');
  let lab: Lab | null = null;
  const demo = P.has('demo') || labMode;
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
  const effects = new Effects(world.scene);
  const helis = new Helis(world.scene, effects);
  const fow = new FogOfWar(world.scene);
  creeps.onBlow = (x, y, k, h, r) => effects.blow(x, y, k, h, r);
  creeps.onGib = (x, y) => effects.gib(x, y);
  const weather = new Weather(world.scene);
  world.look = weather.look;
  const overlays = new Overlays(world.scene, structs);
  const rig = new CameraRig(world.camera, canvas);
  let transport: Transport | null = null;
  const send: Controller['send'] = (c) => transport?.send(c);
  const ctl = new Controller(game, send, rig, effects);
  const labels = new Labels(app);
  const hud = new Hud(app, ctl);
  const portraits = new Portraits(world.renderer, world.backend === 'WebGL2');
  hud.setPortraits(portraits);
  ctl.onToast = (t, l) => hud.toast(t, l);
  const input = new Input(canvas, ctl, rig, hud);
  // A lost WebGPU device reloads once on WebGL2 (kept for this tab's session) instead of looping.
  world.onDeviceLost((msg) => {
    console.warn('taildefense: GPU device lost:', msg);
    hud.toast('GPU device lost; restarting on WebGL2', 2);
    try { sessionStorage.setItem('td.webgl', '1'); } catch { /* storage blocked */ }
    setTimeout(() => location.reload(), 1200);
  });

  let centredOnHero = false;
  let hooksApplied = false;
  let warm = 0; // 0 not started, 1 building the shaders, 2 done
  const turretHeight = (x: number, y: number) => {
    const s = game.structAtTile(Math.floor(x), Math.floor(y));
    const k = s >= 0 ? game.cur.sKind[s] : 0;
    return k === K_GUN ? 0.75 : k === K_CANNON ? 0.86 : k === K_FROST ? 1.5 : k === K_TESLA ? 1.6 : 1.0;
  };

  const handlers: Handlers = {
    onWelcome(w: Welcome) {
      splash?.progress(0.25);
      game.reset(w);
      creeps.setup(w.creeps);
      structs.setup(w.structs);
      loot.setup(w.sites);
      heroes.clear();
      rig.setMap(w.w, w.h);
      rig.center(w.core.x, w.core.y);
      centredOnHero = false;
      ctl.sel = null;
      ctl.setMode({ k: 'none' });
      hud.buildCard = false;
    },
    onTerrain(t) {
      game.setTerrain(t);
      terrain.build(game.tiles, game.w, game.h);
      splash?.progress(0.35);
    },
    onFrame(buf) {
      if (!game.welcome) return;
      const f = game.applyFrame(buf, performance.now());
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
      if (m.t === 'toast') hud.toast(m.text, m.level);
      else if (m.t === 'status') hud.status(m.text);
    },
    onConn(state, detail) { hud.setConn(state, detail); },
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
    };
    transport = new DemoHost(handlers, opt);
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
    if (mouse !== undefined || P.has('build') || P.has('ability')) {
      const [mx, my] = (mouse || '').split(',').map(Number);
      ctl.mx = Number.isFinite(mx) ? mx : window.innerWidth / 2;
      ctl.my = Number.isFinite(my) ? my : window.innerHeight / 2 - 60;
      ctl.mouseIn = true;
    }
    if (P.has('build')) { hud.buildCard = true; const k = Number(P.get('build')); if (k) ctl.startBuild(k); }
    if (P.has('ability')) ctl.startAbility(Number(P.get('ability')) || 1);
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
    }
  };
  (window as unknown as { td: unknown }).td = { game, ctl, rig, hud, world, heroes, helis, get transport() { return transport; } };

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
    if (transport instanceof DemoHost && !lab) transport.pump();
    const W = window.innerWidth, H = window.innerHeight;
    const wd = game.welcome;
    if (wd && game.frames > 1) {
      if (!hooksApplied && game.cur.nPlayers > 0) applyHooks();
      if (labMode && !lab) {
        lab = new Lab(game, wd.core.x, wd.core.y);
        (transport as DemoHost).halt();
        const [lx, ly] = lab.center(P.get('lab') ?? '');
        rig.follow = false; rig.center(lx, ly); rig.setDist(Number(P.get('dist')) || 26);
      }
      if (lab) lab.step(now); else game.interpolate(now);
      const me = game.me();
      if (me && (me.flags & PF_ALIVE) && !lab) rig.track(game.prx[me.id], game.pry[me.id]);
    }
    input.update(dt, W, H);
    rig.update(dt);
    world.followSun(rig.tx, rig.tz, rig.span());
    weather.update(game, dt, world.camera, rig.tx, rig.tz, rig.dist);
    world.setFog(rig.dist);
    if (wd) {
      // Waves are fought at dusk.
      const me = game.me();
      const goal = game.cur.phase === Phase.Wave ? 1 : 0;
      const m = world.night + (goal - world.night) * Math.min(1, dt * 0.6);
      const alive = !!me && (me.flags & PF_ALIVE) !== 0;
      world.setMood(m, me ? game.prx[me.id] : 0, me ? game.pry[me.id] : 0, me ? game.paim[me.id] : 0, alive, wd.core.x, wd.core.y);
      effects.dark = Math.min(1, Math.max(m, weather.look.dark));
    }
    ctl.updateMouse(W, H);

    if (wd) {
      // Hover highlight.
      const h = ctl.hover;
      const hs = h?.t === 'struct' ? h.id : -1, hh = h?.t === 'hero' ? h.id : -1;
      if (hs !== hoverStruct) { structs.setHover(hoverStruct, false); structs.setHover(hs, true); hoverStruct = hs; }
      if (hh !== hoverHero) { heroes.setHover(hoverHero, false); heroes.setHover(hh, true); hoverHero = hh; }
      creeps.hovered = h?.t === 'creep' ? h.id : -1;
      const loots = h?.t === 'site' && ctl.mode.k === 'none' && !game.cur.siteSearched(h.id);
      if (loots !== hoverLoot) { document.body.classList.toggle('cur-loot', loots); hoverLoot = loots; }
      const revives = ctl.reviveTarget() >= 0;
      if (revives !== hoverRevive) { document.body.classList.toggle('cur-revive', revives); canvas.style.cursor = revives ? REVIVE_CURSOR : ''; hoverRevive = revives; }
      updateOverlays();
      creeps.update(game, now, dt, world.camera);
      structs.update(game, now, dt);
      heroes.update(game, now, dt, world.camera);
      loot.update(game, now);
      effects.update(game, world.camera, dt);
      helis.update(game, now, dt);
      fow.update(game, dt);
    }
    // The shaders are built behind the splash once the first frame has filled the scene, and
    // nothing is drawn until they are: drawing would build what is left all at once.
    if (wd && game.frames > 1 && warm === 0) {
      warm = 1;
      splash?.progress(0.4);
      // Then one real frame behind the splash, for the shadow passes, which three cannot
      // build ahead: whatever that costs is spent on the finished splash, not the game.
      const p = world.warm((f) => splash?.progress(0.4 + 0.5 * f))
        .then(() => new Promise<void>((ok) => requestAnimationFrame(() => { world.render(); splash?.progress(1); ok(); })))
        .catch((e) => console.warn('taildefense: shader warm-up failed', e));
      // Should it hang, the game shows anyway, shaders or not.
      void Promise.race([p, new Promise((ok) => setTimeout(ok, 20000))]).then(() => { warm = 2; });
      splash?.holdFor(p);
    }
    if (warm === 2 || !wd) world.render();
    if (wd) {
      const sel = ctl.sel;
      labels.draw(game, world.camera, {
        hoverStruct: hs(), selStruct: sel?.t === 'struct' ? sel.id : -1,
        hoverCreep: ctl.hover?.t === 'creep' ? ctl.hover.id : -1, selCreep: sel?.t === 'creep' ? sel.id : -1,
        showAllBars: ctl.mode.k === 'build',
        hoverSite: ctl.hover?.t === 'site' ? ctl.hover.id : -1, siteHint: ctl.hover?.t === 'site' ? ctl.siteHint(ctl.hover.id) : '',
      }, now, rig.dist);
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
      ].join('\n'));
    }
  };
  const hs = () => (ctl.hover?.t === 'struct' ? ctl.hover.id : -1);

  const updateOverlays = () => {
    const wd = game.welcome!, f = game.cur, me = game.me();
    const m = ctl.mode;
    const hx = me ? game.prx[me.id] : 0, hy = me ? game.pry[me.id] : 0;
    // Build mode: radius and ghost.
    if (m.k === 'build' && ctl.groundOk) {
      const t = ctl.buildTile(m.kind);
      overlays.buildGhost(m.kind, t.tx, t.ty, t.w, t.h, ctl.canPlace(m.kind, t.tx, t.ty) === '');
    } else overlays.buildGhost(-1);
    overlays.ring('build', m.k === 'build', wd.core.x, wd.core.y, wd.buildRadius, 0xffd860, 0.7);
    // Ability targeting: range around the hero and the area at the cursor.
    if (m.k === 'ability' && me) {
      const a = ctl.ability(m.slot);
      const range = a?.range ?? 0;
      overlays.ring('range', range > 0, hx, hy, range, 0x80c8ff, 0.7);
      const inRange = range <= 0 || Math.hypot(ctl.ground.x - hx, ctl.ground.z - hy) <= range;
      overlays.areaPreview(ctl.groundOk && (a?.radius ?? 0) > 0, ctl.ground.x, ctl.ground.z, a?.radius ?? 1, inRange ? 0xff7040 : 0x808080);
    } else { overlays.ring('range', false); overlays.areaPreview(false); }
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
        x = siteX(s); y = siteY(s); r = s.kind === SiteKind.Bus ? 1.7 : s.kind === SiteKind.Army || s.kind === SiteKind.Ambulance ? 1.3 : wreck(s.kind) ? 1.05 : 0.85; col = f.siteSearched(p.id) ? 0xa0a098 : 0xffd040;
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
    } else if (td?.turret) overlays.ring('turret', true, f.sX[tsel] + 0.5 * f.sW[tsel], f.sY[tsel] + 0.5 * f.sH[tsel], turretRange(td, f.sLevel[tsel]), 0xffffff, 0.45);
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
  d.innerHTML = `<h1>taildefense</h1><div class="big">Could not start the 3D view</div><div class="muted"></div>`;
  (d.lastChild as HTMLElement).textContent = String(e?.message ?? e);
  document.body.appendChild(d);
});
