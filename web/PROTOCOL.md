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
  "proto": 2,
  "version": "a1b2c3d",
  "you": 0,                    // your player id
  "w": 320, "h": 200,          // map size in tiles
  "seed": "1234567",           // string: it is a uint64
  "host": "box",               // the host machine
  "hosting": true,             // this td is the host (leaving ends the game for everyone)
  "hint": "td join box",       // how friends join, "" when only this machine can
  "tickRate": 20,
  "core": {"x": 160, "y": 100},// generator centre, tiles
  "buildRadius": 24,           // building only within this distance of core
  "shopRadius": 4.5,           // shop only within this distance of the armory centre
  "maxLevel": 5,               // weapon track and gear max level
  "maxStructLevel": 5,
  "repairCostPerHP": 0.1,
  "sellFraction": 0.5,         // selling returns this share of price + upgrades, times hp/maxHp
  "tracks": ["damage", "fire rate", "handling", "special"],
  "creeps": [                  // index = creep kind
    {"name": "walker", "hp": 40, "speed": 1.7, "radius": 0.45, "size": 1, "ranged": false, "bounty": 3}
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
  "abilities": [               // index = ability slot 0..3, keys Q W E R
    {"name": "Signature", "key": "Q", "desc": "the equipped weapon's own ability",
     "target": "point", "range": 0, "cool": [0, 0, 0], "costs": [0, 0, 0], "always": true},
    {"name": "Grenade", "key": "W", "desc": "...", "target": "point", "range": 11,
     "radius": [2.5, 3, 3.5], "cool": [9, 8, 7], "costs": [200, 450, 800], "always": false}
  ],
  "structs": [                 // index = struct kind; 0 is "none"
    {"name": "Wall", "price": 20, "hp": 320, "w": 1, "h": 1, "range": 0, "turret": false,
     "key": "W", "desc": "...", "upgrade": [0, 96, 192, 288, 384]}   // [level] price level -> level+1
  ],
  "buildable": [3, 4, 5, 6, 7, 8]
}
```

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
  u8   respawn        seconds until respawn when dead
  u32  gold, u32 kills, u32 damage
  u8   owned          bit k set: weapon k owned
  u8   levels[28]     weapon-major: levels[w*4 + track]
  u8   gear[3]
  u8   order          0 idle, 1 move, 2 attack-move, 3 attack, 4 hold, 5 build, 6 repair
  u8   buff           0 none, else the weapon kind whose signature buff is running
  u8   buffLeft       deciseconds
  4 × (u8 level, u16 cooldown deciseconds left)     ability slots Q W E R
  u8   nameLen, name (utf-8)

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
  u8   flags          1 burning, 2 slowed
  u8   reserved

u16  nTracers         shots fired this tick
  u16  x0, y0, x1, y1 q8
  u8   kind           0..6 player weapon kind, 16+structKind turret shot, 32 spitter spit,
                      33 dash (the hero's leap, start to end)
u16  nBlasts          explosions and pulses this tick
  u16  x, y q8
  u8   r              radius * 8
  u8   kind           0 explosion, 1 frost pulse, 2 tesla spark, 3 concussion, 4 airstrike
u16  nDeaths          creeps that died this tick
  u16  x, y q8
  u8   kind
u16  nEffects         lasting effects, the full current list every frame
  u8   kind           1 grenade in flight (x0,y0 -> x,y), 2 napalm pool, 3 airstrike target
  u16  x0, y0, x, y q8
  u8   r              radius * 8
  u8   left           deciseconds left
  u8   total          deciseconds it lasts in all
u8   nNotes           announcements to everyone this tick
  u8   level          0 info, 1 good, 2 bad
  u16  len, text (utf-8)
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
{"op": "attack",  "id": 1234}               // chase and shoot one creep
{"op": "stop"}                               // drop the order, fight what comes in range
{"op": "hold"}                               // stand still, fight what comes in range
{"op": "ability", "slot": 1, "x": 150, "y": 98}  // cast Q W E R (slot 0..3) at a point
{"op": "build",   "kind": 5, "tx": 150, "ty": 96}  // walk to the tile and build there
{"op": "repair",  "s": 12}                   // walk to struct 12 and repair it (costs gold)
{"op": "upgradeStruct", "s": 12}             // anywhere
{"op": "sell",    "s": 12}                   // anywhere, your own or the base's
{"op": "buyWeapon", "w": 2}                  // at the armory
{"op": "upgrade", "w": 2, "track": 0}        // at the armory
{"op": "gear",    "g": 1}                    // at the armory
{"op": "buyAbility", "slot": 2}              // at the armory
{"op": "select",  "w": 2}                    // equip an owned weapon
{"op": "reload"}
{"op": "ready",   "on": true}                // ready for the next wave (all ready: starts in 3 s)
{"op": "restart"}                            // a new map, only once the game is over
{"op": "chat",    "text": "gg"}
{"op": "leave"}                              // back to the terminal; ends the game if hosting
```
