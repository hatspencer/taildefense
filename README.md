# taildefense

Co-op wave defense played in your browser over your tailnet. The game is 3D, seen from a tilted
camera you can rotate, with WC3-style controls. You and your friends hold a walled base around a
generator. Between waves you shop at the armory, upgrade weapons and abilities, build and repair
turrets and walls. During a wave, hordes come in from every side of the map. The goal is to
survive as many waves as you can.

```
td            # launcher: host a game, find games on your tailnet, settings, changelog, doctor
td host       # host a game and open it in your browser
td join box   # join the game hosted on the machine "box"
```

## Setup

You need Tailscale running on every player's machine, and podman or docker to build (see
[Dependencies](#dependencies)).

```
./build.sh install     # builds and installs td into ~/.taildefense, symlinked from ~/.local/bin/td
td doctor              # checks tailscale, the browser, the container engine
```

Works on Linux and macOS, amd64 and arm64. The client renders with WebGPU, and falls back to
WebGL 2 where WebGPU isn't available. Any current Chrome, Edge, Firefox or Safari will do.

## Commands

| command | what it does |
|---|---|
| `td` | launcher: host (←/→ picks the difficulty, f turns fog of war on or off, y copies the join command for your friends), join (lists the games on your tailnet), settings, a changelog of the latest commits with yours marked, the doctor's checks, update status. It opens with a short splash (any key skips it, `--no-splash` or `--no-anim` turns it off) |
| `td host [--port N] [--seed S] [--name NAME] [--difficulty D]` | host a game and play it in the browser |
| `td join HOST[:PORT] [--name NAME]` | join a game by tailnet name or address |
| `td serve [--port N] [--seed S] [--difficulty D]` | headless dedicated host; logs to stdout until interrupted |
| `td ls [--json] [--port N]` | games running on your tailnet |
| `td bench [--wave N] [--players P] [--seconds S] [--seed S]` | time a busy wave offline: simulation, encoding, relay |
| `td frame [--width W] [--height H] [--view menu\|join\|settings\|changelog\|doctor\|help\|splash] [--at S]` | render one launcher frame from demo data, 160×48 unless told otherwise; `--at` is seconds into the splash |
| `td doctor` | check tailscale, the browser, container engine, install |
| `td config [KEY [VALUE]]` | show or change settings: NAME, PORT, DIFFICULTY, FOG, VOLUME, BROWSER, AUTOUPDATE; `td config KEY --reset` returns one to its default |
| `td update [-f] [-b BRANCH]` | rebuild from the repo's main (or a branch) and reinstall |
| `td install [-f]` | install this build |
| `td version [--offline] [--json]` | this build and whether a newer one exists |

Every setting can also come from the environment (`TAILDEFENSE_NAME`, `TAILDEFENSE_PORT`,
`TAILDEFENSE_DIFFICULTY`, `TAILDEFENSE_FOG`, `TAILDEFENSE_VOLUME`, `TAILDEFENSE_BROWSER`), and `td config` says where
each value in force came from. `--theme NAME` (or `TAILDEFENSE_THEME`) picks the colour theme of the
launcher and td's output, and `--no-color` turns colour off.


The settings, the network and updates are explained in [docs/settings.md](docs/settings.md).

## Dependencies

**To build:** podman or docker (Docker is tried first, `TAILDEFENSE_CONTAINER_ENGINE` picks).
The toolchains come as images, `golang:1.27-alpine` and `node:26-alpine`
(override with `TAILDEFENSE_GO_IMAGE` and `TAILDEFENSE_NODE_IMAGE`), so nothing else is installed.

| side | dependencies |
|---|---|
| Go (`go.mod`) | Bubble Tea, Lip Gloss and `charmbracelet/x/ansi` for the launcher, `muesli/termenv`, `golang.org/x/term`; everything else, the WebSocket included, is the standard library |
| client (`web/package.json`, exact pins) | three 0.186 (`three/webgpu`, TSL), camera-controls; esbuild, TypeScript 7 and `@types/three` to build |

**To run:** `td` is one static binary with the client embedded; it needs no Go, Node or
container at run time.

- **Tailscale**, running and logged in, with the `tailscale` CLI on the PATH: td asks it for this
  machine, the peers and who is connecting (`whois`). No tsnet, nothing of Tailscale is built in.
- **A browser** with WebGPU or WebGL 2: Chrome, Chromium, Brave, Edge, Vivaldi, Firefox or Safari.
- **Optional:** a clipboard tool for y on Host (`wl-copy`, `xclip` or `xsel` on Linux, `pbcopy`
  on macOS; td also asks the terminal, over OSC 52), and git plus the container engine for `td update`.

## Playing

Everyone who joins is dealt a survivor: a paramedic, mechanic, hunter, student, builder, nurse,
biker, farmer, ex-soldier or office worker, each with their own face, skin, body, build and hair.
A team gets as many different outfits as it can, all worn in the player's colour, and you keep
yours if you drop out and come back.

You walk with WASD and your hero fights by itself: walking, standing or holding, it shoots the
nearest creep it can see in range, and doesn't waste shots on walls. WASD goes the way the view
faces, however the camera is turned, and the camera follows while you walk.

| input | |
|---|---|
| W A S D | walk |
| E | use what is under the cursor, or else the nearest thing: revive a downed teammate, pick up a dropped weapon, search a loot site, repair a damaged building, shop at the armory (walking there first); on a creep, focus fire on it |
| right-click | on a creep, focus fire on it; anywhere else, the equipped weapon's signature, at the cursor |
| Shift / F / Q | abilities: grenade, dash, airstrike; aim with the cursor and left-click |
| H | hold position |
| 1-6, 0, R | equip a weapon (0 is the crowbar, on brutal), reload (or the reload button) |
| 8 | use a medkit |
| G (hold) | hold a second to drop the weapon in hand for a teammate, upgrades and all (you keep at least one) |
| V | taunt: flip them off and shout; every creep around you comes for you for 5 s, sleeping guards too |
| B | build: X wall, G gate, T gun turret, C cannon, F frost tower, L tesla coil, N sniper tower, M missile battery; shift keeps placing |
| left-click | select a building, creep or player |
| U / Delete twice | upgrade / sell the selected wall or gate (60% more HP a level); a turret upgrades a track at a time from its card |
| C | armory: weapons, upgrade tracks, gear, abilities (you have to be standing by it) |
| Y | ready for the next wave |
| T | the next turret: selects it (its upgrade and sell card shows) and looks at it; again for the one after |
| N (hold) | look at the generator; tap twice to walk back to it |
| P | pause or resume the game, for everyone; anyone can do either |
| M | big map, and back |
| Alt+left-click, or Z then left-click | ping: mark the spot for the whole team, in the world or on the map. On a creep it warns of danger, on a loot site it marks loot, on a building it calls to defend it |
| hold Space | sprint, until you run out of stamina |
| middle-drag, Alt+wheel | rotate the camera |
| wheel | zoom |
| arrows, screen edges | look around; walking brings the camera back, tapping Space recenters on your hero, a double tap locks the camera to it |
| Enter | chat with the team; in the chat, Tab adds where you are ("NE of the base, 40 m") |
| Tab, F1 (or ?), F3, F4 | scoreboard, help, performance readout, the pixel view on or off |
| Esc, F10 | cancel the current mode or window, else the menu |


The rest of the player's guide (loot sites, the dead and their kinds, bosses, weapons'
signatures, weather, waves and breaks) is in [docs/playing.md](docs/playing.md).

## Architecture

```
            the host's machine                                    a friend's machine
┌────────────────────────────────────────────┐        ┌────────────────────────────────────┐
│  td host                                   │        │  td join box                       │
│                                            │        │                                    │
│  ┌──────────────────────────────────────┐  │        │                                    │
│  │  netplay.Server · tailnet IP + lo    │  │        │                                    │
│  │  :7787, nothing else                 │  │        │                                    │
│  │                                      │  │  TCP   │                                    │
│  │  game.World ── Step() at 20 Hz       │◀─┼────────┼── commands (orders, not keys)      │
│  │  flow field · spatial hash · A*      │  │tailnet │                                    │
│  │  waves · loot · aggro · weather      │──┼────────┼─▶ deltas, deflated; a keyframe     │
│  │                                      │  │        │   to catch up                      │
│  │  Encoder: one delta for all, a       │  │        │                                    │
│  │  keyframe for whoever fell behind    │  │        │                                    │
│  └──────────────┬───────────────────────┘  │        │                                    │
│      loopback   │ ▲  same protocol         │        │                                    │
│                 ▼ │                        │        │                                    │
│  ┌──────────────────────────────────────┐  │        │  ┌──────────────────────────────┐  │
│  │  web.Session                         │  │        │  │  web.Session                 │  │
│  │  netplay.Client ─▶ Replica           │  │        │  │  netplay.Client ─▶ Replica   │  │
│  │  view encoder: the whole world,      │  │        │  │  view encoder                │  │
│  │  every tick                          │  │        │  │                              │  │
│  │  HTTP + WebSocket, 127.0.0.1 only,   │  │        │  │  127.0.0.1:random #token     │  │
│  │  random port, #token                 │  │        │  │                              │  │
│  └──────────────┬───────────────────────┘  │        │  └──────────────┬───────────────┘  │
│                 │ ▲  JSON commands         │        │                 │ ▲                │
│  binary frames  ▼ │                        │        │                 ▼ │                │
│  ┌──────────────────────────────────────┐  │        │  ┌──────────────────────────────┐  │
│  │  Browser (TypeScript, three.js)      │  │        │  │  Browser                     │  │
│  │  state: decode, interpolate          │  │        │  │                              │  │
│  │  scene: WebGPU (WebGL 2 fallback),   │  │        │  │                              │  │
│  │  instanced creeps, TSL materials     │  │        │  │                              │  │
│  │  HUD · minimap · input → controller  │  │        │  │                              │  │
│  └──────────────────────────────────────┘  │        │  └──────────────────────────────┘  │
└────────────────────────────────────────────┘        └────────────────────────────────────┘
                     │                                                  │
                     └────────────── tailscaled (whois, peers) ─────────┘
```

The host plays its own game through a client over loopback; `td serve` is the same host without
it. How one tick travels from a key press to the screen, and why it's built this way, is in
[docs/architecture.md](docs/architecture.md).

| package | what it holds |
|---|---|
| `internal/game` | the simulation: world, creeps, waves, loot, abilities, weather. No I/O |
| `internal/netplay` | host and client: handshake, commands, delta/keyframe codec, the replica |
| `internal/web` | the local web server: page, WebSocket, the browser's frame, browser launching |
| `internal/playtest` | bots, the invariant checker, the fuzzer, the golden game |
| `internal/tui`, `internal/ui` | the launcher (Bubble Tea) and td's terminal output |
| `internal/cli` | the commands: host, serve, ls, doctor, config, bench, install, update |
| `internal/tailnet` | talks to the installed tailscale: this machine, peers, whois |
| `web/src` | the browser client: `net`, `state`, `scene/`, `hud/`, `input`, `controller` |

## Development

```
./build.sh check   # gofmt, vet, Go tests, client typecheck (in containers)
./build.sh build   # build ./td for this machine, client included
./build.sh install # build and install it
./build.sh test …  # go test ./..., with any flags given
./build.sh web     # build only the browser client into internal/web/dist
./build.sh dist    # cross-compile linux/darwin × amd64/arm64 into dist/
./build.sh npm …   # run npm in the node container, inside web/
./build.sh soak 12 # bots play 12 more games to late waves (the short set runs in check)
./build.sh fuzz 2m # fuzz the commands players give
./build.sh golden  # rewrite the golden game and the launcher's golden frames after a deliberate change
./build.sh go …    # any go command in the container; fmt, tidy and shell too
```

Playtests, the golden game, the demo and the animation lab are described in
[docs/development.md](docs/development.md). `web/PROTOCOL.md` is the contract between `td` and
the page, and `docs/game-design.md` records the design decisions and why they were made.
