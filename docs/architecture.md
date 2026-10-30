# Architecture

The README has the picture of the machines and the packages. This is the rest: how one tick
travels, and why it's built this way.

The host plays its own game the way everyone else does, through a client over loopback. `td
serve` is the same host without that client. The launcher (`td`) finds games by probing every
tailnet peer on the game port; a probe gets the host's `Info` (players, wave, difficulty,
version) and hangs up.

One tick, from a key press to the screen:

```
Browser                   local td (web.Session)               host td (netplay.Server)
  │                                │                                    │
  │  {"op":"move","x":…,"y":…}     │                                    │
  │ ──────────────────────────────→│  Cmd: op, a, b, x/y to 1/8 tile,   │
  │                                │  t, text, seq                      │
  │                                │ ──────────────────────────────────→│  netplay.Exec on the World,
  │                                │                                    │  between ticks
  │                                │                                    │  every 33 ms: World.Step,
  │                                │                                    │  Encoder.Delta, shared by
  │                                │  frame: delta (or keyframe),       │  every player's queue
  │                                │  over UDP when it gets through     │
  │                                │  ack: seq, tick, behind the frame  │
  │                                │ ←──────────────────────────────────│
  │                                │  Replica.Apply                     │
  │  frame: the whole world        │                                    │
  │ ←──────────────────────────────│                                    │
  │  interpolate, draw             │                                    │
```

## Why it's built this way

- **The host is authoritative.** It simulates at 30 Hz, and each player's `td` keeps a replica fed
  by compressed delta frames. 30 rather than 20 puts a command in a
  frame and the frame on screen about 25 ms sooner, for half again the host's work and about a
  third more bandwidth. The rules are in seconds; the few things the balance was tuned on 20 Hz
  ticks for (a turret's or a creep's cadence, armour against damage over time, a rocket's
  fuse) say so in `internal/game` and play the same at either rate. Players send orders, not keystrokes: a
  spot to walk to (the host finds the A* path), a heading for WASD, a target, a purchase. Every
  rule runs on the host, so there's nothing to cheat with.
- **Frames over UDP, everything else over TCP.** A player's TCP connection carries the
  handshake, welcomes, commands, acks, toasts, stats and chat, which must all arrive in order.
  Frames go as datagrams once a hello with a token from the TCP welcome has come back over UDP
  from the same tailnet IP: over TCP one lost segment holds every frame behind it for a
  retransmit timeout (a 250-430 ms stall at 1% loss in `./build.sh netsim`), though the next
  frame would have made the lost one moot. Over UDP a loss costs one frame. Every frame on
  either path is numbered, and the replica applies a delta only on the one before it; each
  datagram unit, deflated on its own and cut into fragments under the tailnet's MTU, repeats
  the one or two deltas before it while that no more than doubles it, so a single loss heals
  without a round trip, and a longer hole asks for a keyframe. An ack waits in the local `td`
  until its frame is in. With nothing back over UDP for four round trips (at least 1.5 s),
  frames go over TCP, starting with a keyframe, but not for good: the client says hello
  whenever nothing has come over UDP for 300 ms (five a second for 5 s, then one a second for
  as long as it plays), the host answers (at once after a first fallback, then after a hold
  of 1 s doubling with each further one in a row up to 10 s), the client confirms (an ack
  datagram and a TCP message, whichever is first) and frames go back to UDP with a keyframe.
  A hello from the player's IP with its token may move the host's binding to a new port at
  any time, as a NAT that remaps a phone's hotspot mid-game needs. With no UDP at all frames
  stay on TCP. F3's `arrv` line says which, and why.
- **Every command is acked.** The local `td` numbers the commands it relays; after a tick the host
  tells each player the last one it applied, so the page can tell which of its orders a frame
  already shows, the base a prediction needs. F3 shows the link: the round trip, command to ack,
  the gaps between frames, and the host's drops, resyncs and tick spacing.
- **The browser only draws.** Your local `td` turns its replica into one compact binary frame per
  tick and sends it to the page over a localhost WebSocket, so the page keeps no delta state. The page
  draws motion a little in the past (the mean frame interval plus twice the arrival jitter,
  a tick to 150 ms) from a buffer of the last six frames, so late or bunched frames don't stutter;
  past the newest it extrapolates up to 100 ms, then waits. The player's own acts (a cast, a
  build, a reload) get their ring, sound and pending ghost at once; the host still decides.
  The WebSocket is a small stdlib implementation, so the Go side adds no modules for it.
- **Your own WASD walk is predicted.** `web/src/predict.ts` is a float32 port of the host's
  steer, stride, collision and stamina. The page numbers its commands, and each frame it
  replays the ones the host's ack does not yet cover from that frame's position, so your hero
  moves the instant you press a key and is drawn now, not a delay ago; everyone else stays
  interpolated. Each ack also says which host tick a command sent at a known time landed in,
  which pins where the host's ticks fall on the page's clock. When the port is right a replay
  lands where the last one did; a correction is eased out over 100 ms, and one over 1.5 tiles
  (or a stun, a throw, death) snaps. A click's walk stays the host's: it is pathfinding. F3's
  `pred` line has the mean correction over 10 s and the snaps. `internal/game/predict_test.go`
  walks survivors with the host's code into `web/test/predict-fixture.json`, and `npm run check`
  replays them through the port, to within float rounding.
- **Lots of creeps, cheaply.**
  - **Simulation.** Creeps live in a dense array with stable ids. They path with a single
    Dijkstra flow field from the generator and find neighbours through a spatial hash rebuilt
    each tick by counting sort. A tick allocates nothing.
  - **Network.** A frame carries only what changed: creeps that left, then a nibble for every
    other creep in id order (two bits an axis, still or an eighth of a tile either way, an
    escape for more), so a horde standing at a wall costs next to nothing; then new arrivals,
    the changed fields of creeps that were hit or turned, and of each player only the groups of
    their record that changed. All of it is deflated.
  - **Rendering.** Creeps of each kind are one instanced mesh, animated (bob, sway, burn, slow,
    hit flash) in TSL node materials on the GPU, and a second one for those past 45 from the
    camera, the same figure without the parts too small to see there (eyes, teeth, claws),
    picked per creep each frame with a little hysteresis. Their geometry is indexed, so a
    face's shared corners run the posing shader once. The effect pools draw only the slots
    still showing something, the ground is in 64-tile pieces that are culled, and a turret's
    shadowless trim is one mesh. On an empty field that took a frame from about 950k
    triangles to 360k, most of the rest trees and walls with their shadows.
  - **Detail.** `web/src/scene/detail.ts` watches the frame time. When frames stay slower
    than 22 ms it steps detail down, a step at a time: the far creeps from 30 and without
    shadows, the drawing buffer at 1.5 then 1 pixel a CSS pixel, no creep shadows, a
    1024 shadow map. A step that buys too little is taken back and not tried for a while,
    and with headroom again (18 ms) it steps back up, waiting longer each time one is soon
    undone. A machine that keeps up never leaves full detail; F3 shows the level.
  - **Numbers.** At wave 40 with 8 players the game hits its 16k creep cap. The host then spends
    about 1-2 ms per tick simulating and 0.1-0.3 ms encoding, and each player gets about
    130 KiB/s over TCP, an 8 KB frame deflated to 4.5 KB (`td bench --wave 40 --players 8`).
    Over UDP it is up to about 140 KiB/s: four datagrams a tick, the repeats of earlier deltas
    only filling out the last one.
- **Generated art.** Everything is low-poly geometry built in code with three.js: no asset files.
- **Generated sound.** The page makes every sound in code from what each frame already says (the
  shots, blasts and deaths of that tick, and what changed since the last one): the protocol
  carries no audio, and the binary no sound files. A worker renders the bank, so making it never
  costs a frame; `web/build.mjs` inlines the worker into `app.js`, because a separate script
  would not load as a worker when the demo is opened from disk.
- **The launcher is Bubble Tea.** It hosts, finds games and holds settings, then opens the browser
  and shows the game's status until it ends.
- **No tsnet.** The game uses the Tailscale already installed on the machine, so your identity
  and ACLs are the ones you already have.
