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
| `td` | launcher: host (←/→ picks the difficulty), join (lists the games on your tailnet), settings, update status |
| `td host [--port N] [--seed S] [--name NAME] [--difficulty D]` | host a game and play it in the browser |
| `td join HOST[:PORT] [--name NAME]` | join a game by tailnet name or address |
| `td serve [--port N] [--seed S] [--difficulty D]` | headless dedicated host; logs to stdout until interrupted |
| `td ls [--json]` | games running on your tailnet |
| `td bench [--wave N] [--players P] [--seconds S]` | time a busy wave offline: simulation, encoding, relay |
| `td frame [--view menu\|join\|settings\|help]` | render one launcher frame from demo data |
| `td doctor` | check tailscale, the browser, container engine, install |
| `td config [KEY [VALUE]]` | show or change settings: NAME, PORT, DIFFICULTY, BROWSER, AUTOUPDATE |
| `td update [-f] [-b BRANCH]` | rebuild from the repo's main (or a branch) and reinstall |
| `td install [-f]` | install this build |
| `td version [--offline] [--json]` | this build and whether a newer one exists |

`DIFFICULTY` is `easy`, `normal` (the default), `hard` or `brutal`, for the games you host. It
scales creep health and wave size, gold, the time between waves, how tough the loot guards are
and how long a downed player can be revived (20 s on normal). A restart keeps the game's difficulty.

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

## Playing

Everyone who joins is dealt a survivor: a paramedic, mechanic, hunter, student, builder, nurse,
biker, farmer, ex-soldier or office worker, each with their own face, skin, body, build and hair.
A team gets as many different outfits as it can, all worn in the player's colour, and you keep
yours if you drop out and come back.

Your hero fights by itself: standing idle or holding, it shoots the nearest creep it can see in
range, and doesn't waste shots on walls.

| input | |
|---|---|
| right-click | move; on a creep, attack it; on a damaged building, repair it; on the armory, walk there and shop; on a loot site, search it; on a downed teammate, revive them |
| A, then left-click | attack-move: walk there, stopping to fight anything on the way |
| S / H | stop / hold position |
| Q W E D | abilities: Q is the equipped weapon's signature, W grenade, E dash, D airstrike |
| 1-7, R | equip a weapon, reload (or the reload button) |
| V | taunt: every creep around you comes for you for 5 s, sleeping guards too |
| B | build: W wall, G gate, T gun turret, C cannon, F frost tower, L tesla coil; shift keeps placing |
| left-click | select a building, creep or player |
| U / X / F | upgrade / sell / repair the selected building |
| G | armory: weapons, upgrade tracks, gear, abilities (you have to be standing by it) |
| N | ready for the next wave |
| P | pause or resume the game, for everyone; anyone can do either |
| M | big map, and back |
| Alt+left-click, or Z then left-click | ping: mark the spot for the whole team, in the world or on the map. On a creep it warns of danger, on a loot site it marks loot, on a building it calls to defend it |
| hold Space | sprint, until you run out of stamina |
| middle-drag, Alt+wheel | rotate the camera |
| wheel | zoom |
| arrows, screen edges | pan; tapping Space recenters on your hero, a double tap locks the camera to it |
| T or Enter | chat with the team; in the chat, Tab adds where you are ("NE of the base, 40 m") |
| Tab, F1, F3, Esc | scoreboard, help, stats, cancel / menu |

The top bar always shows the base's health, the generator's, next to the wave. Click it to look at
the base.

On the minimap, left-drag moves the view, right-click gives a move order and Alt+click pings.

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
bus is slow to search but gives two finds, if nothing is nesting in it. A glint marks
the ones nobody has searched yet. Right-click one to walk over and search it, which takes a few
seconds and stops if you get hit. The further from the base, the better the loot, and searching
during a wave is luckier. Scavenger gear from the armory raises your luck too. Sometimes a house
hides a nest, and every fifth wave some of the searched sites are restocked.

Most sites are guarded like little dungeons: creeps sleep around them, from a few walkers to a
lair with a brute. You can search one with the guards still about, if you dare. Better guarded
sites hold better loot, and the quiet ones near the base only ever give gold, small upgrades and
now and then something more. Guards wake when you get close or shoot one, and give up and walk
home if you lead them too far away. In fog they notice you later.

Far out are three overrun outposts: walled forts with a keep, held by a garrison and its
warlord. They are hard going early on, and the stash inside is worth it: three finds, the first
rare at least. The hardest sites spring ambushes, with creeps that burst out as you walk in or
start searching.

Gunfire is loud. Shooting wakes guards nearby and pulls wave creeps in earshot towards you; rain
and storms muffle it.

Creeps can be pulled. Shooting one may make it come for you instead of the generator, and a
taunt (V) pulls everything around you. Creeps also take against things by themselves now and
then: a turret or wall they pass, or a survivor further off than they'd normally notice.

When you go down you can be revived where you fell: a teammate right-clicks you and stays
next to you for a few seconds, and a hit starts it over. If nobody does, you're back at the base
when the countdown runs out.

The weather changes between waves and is the same for everyone. Fog shortens everyone's range
and hides teammates from the map and their health bars, rain dampens fire and slows creeps a
little, a storm throws lightning at creeps out in the open, and snow slows everything down.
Wet weather is mostly light, a drizzle or a passing thunder shower. Heavy rain and full storms
are rare.

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
and gates slow them down, but don't seal the base. The waves grow every time, faster the longer
the game goes, and with every player who is actually playing (anyone idle for 90 s doesn't
count). Every fifth wave is a swarm that swells as the game goes on; from wave 10 they are
hordes, a third of which pours out of every spawn point at once. Every tenth wave brings an
abomination.

The waves don't wait. 40 s after a wave has all come out and reached the base, the countdown to
the next one starts whether or not the last is dead, so a team out looting comes back to two
waves at once.

Between waves there is a short break, 15 s on Normal, and after every fifth wave a long one,
a minute on Normal, to go out exploring and looting; ten seconds before it ends everyone is
called home. The last seconds of every break count down in the middle of the screen. When
everyone is ready the countdown jumps to 3 s.

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
camera-controls, esbuild). `web/PROTOCOL.md` is the contract between `td` and the page, and
`docs/game-design.md` records the game design decisions and why they were made. Open
`internal/web/dist/index.html#demo` straight from disk for a self-running demo with a fake host;
`#demo&webgl` forces the WebGL 2 path, and `#demo&creeps=8000` stresses it.
