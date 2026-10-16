# Development

Everything builds and runs in containers through `./build.sh`; neither Go nor Node is installed
on the host. The README lists its targets.

## Playtests

`internal/playtest` plays whole games with nobody at the keys. Bots shop, build, loot, fight,
revive and taunt through the host's own command path (`netplay.Exec`). After every tick it
checks the world's invariants (`game.World.Check`), rebuilds a client replica from the wire to
see it agrees, and fails a wave that won't end. A game is its seed and its command log, so it
replays tick for tick. The golden game's world hash is kept in
`internal/playtest/testdata/golden.txt`: any change to how the game plays fails it until it is
rewritten with `./build.sh golden`, so the diff shows the change was intended. A soak failure
prints a `TD_SOAK_ONE=…` line that plays that game again.

## The client

The client source is in `web/` (TypeScript, three.js 0.186 with `three/webgpu` and TSL,
camera-controls, esbuild). `web/PROTOCOL.md` is the contract between `td` and the page, and
`docs/game-design.md` records the game design decisions and why they were made. Open
`internal/web/dist/index.html#demo` straight from disk for a self-running demo with a fake host;
`#demo&webgl` forces the WebGL 2 path, `#demo&creeps=8000` stresses it, and `#demo&evac` plays
the end: the evac Huey flying in to the helipad, boarding (E), lift-off and the field report.
The demo and the lab are a bundle of their own, `demo.js`, which the page fetches only for `#demo` and `#lab`.
`#lab` is the animation bench: every creep kind walking, idle, attacking, hit, burning, asleep
and dying, beside the survivors' poses; `#lab=0`…`#lab=10` looks at one creep row, `#lab=0.6` at
one creep (row and column: the walker dying), `#lab=h` at the survivors (`#lab=h0`…`#lab=h9` at
one of them), and `&dist=11` brings the camera in. In the demo, `#site=3` puts the view on the
fourth ruined house, to look at its walls.
A real game cancels the browser's shortcuts, DevTools' among them, and asks before the page is
left; add `&dev` after the token in its URL to keep them (td's own Firefox profile has DevTools
off whatever the URL says).

The survivors, creeps, guns, turrets and ruined walls are modelled in Blender by `tools/blender/figures.py`,
which writes `web/src/scene/figures.gen.ts` (every piece's vertices, joints, colour codes and
tones, and the pivots the page animates them about). Run the file in Blender to rewrite the
module; it also lays them all out in the scene to look at (the guns at twice their size, the
turrets with their heads on, each wall style as a short run of three tiles), and `show_heads()` puts two big
heads beside them to study the face. Commit the script and the module together.
