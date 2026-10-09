# Game design

The design decisions behind taildefense and the reasons for them. The numbers live in code
(`internal/game`); this file says why they are what they are. When a decision changes, update
it here along with the code.

## Pillars

- **Co-op first.** Everything should push the team to talk and split up: some stay and build,
  some go out and loot, and someone has to come back for the downed.
- **Fast.** Short breaks, waves that don't wait, no long downtime. A game is meant to be
  played through in an evening.
- **Readable.** An 8-bit look with chunky shapes. Every threat has to be readable at a glance,
  even with thousands of creeps on screen.
- **Risk for reward.** The good stuff is far out, guarded and noisy to get. Staying home is safe
  and poor.

## Pacing

| | Easy | Normal | Hard | Brutal |
|---|---|---|---|---|
| before wave 1 | 40 s | 20 s | 25 s | 30 s |
| break between waves | 20 s | 15 s | 18 s | 20 s |
| long break, after every 5th wave | 75 s | 60 s | 60 s | 60 s |

- **Short breaks** (15 s on Normal) keep the pressure on: enough to shop, repair and drop a
  turret, not enough to wander off. If everyone presses Ready, the countdown jumps to 3 s.
- **A long break after every fifth wave** (a minute on Normal) is the time to explore and loot.
  It lines up with the restock (some searched sites refill every fifth wave), so there is
  something worth going out for. 10 s before it ends, everyone is told to head back.
- **Announcements and a countdown.** The end of a wave says what it paid and how long the
  break is. The long break announces itself. The last 5 s of every break count down big in the
  middle of the screen ("wave N incoming"), so nobody is caught out.
- **Waves don't wait.** Once a wave is all out, it gets 40 s of overtime. The clock only starts
  when the wave reaches the base (a creep inside the build radius), or after 150 s whatever
  happens. Then the next break starts whether or not the wave is dead. A team that stays out
  looting comes back to two waves at once. The overtime waits for the base, so a slow wave
  isn't cut short before it gets there.
- **Stragglers don't stall the game.** If nothing of a wave has died for 30 s and at most 10 are
  left, they give up. A real fight is never cut short.
- **Pause.** Any player can pause, and any player can resume; the banner names who paused. If
  the pauser leaves, the game resumes. Friends playing together decide among themselves; no
  votes, no host privilege.

## Waves

- **They grow faster the longer the game goes.** The budget (in walker equivalents) is
  `20 + 12f + 1.1f² + 0.015f³` for wave f, times the difficulty. The early waves are gentle,
  and by the 30s it is a flood.
- **They scale with players who are actually playing.** Each player beyond the first adds
  `0.6 + 0.015·min(f, 30)` of a wave. A player who hasn't given a command for 90 s doesn't
  count, so an AFK friend doesn't make the game harder for the rest.
- **Spawning is spread out.** A wave comes out over `14 + min(wave, 30)` seconds, so later waves
  arrive as a stream, not a drip.
- **Every fifth wave is a swarm.** Its budget is multiplied by `1.5 + 0.05·min(f, 40)`, so the
  swarms swell as the game goes on.
- **Hordes from wave 10.** On swarm waves from 10 on, a third of the budget pours out of every
  spawn point at once, within 4–8 s, mostly swarmers. The HUD labels the wave "HORDE". This is
  the moment the base has to hold, and why the walls matter.
- **Every tenth wave brings an abomination**, a boss to rally around.
- **The cap.** 16k creeps alive. Around wave 40 with 8 players the game reaches it.

## Difficulty

Difficulty scales creep health, wave size, gold, break lengths, revive time and loot guards.
Harder modes get a little longer short breaks than Normal, since there is more to build against
each wave, but Normal is the reference for timing.

## Loot

- **Distance is the main gradient.** Sites further from the base give better loot. Searching
  during a wave is luckier than in a break. Scavenger gear raises luck too.
- **Guard level caps the rarity.** Rarity is capped by how well guarded a site is:

  | guards | best it gives |
  |---|---|
  | none | common |
  | light | good |
  | guarded | rare |
  | lair, garrison | jackpot |

  A find goes one step over the cap 6% of the time. The quiet houses near the base give gold
  and small upgrades, and only now and then something useful. That's so nobody gets a
  top weapon without taking a risk.
- **Guards like a little dungeon.** Creeps sleep around a site. They wake when you get close
  or shoot one, and give up and walk home if you lead them too far. You may search with the
  guards still about, if you dare. A hit stops the search.
- **Outposts.** Three overrun forts far out, held by a garrison and its warlord. They give three
  finds, the first one rare at least. They're hard early on, and a goal for later.
- **Ambushes and nests.** The hardest sites spring creeps as you walk in or search, and a house
  can hide a nest. Danger is never fully known in advance.
- **Restock.** Every fifth wave, some searched sites refill, so the map stays worth exploring
  in a long game.
- **Supply drops.** After every tenth wave a Huey gunship flies a crate 36–50 tiles out from the
  base, onto open ground a survivor can walk to. It's the long break's lure: worth the walk, out
  where the creeps are. The door gunner thins them on the way in. Opening it takes 2.5 s of
  standing by it unhurt, and it pays the whole team (gold, full medkits) plus a rare find for the
  opener. Up to three wait unopened. The surfboards on the Huey's side are for Kilgore.

### Wrecks

Wrecks on the roads come in kinds, so you know what to expect at a glance:

| wreck | where | what it gives |
|---|---|---|
| car | everywhere | anything, a little |
| pickup truck | everywhere | leans to tools and gear |
| school bus | nearer town | slow to search, two finds, often a nest inside |
| ambulance | anywhere | gear, and patches up the searcher |
| police cruiser | mid and far | leans to weapons |
| army truck | far out | weapons, better luck, always guarded |

"Leans to" means 60% of the finds come from the favoured kind. The kinds get tougher and
richer further out: the near roads are mostly cars and pickups, and the far roads hold most of
the army trucks.

## Noise and aggro

- Gunfire wakes guards nearby and pulls wave creeps in earshot. Rain and storms muffle it.
  Going out loud has a cost.
- Shooting a creep may turn it on you, and a taunt (V) pulls everything nearby for 5 s. Teammates
  can save each other this way.
- Creeps sometimes take against a turret, wall or far-off survivor by themselves, so the waves
  aren't perfectly predictable.

## Controls

- **WASD walks, like Project Zomboid or a twin-stick game.** The camera-free click-to-move of
  an RTS felt remote for a survival game: kiting a crowd by right-clicking behind you is
  clumsy. WASD goes the way the view faces, whatever the camera's yaw, so W is always up the
  screen. The client sends the direction several times a second while a key is held, and the
  host walks it straight with no pathfinding; a steer the host stops hearing about lapses
  after 0.4 s, so a lost key-up can't send a survivor off the map.
- **Aiming stays automatic.** The hero shoots the nearest creep in range while walking. This is
  co-op tower defense with thousands of creeps, not an aim game; your hands are for walking,
  abilities and building.
- **The rest follows Overwatch.** The weapon's signature is secondary fire on the right mouse
  button, at the cursor. The abilities are Shift, E and Q, with the big one (airstrike) on Q.
  E is "use": what is under the cursor, or else the nearest usable thing (a downed teammate, a
  loot site, a damaged structure, the armory); on a creep it focuses fire. Attack-move and stop
  went away with click-to-move; H still holds position.
- **The camera follows while you walk.** Arrows and the screen edge still look away, and the
  next step brings it back. The minimap's right-click still walks you there by path.
- **Numbers are the inventory.** 1–7 are the weapons, 8 the medkit. A weapon run dry reloads in
  the background, so switching to a loaded one is the fast way out of an empty magazine and
  carrying two guns pays.
- **Medkits are a decision, not a regen stat.** One heals 40% over 3 s, and a hit cuts it
  short, so you heal after you get clear, not in the crowd. You carry up to three, start with
  one, buy them for 60 gold or find them in ambulances. The old regen gear row is Vitamins.
- **The taunt is rude.** The survivor turns to the camera, flips the horde off and shouts. It's
  the funniest thing in the game to do to a brute, and it reads at a glance.

## Downed and revive

When you go down you stay where you fell, and a teammate can revive you by standing next to
you for a few seconds; a hit starts the revive over. Otherwise you respawn at the base when the
countdown ends. This makes going out alone risky, and going in pairs worth it.

## Weather

The weather changes between waves and is the same for everyone. Fog shortens everyone's range,
and creeps notice you later. Rain dampens fire and slows creeps a little, storms throw
lightning at creeps in the open, and snow slows everything.

**Heavy weather is rare.** Heavy rain, storms and heavy snow are dramatic but tiring to look at
and play through wave after wave. Their everyday forms are a **drizzle** (a little rain, fire
burns slightly cooler), a **thunder shower** (light rain, a bolt every 7–15 s instead of every
few seconds) and **snow** (a thin fall of flakes and a dusting on the ground; heavy snow is a
thick, wind-driven fall that turns the ground white). Odds per wave, roughly:

| clear | fog | drizzle | snow | thunder shower | heavy rain | heavy snow | storm |
|---|---|---|---|---|---|---|---|
| 39% | 17% | 16% | 9% | 8% | 5% | 4% | 3% |

Light weather counts as a fraction of its heavy form for every effect (drizzle 0.3, thunder
shower 0.5, snow 0.4), on screen and in the sim alike.

**Fog hides teammates.** In thick fog (strength above 0.4), other players vanish from the
minimap. Their figures and names stay visible in the world, but their health bars, search and
revive rings and respawn countdown are hidden. A downed teammate's call says "somewhere in the
fog" instead of where. The team has to talk ("I'm at the bus north of the base") and stick
together. This is client-side only. The host still sends everything, so it is a game feel
choice, not a cheat guard.

## Survivors

- **Archetypes.** Ten of them: paramedic, mechanic, hunter, student, builder, nurse, biker,
  farmer, ex-soldier and office worker. Each has its own outfit, and the archetype shows on the
  scoreboard.
- **Looks are random.** Skin, body, hair, beard, build, height and glasses vary independently,
  so a team of eight looks like eight different people of any race and gender. It's all
  cosmetic. No archetype plays differently, so nobody feels stuck with a bad pick.
- **Assignment.** A new player is dealt one of the least-used archetypes, so a team is varied
  by default. A player who reconnects keeps their look.
- **Portrait.** The HUD shows a 16×16 pixel portrait of your survivor.

## Map and orientation

- North is the top of the map. The compass strip shows where the camera faces, and the minimap
  is always north up. Calls like "brute from the NW" mean the same to everyone.
- Chat with Tab inserts where you are ("NE of the base, 40 m").
- **Pings, like DOTA.** Alt+click (or Z, then click) marks a spot for everyone, in the world
  or on the minimap. Talking is better, but a ping is faster in a fight. The ping's meaning comes
  from what is under the cursor, so there is one gesture to learn: a creep is "danger" (always
  red), an unsearched site "loot", a structure "defend", anything else "here". Everyone sees
  ground rings, a beacon with the pinger's name, a pulse on the minimap, and an edge arrow
  when it is off screen. It lasts 5 s. Pings show through fog. Fog hides where teammates are,
  not what they say. The host meters them (3 back to back, then one a second), so one player
  can't flood everyone's screen.
- **M expands the minimap** into a big map in the middle of the screen, sized to fit between the
  compass and the console. It works like the small map: click to look, right-click to walk
  there. M or Esc closes it. This is for planning a loot run during the long break without
  squinting.

## HUD

- **The base's health is always in the top bar**, right after the wave readout. It's the one
  number the game is lost on, so nobody should have to go looking for it. It is a segmented bar
  and a percentage: moss, then amber below 60%, rust and pulsing below 30%. It flashes when the
  generator takes a hit. Clicking it looks at the base.

## Boot splash

The page opens on a short splash (about 2.5 s, any key or click skips it, reduced motion shows
the finished frame). It's in the same spirit as crowbar's boot, where a torch welds the wordmark,
but it tells this game's story instead:

- The **wordmark is a wall**. TAILDEFENSE is set in a chunky 6×7 block font, and every pixel
  of it is a bevelled brick. The bricks drop in from both ends towards the middle, glow hot as
  they land and kick up dust. "tail" is bone and "defense" amber, the HUD's two main inks.
- **Creeps crawl in** from the dark edges while it is being built. Once the wall stands, its
  guns open up from both ends and amber tracers pick them off one by one.
- **A searchlight** crosses the finished word once.
- The tagline types in under it in the CRT face: "hold the base · loot the dark · bring
  everyone home". A strip of masking tape ("co-op tower defense · over the tailnet") slaps
  onto the word, and a segmented bar fills like a wave counter.
- It is drawn on a low-res canvas scaled up with hard pixels, over ordered-dither ground and
  scanlines, so it looks like the game's pixel view. Its clock advances at most 1/30 s per
  frame, so while the page is busy loading it slows down instead of skipping ahead.
- The connection screen uses the same wordmark, finished.
