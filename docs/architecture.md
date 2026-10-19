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
  │                                │  t, text                           │
  │                                │ ──────────────────────────────────→│  netplay.Exec on the World,
  │                                │                                    │  between ticks
  │                                │                                    │  every 50 ms: World.Step,
  │                                │                                    │  Encoder.Delta, shared by
  │                                │  frame: delta (or keyframe)        │  every player's queue
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
- **The browser only draws.** Your local `td` turns its replica into one compact binary frame per
  tick and sends it to the page over a localhost WebSocket, so the page keeps no delta state. The page interpolates between frames.
  The WebSocket is a small stdlib implementation, so the Go side adds no modules for it.
- **Lots of creeps, cheaply.**
  - **Simulation.** Creeps live in a dense array with stable ids. They path with a single
    Dijkstra flow field from the generator and find neighbours through a spatial hash rebuilt
    each tick by counting sort. A tick allocates nothing.
  - **Network.** A frame carries only what changed: creeps that left, 1-byte moves for the rest
    in id order, then new arrivals, all deflated.
  - **Rendering.** Creeps of each kind are one instanced mesh, animated (bob, sway, burn, slow,
    hit flash) in TSL node materials on the GPU.
  - **Numbers.** At wave 40 with 8 players the game hits its 16k creep cap. The host then spends
    about 2 ms per tick simulating and 0.3 ms encoding, and each player gets about 135 KiB/s
    over the tailnet (`td bench --wave 40 --players 8`).
- **Generated art.** Everything is low-poly geometry built in code with three.js: no asset files.
- **The launcher is Bubble Tea.** It hosts, finds games and holds settings, then opens the browser
  and shows the game's status until it ends.
- **No tsnet.** The game uses the Tailscale already installed on the machine, so your identity
  and ACLs are the ones you already have.
