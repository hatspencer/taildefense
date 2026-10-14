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

You need Tailscale running on every player's machine, and podman or docker to build. The build
always runs in containers: `golang:1.27-alpine` for the Go side, `node:24-alpine` for the browser
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
| `td` | launcher: host (←/→ picks the difficulty, f turns fog of war on or off, y copies the join command for your friends), join (lists the games on your tailnet), settings, a changelog of the latest commits with yours marked, the doctor's checks, update status. It opens with a short splash (any key skips it, `--no-splash` or `--no-anim` turns it off) |
| `td host [--port N] [--seed S] [--name NAME] [--difficulty D]` | host a game and play it in the browser |
| `td join HOST[:PORT] [--name NAME]` | join a game by tailnet name or address |
| `td serve [--port N] [--seed S] [--difficulty D]` | headless dedicated host; logs to stdout until interrupted |
| `td ls [--json] [--port N]` | games running on your tailnet |
| `td bench [--wave N] [--players P] [--seconds S] [--seed S]` | time a busy wave offline: simulation, encoding, relay |
| `td frame [--width W] [--height H] [--view menu\|join\|settings\|changelog\|doctor\|help\|splash] [--at S]` | render one launcher frame from demo data, 160×48 unless told otherwise; `--at` is seconds into the splash |
| `td doctor` | check tailscale, the browser, container engine, install |
| `td config [KEY [VALUE]]` | show or change settings: NAME, PORT, DIFFICULTY, FOG, BROWSER, AUTOUPDATE; `td config KEY --reset` returns one to its default |
| `td update [-f] [-b BRANCH]` | rebuild from the repo's main (or a branch) and reinstall |
| `td install [-f]` | install this build |
| `td version [--offline] [--json]` | this build and whether a newer one exists |

Every setting can also come from the environment (`TAILDEFENSE_NAME`, `TAILDEFENSE_PORT`,
`TAILDEFENSE_DIFFICULTY`, `TAILDEFENSE_FOG`, `TAILDEFENSE_BROWSER`), and `td config` says where
each value in force came from. `--theme NAME` (or `TAILDEFENSE_THEME`) picks the colour theme of the
launcher and td's output, and `--no-color` turns colour off.

`DIFFICULTY` is `easy`, `normal` (the default), `hard` or `brutal`, for the games you host. It
scales creep health and wave size, gold, the time between waves, how tough the loot guards are
and how long a downed player can be revived (20 s on normal). Hard and brutal are played at night: out
past the base you see only a few steps round you (twice as far with a rifle), the map is black until someone on the team has
been there, the dead come out of the dark, and nobody
tells you how many guards a site has left. On brutal
you start with only a crowbar. A restart keeps the game's difficulty. The host can also change it
mid-game by clicking the difficulty chip at the top left.

`FOG` is `off` by default. On, the games you host hide whatever the team cannot see, on any
difficulty; at night (hard and brutal) that is always so.

`BROWSER` is `auto` by default: td finds the browsers installed (Chrome, Chromium, Brave, Edge,
Vivaldi, Firefox, and Safari on macOS) and starts the best one full screen, as an app window with
a profile of its own that keeps the GPU busy even unfocused, and closes it when the game ends. It
also prints a clickable link per browser it found, so the game can be started in another one, plus
a plain link for any browser. A browser's name (`chrome`, `firefox`…) always uses that one,
`default` opens an ordinary tab in the system's browser, `none` only prints the links, and anything
else is a command run with the URL. `--no-browser` does the same as `none` for one run, which is
handy over SSH.

The host listens on its tailnet address and on loopback, port 7787, and never on any other
interface. Players are identified by their tailnet login (`tailscale whois`), so someone who drops
and rejoins keeps their gold and weapons.

The game page is served only on `127.0.0.1`, on a random port. Its URL carries a random token, and
the page's WebSocket refuses a wrong token or a page from another origin. One tab plays at a time;
opening the URL again takes over from the old tab.

Updates: the version is the git commit. With `AUTOUPDATE` on (the default), the launcher checks
the repo's main at most once an hour and updates in the background, then offers a restart.
`td host`, `td join` and `td serve` say when td is out of date and how to update, in the
terminal and in the game page.
A host and its players must run the same td: a host refuses a player whose version differs from
its own, and the refusal names both versions and says to run `td update` on both machines. The
launcher's join list and `td ls` mark such games with ✗.

After installing, `td update` lists the commits it brought in, newest first, read from its own
clone deepened by 200 commits with blobs left out, about a second. An installed commit it cannot
find there (a dirty local build, a branch switch, an install over 200 commits old) gets the latest
15 instead, labelled as such, rather than a guess. It is best-effort: a fetch that fails never
fails the update. A background update writes the list to its log.

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
| E | use what is under the cursor, or else the nearest thing: revive a downed teammate, search a loot site, repair a damaged building, shop at the armory (walking there first); on a creep, focus fire on it |
| right-click | on a creep, focus fire on it; anywhere else, the equipped weapon's signature, at the cursor |
| Shift / F / Q | abilities: grenade, dash, airstrike; aim with the cursor and left-click |
| H | hold position |
| 1-6, 0, R | equip a weapon (0 is the crowbar, on brutal), reload (or the reload button) |
| 8 | use a medkit |
| V | taunt: flip them off and shout; every creep around you comes for you for 5 s, sleeping guards too |
| B | build: X wall, G gate, T gun turret, C cannon, F frost tower, L tesla coil; shift keeps placing |
| left-click | select a building, creep or player |
| U / X | upgrade / sell the selected building (turrets, and walls and gates, which get 60% more HP a level) |
| G | armory: weapons, upgrade tracks, gear, abilities (you have to be standing by it) |
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

The top bar always shows the base's health, the generator's, next to the wave. Click it to look at
the base.

On the minimap, left-drag moves the view, right-click walks you there and Alt+click pings.

A weapon run dry reloads in the background: switch to another and keep shooting, and the empty
one comes back full a moment later. Its slot shows a moving strip while it reloads.

Medkits (8) heal 40% of your health over 3 s, unless a hit cuts it short. You start with one and
carry up to three. Buy them at the armory for 60 gold, or find them in places with a first-aid
kit, like an ambulance. The gear row that raises regeneration is Vitamins.

After every tenth wave a Huey gunship (surfboards strapped to its side) flies a supply crate out
beyond the walls, its door gunner working over the zone on the way in. The crate comes down under
a chute and marks itself with green smoke. Stand by it for a few seconds, unhurt, to open it:
gold and full medkits for everyone, and a rare find for the one who opened it. E walks you to a
crate nearby.

A ping shows for 5 s: rings on the ground and a beacon with your name over the spot, a pulse on
everyone's minimap, and an arrow at the edge of the screen for anyone looking elsewhere. Pings
show through fog. Three can go back to back, then one a second.

North is the top of the map. The compass strip at the top of the view shows which way the camera
faces as you rotate it, and clicking it turns the view north up again. The minimap is always north
up, and a downed teammate's call says where they fell, so "brute coming in from the NW" means
the same thing to everyone.

Outside the walls are ruined houses, wrecks and supply crates worth looting. The wrecks on the
roads differ: a pickup's bed holds tools and gear, a police cruiser or an army truck guns (the
army trucks are far out, and always guarded), an ambulance's kit patches you up, and a school
bus is slow to search but gives two finds, if nothing is nesting in it. A fire engine's lockers
always hold a medkit, an armoured cash van is slow to crack but pays out in gold, a camper van
may still have somebody living in it, and a motorbike's panniers take a second. Wrecks lie along the
roads and are solid: you walk round them, and search one from its side. A glint marks
the ones nobody has searched yet. Press E on one to walk over and search it, which takes a few
seconds and stops if you get hit. The further from the base, the better the loot, and searching
during a wave is luckier. Scavenger gear from the armory raises your luck too. Sometimes a house
hides a nest, and every fifth wave some of the searched sites are restocked.

Most sites are guarded like little dungeons: creeps sleep around them, from a few walkers to a
lair with a brute. You can search one with the guards still about, if you dare. Better guarded
sites hold better loot, and the quiet ones near the base only ever give gold, small upgrades and
now and then something more. Guards wake when you get close or shoot one, and give up and walk
home if you lead them too far away. In fog they notice you later.

Out by the edge, beside a road, stands a gas station. Its counter always gives a weapon you
don't have yet, and it is held hard: a garrison sleeps round the pumps and more of the dead hide
in the shop, bursting out when you step onto the lot and again when you start on the counter. A
shot or a blast that reaches a fuel pump sets it off: a fireball that hurts survivors too, sets
off the pumps beside it and leaves the ground burning.

Far out are three overrun outposts: walled forts with a keep, held by a garrison and its
warlord. They are hard going early on, and the stash inside is worth it: three finds, the first
rare at least. The hardest sites spring ambushes, with creeps that burst out as you walk in or
start searching.

Out in the wilds lies a crashed cargo plane: the hull with its hold, the tail torn off behind it,
a wing in pieces and a long burnt scar. A garrison sleeps in the wreckage, more come out when you
walk in, and its leaking engines go up like the gas station's pumps when shot. The hold gives a
field manual, a piece of kit and something rare or better.

On the outskirts, far from the base, stands an old church. Press E at the bell rope inside, under
the tower, and the bell rings out over the whole map: for a minute every creep there is, the wave
on its way in, the wanderers and the guards at their sites, heads for the church. Use it to pull a
wave off the base or to empty the sites for a raid, and don't be there when they arrive. The bell
can be rung again after a couple of minutes.

The dead also wander the wastes on their own, in small packs, shambling about away from the base.
They come for you if you get close or shoot them, and more turn up as they are killed, a few more
every wave. Every tenth wave they hear the call: partway into it, every wanderer left rushes the
generator, and the wave isn't over until they are dead too.

Once the dead are after you they run faster than you walk; only a sprint gets you away. Some are
sprinters, faster even than your sprint in bursts of a few seconds: outrunning one means running
on while it slows, or turning to fight. They call to each other, too: one that comes for you
brings everything round it, and that brings everything round it. Hiding in a ruin doesn't help
for long; they find the door.
Every hit you land stops one for a moment, though, which buys a step.

The dead come in kinds, and new ones join the waves as the game goes on: walkers from the
start, runners from wave 2, swarmers (small, fast, weak, many) from wave 3, brutes from wave 4,
spitters, which spit from a few steps off, from wave 6, and hurlers, which throw shards of bone
from twice as far, from wave 8. From wave 10 the bosses come.

Brutes and abominations slam the ground when you come near: a ring shows where it will land a
moment before. Get out of it, and don't fight them next to your turrets: the slam wrecks those
too. The broodmother, the other boss, fights from afar instead: she lobs sacs of bile over walls
at where you stand. Keep moving when the ring shows under you; a sac leaves a pool of acid and
a few swarmers behind, and every quarter of her life you shoot away spills a brood of them.

Gunfire is loud. Shooting wakes guards nearby and pulls wave creeps in earshot towards you; rain
and storms muffle it.

Creeps can be pulled. Shooting one may make it come for you instead of the generator (at a
quickened walk until it is close enough to see you, then at a run), and a
taunt (V) pulls everything around you. Creeps also take against things by themselves now and
then: a turret or wall they pass, or a survivor further off than they'd normally notice.

When you go down you can be revived where you fell: a teammate presses E on you and stays
next to you for a few seconds, and a hit starts it over. If nobody does, you're back at the base
when the countdown runs out.

The weather changes between waves and is the same for everyone. Fog shortens everyone's range
and hides teammates from the map and their health bars, rain dampens fire and slows creeps a
little, a storm throws lightning at creeps out in the open, and snow slows everything down.
Wet weather is mostly light, a drizzle or a passing thunder shower, and snow mostly a thin
fall. Heavy rain, full storms and heavy snow are rare.

Each weapon has its own signature ability on the right mouse button, stronger with its special upgrades:

| weapon | signature (right-click) |
|---|---|
| Pistol | fan the hammer: six quick shots |
| Shotgun | concussion: a blast in front that throws back and slows |
| SMG | bullet hose: double fire rate for 4 s |
| Rifle | piercing shot: five times the damage through a whole line |
| Minigun | overdrive: faster and piercing for 5 s |
| Rocket launcher | barrage: six rockets round a point |
| Crowbar (brutal) | haymaker: a swing all round that hurts and throws back |

Grenade, dash and airstrike are bought and levelled at the armory.

Creeps follow a flow field toward the generator and chew through whatever is in the way. Walls
and gates slow them down, but don't seal the base. The waves grow every time, faster the longer
the game goes, and with every player who is actually playing (anyone idle for 90 s doesn't
count). Each wave comes in from one side of the map, or from two or three later on, and seldom
from the side the last one did; the wave's notice says where ("incoming from the north and
east"). Every fifth wave is a swarm that swells as the game goes on; from wave 10 they are
hordes, a third of which pours out of every point on the wave's sides at once. Every tenth wave
brings a boss: an abomination or a broodmother, taking turns.

A wave holds until it is dead: the break before the next one starts only once every creep of it
is gone (sleeping guards don't count), so two waves never land on the base at once. Stragglers
don't stall the game: if nothing of the wave has died for 30 s and at most 10 are left, they
give up.

Between waves there is a short break, 15 s on Normal, and after every fifth wave a long one,
a minute on Normal, to go out exploring and looting; ten seconds before it ends everyone is
called home. The last seconds of every break count down in the middle of the screen. When
everyone is ready the countdown jumps to 3 s.

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

The host plays its own game the way everyone else does, through a client over loopback. `td
serve` is the same host without that client. The launcher (`td`) finds games by probing every
tailnet peer on the game port; a probe gets the host's `Info` (players, wave, difficulty,
version) and hangs up.

One tick, from a key press to the screen:

```
Browser                   local td (web.Session)               host td (netplay.Server)
  │                                │                                    │
  │  {"op":"move","x":…,"y":…}     │                                    │
  │ ──────────────────────────────▶│  Cmd: op, a, b, x/y to 1/8 tile,   │
  │                                │  t, text                           │
  │                                │ ──────────────────────────────────▶│  netplay.Exec on the World,
  │                                │                                    │  between ticks
  │                                │                                    │  every 50 ms: World.Step,
  │                                │                                    │  Encoder.Delta, shared by
  │                                │  frame: delta (or keyframe)        │  every player's queue
  │                                │ ◀──────────────────────────────────│
  │                                │  Replica.Apply                     │
  │  frame: the whole world        │                                    │
  │ ◀──────────────────────────────│                                    │
  │  interpolate, draw             │                                    │
```

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

`internal/playtest` plays whole games with nobody at the keys. Bots shop, build, loot, fight,
revive and taunt through the host's own command path (`netplay.Exec`). After every tick it
checks the world's invariants (`game.World.Check`), rebuilds a client replica from the wire to
see it agrees, and fails a wave that won't end. A game is its seed and its command log, so it
replays tick for tick. The golden game's world hash is kept in
`internal/playtest/testdata/golden.txt`: any change to how the game plays fails it until it is
rewritten with `./build.sh golden`, so the diff shows the change was intended. A soak failure
prints a `TD_SOAK_ONE=…` line that plays that game again.

The client source is in `web/` (TypeScript, three.js 0.186 with `three/webgpu` and TSL,
camera-controls, esbuild). `web/PROTOCOL.md` is the contract between `td` and the page, and
`docs/game-design.md` records the game design decisions and why they were made. Open
`internal/web/dist/index.html#demo` straight from disk for a self-running demo with a fake host;
`#demo&webgl` forces the WebGL 2 path, and `#demo&creeps=8000` stresses it.
`#lab` is the animation bench: every creep kind walking, idle, attacking, hit, burning, asleep
and dying, beside the survivors' poses; `#lab=0`…`#lab=7` looks at one creep row, `#lab=h` at the
survivors (`#lab=h0`…`#lab=h7` at one of them), and `&dist=11` brings the camera in.
