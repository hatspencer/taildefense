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
  │                                │                                    │  every 50 ms: World.Step,
  │                                │                                    │  Encoder.Delta, shared by
  │                                │  frame: delta (or keyframe)        │  every player's queue
  │                                │  ack: seq, tick, behind the frame  │
  │                                │ ←──────────────────────────────────│
  │                                │  Replica.Apply                     │
  │  frame: the whole world        │                                    │
  │ ←──────────────────────────────│                                    │
  │  interpolate, draw             │                                    │
```

## Why it's built this way

- **The host is authoritative.** It simulates at 20 Hz, and each player's `td` keeps a replica fed
  by compressed delta frames over one TCP connection. Players send orders, not keystrokes: a
  spot to walk to (the host finds the A* path), a heading for WASD, a target, a purchase. Every
  rule runs on the host, so there's nothing to cheat with.
- **Every command is acked.** The local `td` numbers the commands it relays; after a tick the host
  tells each player the last one it applied, so the page can tell which of its orders a frame
  already shows, the base a prediction needs. F3 shows the link: the round trip, command to ack,
  the gaps between frames, and the host's drops, resyncs and tick spacing.
- **The browser only draws.** Your local `td` turns its replica into one compact binary frame per
  tick and sends it to the page over a localhost WebSocket, so the page keeps no delta state. The page
  draws motion a little in the past (the mean frame interval plus twice the arrival jitter,
  50-150 ms) from a buffer of the last four frames, so late or bunched frames don't stutter;
  past the newest it extrapolates up to 100 ms, then waits. The player's own acts (a cast, a
  build, a reload) get their ring, sound and pending ghost at once; the host still decides.
  The WebSocket is a small stdlib implementation, so the Go side adds no modules for it.
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
    hit flash) in TSL node materials on the GPU.
  - **Numbers.** At wave 40 with 8 players the game hits its 16k creep cap. The host then spends
    about 2 ms per tick simulating and 0.3 ms encoding, and each player gets about 100 KiB/s
    over the tailnet, a 10 KB frame deflated to 5 KB (`td bench --wave 40 --players 8`).
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
