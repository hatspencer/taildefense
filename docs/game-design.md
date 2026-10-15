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
- **Room to build.** Building is allowed within 40 tiles of the generator, well past the
  starting walls (14 out), so the team can push a second ring of walls and turrets out toward
  the fronts. No ruin, loot crate or wrecked car stands on that ground, and the generator
  keeps all of it in sight.

## Pacing

| | Easy | Normal | Hard | Brutal |
|---|---|---|---|---|
| before wave 1 | 40 s | 20 s | 25 s | 30 s |
| break between waves | 20 s | 15 s | 18 s | 20 s |
| long break, after every 5th wave | 75 s | 60 s | 60 s | 60 s |
| starting weapon | pistol | pistol | pistol | crowbar |
| sight out past the base | 12 | 12 | 7, night | 3 round, 11 ahead, night |

- **Night on hard and brutal.** Out past the generator's lights a survivor sees only a small
  pool round them (twice as far with a rifle in hand: the scope), and the dead beyond it aren't shown at all, so they come out of the dark
  on you. The map starts pitch black, on screen and on the minimap, sites and all: only
  ground someone has lit shows, dimly, once they have moved on. What one survivor finds the
  whole team keeps, and the host remembers it, so a survivor who joins late or reloads starts
  from the team's map. A survivor can only hit what the team can see: bullets,
  blasts and swings go straight through the dead out in the dark, and guns only pick
  targets in sight. The whole base, everything within building range of the generator, is
  always in sight (on every difficulty), and each turret sees a little past what it shoots,
  so what a turret out on the edge can see, the whole team can see and shoot. Nor
  does anyone keep count of a site's guards: its skulls say how hard it is, never how many
  are left, so whether a site is clear is found out the hard way.
- **Brutal's night shows only what is lit.** A survivor carries a flashlight: a small pool
  round them (3) and a beam down their aim (11, and the rifle's scope doubles the beam, not the
  pool). What is behind you is in the dark, so where you look matters and the team has to
  cover each other's backs. A shot finds only what the beam or a pool shows. On hard the
  ground the team has found stays dimly on screen; on brutal it goes back to black as soon as
  nobody lights it, and so do the glints over the sites there. Only the survivors' light, the
  base and turrets' sight show, so the dark you have just walked through is as unknown as the
  dark ahead. The minimap keeps the
  team's map, which is the one thing brutal leaves you to find your way back by.
- **Brutal starts in melee.** Survivors begin with a crowbar and no gun: a short swing that
  hits up to three creeps in front, never runs dry, and is quiet. Its ultimate, Berserk, doubles
  the swings, heals by the hit and can't be slowed or stunned. Guns are bought or found as usual; the crowbar is
  never sold or found, so it is brutal's alone.

- **Short breaks** (15 s on Normal) keep the pressure on: enough to shop, repair and drop a
  turret, not enough to wander off. If everyone presses Ready, the countdown jumps to 3 s.
- **A long break after every fifth wave** (a minute on Normal) is the time to explore and loot.
  It lines up with the restock (some searched sites refill every fifth wave), so there is
  something worth going out for. 10 s before it ends, everyone is told to head back.
- **Announcements and a countdown.** The end of a wave says what it paid and how long the
  break is. The long break announces itself. The last 5 s of every break count down big in the
  middle of the screen ("wave N incoming"), so nobody is caught out.
- **A wave holds until it is dead.** The next break only starts once every creep of the wave
  is gone (sleeping guards don't count), so two waves never stack up on the base.
- **Stragglers don't stall the game.** If nothing of a wave has died for 30 s and at most 10 are
  left, they give up. A real fight is never cut short. Nothing of a wave is put down
  where it could never get out, such as a sealed room of a ruin by the edge. A creep that has
  got nowhere for a second stops being pushed by the crowd, so two can't pin each other against
  water for good.
- **Pause.** Any player can pause, and any player can resume; the banner names who paused. If
  the pauser leaves, the game resumes. Friends playing together decide among themselves; no
  votes, no host privilege.

## Waves

- **They grow faster the longer the game goes.** The budget (in walker equivalents) is
  `20 + 12f + 1.1f² + 0.015f³` for wave f, times the difficulty. The early waves are gentle,
  and by the 30s it is a flood.
- **Walkers come at half price.** From wave 3 a walker takes half a unit of the budget, so the
  waves bring twice the walkers for the same cost; wave 2 is between. Wave 1 is left as it was,
  as many as the starting turrets can hold alone, since they have no more to spare.
- **They scale with players who are actually playing.** Each player beyond the first adds
  `0.6 + 0.015·min(f, 30)` of a wave. A player who hasn't given a command for 90 s doesn't
  count, so an AFK friend doesn't make the game harder for the rest.
- **Spawning is spread out.** A wave comes out over `14 + min(wave, 30)` seconds, so later waves
  arrive as a stream, not a drip.
- **Waves come from a side, not from everywhere.** The map's edge is lined with entry points
  every few tiles. Each wave picks its fronts: one side for waves 1–3, one or two up to wave 9,
  two or three after. Its groups come in at the points within about 25° of each front, and the
  first front is at least 60° from the last wave's, so the pressure moves round the walls. The
  wave's notice names the sides, so the team knows where to stand; on Hard and Brutal it
  doesn't, and the team has to spread out or scout.
- **Every fifth wave is a swarm.** Its budget is multiplied by `1.5 + 0.05·min(f, 40)`, so the
  swarms swell as the game goes on.
- **Hordes from wave 10.** On swarm waves from 10 on, a third of the budget pours out of every
  entry point on the wave's fronts at once, within 4–8 s, mostly swarmers. The HUD labels the wave "HORDE". This is
  the moment the base has to hold, and why the walls matter.
- **Every tenth wave brings a boss** to rally around: wave 10 an abomination, 20 one of each,
  and so on, the abomination and the broodmother taking turns. Outposts' warlords are one or
  the other too.
- **The broodmother** is the boss that fights at range. Bloated and slow (she never breaks
  into a run), 2600 health, armour 6. With a survivor 4–16 tiles off, every 4.5 s she rears
  back for 0.7 s and lobs a sac of bile at where they stand, over walls and all; it lands
  1.2 s later. The spot is ringed on the ground from the moment she rears, so a survivor who
  keeps moving is clear of it. Whoever is still inside the 2.5-tile splash takes 45 (half at the
  edge) and is slowed 1.4 s; structures there take 60. It leaves a pool of acid for 6 s that
  burns survivors (14/s) and structures (20/s), though not the dead, and two swarmers crawl
  out of the burst. Closer than 4 tiles she claws (60 a blow). Each quarter of her life lost
  splits her open and spills six swarmers round her.
- **The cap.** 16k creeps alive. Around wave 40 with 8 players the game reaches it.

## Difficulty

Difficulty scales creep health, wave size, gold, break lengths, revive time and loot guards.
The host can change it mid-game by clicking the difficulty chip at the top left, which steps
to the next one (round from Brutal to Easy). It counts from then on: creeps already out keep
their health, and a survivor keeps the weapon they started with. Night falls or lifts with it.
Harder modes get a little longer short breaks than Normal, since there is more to build against
each wave, but Normal is the reference for timing.

## Turrets

- **Turrets upgrade by track, as weapons do.** Damage, fire rate, range and a special, each
  0 to 5, bought separately (TurretUpgradeCost: 30% of the turret's price, times 1.5 a level).
  A single level bar made every upgrade the same choice; tracks let a gun turret by the gate go
  for fire rate while one on a long road goes for range, and they read the same as the armory.
  Each level gives +30% damage, +15% fire rate or +8% range; the special is per turret. Every
  upgrade adds 6% of the turret's base HP, so a fully upgraded one has about twice it, as a
  level 5 turret had before.
- **Each turret has a job.** The gun is cheap and fast but its small rounds barely dent armour;
  the cannon and the missile battery are for crowds (one big burst, or several small ones spread
  over different creeps); frost holds them in place; tesla chains through a line. The sniper
  tower fills the gap at the top: very long range, slow, and it picks the creep with the most
  health left rather than the nearest, so it works on brutes and bosses while the rest of the
  base clears the small ones.
- **Turret fire never provokes.** A creep a turret hits doesn't turn on the turret's builder,
  missiles included, the same as a turret's bullets: aggro comes from what survivors do.
- **Anyone can sell anyone's building.** The base belongs to the team: a wall someone who has
  left put in the wrong place, or a turret worth more moved, shouldn't wait on its builder. The
  gold goes to the seller and the team hears who sold whose, so it is never done unseen.
- **Repair beats selling and rebuilding.** Repair costs 0.1 gold a hit point, capped so a full
  mend from nothing costs at most half of what went into the structure, the same share selling
  returns. A wall's hit points are cheap new (20 gold for 320), and at the flat rate alone a
  wall below about half health was cheaper sold and put back than mended; turrets, whose hit
  points are dear, keep the flat rate.
- **The destroyed leave ghosts, and one key puts the base back.** After a bad wave the break
  went on clicking every wall back in place. A destroyed building leaves a ghost, and H (or the
  top bar's button) between waves rebuilds every ghost at its first level and repairs everything
  damaged, after showing the total. Only between waves, so it is a decision of the break and
  not a way to refill walls under attack. Building over a ghost clears it.

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
  finds, the first one rare at least. They're hard early on, and a goal for later. Every brute
  and abomination slams the ground every few seconds once a survivor comes within its ring
  (6 tiles for a brute, 9 for an abomination): the ring shows on the ground for about a second
  first, and whoever is still inside is hurt hard (75 at the middle for a brute, 130 for an
  abomination, half that at the edge), thrown clear and stunned where they land: no walking,
  firing or abilities for 1.5 s (brute) or 2.5 s (abomination), with stars round their head.
  Turrets, walls and other buildings caught by the ring are hurt the same (the armory excepted).
  Step out, or eat it. A broodmother warlord lobs bile instead (above).
- **The gas station.** One per map, beside a road out near the edge. Its shop always gives a
  gun you don't have yet, so it is heavily held: a garrison round the pumps, and more hiding in
  the shop that burst out when you step onto the lot. The pumps blow up when shot, hurting
  everyone close, creeps and survivors alike, and setting off the pumps beside them. Blow them
  from range to thin the guards, or get caught in it.
- **The plane crash.** One per map, out past the middle ring on open ground, off the roads and
  well clear of the station and the outposts. Its scar is burnt clear of trees and water. The
  hull and the broken-off tail are solid; its hold is searched from beside the hull and always
  gives a field manual (an ability level), a piece of kit and a find that is rare or better.
  A garrison of brutes, runners and spitters sleeps in the wreckage, an ambush comes out at
  the first survivor inside it and another at the hold, and its two leaking engines blow up
  like the pumps when shot.
- **The church.** One per map, out on the outskirts far from the base and clear of the other
  landmarks: a roofless stone nave with pews and an altar, its bell tower at the end facing the
  generator. Nothing guards it and there is nothing to find. Press E inside at the foot of the
  tower and you pull the rope for 2.5 s (a hit starts you over), and the bell rings out over
  the whole map: every creep there is, the wave on its way in, the wanderers and the guards
  asleep at their sites, drops what it was doing and makes for the church at half again its
  pace, for a minute, unless it sees a survivor on the way. It pulls a wave off the base or
  empties the sites for a raid, and whoever rang it had better be gone before they arrive.
  When the bell stops, the wave turns back to the generator and the guards try to get home; one
  that can't settles where it stands. The bell can be rung again two and a half minutes after.
- **Wanderers.** The dead roam the wastes between the sites, away from the base, in packs of
  three to six that keep together: walkers mostly, now and then a runner, spitter or brute
  among them. About four dozen at the start, four more each wave (up to 300), more on harder
  settings. They come for a survivor who gets close or shoots them, and new packs turn up, out
  of sight, as they are killed. The way out is never quite empty.
- **The chain.** A creep that goes for a survivor howls a moment later, and everything within
  seven tiles that isn't after that survivor yet wakes and comes too, and howls in its turn.
  One shot, or one guard woken, can bring a whole stretch of the wastes down on you.
- **Chasing.** Every creep after a survivor runs faster than a walking survivor (6.6 to 6), but
  slower than a sprinting one, so sprinting still gets you away. Out of a straight line they
  path round walls: hide in a ruin and they find its door and pour in.
  Only one that can see the survivor (within its aggro) runs; one pulled from further off, by
  a shot, the noise, a howl or a taunt, comes on at half again its own pace until it can.
- **Hits stun.** A survivor's hit stops a creep for a moment (a quarter second; a brute
  0.15 s, an abomination 0.08 s), its windup held where it was, so its blow comes late but
  still comes. A creep just stunned can't be stunned again for half a second, so a fast gun
  doesn't pin one down. A shotgun's load stuns two and a half times as long. Turrets and
  burning ground never stun.
- **Blows slow survivors.** A creep's blow makes a survivor walk at half speed for a moment;
  they keep firing. It lasts 0.4 s for most, a second for a brute's, 1.5 s for the
  abomination's, 2.2 s for a hurler's bone. A fuel pump going up slows them 0.8 s; a slam stuns instead (above). A survivor just slowed can't be slowed again for 0.6 s, so a swarm can't hold one.
- **Hurlers.** From wave 8, in ones to threes, a gaunt dead thing tears shards of bone out of
  its own back and throws them: 13 tiles, over twice a spitter's reach, with a long wind-up.
  Each hit is light but slows the survivor longest of any blow, pinning them for the rest of
  the crowd. They hunt survivors and never siege the base, which their reach would let them
  shell from beyond the turrets.
- **Sprinters.** Some runners, swarmers and walkers sprint once they have a survivor to chase:
  faster than even a sprinting survivor for about three and a half seconds, then four seconds
  at the usual chase. You can't simply run from a pull; you have to outlast it.
- **The call.** Every tenth wave, partway in, every wanderer left rushes the generator as part of
  the wave, and the wave holds until they are dead. Thinning them beforehand pays off.
- **Ambushes and nests.** The hardest sites spring creeps as you walk in or search, and a house
  can hide a nest. Danger is never fully known in advance.
- **Restock.** Every fifth wave, some searched sites refill, so the map stays worth exploring
  in a long game.
- **Supply drops.** After every tenth wave a Huey gunship flies a crate 36–50 tiles out from the
  base, onto open ground a survivor can walk to. It's the long break's lure: worth the walk, out
  where the creeps are. The door gunner thins them on the way in. Opening it takes 2.5 s of
  standing by it unhurt, and it pays the whole team (gold, full medkits) plus a rare find for the
  opener. Up to three wait unopened. The surfboards on the Huey's side are for Kilgore.
- **Weapons change hands.** A survivor can drop a weapon they carry and a teammate pick it up,
  every upgrade track as it was, its magazine too. Gold is personal, so this is how a team pools
  it: one player buys and upgrades a rifle, another uses it. Picking up takes 0.2 s, a token
  channel like a search's (a hit restarts it), so it is a deliberate act and not something you
  walk over by accident. Dropping is the reverse: G held for a second, so a stray tap mid-fight
  doesn't throw a gun away. A survivor keeps at least one weapon, a kind they already carry can't
  be picked up (one of each, as in the armory), and at most 32 lie about at once.

### Ruined houses

Houses come in kinds, each its own shape and build, so the countryside reads as more than
one box repeated (`internal/game/ruins.go`, walls in `web/src/scene/terrain.ts`):

- **Cottage:** one room, one doorway; clapboard, brick, fieldstone or timber.
- **Two rooms:** split by an inner wall with a gap, a concrete floor; mostly brick.
- **L-shaped:** a corner missing, a concrete floor, sometimes a back door.
- **Barn:** big, timber, a wide door at each end so the dead can pour straight through, and
  the loft's rubble on the floor.
- **Shed:** small, timber or cinder block.
- **Collapsed:** walls fallen in at several places and rubble inside; old stone or brick.

Each is searched from its middle, which is always open floor. Outposts have their own concrete
walls topped with sandbags, and the gas station's shop is painted block.

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
| motorbike | nearer town | a one-second look in the panniers |
| camper van | anywhere | better luck, but a quarter of them have something living inside |
| fire engine | anywhere, more further out | leans to gear, always a medkit |
| armoured van | mid and far | slow to crack, pays in gold, always guarded |

"Leans to" means 60% of the finds come from the favoured kind. The kinds get tougher and
richer further out: the near roads are mostly cars and pickups, and the far roads hold most of
the army trucks.

A survivor walks round a wreck, not through it, so none is placed where it would close a way:
a car across a one-tile track or a gap between rocks would leave the other side reachable only
the long way round, or not at all. Map generation tries the spot again elsewhere.

## Noise and aggro

- Gunfire wakes guards nearby and pulls wave creeps in earshot. Rain and storms muffle it.
  Going out loud has a cost.
- Shooting a creep may turn it on you, and a taunt (J) pulls everything nearby for 5 s. Teammates
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
- **Fighting first, building second, as in Overwatch.** The keys under the left hand are for
  the fight: Q the ultimate, Shift, F and V the grenade, dash and airstrike, cast at the cursor
  the moment the key goes down. There is no aim mode: an aim-then-click step was a beat too slow
  in a crowd, and the cursor is already where you look. Right-click only focuses fire on a
  creep; it used to cast the signature off a creep, which went off whenever a click missed.
  E is "use": a downed teammate, loot site or supply crate right beside you comes first, so a
  hero out looting searches the wreck at hand whatever is selected. Otherwise it uses what is
  under the cursor, or else the nearest usable thing (a damaged structure, the armory); on a
  creep it focuses fire. R reloads. The taunt is J: a reach, but seldom needed in a split second.
  Attack-move went away with click-to-move; Stop is a button on the orders card, and hold
  position came off the keys, since the hero standing still already holds.
- **Building is a bar of numbers behind B.** 1–8 pick wall, gate, gun, cannon, frost, tesla,
  sniper, missile, in the order of price, so the build keys never clash with the fight keys,
  and the letters they used to take (I, L, X) are free. Walls and gates stay picked after each
  one, because they go down in lines; a turret is one decision, so it places once and Shift
  keeps it.
- **The camera follows while you walk.** Arrows and the screen edge still look away, and the
  next step brings it back. The minimap's right-click still walks you there by path.
- **Numbers are the inventory.** 1 is the medkit, the thing reached for in a hurry; 2–7 the
  weapons in the order they are bought, 0 the crowbar. A weapon run dry reloads in
  the background, so switching to a loaded one is the fast way out of an empty magazine and
  carrying two guns pays.
- **Medkits are a decision, not a regen stat.** One heals 40% over 3 s, and a hit cuts it
  short, so you heal after you get clear, not in the crowd. You carry up to three, start with
  one, buy them for 60 gold or find them in ambulances and fire engines. The old regen gear row is Vitamins.
- **Night vision goggles are the way out of the dark, at a price.** 3000 gold, more than the
  rocket launcher, for daytime sight (12, the rifle's scope doubles it) at night, worn instead
  of brutal's flashlight, so all round, not just ahead. Sold only on hard and brutal, where
  there is a night. Bought once and kept through being downed, like the gear. At night they show on
  the survivor and their portrait, green lenses over the eyes, so the team knows whose eyes to trust in the dark,
  and their sight is everyone's, as any survivor's is.
- **The generator heals, slowly.** Standing right by it (within a step and a half of its
  sides) gives back 2 HP a second, mid-wave too: a place to catch your breath, not to stand
  in a fight.
- **The taunt is rude.** The survivor turns to the camera, flips the horde off and shouts. It's
  the funniest thing in the game to do to a brute, and it reads at a glance.
- **The browser stays out of the game.** A Ctrl+S meant for a slip of the hand, a print dialog,
  find bar, page zoom, reload, DevTools or a mouse's back button tears you out of a wave. On a
  real game the page cancels the browser's own shortcuts (Ctrl or Cmd with anything but
  clipboard and undo, Alt+arrows, the function keys but F11), its right-click menu and Ctrl+wheel
  zoom, and asks before leaving a game that is still on. Ctrl+W, Ctrl+T and Ctrl+Tab never reach
  a page, so that question is what catches them. td's Firefox profile has DevTools turned off,
  since Firefox opens them before the page hears the key. The demo, the lab and `#dev` leave the
  browser alone.

## Ultimates and abilities

- **An ultimate per weapon, on a meter.** The old signatures were on a cooldown, so they were
  cast whenever ready and mattered little. An ultimate is rare, about one every three waves, so
  it is saved for the moment it turns: the meter fills by damage dealt, measured against what a
  wave holds (ultFull: 70% of three waves' walker-health at the current wave and difficulty), so
  the pace stays the same as waves grow. A revive gives 15%, so helping fills it too. Turret fire
  and burning don't count: the meter rewards the survivor's own fighting, not the base's.
  It doesn't fill while one runs, and going down ends it.
- **Each ultimate leans into its weapon.** Dead Eye makes the pistol, the weakest gun, the one
  that clears the screen: a 1.5 s mark at half speed, then a shot at everything in sight, lethal
  to all but brutes and bosses (200 for them, so it can't erase a boss). Dragon's breath gives
  the shotgun its crowd control as fire and a shove. The SMG's Run and gun is about moving,
  the rifle's Railgun about lines, the minigun's Overdrive about holding a lane, the launcher's
  Cluster MIRV about one big crowd far off, and the crowbar's Berserk about standing in the
  middle of it. None spends ammo while it runs, so it isn't cut short by a reload.
- **The shotgun hits harder from further.** 13 a pellet and range 10, with a tighter spread:
  it was the gun nobody kept past the first armory visit.
- **The grenade grows with the game.** Five levels where it had three, from 120 damage to 400,
  wider and quicker each level, and from level 4 it leaves fire burning; a three-level grenade
  stopped mattering by the mid game, when it was the one ability always at hand.

## Downed and revive

When you go down you stay where you fell, and a teammate can revive you by standing next to
you for a few seconds; a hit starts the revive over. Otherwise you respawn at the base when the
countdown ends. This makes going out alone risky, and going in pairs worth it.

A survivor put back at the base is shielded for 5 seconds, drawn blinking: no harm, slow or stun
lands, but they can shoot. Without it a swarm on the nexus killed them again as they stood up,
over and over. A revive gives no shield: the reviver chose the moment.

## Weather

The weather changes between waves and is the same for everyone. Fog shortens everyone's range,
and creeps notice you later. Rain dampens fire and slows creeps a little, storms throw
lightning at creeps in the open, and snow slows everything.

**Fog and rain close in.** A survivor sees 60% less far in full fog and 30% less in heavy rain
or a storm (a drizzle and a thunder shower count as a fraction of it). On screen the world
fades into the weather's haze past that distance round your survivor, in every difficulty.
With fog of war or at night it is also the survivor's sight: what they can light, and so, at
night, what their shots can find.

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
minimap, and with fog of war so does what they see: the minimap lights only what your own
survivor and the structures see, and shows only the creeps in it, so neither a moving pool of
sight nor a crowd of creeps gives a teammate away. Their figures and names stay visible in the world, but their health bars, search and
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
- **Portraits.** Your survivor's portrait in the console, and each teammate's in a frame down
  the left, is their own model from the chest up, rendered live and pixelated like the world.
  It shows how they are doing at a glance: breathing (hard when sprinting or hurt), blinking,
  looking the way they aim, flinching red when hit, cut and bloodied as health drops, a plaster
  while a medkit works, eyes down to reload or search, mouth open in a taunt, slumped when down.

## Models

- **Organic, not boxes.** Survivors and creeps are modelled in Blender in the spirit of Project
  Zomboid (`docs/artdirection.png`): bodies of fused ellipsoids, one skin from hips to neck,
  sculpted heads with faces that read from the camera. Low-poly and flat-coloured so they
  keep the pixelated look and a horde still draws in one call per kind.
- **Survivors** are one skinned body each, with clothes, hair, hats and gear laid on it as
  pieces, so ten archetypes and every random look come from one set of parts.
- **The dead look like the people they were.** Creeps are posed as zombies in the model
  itself: hunched, heads pushed forward, knees bent, hands hooked. Their clothes are torn and
  bloodied but stay in the colours the page swaps per creep, so a horde is still a crowd. A
  walker in a torn short-sleeved shirt; a runner lunging with its shirt hanging open; a bald
  crawler on its knees and hands; the brute a builder in an orange hi-vis vest and a hardhat;
  the spitter's belly swollen out of its shirt with boils that swell as it fills; the hurler
  gaunt and barefoot in a tank top and shorts, bone through its back.
- **The bosses are made of people.** The abomination is several bodies fused into one hunched
  hulk: an arm swollen to a club, another torso sunk in its back with its own head and arm,
  a fourth arm out of its ribs. The broodmother is a starved woman on long legs, her belly a
  vast veined sac bursting out of her gown, egg sacs on her back, lank hair over her face.
- **Size stays the rules'.** A creep stands about as tall for its collision radius as before, so how
  big it looks is still how big it is to hit.

## Puppets: how bodies move

- **Every body is a puppet** on one 12-joint skeleton (chest, head, two arms and two legs of two
  parts each, and two spare joints for a spitter's belly or an abomination's extra arms). The
  motion is procedural, not keyframed, so it reacts to what the body is doing.
- **Feet don't slide.** The gait advances with distance actually travelled, so a slowed creep
  shuffles and a runner bounds. Survivors split upper and lower body: legs follow the movement,
  the torso follows the aim, so strafing and backpedalling read. Hands hold each gun by IK.
- **Springs carry the weight.** Lean, recoil, flinch, a pack bouncing and hair swinging all run
  through damped springs, so motion settles instead of snapping.
- **Creeps are crowds of people.** Shirt, trousers, skin and hair are picked per creep, and each
  one has its own gait offset and head tilt. A badly hurt walker or runner may lose an arm.
- **Creeps are skinned on the GPU** so thousands can animate at once. The CPU only writes a few
  numbers per creep each frame.
- **The dead stay a while.** A killed creep falls the way it was facing, or is thrown by a
  blast, lies there, then sinks into the ground.
- **Blows are telegraphed.** Every creep winds up before it hits: walkers claw and bite, runners
  coil and pounce, swarmers rear and lunge, brutes slam both fists down (with a dust ring),
  spitters swell and whip the head forward, and the abomination rears and sweeps several arms.
  The host decides the timing (creep flag 64 in every frame), so the windup you see is the real warning, and a
  survivor who steps out of reach in time takes nothing.
- `#lab` in the browser shows every animation side by side.

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
  there. M or Esc closes it. This is for planning a run during the long break without
  squinting.
- **Loot sites are not on the map**, on any difficulty. Finding them is the point of going out:
  marked on the map, every site is a known errand and the wastes stop being unknown. The glint
  over a site in the world still shows which ones nobody has searched.

## HUD

- **The base's health is always in the top bar**, right after the wave readout. It's the one
  number the game is lost on, so nobody should have to go looking for it. It is a segmented bar
  and a percentage: moss, then amber below 60%, rust and pulsing below 30%. It flashes when the
  generator takes a hit. Clicking it looks at the base.
- **Teammates down the left**, one frame each: portrait, name, health and what they are doing.
  One who is down turns red with their respawn countdown and where they fell, and the bar
  fills as someone revives them. Clicking a frame looks at that teammate, or revives them if
  they are down.

## Boot splash

The page opens on a short splash (about 1.5 s, any key or click skips it, reduced motion shows
the finished frame). It's in the same spirit as crowbar's boot, where a torch welds the wordmark,
but it tells this game's story instead:

- The **wordmark is a wall**. TAILDEFENSE is set in a chunky 6×7 block font, and every pixel
  of it is a bevelled brick. The bricks drop in from both ends towards the middle, glow hot as
  they land and kick up dust. "tail" is bone and "defense" amber, the HUD's two main inks.
- **A searchlight** crosses the finished word once.
- The tagline types in under it in the CRT face: "hold the base · loot the dark · bring
  everyone home". A strip of masking tape ("co-op tower defense · over the tailnet") slaps
  onto the word, and a segmented bar fills like a wave counter.
- It is drawn on a low-res canvas scaled up with hard pixels, over ordered-dither ground and
  scanlines, so it looks like the game's pixel view. Its clock advances at most 1/30 s per
  frame, so while the page is busy loading it slows down instead of skipping ahead.
- The connection screen uses the same wordmark, finished.
