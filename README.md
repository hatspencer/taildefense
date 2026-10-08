# taildefense

Co-op wave defense played in your browser over your tailnet. The game is 3D, seen from a tilted
camera you can rotate, with WC3-style controls. You and your friends hold a walled base around a
generator. Between waves you shop at the armory, upgrade weapons and abilities, build and repair
turrets and walls. During a wave, hordes come in from every side of the map. The goal is to
survive as many waves as you can.

```
td            # launcher: host a game, find games on your tailnet, settings
td host       # host a game and open it in your browser
td join box   # join the game hosted on the machine "box"
```

## Setup

You need Tailscale running on every player's machine, and podman or docker to build. The build
always runs in containers: `golang:1.27-alpine` for the Go side, `node:22-alpine` for the browser
client. Neither Go nor Node is installed on the host.

```
./build.sh install     # builds and installs td into ~/.taildefense, symlinked from ~/.local/bin/td
td doctor              # checks tailscale, the browser, the container engine
```

Works on Linux and macOS, amd64 and arm64. The client renders with WebGPU, and falls back to
WebGL 2 where WebGPU isn't available. Any current Chrome, Edge, Firefox or Safari will do.

## Commands

| command | what it does |
|---|---|
| `td` | launcher: host, join (lists the games on your tailnet), settings, update status |
| `td host [--port N] [--seed S] [--name NAME]` | host a game and play it in the browser |
| `td join HOST[:PORT] [--name NAME]` | join a game by tailnet name or address |
| `td serve [--port N] [--seed S]` | headless dedicated host; logs to stdout until interrupted |
| `td ls [--json]` | games running on your tailnet |
| `td bench [--wave N] [--players P] [--seconds S]` | time a busy wave offline: simulation, encoding, relay |
| `td frame [--view menu\|join\|settings\|help]` | render one launcher frame from demo data |
| `td doctor` | check tailscale, the browser, container engine, install |
| `td config [KEY [VALUE]]` | show or change settings: NAME, PORT, BROWSER, AUTOUPDATE |
| `td update [-f] [-b BRANCH]` | rebuild from the repo's main (or a branch) and reinstall |
| `td install [-f]` | install this build |
| `td version [--offline] [--json]` | this build and whether a newer one exists |

`BROWSER` is `default` (the system browser), `none` (print the URL instead) or a command to run
with the URL. `--no-browser` does the same as `none` for one run, which is handy over SSH.

The host listens on its tailnet address and on loopback, port 7787, and never on any other
interface. Players are identified by their tailnet login (`tailscale whois`), so someone who drops
and rejoins keeps their gold and weapons.

The game page is served only on `127.0.0.1`, on a random port. Its URL carries a random token, and
the page's WebSocket refuses a wrong token or a page from another origin. One tab plays at a time;
opening the URL again takes over from the old tab.

Updates: the version is the git commit. With `AUTOUPDATE` on (the default), the launcher checks
the repo's main at most once an hour and updates in the background, then offers a restart.
When a host and a player run different game protocols, the refusal tells the older one to run
`td update`.

## Playing

Your hero fights by itself: standing idle or holding, it shoots the nearest creep in range.

| input | |
|---|---|
| right-click | move; on a creep, attack it; on a damaged building, repair it; on the armory, walk there and shop |
| A, then left-click | attack-move: walk there, stopping to fight anything on the way |
| S / H | stop / hold position |
| Q W E R | abilities: Q is the equipped weapon's signature, W grenade, E dash, R airstrike |
| 1-7, T | equip a weapon, reload |
| B | build: W wall, G gate, T gun turret, C cannon, F frost tower, L tesla coil; shift keeps placing |
| left-click | select a building, creep or player |
| U / X / F | upgrade / sell / repair the selected building |
| G | armory: weapons, upgrade tracks, gear, abilities (you have to be standing by it) |
| N | ready for the next wave |
| middle-drag, Alt+wheel | rotate the camera |
| wheel | zoom |
| arrows, screen edges | pan; Space recenters on your hero, double Space locks the camera to it |
| Enter, Tab, F1, F3, Esc | chat, scoreboard, help, stats, cancel / menu |

On the minimap, left-drag moves the view and right-click gives a move order.

Each weapon has its own signature ability on Q, stronger with its special upgrades:

| weapon | Q |
|---|---|
| Pistol | fan the hammer: six quick shots |
| Shotgun | concussion: a blast in front that throws back and slows |
| SMG | bullet hose: double fire rate for 4 s |
| Rifle | piercing shot: five times the damage through a whole line |
| Flamethrower | napalm: a pool of fire for 6 s |
| Minigun | overdrive: faster and piercing for 5 s |
| Rocket launcher | barrage: six rockets round a point |

Grenade, dash and airstrike are bought and levelled at the armory.

Creeps follow a flow field toward the generator and chew through whatever is in the way. Walls
and gates slow them down, but don't seal the base. Every fifth wave is a swarm, and every tenth
brings an abomination.

## Why it's built this way

- **The host is authoritative.** It simulates at 20 Hz, and each player's `td` keeps a replica fed
  by compressed delta frames over one TCP connection. Players send orders, not keystrokes, and the
  host walks heroes along A* paths, so there's nothing to predict and nothing to cheat with.
- **The browser only draws.** Your local `td` turns its replica into one compact binary frame per
  tick and sends it to the page over a localhost WebSocket. The page interpolates between frames.
  The WebSocket is a small stdlib implementation, so the Go side adds no modules for it.
- **Lots of creeps, cheaply.**
  - **Simulation.** Creeps live in a dense array with stable ids. They path with a single
    Dijkstra flow field from the generator and find neighbours through a spatial hash rebuilt
    each tick by counting sort. A tick allocates nothing.
  - **Network.** A frame carries only what changed: creeps that left, 1-byte moves for the rest
    in id order, then new arrivals, all deflated.
  - **Rendering.** Creeps of each kind are one instanced mesh, animated (bob, sway, burn, slow,
    hit flash) in TSL node materials on the GPU.
  - **Numbers.** At wave 40 with 8 players the game hits its 16k creep cap, and the host spends
    about 0.7 ms per tick simulating and 0.1 ms encoding (`td bench`).
- **Generated art.** Everything is low-poly geometry built in code with three.js: no asset files.
- **The launcher is Bubble Tea.** It hosts, finds games and holds settings, then opens the browser
  and shows the game's status until it ends.
- **No tsnet.** The game uses the Tailscale already installed on the machine, so your identity
  and ACLs are the ones you already have.

## Development

```
./build.sh check   # gofmt, vet, Go tests, client typecheck (in containers)
./build.sh web     # build only the browser client into internal/web/dist
./build.sh dist    # cross-compile linux/darwin × amd64/arm64 into dist/
./build.sh npm …   # run npm in the node container, inside web/
```

The client source is in `web/` (TypeScript, three.js 0.186 with `three/webgpu` and TSL,
camera-controls, esbuild). `web/PROTOCOL.md` is the contract between `td` and the page. Open
`internal/web/dist/index.html#demo` straight from disk for a self-running demo with a fake host;
`#demo&webgl` forces the WebGL 2 path, and `#demo&creeps=8000` stresses it.
