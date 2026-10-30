# Development

Everything builds and runs in containers through `./build.sh`; neither Go nor Node is installed
on the host. The README lists its targets.

## Playtests

`internal/playtest` plays whole games with nobody at the keys. Bots (`netplay.Bot`, the same ones
`--bots` puts in a hosted game) shop, build, loot, fight,
revive and taunt through the host's own command path (`netplay.Exec`). After every tick it
checks the world's invariants (`game.World.Check`), rebuilds a client replica from the wire to
see it agrees, and fails a wave that won't end. A game is its seed and its command log, so it
replays tick for tick. The golden game's world hash is kept in
`internal/playtest/testdata/golden.txt`: any change to how the game plays fails it until it is
rewritten with `./build.sh golden`, so the diff shows the change was intended. It holds on
amd64 and arm64 alike because `./build.sh` compiles with `-gcflags=all=-d=fmahash=qn`: arm64
would otherwise fuse `a*b+c` into one rounding and play a slightly different game; a bare
`go test` on arm64 fails `TestProductsAreRoundedOnTheirOwn` to say so. A soak failure
prints a `TD_SOAK_ONE=…` line that plays that game again.

## The client

The client source is in `web/` (TypeScript, three.js 0.186 with `three/webgpu` and TSL,
camera-controls, esbuild). `web/PROTOCOL.md` is the contract between `td` and the page, and
`docs/game-design.md` records the game design decisions and why they were made. Open
`internal/web/dist/index.html#demo` straight from disk for a self-running demo with a fake host;
`#demo&webgl` forces the WebGL 2 path, `#demo&creeps=8000` stresses it, and `#demo&evac` plays
the end: the evac Huey flying in to the helipad, boarding (E), lift-off and the field report.
The demo plays sound at 70 after the first click; `#demo&vol=0` silences it, `#demo&vol=40` sets it,
and `#demo&music=30` the music (50 by default). From disk the music plays outside Web Audio
(a browser gives Web Audio only silence from file://), so it fades but is not filtered; served
by td it is both. F3's `music` line shows the track wanted, the wave's intensity and each fade.
`#demo&firstrun` opens the first steps (a real game shows them once per machine), `#demo&phase=over`
the field report, and `#demo&help`, `#demo&menu` and `#demo&score` the windows.
The demo and the lab are a bundle of their own, `demo.js`, which the page fetches only for `#demo` and `#lab`.
F3's `sound` line shows the voices playing and the most at once, the sounds dropped and taken
over since the last frame, the output's peak in dBFS and the compressor's pull in dB. The demo
leaves the sound engine at `window.tdSound`, whose `synth.plays`, `drops` and `steals` count
every sound by name, for a browser test to read; a musical cue counts as `cue:<name>`.
`#lab` is the animation bench: every creep kind walking, idle, attacking, hit, burning, asleep
and dying, beside the survivors' poses; `#lab=0`…`#lab=10` looks at one creep row, `#lab=h` at the
survivors (`#lab=h0`…`#lab=h17` at one of them), `#lab=legend` at the legendary blades (the
katana's combo, a pair of katanas, Flash Draw, the greatsword's combo with its follow-through,
Skyfall, and the evolved blades), `#lab=crowbar` at the crowbar's Home Run (plain and
Bonebreaker's, out in the open past the others), `#lab=fx` at the turret evolutions' shots (a napalm missile
bursting, an arc web), and `&dist=11` brings the camera in.
`#lab=sound` puts the sound bench over it: every recipe in the bank and every set of recordings,
clicked (or Enter) to play as the game does, or the recipe, the recording or both alone (s, r, b),
at the level the game plays it and the volume on its slider. Recordings come in through
`web/src/sound/samples.ts`, whose head is the contract for adding a category; their sources and
licences are in `web/src/sound/samples/CREDITS.md`.
A real game cancels the browser's shortcuts, DevTools' among them, and asks before the page is
left; add `&dev` after the token in its URL to keep them (td's own Firefox profile has DevTools
off whatever the URL says).
