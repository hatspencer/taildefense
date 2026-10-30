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

## Bad networks

`./build.sh netsim [s]` plays a real host to a client through `internal/netsim`'s proxy for
s seconds (10 by default) at each of 0, 40±10 and 120±30 ms with 0, 1 and 3% loss, applied each
way, and tables frame gaps (p50, p99, max), stalls of more than 100 ms (three ticks) and the
round trip of an echo sent behind the player's steering. A last pair plays a phone's hotspot:
65±20 ms each way, losses in bursts (`Profile.Burst`, two state) and a 2 s outage both ways a
quarter of the way in (`Profile.Outages`); `max out` is the longest gap outside the outage,
`on udp` the share of the case frames came over UDP and `switch` how often they moved. It is
`TestNetcode`, skipped unless `TD_NETSIM=1`, so `check` stays fast. The proxy needs no hooks in the game: point anything at
`netsim.Listen(target, up, down, seed)` and connect to its `Addr()`. TCP cannot lose a byte, so
there a loss holds its direction for a retransmit timeout (`Profile.RTO`, at least 200 ms) and
everything behind it waits, which is what a player on TCP sees. `netsim.ListenUDP` drops for
real and can reorder, for a datagram transport.

To shape the real thing, a hosted game and a browser, use the OS. On Linux, netem shapes what
leaves an interface; on `lo` both directions leave it, so a round trip pays the delay twice:

```
sudo tc qdisc add dev lo root netem delay 40ms 10ms loss 1%
sudo tc qdisc change dev lo root netem delay 120ms 30ms loss 3%
sudo tc qdisc del dev lo root
```

Over the tailnet use `dev tailscale0` the same way; it shapes only what this machine sends, so
shape the other machine too for both directions. netem's jitter reorders packets, which TCP
puts right at a cost; the proxy never reorders a stream.

On macOS, dummynet through pf, on the game port 7787, TCP and the UDP frames both (it has no jitter). Loading rules from
stdin replaces pf's main ruleset until `/etc/pf.conf` is loaded again:

```
sudo dnctl pipe 1 config delay 40 plr 0.01
sudo dnctl pipe 2 config delay 40 plr 0.01
printf 'dummynet out proto { tcp udp } from any to any port 7787 pipe 1\ndummynet out proto { tcp udp } from any port 7787 to any pipe 2\n' | sudo pfctl -f -
sudo pfctl -E    # prints a token
# undo:
sudo pfctl -f /etc/pf.conf && sudo dnctl -q flush && sudo pfctl -X <token>
```

## The client

The client source is in `web/` (TypeScript, three.js 0.186 with `three/webgpu` and TSL,
camera-controls, esbuild). `web/PROTOCOL.md` is the contract between `td` and the page, and
`docs/game-design.md` records the game design decisions and why they were made. Open
`internal/web/dist/index.html#demo` straight from disk for a self-running demo with a fake host;
`#demo&webgl` forces the WebGL 2 path, `#demo&creeps=8000` stresses it, and `#demo&evac` plays
the end: the evac Huey flying in to the helipad, boarding (E), lift-off and the field report.
`#demo&lag=120` delays commands, frames and acks by half that each way, to watch the hero's
WASD prediction at work (F3's `pred` line); the demo walks a steered survivor with the same
`predict.ts` code and acks numbered commands as the host does.
The demo plays sound at 70 after the first click; `#demo&vol=0` silences it, `#demo&vol=40` sets it,
and `#demo&music=30` the music (50 by default). From disk the music plays outside Web Audio
(a browser gives Web Audio only silence from file://), so it fades but is not filtered; served
by td it is both. F3's `music` line shows the track wanted, the wave's intensity and each fade.
`#demo&firstrun` opens the first steps (a real game shows them once per machine), `#demo&phase=over`
the field report, and `#demo&help`, `#demo&menu` and `#demo&score` the windows.
The demo and the lab are a bundle of their own, `demo.js`, which the page fetches only for `#demo` and `#lab`.
F3's first line is the renderer, and on WebGL2 why: `forced: #webgl`, `forced: GPU device lost
earlier`, `no navigator.gpu` (the browser has no WebGPU), `no adapter` (it has, but gives none:
turned off or a blocklisted GPU) or `WebGPU failed: …`. `draws` and `tris` count every pass
of the frame, the sun's shadow and the portraits included. The `detail` line is the detail
governor: its level of 5, `auto` or `pinned`, what its last step did, and the creeps drawn in
the near and the far model and where the far one starts. `#demo&detail=N` pins a level (0 is
full detail); `#demo&creeps=8000&cam=a,a,a,60` is a big horde from far up to measure with.
F3's `sound` line shows the voices playing and the most at once, the sounds dropped and taken
over since the last frame, the output's peak in dBFS and the compressor's pull in dB. The demo
leaves the sound engine at `window.tdSound`, whose `synth.plays`, `drops` and `steals` count
every sound by name, for a browser test to read; a musical cue counts as `cue:<name>`.
F3's link lines, all in ms: `ping` the last round trip to the host, its average, its p99 over a
minute, echoes lost and how packets reach the host (`direct`, `DERP fra`, `relay`, `local`);
`ack` the last command's time to its ack and the p50 and p99 over 10 s;
`arrv` how frames come from the host and the gaps between them reaching td over 10 s (33 when
all is well): `udp`, or `tcp` with why: `(udp off)` when either side has `TAILDEFENSE_NO_UDP` or
the host has no UDP socket, `(udp: trying)` and after 5 s `(udp: no answer)` while the host has
never answered a hello, `(udp: starting)` between the answer and the first datagram, and
`(udp: lost, retrying)` after frames came over UDP and fell back (td's terminal notes each
change); `host` the host's tick spacing p99, the frames it dropped for this player, the keyframes it resent after them and
the deepest the player's queue got of its depth; `page drop` the frames td dropped for a slow
page (with four waiting it drops the oldest, so the page goes on from the newest). The demo has no link: those lines show `-`.
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
