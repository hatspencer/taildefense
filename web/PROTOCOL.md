# Browser protocol

The browser never talks to the game host. `td host` and `td join` each run a small web
server on `127.0.0.1` that serves this client and relays to the host over the tailnet:

```
browser ──WebSocket (localhost)──▶ td (this machine) ──TCP, deflate, deltas (tailnet)──▶ host
```

The local `td` decodes the host's delta stream into a replica and sends the browser a
**full view of the world every tick** (20 Hz). Localhost bandwidth is free, so the client
keeps no delta state: each frame replaces the last. Interpolation between the last two
frames is the client's business.

## Connecting

The page is opened as `http://127.0.0.1:PORT/#TOKEN`. The client connects to
`ws://127.0.0.1:PORT/ws?token=TOKEN` (same host and port as the page). A wrong token or a
foreign `Origin` is refused. One browser tab at a time: a new connection replaces the old
one, which receives `{"t":"end","reason":"opened in another tab"}`.

On every (re)connection the server sends, in order: the `welcome` JSON, the terrain binary
message, then frames. A reload of the page therefore resumes the same game.

## Server → browser

Text messages are JSON objects with a `t` field. Binary messages start with a type byte.

### `welcome` (text)

Sent on connect, and again when the host restarts the game on a new map (the client resets
everything it knows, a terrain message follows).

```jsonc
{
  "t": "welcome",
  "proto": 9,
  "version": "a1b2c3d",
  "you": 0,                    // your player id
  "w": 320, "h": 200,          // map size in tiles
  "seed": "1234567",           // string: it is a uint64
  "host": "box",               // the host machine
  "hosting": true,             // this td is the host (leaving ends the game for everyone)
  "hint": "td join box",       // how friends join, "" when only this machine can
  "tickRate": 20,
  "difficulty": {"id": 1, "name": "Normal"},   // chosen by the host before hosting
  "difficulties": ["Easy", "Normal", "Hard", "Brutal"],
  "fogOfWar": false,           // the host's FOG setting: the client hides what the team cannot see
  "weathers": [                // index = weather kind in the frame
    {"name": "Clear", "info": ""},
    {"name": "Fog", "info": "everyone sees and shoots 25% less far; creeps notice you later"}
  ],
  "taunt": {"cool": 12, "radius": 12, "time": 5},  // the taunt command: cooldown s, pull radius, s hunted
  "revive": {"reach": 1.6, "time": 2.5, "hp": 0.4}, // stand within reach for time seconds; up with hp*maxHp
  "medkit": {"heal": 0.4, "time": 3, "max": 3, "cost": 60}, // one heals heal*maxHp over time s; carry max; cost gold
  "core": {"x": 160, "y": 100},// generator centre, tiles
  "buildRadius": 24,           // building only within this distance of core
  "shopRadius": 4.5,           // shop only within this distance of the armory centre
  "maxLevel": 5,               // weapon track and gear max level
  "maxStructLevel": 5,
  "repairCostPerHP": 0.1,
  "sellFraction": 0.5,         // selling returns this share of price + upgrades, times hp/maxHp
  "tracks": ["damage", "fire rate", "handling", "special"],
  "creeps": [                  // index = creep kind
    {"name": "walker", "hp": 40, "speed": 1.7, "radius": 0.45, "size": 1, "ranged": false, "bounty": 3,
     "rate": 1, "windup": 0.4}   // blows per second; seconds each is wound up (creep flag 64)
  ],
  "weapons": [                 // index = weapon kind
    {
      "name": "Pistol", "short": "PST", "price": 0, "range": 14,
      "fire": "hitscan",       // hitscan | cone | rocket
      "special": "+1 pierce",
      "costs": [[60, 93, 144, 223, 346], ...],      // [track][level] price to go level -> level+1
      "values": [["14 dmg", "17 dmg", ...], ...],   // [track][level 0..5] what the track gives
      "sig": {"name": "Fan the hammer", "desc": "...", "cool": 8, "range": 14, "radius": 0, "target": "point"}
      // radius: area round the point; with "cone" (half-angle, radians) it is a cone's reach in front
    }
  ],
  "gear": [ {"name": "Armor", "info": "+25 max HP", "costs": [90, 153, 260, 442, 752]} ],
                               // 0 Armor, 1 Boots, 2 Medkit, 3 Scavenger (luck when searching)
  "abilities": [               // index = ability slot 0..3; "key" is what the client binds it to (RMB Shift E Q)
    {"name": "Signature", "key": "Q", "desc": "the equipped weapon's own ability",
     "target": "point", "range": 0, "cool": [0, 0, 0], "costs": [0, 0, 0], "always": true},
    {"name": "Grenade", "key": "W", "desc": "...", "target": "point", "range": 11,
     "radius": [2.5, 3, 3.5], "cool": [9, 8, 7], "costs": [200, 450, 800], "always": false}
  ],
  "structs": [                 // index = struct kind; 0 is "none"
    {"name": "Wall", "price": 20, "hp": 320, "w": 1, "h": 1, "range": 0, "turret": false,
     "key": "W", "desc": "...", "upgrade": [0, 96, 192, 288, 384]}   // [level] price level -> level+1
  ],
  "buildable": [3, 4, 5, 6, 7, 8],
  "siteKinds": [               // index = site kind
    {"name": "Ruined house", "search": 3},   // search: seconds it takes
    {"name": "Car wreck", "search": 2},
    {"name": "Supply crate", "search": 1.5},
    {"name": "Overrun outpost", "search": 6},
    {"name": "Pickup truck", "search": 2.5},
    {"name": "Police cruiser", "search": 2.5},
    {"name": "Ambulance", "search": 3},
    {"name": "School bus", "search": 4},
    {"name": "Army truck", "search": 3.5},
    {"name": "Gas station", "search": 5},
    {"name": "Fuel pump", "search": 0}       // not loot: see below
  ],
  "sites": [                   // index = site id, used in the loot command
    {"kind": 0, "x": 40, "y": 30, "w": 8, "h": 6,  // tiles covered: the house with its walls
     "sx": 43.5, "sy": 32.5,                        // the spot a survivor searches from
     "tier": 2,                                     // 0 near the base .. 2 far out: better loot
     "guard": 2,                                    // 0 unguarded .. 3 a lair, 4 a garrison: how hard its guards are
     "yaw": 0}                                      // a wreck's heading, radians from +x towards +y; survivors can't walk through it
  ]
}
```

Weather is the host's and the same for everyone. It changes between waves, easing out and
the next one in over a few seconds; its effects scale with `weatherAmt`:

| kind | name  | effect |
|------|-------|--------|
| 0    | Clear | none |
| 1    | Fog   | survivors and turrets reach 25% less far; creeps notice survivors at 60% of the distance |
| 2    | Heavy rain | burning does half the damage; creeps 8% slower (rare) |
| 3    | Storm | heavy rain, and lightning strikes creeps out in the open every few seconds (blast kind 8; rare) |
| 4    | Snow  | light snow: creeps 6% slower, survivors 3% slower |
| 5    | Drizzle | light rain: burning does 15% less damage, creeps 2.4% slower |
| 6    | Thunder shower | light rain, and lightning now and then (every 7–15 s) |
| 7    | Heavy snow | creeps 15% slower, survivors 8% slower (rare) |

Difficulty is the host's choice, fixed for the game (a restart keeps it): it scales creep
health and wave size, the gold creeps drop, the build time between waves, the strength of
loot guards and how long a downed survivor can be revived.

Loot sites are fixed for a map. A house is a ruin of rock tiles with a doorway; the
searcher stands inside at `sx, sy`; an outpost is a walled fort searched in its keep. A wreck
(kinds 1 and 4..8: car, pickup, police cruiser, ambulance, school bus, army truck) or a crate
covers one tile and is not solid; the client draws the vehicle round it. Pickups and
ambulances lean towards gear, cruisers and army trucks towards weapons; an ambulance's kit
heals the searcher, a bus gives two finds and often hides a nest, and an army truck is always
guarded.
Every map has one gas station (kind 9), beside a road out near the edge: `x, y, w, h` is its
shop, a walled room searched at its counter, and its search always gives a weapon the
searcher does not have yet. Its fuel pumps (kind 10, one tile each) stand on the concrete lot
in front, under a canopy the client draws over them. They are sites only to share the list and
the searched bit, which for a pump means blown up: they cannot be searched. A shot, a flame,
a rocket or a blast that reaches a standing pump sets it off: a fireball (blast kind 0) that
hurts survivors as well as creeps, sets off the pumps beside it, and leaves burning fuel
(effect kind 2). A standing pump blocks survivors like a wreck. The station's garrison sleeps
round the pumps, and more creeps hide in the shop: they burst out at the first survivor on
the lot, and again when someone starts on the counter.
Each site can be searched once; whether it has been is in every frame. Every fifth wave
some searched sites are restocked, and their guards come back.

Most sites are guarded, like small dungeons: creeps (flag 4) sleep around them from the
start of the game, stronger the higher the site's `guard`. Guards do not take part in waves
and a wave ends without them. They wake when a survivor comes close or shoots one, chase,
and go back home when led too far away. A site can be searched with its guards still alive,
if you dare; the frame carries how many are left per site. Better guarded sites find better
loot, and the guard level caps it: unguarded sites never give more than a common find, bar
now and then.

The signature ability (slot 0, Q) depends on the equipped weapon: its name, cooldown and range
are in `weapons[cur].sig`. It is always available at level 1. Slots 1–3 start at level 0
(locked) and are bought at the armory up to level 3; `costs[l]` is the price of l -> l+1 and
`cool[l-1]` the cooldown at level l, `radius[l-1]` the area at level l. A turret's
`ranges[l-1]` is its reach at level l (absent for walls and gates).

### Terrain (binary, type 2)

```
u8   2
u8   tile[w*h]      row-major, index y*w+x
```

Tiles: 0 grass, 1 dirt (roads), 2 floor (base concrete), 3 sand, 4 water, 5 tree, 6 rock.
4 and up are solid (nothing walks or builds there). Trees and rocks stop bullets.

Tile (x, y) covers world coordinates [x, x+1) × [y, y+1). Positions below are in tiles,
quantised to 1/8: a `q8` value v is the coordinate v / 8.

### Frame (binary, type 1)

All little-endian. Counts precede their lists.

```
u8   1
u32  tick
u8   phase            0 build (between waves), 1 wave, 2 over (generator destroyed)
u16  wave             current wave number (0 before the first)
u16  phaseLeft        deciseconds until the next wave, build phase only
u32  pending          creeps of this wave still to spawn
u32  totalKills
u16  best             waves survived, when over
u8   weather          index into the welcome's weathers: 0 clear, 1 fog, 2 heavy rain, 3 storm, 4 snow,
                      5 drizzle, 6 thunder shower, 7 heavy snow
u8   weatherAmt       how strong it is right now, 0..255; it eases in and out between waves
u8   pausedBy         0 running, else 1 + the id of the player who paused the game

u8   nPlayers
  u8   id
  u8   flags          1 connected, 2 alive, 4 firing, 8 ready, 16 reloading,
                      32 hurt (just took damage), 64 at armory (can shop), 128 moving
  u16  x q8, u16 y q8
  u16  aim            angle in turns * 65536 (0 = +x, increasing towards +y)
  u16  hp, u16 maxHp
  u8   cur            equipped weapon kind
  u16  ammo, u16 mag
  u8   reload         fraction of the reload left, 0..255
  u8   respawn        seconds until respawn when down; until then a teammate can revive
                      them where they fell
  u32  gold, u32 kills, u32 damage
  u8   owned          bit k set: weapon k owned
  u8   levels[28]     weapon-major: levels[w*4 + track]
  u8   gear[4]        Armor, Boots, Vitamins, Scavenger
  u8   order          0 idle, 1 move, 2 attack-move, 3 attack, 4 hold, 5 build, 6 repair,
                      7 loot, 8 revive, 9 steer (walking with WASD)
  u8   channel        how far the current search (order 7) or revive (order 8) is, 0..255;
                      0 while walking there
  u8   revived        for a downed survivor: how far the best revive on them is, 0..255
  u8   emote          0 none, 1 taunting
  u8   emoteLeft      deciseconds left of the emote
  u16  tauntCool      deciseconds until the taunt can be used again
  u8   stamina        0..255, spent by sprinting
  u8   sprint         bit 0 sprinting now, bit 1 winded (no sprint until the bar is back to about a third)
  u32  look           what the survivor looks like, dealt by the host on joining, bits:
                        0-3 archetype (0 paramedic, 1 mechanic, 2 hunter, 3 student, 4 builder,
                            5 nurse, 6 biker, 7 farmer, 8 ex-soldier, 9 office worker),
                        4-6 skin tone (0 deepest .. 7 palest), 7-8 body (0 masc, 1 fem, else androgynous),
                        9-12 hair style, 13-15 hair colour, 16-17 facial hair, 18-19 build,
                        20-21 height, 22-23 glasses when both are 0
  u8   buff           0 none, else the weapon kind whose signature buff is running
  u8   buffLeft       deciseconds
  4 × (u8 level, u16 cooldown deciseconds left)     ability slots 0..3
  u8   medkits        carried
  u8   heal           deciseconds of a medkit's healing left
  u8   reloading      bit k set: weapon k is reloading, in hand or not
  u8   nameLen, name (utf-8)

u16  nSites           same as the welcome's site list
  u8   site[nSites]   bit 7 set: searched; bits 0..6: guards of the site still alive

u8   nCrates          supply crates down and not yet opened (at most 3)
  u16  x, y q8
  u8   open           how far opening it is, 0..255

u16  nStructs         the whole list; the index is the struct id used in commands
  u8   alive          dead slots are kept (alive 0) so ids stay stable
  u8   kind
  u16  x, u16 y       top-left tile
  u8   w, u8 h        tiles
  u16  hp, u16 maxHp
  u8   level
  i8   owner          player id, -1 for the starting base

u16  nCreeps
  u16  id             stable for the creep's life; reused after death
  u16  x q8, u16 y q8
  u8   kind
  u8   hp             fraction of max, 1..255
  u8   flags          1 burning, 2 slowed, 4 guard (of a loot site, not of the wave),
                      8 hunting a survivor (aggro: pulled, taunted or provoked),
                      16 going for a structure (a turret or wall caught its eye),
                      32 asleep (a guard resting at its site),
                      64 winding up a blow (it lands in the creep kind's windup seconds or less),
                      128 striking (the blow lands this tick)
  u8   target         for flag 8: the hunted survivor's player id; else, while attacking a
                      structure, 128 + the angle to it in 127ths of a turn (0 = +x, towards +y);
                      else 255

u16  nTracers         shots fired this tick
  u16  x0, y0, x1, y1 q8
  u8   kind           0..6 player weapon kind, 16+structKind turret shot, 32 spitter spit,
                      33 dash (the hero's leap, start to end), 34 the Huey's door gunner
                      (x0,y0 is the Huey over the ground; it fires from the air)
u16  nBlasts          explosions and pulses this tick
  u16  x, y q8
  u8   r              radius * 8
  u8   kind           0 explosion, 1 frost pulse, 2 tesla spark, 3 concussion, 4 airstrike,
                      5 loot found (r: 8 = jackpot or rare, else common), 6 ambush (a nest wakes),
                      7 taunt (a ring the size of the pull), 8 lightning strike (storm),
                      9 revived (a survivor stands up), 10 guards wake (at the guard)
u16  nDeaths          creeps that died this tick
  u16  x, y q8
  u8   kind
u16  nEffects         lasting effects, the full current list every frame
  u8   kind           1 grenade in flight (x0,y0 -> x,y), 2 napalm pool, 3 airstrike target,
                      4 supply drop: a Huey flying in from x0,y0 to hover over x,y (eased in over
                      all but the last 3 s); the crate lands at x,y when it ends, 5 a warlord's
                      slam coming down on every survivor within r of x,y when it ends
  u16  x0, y0, x, y q8
  u8   r              radius * 8
  u8   left           deciseconds left
  u8   total          deciseconds it lasts in all
u8   nNotes           announcements to everyone this tick
  u8   level          0 info, 1 good, 2 bad, 3 a player's chat line "name: text"
  u16  len, text (utf-8)
u8   nPings           spots players marked for the team this tick
  u8   player         who pinged
  u16  x, y q8
  u8   kind           0 here, 1 danger (on a creep), 2 loot (on a site), 3 defend (on a structure)
```

### Other text messages

```jsonc
{"t": "toast", "level": 2, "text": "not enough gold: need 250, have 120"}  // to you only
{"t": "status", "text": "hosting · 2/8 · friends: td join box"}          // about every 2 s
{"t": "end", "reason": "the host ended the game or went away"}          // then the socket closes
```

## Browser → server

Text messages, JSON, one command each. Coordinates are tiles (floats); `tx`, `ty` are tile
integers. The host checks everything; a refusal comes back as a `toast` with level 2.

```jsonc
{"op": "move",    "x": 160.5, "y": 103.2}   // walk there, ignoring creeps
{"op": "amove",   "x": 140.0, "y": 100.0}   // attack-move: walk, stop to fight anything in range
{"op": "steer",   "x": 1.57, "on": true}    // WASD: walk along the angle x (radians, map coordinates:
                                            // 0 east, pi/2 south); repeat while held, it lapses
                                            // after 0.4 s; on false stops
{"op": "medkit"}                            // use a medkit
{"op": "buyMedkit"}                         // buy one, at the armory
{"op": "attack",  "id": 1234}               // chase and shoot one creep
{"op": "stop"}                               // drop the order, fight what comes in range
{"op": "hold"}                               // stand still, fight what comes in range
{"op": "ability", "slot": 1, "x": 150, "y": 98}  // cast Q W E R (slot 0..3) at a point
{"op": "build",   "kind": 5, "tx": 150, "ty": 96}  // walk to the tile and build there
{"op": "repair",  "s": 12}                   // walk to struct 12 and repair it (costs gold)
{"op": "loot",    "site": 3}                 // walk to site 3 and search it
{"op": "upgradeStruct", "s": 12}             // anywhere
{"op": "sell",    "s": 12}                   // anywhere, your own or the base's
{"op": "buyWeapon", "w": 2}                  // at the armory
{"op": "upgrade", "w": 2, "track": 0}        // at the armory
{"op": "gear",    "g": 1}                    // at the armory
{"op": "buyAbility", "slot": 2}              // at the armory
{"op": "select",  "w": 2}                    // equip an owned weapon
{"op": "reload"}                             // reload the equipped weapon now
{"op": "taunt"}                              // pull every creep within taunt.radius onto you
{"op": "revive",  "p": 2}                    // walk to downed player 2 and revive them
{"op": "ready",   "on": true}                // ready for the next wave (all ready: starts in 3 s)
{"op": "restart"}                            // a new map, only once the game is over
{"op": "chat",    "text": "gg"}
{"op": "ping",    "x": 150, "y": 98, "kind": 1}  // mark a spot for everyone; 3 back to back, then one a second
{"op": "leave"}                              // back to the terminal; ends the game if hosting
```
