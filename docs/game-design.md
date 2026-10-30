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
| starting gold | 150 | 150 | 150 | 0 |
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
  hits up to four creeps in front, never runs dry, and is quiet. Its ultimate, Berserk, doubles
  the swings, heals by the hit and can't be slowed or stunned. Guns are bought or found as usual; the crowbar is
  never sold or found, so it is brutal's alone. Nor do they start with any gold: the first
  turret or gun is paid for with the first wave's bounties, swung for with the crowbar.

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
  count, so an AFK friend doesn't make the game harder for the rest. A host's bots (`--bots`)
  count like anyone else.
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
- **Every tenth wave brings a boss** to rally around: wave 10 an abomination, 20 a
  broodmother and a goliath, 30 one of each, and so on, the three taking turns. Outposts'
  warlords are one of them too.
- **The broodmother** is the boss that fights at range. Bloated and slow (she never breaks
  into a run), 2600 health, armour 6. With a survivor 4–16 tiles off, every 4.5 s she rears
  back for 0.7 s and lobs a sac of bile at where they stand, over walls and all; it lands
  1.2 s later. The spot is ringed on the ground from the moment she rears, so a survivor who
  keeps moving is clear of it. Whoever is still inside the 2.5-tile splash takes 45 (half at the
  edge) and is slowed 1.4 s; structures there take 60. It leaves a pool of acid for 6 s that
  burns survivors (14/s) and structures (20/s), though not the dead, and two swarmers crawl
  out of the burst. Closer than 4 tiles she claws (60 a blow). Each quarter of her life lost
  splits her open and spills six swarmers round her.
- **The goliath** is the boss that comes for you. A stitched-together giant, 3600 health,
  armour 9, faster on the march than the other two (1.7 to their 1), and every one of them
  charges: in bursts it runs down even a sprinting survivor, like a sprinter. It slams (9.5
  tiles, 120 at the middle) and its slam stuns longest of anything, 4.2 s. Whoever gets within
  arm's reach is caught: held up for 1.1 s, then thrown 10 tiles behind it, back the way it came
  and into whatever follows it, and the fall takes 55 and stuns 1.8 s. A throw that meets a wall
  ends there, hurting the same. The team can break the hold: 6% of its health shot off it while
  it holds someone makes it let go. It grabs again 5 s after a throw. The goliath exists
  because the other bosses can be kited: the abomination is slow and the broodmother keeps her
  distance, so standing off and shooting was always safe. The goliath punishes that, and the
  grab is what makes a teammate's fire matter in the moment rather than eventually.
- **Maulers** are the goliath's brute: from wave 12, alone, growing commoner up to wave 30 (a
  fifth as common as brutes at their peak). 420 health, armour 5, 2.6 tiles a second where a
  brute walks 1.5, and charging like the goliath. Its slam is a brute's size but stuns 3 s; its
  grab holds 0.9 s, throws 7 tiles and the fall takes 35 and stuns 1.2 s; 12% of its health
  shot off frees whoever it holds. A level 4 site's second guard is a mauler from wave 15.
- **Hounds** are the dead dogs: from wave 5, in packs of four to eight, 20 health, a quick
  weak bite. They chase at 9 tiles a second (a survivor walks 6 and sprints 9.6), half of them
  sprinters on top of that, and they bite from further than they look, leaping in. You can't
  outrun a pack; you turn and shoot it. From wave 5 one wandering pack in six is hounds, and an
  ambush may bring some. They're there to make the open ground between the sites dangerous in
  a way walkers can't: walkers you walk away from.
- **Affixes make one wave unlike the last.** From wave 4 every wave but the boss waves comes
  with an affix, and from wave 15 with two, never all the last wave's again:
  - *Armoured*: every creep shrugs off 3 more of each hit. The gun turret's small rounds feel it
    most; snipers and cannons don't.
  - *Hasty*: every creep a fifth faster, so a short maze gives the guns less time.
  - *Sappers*: a fifth of the walkers and runners carry a charge. They ignore the maze, walk
    straight for the walls and blow up against the first structure they reach (280 to
    everything within 1.6 tiles but the generator and the armory), for no bounty. Traps and
    turrets out in front of the walls are the answer.
  - *Splitters*: a third of the walkers, runners and brutes burst into two swarmers when they
    die, so what dies at the walls is still a problem. Area damage, flame vents and spikes are
    the answer.

  Each one rewards a different base, so a team that has built for one has something to change
  for the next. That is why the next wave is **forecast**: the break before it says its affixes
  and its sides ("scouts report wave 7: sappers…"), and the HUD's wave label shows them, so the
  break is for deciding what to build. On Hard and Brutal the sides stay unsaid, as before; the
  affixes are always told.
- **The cap.** 16k creeps alive. Around wave 40 with 8 players the game reaches it.

## The end: get to the choppa

A game used to end only one way, overrun, so the best a team could do was lose late. Now it
can be won. The host picks how long the game is: 20, 30 or 40 waves (40 by default), or
endless, which goes on as before until the generator falls.

- **The last wave is the same on every difficulty.** Difficulty already scales what each wave
  is; how many there are is the host's choice of evening. 40 is where the waves meet the creep
  cap with a full team, so past it the game stops getting harder anyway.
- **Clearing the last wave calls the evac Huey.** It lands on the helipad 60 s later, and the
  last of the dead, one more wave's worth, come for the pad rather than the generator. The
  defence has to move out of the walls for the finale.
- **The generator can't fall during the evac.** The game is decided at the pad, not by a
  stray creep at the base the team has walked away from.
- **Boarding is a hold.** E by the landed Huey (E anywhere once it is down walks you there),
  then a second unhurt beside it; a hit starts it over, like a revive. Aboard, a survivor
  rides along, out of the fight.
- **The Huey waits, but not for ever.** It stays down up to 90 s. Once someone is aboard it
  leaves when everyone still playing is aboard, or 30 s later at most, so one player can't
  hold the rest hostage. A player who has given no command for 90 s is not waited for, as the
  waves don't count them either. Nobody aboard after 90 s, it leaves empty.
- **The door gunner** works a minigun from the air on the way in and from the pad, as on a
  supply drop: 25 rounds a second, 16 tiles' reach, over walls and trees. It covers the
  survivors rather than itself: first whatever has one of them in its hands, then whatever is
  closest to one of them near the Huey, and only with nobody near, whatever is closest to the
  Huey. The pad is easier to hold than open ground, and running for the Huey is helped in.
- **The pad is further out the harder the game.** About 22 tiles from the generator on easy,
  28 on normal (in the build ring, where it can be fortified round but not built on), 48 on
  hard and 58 on brutal, out past the generator's lights. At night it has to be found: the pad
  shows on the map and the minimap only once a survivor's light has fallen on it, and the host
  says so. The evac call names the direction anyway, and the Huey's landing lights show it, so
  a team that never went looking still gets a chance, just a worse one.
- **Lift-off is a scene.** The camera rides the Huey for everyone, black bars slide in, it
  banks round for home and climbs away off the edge of the map; only then does the field
  report come up. It is stamped Extracted, or Left behind if the Huey left empty, and every
  survivor's card says whether they got out.

## Difficulty

Difficulty scales creep health, wave size, gold, break lengths, revive time and loot guards.
The host can change it mid-game by clicking the difficulty chip at the top left, which steps
to the next one (round from Brutal to Easy). It counts from then on: creeps already out keep
their health, and a survivor keeps the weapon they started with. Night falls or lifts with it.
Harder modes get a little longer short breaks than Normal, since there is more to build against
each wave, but Normal is the reference for timing.

## Mazes

The midgame was the same wave after wave: the walls were a ring that creeps chewed through, so
building meant more turrets round the same ring. Now the dead walk round walls while there is a
way round (`internal/game/maze.go`), so the base is something to shape: a labyrinth that walks
them under the guns is the team's plan, and keeping it honest is the game.

- **The way round, however long; breaking in only when sealed.** Two flow fields: the maze
  field, where a structure is a wall, and the breach field, where it costs its hit points to
  cross. A creep follows the maze while it reaches the generator and the breach field only
  when it doesn't. A cut-off maze is a mistake you see at once (the base sealed, red dots),
  not a silent loss of every wall.
- **The base starts sealed.** Its gates are shut, so the first waves break in as they always
  did, and a team that never touches a gate plays the game it knew. Opening one is the choice
  to build a maze, and gates are what make the maze move: shut one mid-wave and the whole
  wave turns for the next way in (gate juggling). Working a gate takes 0.8 s standing beside
  it and it can't swing again for 4 s, so juggling is a job for someone, not a free reroute;
  it won't shut on a creep in the gateway.
- **Patience.** Inside the build ring and 4 tiles past it, a creep counts the ground it walks.
  Past Patience times the straight way in from where it entered (3 on normal, 3.5 easy, 2.6
  hard, 2.2 brutal) plus 12 tiles, it frenzies: 1.4 times as fast, 1.5 times as hard on
  structures, and done walking round anything. A maze tripling the walk is the sweet spot; an
  endless one buys a frenzy at its deepest point, where it hurts most.
- **Big creeps need room.** Brutes and the bosses follow a field of tiles with a clear two by
  two square. Where a maze is all one-tile lanes they have no way round and shoulder into the
  weakest wall beside them, so a maze for the late game needs wider lanes, which cost more
  walls.
- **A wall is not bait.** A creep that wants a survivor behind a wall no longer claws at the
  wall; it keeps to the maze, and each second it can't reach them wears a tile of its
  patience. Otherwise standing behind the maze would undo it. A calm creep takes against only
  a turret it can walk to; a frenzied one takes against anything.
- **Traps line the lanes.** Spikes, tar, the flame vent and the mine (`internal/game/traps.go`)
  are flat buildings in their own grid, so nothing paths round them and nothing changes the
  maze; they reward a long walk the way turrets reward range. Their damage is turret fire: it
  never provokes, and the kills pay the builder. Each is cheap and narrow on its own: spikes
  wear by the creep-second they cut (100 or so crossings), tar only slows, the vent bursts
  once every three seconds, and the mine is spent at once, a ghost for H to lay again, so
  traps are a running cost of a maze rather than a one-off.
- **The preview is the client's own.** In build mode, or with a gate picked out, the page works
  out the maze field over the build ring itself (`web/src/route.ts`) and dots the way in from
  eight points round it, with the average walk and how much the ghost adds. It ignores the
  wide field, so a maze that brutes will smash still looks walkable.

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
- **Gold is personal, but it can be given.** The Tab scoreboard has 50, 250 and half-of-yours
  buttons on each teammate's card, usable anywhere at any time, so the one saving for a rocket
  launcher can be topped up and the one who left with a fortune doesn't take it with them. The
  log says who gave whom what, briefly, as it does upgrades, and the one given to gets a toast.
- **Turrets and traps pay the team.** A creep finished by a turret, or by a fuel pump or a
  plane's engine a survivor set off (the blast or its burning fuel), splits its bounty evenly
  among everyone in the game, the part that does not divide carried to the next. A turret
  guards everyone, and its builder is often off looting while it works; paying only the builder
  made the base a few players' bank. The total is the same as before, only who gets it changed.
  A kill by a survivor's own gun, grenade or ability still pays them alone.
- **Evolutions are the late game's turret choice.** Once the generator is at tier III, a turret
  whose tracks add up to 12 (of 20) can evolve, once, into one of two branches for its price
  again (`internal/game/evolve.go`). The pairs are built to pull against each other and the
  affixes, so the team has something to argue about: the gun's Gatling (2.2× fire rate, 0.75×
  damage) against its Penetrator (ignores armour, 1.3× damage: the armoured wave's answer);
  the cannon's Mortar (1.8× range, lobs over walls) against Shrapnel (1.7× blast); the frost
  tower's Cryo (every third pulse freezes for 0.8 s) against Blizzard (1.6× reach, longer and
  10% deeper slow); the tesla's Storm conductor (1.2× damage, up to twice that in rain, two more
  jumps) against the Arc web
  (four more jumps, two tiles further each); the sniper's Spotter (marks its target: +25% from
  everything for 5 s) against Anti-materiel (pierces 8 more, armour and all); the missile
  battery's Swarm (twice the missiles, 0.6× damage) against Napalm (sets what it bursts on
  alight). An evolution is mostly numbers on top of the tracks, so it stays readable, plus at
  most one rule of its own.
- **The amplifier pylon makes placement matter.** +15% fire rate to every turret within 3
  tiles, not stacking: one pylon among four turrets is the play, not four pylons by one. It
  needs tier II.
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

### Turret balance, by measurement

The turrets, their evolutions, the traps and the Overload are set on the balance bench
(`internal/game/balance_test.go`; `./build.sh go test ./internal/game -run TestBalanceTable -v
-args -balance`, `-balance-only lane,support,...` for parts), and
`internal/game/balance_bands_test.go` holds what came of it. The weapons have their own section.

- **A blob is the wrong yardstick.** Time to clear a frozen blob of 30 creeps flatters splash
  without limit (a level 5 cannon's 4-tile blast takes all 30 at once) and says nothing about
  range or slows. The main measure is the lane: 60 creeps sampled from a real wave's plan walk
  single file down a 50-tile road 3 tiles from the turret, and what counts is the share of their
  health taken off and the hit points per 100 gold. Range is time with them, a slow is more of
  it, splash is how bunched they come. Waves 4, 9, 19 and 29 (the normal mix), 20 (a swarm). A
  turret that takes the whole lane says nothing about its gold, so comparisons are made where
  nothing does.
- **Frost is a pure slow, valued by what it adds.** Its 3 a pulse never kills anything big; its
  worth is the hit points a partner (gun, cannon, tesla, sniper, missile at 3s) takes with it
  beside them, against what the same gold in more of the partner would take. Tar and the
  spotter's mark are measured the same way, the pylon among four turrets.
- **Bosses by gold-seconds.** One creep of every kind, bosses and armoured ones too, killed by
  one turret 6 tiles off at wave 20; a boss killer's figure is seconds times gold.
- **The gold curve.** A solo game earns about 9 000 by wave 10, 54 000 by 20 and 190 000 by 30
  while a wave's health grows from 70 000 to 2.6 million: gold outruns health, so late on
  nothing is short of gold, only of value per gold and of room.
- **Tuned at 20 Hz, played at 30.** The bench numbers were taken at 20 ticks a second, and some
  of them lean on its whole ticks: a cooldown set afresh when it runs out (a turret's shot, a
  creep's blow, a vent, a reload) lasted as many 20 Hz ticks as counting it down took (a gun
  turret's quarter second took six), armour came off every tick of napalm or spikes, a hit by
  them had its 12% chance to turn a creep each tick, and a rocket's fuse looked once a tick.
  At 30 Hz each is worked out as it was at 20 (`tunedRate` in `defs.go`), so the game plays the
  same in seconds: 32 bot games last about 108 s a wave at either rate, within a second.

What the bench found, and what changed:

- **The sniper was not the boss killer.** A missile battery killed a wave 20 abomination for
  about half the sniper's gold-seconds (198 against 408 at 3s) and a level 0 sniper never
  killed one. Now each round also tears 1.6% of its mark's full health out of it (armour and
  all, growing with the damage track), which means nothing to a walker and everything to a
  boss: a level 0 sniper kills it in 128 s, at 3s in 46 s, and every sniper does it for less
  than any other turret (117 against 150 for the next, the penetrator; 289 for missiles). It
  is also the only turret that kills a wave 30 boss inside a minute.
- **Missiles were accurate.** Each missile now goes for where its mark stands, up to 1.6 tiles
  off, leading nothing, and bursts where it comes down rather than on the first creep it
  passes; the blast is 2 tiles where it was 1.5. A crowd still eats the whole salvo; a lone or
  a quick creep sees much of it land wide. The level 0 battery clears the wave 30 pack in 35 s
  (never, before); its boss figure went from 198 to 289.
- **Frost's upgrades bought nothing.** Inside its reach a creep was slowed for good whatever
  the special said, since the next pulse came before the slow ran out, so a level 3 tower
  added a quarter of what more gun would. The special now deepens the slow, 45% of a creep's
  pace at level 0 to 75% at 5 (Blizzard another 10%); the deepest slow on a creep holds, so
  frost and tar don't stack. Beside a level 3 gun at wave 29, frost 3 now adds 913 per 100 gold
  (741 before) against the gun's own 672, Blizzard 1541 (919), Cryo 1285 (1076). A level 0
  tower adds 2 000 to 4 000: the first slow on a lane is the best buy there is, and because a
  second adds nothing it stays one per lane.
- **The tesla trailed.** At level 3 it took the least per gold of the fighting turrets late
  (629 against 794 to 1006 at wave 29). It now starts with two jumps rather than one, keeps 90%
  of its damage at each jump (85%), costs 280 (320) and strikes for 36 (32): 899 now, and ahead
  of the gun turret per gold on a bunched crowd. Its storm conductor, the arc web without its
  jumps when dry, hits a fifth harder rain or not.
- **The cannon at level 0 was the best buy of all**, 1 600 to 1 900 per 100 gold where the
  other turrets get 700 to 1 400, so it fires every 1.7 s rather than 1.4 and its special adds
  0.3 blast a level (0.35): 1 609 at wave 29, still the cheap crowd answer, and slow and heavy
  as it should be. Cannon 5, missile 5 and swarm are the fastest on a blob, but in the lane per
  gold they sit at or below the median (516, 472, 864), so they were left.
- **Napalm and vents burned a flat 14 and 10 a second**, nothing at wave 29; they now burn by
  their damage (35% of a missile's, a quarter of a vent's burst), and trap levels add half
  their damage each, not a third.
- **Mines didn't grow** and missed a wave 29 walker by half; a mine is laid again every wave,
  so its damage now grows with the square root of the creeps' health (260 at wave 1, 900 at
  29) and it reaches 3 tiles, not 2.4. Mines are a crowd's answer: in a sparse stream the first
  quick creep sets each off alone.
- **The Overload grows with the creeps' health** (above): 450 at wave 30 no longer killed a
  walker.

Wave 29 lane, hit points per 100 gold (before → after):

| | level 0 | level 3 | evolutions |
|---|---|---|---|
| Gun | 1058 → 1058 | 794 → 794 | Gatling 1049 → 1049, Penetrator 929 → 929 |
| Cannon | 1920 → 1609 | 975 → 872 | Mortar 945 → 765, Shrapnel 1074 → 955 |
| Tesla | 687 → 1233 | 629 → 899 | Storm 579 → 935, Arc web 680 → 942 |
| Sniper | 1131 → 1392 | 1006 → 1120 | Spotter 932 → 1032, Anti-materiel 1158 → 1189 |
| Missile | 1203 → 1368 | 823 → 869 | Swarm 789 → 864, Napalm 758 → 941 |

The evolutions went from a spread of 579 to 1185 (2×) to 765 to 1189 (1.55×). The tests hold
the shape rather than the numbers: every fighting evolution within 0.65 to 1.45 of their median
at wave 29, frost's two worth 0.8 of more gun beside one; every level 3 and evolution above half
the median late; every fighting turret at level 0 taking a fifth of a wave 9 lane, and frost 0
beside a gun adding more than more gun; the sniper killing a boss for less than 1/1.2 of anyone
else's gold-seconds and by 1.5 at level 0; missiles landing spread and short of their true
damage on a lone creep; the tesla ahead of the gun on a pack and per gold on a bunched crowd;
the cannon the slowest crowd turret with the heaviest shell; frost hurting under a tenth of a
gun, deepening with its special, and adding at least 0.65 of more partner beside each; spikes,
vents and mines at least 0.6 of a gun turret's gold, tar beside a gun as good as more gun; and
the Overload killing every small creep at waves 10 to 30 but no brute.

## A base that grows

- **The generator's tiers are the team's shared project.** Gold is personal, so before this the
  team never had to decide anything together. Anyone pays into the next tier from the
  generator's card, 100 at a time (clicking the base chip opens it); the notes say who paid
  what. Tier II takes 600 and tier III 1600, each half again for every player beyond the first
  who is playing, so it lands around wave 8–10 and 18–20 if the team saves for it, and the
  saving is the decision: a tier is gold not spent on turrets now.
- **What a tier gives.** Each adds 30% of the generator's base health (healing it by as much),
  and shows on its model: a radio mast on scaffolding at II, floodlights at III. Tier II unlocks
  the amplifier pylon, tier III turret evolutions and the Overload.
- **The Overload is the team's last word.** Once a wave, anyone sets it off from the
  generator's card: everything within 18 tiles of the generator (the walls and a little past)
  takes 120 times the wave's health scale (360 at wave 10, 1500 at 30: every small creep dies,
  a brute loses about 40%) and is frozen for 1.5 s. A flat 150 + 10 a wave fell behind the
  creeps' health, which grows twelvefold by wave 30, and by then failed to kill a walker. It is turret fire, so it turns nobody on
  anyone. Once a wave makes it a decision when to use it, not a cooldown to press.
- **Not done: forward relays.** A relay at a cleared outpost, adding a build ring there, would
  tie the raids out on the map to the base; it is left for when the middle game needs it.

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
  Maulers and goliaths slam too, and stun longer still (3 s and 4.2 s; above).
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
  among them, and from wave 5 now and then a pack of hounds. About four dozen at the start, four more each wave (up to 300), more on harder
  settings. They come for a survivor who gets close or shoots them, and new packs turn up, out
  of sight, as they are killed. The way out is never quite empty.
- **The chain.** A creep that goes for a survivor howls a moment later, and everything within
  seven tiles that isn't after that survivor yet wakes and comes too, and howls in its turn.
  One shot, or one guard woken, can bring a whole stretch of the wastes down on you.
- **Chasing.** Every creep after a survivor runs faster than a walking survivor (6.6 to 6), but
  slower than a sprinting one, so sprinting still gets you away. Hounds chase at 9, just short
  of a sprint. Out of a straight line they
  path round walls: hide in a ruin and they find its door and pour in.
  Only one that can see the survivor (within its aggro) runs; one pulled from further off, by
  a shot, the noise, a howl or a taunt, comes on at half again its own pace until it can.
- **Hits stun.** A survivor's hit stops a creep for a moment (a quarter second; a brute or a
  mauler 0.15 s, a boss 0.08 s), its windup held where it was, so its blow comes late but
  still comes. A creep just stunned can't be stunned again for half a second, so a fast gun
  doesn't pin one down. A shotgun's load stuns two and a half times as long, and 0.3 times
  longer for each level of its special track. Turrets and burning ground never stun.
- **Blows slow survivors.** A creep's blow makes a survivor walk at half speed for a moment;
  they keep firing. It lasts 0.4 s for most, a second for a brute's, 1.5 s for the
  abomination's, 2.2 s for a hurler's bone. A fuel pump going up slows them 0.8 s; a slam stuns instead (above). A survivor just slowed can't be slowed again for 0.6 s, so a swarm can't hold one.
- **Hurlers.** From wave 8, in ones to threes, a gaunt dead thing tears shards of bone out of
  its own back and throws them: 13 tiles, over twice a spitter's reach, with a long wind-up.
  Each hit is light but slows the survivor longest of any blow, pinning them for the rest of
  the crowd. They hunt survivors and never siege the base, which their reach would let them
  shell from beyond the turrets.
- **Sprinters.** Some runners, swarmers, walkers and hounds, and every mauler and goliath, sprint once they have a survivor to chase:
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
  where the creeps are. The door gunner's minigun thins them on the way in. Opening it takes 2.5 s of
  standing by it unhurt, and it pays the whole team (gold, full medkits) plus a rare find for the
  opener. Up to three wait unopened. The surfboards on the Huey's side are for Kilgore.
- **Weapons change hands.** A survivor can drop a weapon they carry and a teammate pick it up,
  every upgrade track as it was, its magazine too. Gold is personal, so this is one way a team
  pools it: one player buys and upgrades a rifle, another uses it. Picking up takes 0.2 s, a token
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

### Shrines

Two shrines on every map, far out (40 tiles or more from the generator, 60 apart): a walled
court of broken stone with pillars down its length, gate posts at its mouth facing the base, and
an altar at the far end with a blade standing in it. It is a lair with a champion, and the dead
rise from the court when someone walks in and again at the altar, as at the gas station. The
altar always gives a legendary, which is the point: a shrine is a known, hard objective for a
team that wants melee, where the gas station and the plane are only a chance. Pillars are walls
to creeps and shots, so the court is a place to fight in, not just to cross.

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
  the fight: Q the ultimate, Shift, F and V the grenade, dash and airstrike. Dash and airstrike
  cast at the cursor the moment the key goes down: an aim-then-click step was a beat too slow in
  a crowd. The grenade keeps one: Shift shows its range and blast, a left-click throws, Esc
  cancels; playing without it, a throw went wherever the cursor happened to be, and the grenade
  is the ability you place with care. Right-click only focuses fire on a
  creep; it used to cast the signature off a creep, which went off whenever a click missed.
  E is "use": a downed teammate, loot site or supply crate right beside you comes first, so a
  hero out looting searches the wreck at hand whatever is selected. Otherwise it uses what is
  under the cursor, or else the nearest usable thing (a damaged structure, the armory); on a
  creep it focuses fire. R reloads. The taunt is J: a reach, but seldom needed in a split second.
  Attack-move went away with click-to-move; Stop is a button on the orders card, and hold
  position came off the keys, since the hero standing still already holds.
- **Building is a bar of numbers behind B.** 1–8 pick wall, gate, gun, cannon, frost, tesla,
  sniper, missile, in the order of price, then 9, 0, - and = the traps (spikes, tar, vent, mine)
  and [ the amplifier pylon, so the build keys never clash with the fight keys,
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

## Weapons

Weapons are balanced by measurement, on the bench in `internal/game/weapon_balance_test.go`
(the turrets' half is `balance_test.go`): each weapon fired as the game fires it at creeps on
open ground, at every upgrade level, close (1.5 tiles), mid (8) and far (15), against every
creep kind and the armoured affix, with its uptime, the share of its fire that lands, the gold in
it and the wave a solo game has earned that by; then fully bought against late waves at the
range it is for. `./build.sh go test ./internal/game -run TestWeaponTable -v -args -balance`
prints it. Tests beside it hold each weapon to its role, so a number tuned later can't quietly
take one's place.

- **Each weapon a way of fighting.** Shotgun: brutal up close and weak far out. Rifle: precise,
  long, the one-target killer at range. SMG: instant, cheap crowd fire with frequent reloads.
  Minigun: the heaviest stream, slow to start. Rocket launcher: the biggest splash, slow and
  dangerous to its shooter. Pistol: the sidearm, carried by its upgrades and a second one.
  Crowbar: a melee panic option that holds up.
- **Shotgun falloff.** A pellet keeps its damage out to 3 tiles, then loses it evenly to 35% at
  the end of its range (shotFall). Its spread already thinned it with distance, but a pellet
  that landed at 9 tiles still hit as hard as at 1, so a maxed shotgun at mid range did as much
  as a maxed SMG. It now does about a third of the rifle's there, and over twice the rifle's up
  close. Dragon's breath burns as hot at the end of its reach, and its shove at range is a third
  of what it was: the old shove pushed creeps out past the gun's range faster than they came
  back, so the ultimate slowed the kill it was meant to speed.
- **The minigun spins up.** From 30% of its rate to full over 2 s of firing, back down over
  1.5 s of not firing, a reload included (spinIdle, spinUp, spinDown); Overdrive spins it at
  once. Without it the minigun was a better SMG at every moment; now an SMG outshoots it for
  the first two seconds (416 a second against 284, both maxed), and it leads by half again once
  spun.
- **Rockets burn their shooter.** A rocket bursting within its blast of the survivor who fired
  it hits them for 15 at its heart, half at its edge, whatever its upgrades (rocketSelf): about
  seven in a row at a creep in your face put down a survivor with no armour. Fire is automatic,
  so the risk is in what you hold, not where you click: the launcher for what is still coming,
  another gun for what has arrived. The cluster rocket goes to a point and spares its shooter.
- **The crowbar hits four.** Four creeps a swing where it was three, 42 a hit at 2 swings a
  second: in reach, fully bought, it does a pistol and a half, and beats back a wave 25 charge in
  about the time the guns do.
- **A blade's handling is reach.** Handling buys magazine and reload, which a blade has none of,
  so on the crowbar, katana and greatsword it was gold for nothing but evolution's sum. Each
  level now adds 8% of the blade's base reach (meleeReachLevel): 40% fully bought, the crowbar
  1.9 to 2.7, the greatsword 2.8 to 3.9. Not more, so a swing stays a swing and not a spear.

The numbers that moved, and why:

| | before | after | why |
|---|---|---|---|
| pistol | 14 damage, +22% a level | 15, +30% a level | the free gun is upgraded first and longest; a maxed pair now matches a maxed SMG |
| SMG | 8 at 11/s, magazine 40 | 11 at 12/s, magazine 50 | armour took most of an 8-damage round; maxed, it trailed a maxed pair of pistols |
| rifle | 60 at 1.4/s | 80 at 1.5/s | it was out-killed on one big creep by the minigun and the rocket at its own range |
| rocket | 140 | 120 | it was the best at crowds and at single targets; it keeps the crowds |
| crowbar | 34 at 1.8/s, 3 a swing | 42 at 2/s, 4 a swing | maxed, it was half a pistol pair's damage in reach and let a whole charge in |

Sustained damage a second on one walker (close, mid, far), and on an armoured brute and an
abomination at mid (the crowbar in reach), at level 0 and fully bought; gold is what is in it:

| | gold | before 0 | after 0 | before 5 | after 5 | before 5 brute+A / boss | after 5 brute+A / boss |
|---|---|---|---|---|---|---|---|
| pistol | 0 / 3464 | 36 36 0 | 38 38 0 | 140 140 0 | 178 178 0 | 106 / 97 | 145 / 135 |
| shotgun | 250 / 7330 | 100 27 0 | 100 15 0 | 952 259 0 | 952 139 0 | 317 / 414 | 120 / 130 |
| SMG | 400 / 9648 | 64 56 0 | 102 91 0 | 274 245 0 | 410 367 0 | 160 / 127 | 286 / 251 |
| rifle | 650 / 13514 | 63 63 63 | 88 88 88 | 277 277 277 | 378 378 378 | 262 / 257 | 362 / 358 |
| minigun | 1400 / 25100 | 135 86 45 | 135 86 45 | 642 425 235 | 593 393 216 | 408 / 341 | 377 / 315 |
| rocket | 2000 / 34360 | 85 86 80 | 73 74 69 | 369 358 345 | 317 307 296 | 349 / 347 | 298 / 296 |
| crowbar | 0 / 3464 | 63 | 86 | 214 | 291 | 193 / 187 | 268 / 261 |

Wave 25, every weapon fully bought (the pistol a pair) at its own range: seconds to clear the
army (10 walkers, 4 runners, 10 swarmers, 4 hounds, 2 brutes, a mauler) and the heavy mix (3
brutes, 6 walkers), to kill one goliath, and to beat back the army charging in from 16 tiles:

| | range | army before | after | heavy before | after | goliath before | after | charge before | after |
|---|---|---|---|---|---|---|---|---|---|
| pistols | 6 | 31.2 | 23.5 | 24.2 | 18.4 | 180 | 129 | 20.0 | 15.2 |
| shotgun | 3 | 13.8 | 16.1 | 8.3 | 9.2 | 54 | 54 | 14.3 | 15.2 |
| SMG | 6 | 36.5 | 21.8 | 27.0 | 16.4 | 270 | 137 | 24.1 | 15.1 |
| rifle | 16 | 26.9 | 18.4 | 22.1 | 15.9 | 134 | 96 | 16.5 | 11.9 |
| minigun | 8 | 14.6 | 16.0 | 11.3 | 12.5 | 101 | 109 | 10.7 | 9.7 |
| rocket | 11 | 12.2 | 15.0 | 9.2 | 10.8 | 97 | 114 | 11.1 | 13.4 |
| crowbar | 1.5 | - | - | - | - | 184 | 132 | 36.3 | 23.2 |

The worst of them took 3 times as long as the best to clear the army and the heavy mix; now it
is 1.6 and 2 times, and the tests hold it under 2.5. On wave 30 it is 1.6 and 1.8. Each is still
best at something: the rocket at a loose pack (2 s), the shotgun at heavies and bosses up close,
the rifle at one big creep at range, the minigun at a long fight, the SMG and the pistols at
their price, and the crowbar is free. The rocket's charge costs its shooter about 140 health.

Cost: the upgrade prices are unchanged (UpgradeCost, a quarter of the weapon's price plus 60,
times 1.55 a level). A solo game has earned a maxed pistol or crowbar by wave 7, a shotgun by 10,
an SMG by 11, a rifle by 13, a minigun by 16 and a launcher by 18, of about 105000 by wave 25, so
late every weapon is affordable and the band above is what decides; damage per gold falls from
the cheap guns to the dear ones (13 a second per 100 gold for a maxed shotgun up close, under 1
for the launcher on one target), which is the price of range, splash and sustain.

### Legendary blades

Melee was a panic option: the crowbar holds up, but nobody chooses it. The legendaries make
melee a way to play, and give the far sites something only they hold (`internal/game/legend.go`).

- **Found, never sold.** The katana and the greatsword are not in the armory's list until
  carried. The gas station's counter and the plane's hold have one 30% of the time, and the
  shrines (below) always do. Gold can buy everything else; these are the reason to walk to the
  edge of the map. A survivor who carries both, and a pair of katanas, gets whetstones (levels on
  the blade in hand) from an altar instead, so a shrine is never wasted.
- **Better than the crowbar level for level, and each its own rule.** The bench holds both at 1.4
  times a crowbar's damage a second on a brute at levels 0, 2 and max. The katana is fast and
  narrow and builds blood loss, which bursts for 16% of a creep's health (5% of a boss's) plus 30:
  the answer to big creeps, which melee otherwise can't get through before they hit back. The
  greatsword is slow and wide, staggers (three times a hit's stun) and shoves, and every third
  swing in a row is a follow-through that hits 1.6 times as hard and shakes the ground round it:
  the answer to a crowd. A pair of katanas cuts 1.7 times as fast, as dual pistols fire twice.
- **F is the weapon art, only with one in hand.** A melee fighter's problem is closing the gap and
  getting out; the dash did that, and a weapon art does it with a cut. Flash Draw (0.3 s drawn
  stance, then a run of 7 tiles that cuts everything within 1.3 tiles of its line for triple
  damage and heavy bleed, 6 s) is a line through a crowd; Skyfall (0.6 s in the air, untouchable,
  landing for 2.4 times the damage within 3 tiles with six times the stun, 9 s) is a way into
  one. Tying the art to the blade in hand rather than a slot keeps the dash for everyone else,
  costs no armory gold, and makes switching to the blade a decision. Q stays each weapon's
  ultimate: Crimson Tempest and Titan's Wrath.
- **Two evolutions, as a turret's.** Once the four tracks add up to 12 levels, 1500 gold picks one
  of two for good: Crimson Fang (bleed that chains and heals) or Moonlit Edge (reach); Ashen
  Colossus (fire) or Stormbreaker (lightning). The same rule as the turrets', so it reads at once.
- **The animations sell the weight.** A swing snaps into its pose in three frames, holds, then
  eases back to a chambered windup: the 8-bit way to show speed and weight, after the stances of
  a souls-like. The katana cuts a three-step combo and flicks the blood off (chiburi) when the
  fight stops; Flash Draw is a sheathed crouch, a streak with afterimages and the cuts landing a
  beat later; the greatsword's third swing is an overhead into the ground; Skyfall is a lift, a
  somersault and a slam. The scene keys them off the frame's swing counter, so every client sees
  the same swing.
- **The crowbar joins the school.** Once a blades game made the crowbar a choice rather than a
  fallback, it needed the same shape: Home Run on F (0.45 s wound back, then 3.2 tiles round in
  front at triple damage, four times the stun, every creep hurled 2.6 tiles; 7 s), and two
  evolutions: Bonebreaker (control: double stun and a shove on every hit, Home Run all the way
  round) and Scrap King (economy: half the bounty again and 4% health a kill, Home Run 3 s
  sooner). The legendaries hit harder; the crowbar's answer is to keep a crowd off you and to pay
  for the base. Holding a crowbar on brutal now means F is Home Run, not the dash.

### Blades games

`MODE=blades` (`--mode blades`, the launcher's `m`) is a game with no guns, chosen by the host
before it starts and kept through a restart (`internal/game/mode.go`). Each survivor picks a
crowbar, katana or greatsword when they join; the pick is one-off, and until it is made they
hold the crowbar, so nobody stands unarmed. Rather than a separate rule set, a blades game gates
the existing sources: the armory, the loot table, the gas station and a weapon on the ground all
ask the world whether a kind is allowed, and a gun never is; the check that runs every tick
fails a game where anyone carries one. The gas station's counter, otherwise a gun, always gives
a legendary there, so the map still has a reason to walk to it. Turrets stay: it is a melee
game, not a game without the base.

## Ultimates and abilities

- **An ultimate per weapon, on a meter.** The old signatures were on a cooldown, so they were
  cast whenever ready and mattered little. An ultimate is rare, about one every three waves, so
  it is saved for the moment it turns: the meter fills by damage dealt, measured against what a
  wave holds (ultFull: 37% of three waves' walker-health at the current wave, and the
  difficulty's wave size and creep health), so the pace stays the same as waves grow and on
  every difficulty. Only the hit points a hit takes count, never overkill: when it counted, a
  rocket or a rifle round on a walker filled the meter for damage nobody needed, and the
  launcher and rifle charged far faster than the pistol or SMG for the same kills. A revive gives 15%, so helping fills it too. Turret fire
  and burning don't count: the meter rewards the survivor's own fighting, not the base's.
  It doesn't fill while one runs, and going down ends it.
- **Each ultimate leans into its weapon.** Dead Eye makes the pistol, the weakest gun, the one
  that clears the screen: a 1.5 s mark at half speed, then a shot at everything in sight, lethal
  to all but brutes and bosses (200 for them, so it can't erase a boss, growing with creep
  health past wave 10 as the grenade does). Dragon's breath gives
  the shotgun its crowd control as fire and a shove. The SMG's Run and gun is about moving,
  the rifle's Railgun about lines, the minigun's Overdrive about holding a lane, the launcher's
  Cluster MIRV about one big crowd far off, and the crowbar's Berserk about standing in the
  middle of it. None spends ammo while it runs, so it isn't cut short by a reload.
- **The shotgun hits harder from further.** 13 a pellet and range 10, with a tighter spread:
  it was the gun nobody kept past the first armory visit. It has since been given falloff (see
  Weapons): the range is there for finishing a creep, not for fighting at it.
- **The shotgun knocks creeps back, up close.** Each pellet pushes its creep a little, so a
  point-blank load shoves a walker about a quarter of a tile, and a tile and a half with the
  special track maxed (more pellets, each pushing harder). The push is full within 2 tiles and
  fades to nothing at 5, half the gun's range: the shotgun is meant to be high risk and high
  reward, and a shove from a safe distance would make it neither. Bosses aren't pushed.
- **Dual pistols are found, not bought.** A weapon find offers a second pistol to whoever
  carries one, among the guns they don't own, and a pistol on the ground can be picked up
  into the other hand. The pair is twice the pistol: each as the survivor upgraded theirs, so
  twice the rounds a second and twice the magazine, and the upgrades bought for one pistol
  pay double. The pistol is the gun everyone starts with and Dead Eye makes it worth keeping;
  a lucky find makes it worth upgrading, and keeps looting worth it for whoever would rather
  spend on turrets. The second pistol carries nothing of its own: a pistol found with levels,
  or dropped by a teammate, is just the other hand.
- **The grenade grows with the game.** Five levels where it had three, from 120 damage to 400,
  wider and quicker each level, and from level 4 it leaves fire burning; a three-level grenade
  stopped mattering by the mid game, when it was the one ability always at hand. Past wave 10
  its blast, its fire, the airstrike and Dead Eye's heavy shot grow as creep health has since
  (lateScale): bought by level, they had stopped growing while the creeps had not, and a full
  grenade was three walkers' health on wave 10 and less than one on wave 30.

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
- Every upgrade bought on a weapon, gear, turret, wall or gate is logged in the chat
  ("ana upgraded a Cannon's fire rate to 3"), so the team sees where the gold goes. The line is
  shown for only a second, because upgrades come in bursts and would push the talk off screen.
  Opening the chat shows them again.
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

## Sound

**The direction.** The sound is a survival story heard from just above: close, dry and
physical where you are, wider and darker with distance, and quiet enough between waves that a
groan out in the dark means something. Three rules order everything else:

1. **What you do answers you first.** Your own gun, reload, kill and hurt are never the sound
   that gets dropped, and each is clear of the rest of the mix.
2. **Warnings over texture.** The siren, the klaxon, the radio and a big one winding up cut
   through. A horde is heard as a horde from a few voices, not as every one of them.
3. **One place, one air.** Every sound shares one outdoor reverb and the same distance rule,
   and the weather's sound changes the whole world's, so the guns, the dead and the rain sound
   like the same field.

The mix's bands, measured as loudness close by (K-weighted, 400 ms): explosions and heavy guns
-8 to -13 LUFS, the player's guns -11 to -20, the big ones' groans and deaths -11 to -15, cues
-12 to -22, the small dead -18 to -24, your own reload and handling -22 to -28, the kill knock
about -29, ambience -32 to -42, footsteps under -45.

- **Synthesized, not recorded.** Every sound is rendered by code in the page
  (`web/src/sound/bank.ts`): no audio files, no licences, nothing to download, and like the
  art, it is all generated. The bank is made once sound starts, in a worker so no frame waits
  on it (about 1.3 s of work, guns first; a sound not made yet is skipped), and the long, low
  sounds (explosions, voices, sirens) at 24 kHz, which they lose nothing by and which halves
  their memory. What is left of a sound after it has died 60 dB away is cut: about 35 MB in
  all. Each sound has a few variants from different seeds, and every play is pitched and set up
  to 15% apart (mostly much less), so fire never sounds like a loop and the ear doesn't tire of
  a sound repeated exactly. A voice varies by 5%, or it stops being the same person, and a cue
  not at all, since its pitch is what it says.
- **Levels from measurement.** Every sound is rendered peak-normalized, then trimmed where its
  measured loudness stood out of line with its kind. Measured, the player's shout was the
  loudest thing in the game, the big ones' groans as loud as a shotgun, the tesla tower a hiss
  with most of its energy above 8 kHz, and the reloads lost under the gun they reload. The
  shout and the groans were brought down, the tesla remade in the mids, the reloads and the
  radio brought up.
- **Guns are built like real shots,** because they are most of what is heard. Six layers: a
  crack of a millisecond, the muzzle blast overdriven into distortion with its top end dying
  first, a resonant body in the mids where the bang is, a low boom falling in pitch, a tail
  rolling away and echoes off the treeline. Then the action: the shotgun's pump, the rifle's
  bolt, the pistol's brass bouncing. Each gun has its own numbers, so a pistol, an SMG and a
  sniper tower are told apart by ear. The pistol is heavy, a desert eagle rather than a 9 mm,
  because it is the gun most of a game is played with and a weak snap makes it feel weak. The
  rifle is a full-power bolt action, a springfield or an AWP: the sharpest crack, the deepest
  boom of the guns and the longest report, then the bolt. The shotgun is a 12 gauge: the widest, hardest
  blast with more crack than thump, a punch deeper than anything hand-held but the rifle and a
  report rolling off the treeline three times, a little under the rifle so the rifle stays the
  biggest shot; then the pump racked, the spent hull landing with a plastic tock, and the
  fore-end slammed home. The SMG is a 9 mm machine pistol: a
  snappy crack and a tight punch with a short boom, so eleven rounds a second stay apart, and
  the bolt clacking home under each one, the clatter that makes a burst sound like a machine. The crowbar is Half-Life's, a little deeper:
  a swish and a struck pipe ringing out for most of a second, measured against the original
  for the ring's length, but pitched down from its 1.1 kHz to about 820 Hz, with a thump as it
  lands and the bar's low modes louder, so a blow has weight rather than only a ping. The towers: the gun turret a sentry, a dry round,
  a feed clack and a servo slewing; the cannon field artillery, the deepest boom in the game, the
  barrel ringing, the recoil and the case dropped; the sniper tower a .50 whose muzzle brake
  throws a wider, harsher blast than the rifle's; the missile battery's tubes popping like a
  blown bottle before each motor lights. The Huey's door gun is an M60 heard from the ground.
  A creep's spit is a hack, a wet pop and bubbling slime; a hurler's bone is torn out with a
  crunch and tumbles through the air, then cracks, splinters and clatters. A dash is a boot
  driving off, the air ripping past and a skid; a grenade is the pin, the spoon spinning away
  ringing, and the throw. The tesla is a zap, an arc's crackle of ragged sparks with a
  snap and a falling tone, kept under 7 kHz; the frost tower, which pulses every second, is a
  short cold gust with ice crackling and a glint of glass, with nothing sustained up high.
  The minigun fires full rifle rounds, so each is a hard slam with a boom under it and a tail
  long enough that 22 a second run together into one roar, over a motor, six barrels chopping
  the air and the feed rattling. A shot under an ultimate sounds like the gun's own, except the
  rifle's Railgun, which has no powder: a snap of discharge, an electric tone diving five
  octaves, the air fizzing behind the slug, the rails ringing and the capacitors whining back
  up to a click.
- **Reloads are built of clacks.** A click and metal sliding on metal is the light half of
  handling a gun; what makes a reload sound solid is the heavy parts going home, each a click
  with the gun's body knocked low under it and a short ring of steel. Each gun reloads its own
  way: the pistol's magazine clattering down and its slide let go, the SMG's magazine slapped
  home and its handle let fly, the rifle's clip pressed in round by round, the minigun's box
  dropped, its belt fed link by link and its barrels given a turn, the launcher's rocket latched
  and armed with two beeps.
- **The siren is a machine across town,** not a tone: two rotors a minor third apart chopping
  air, a buzz with wind in it that grows louder as the motor winds up, swept towards you and
  away as the head turns, and sent back late by the hills. The wave's siren winds up, holds and
  is cut; a boss wave's, every tenth, is the attack signal instead, wailing up and down with a
  deeper siren farther off wailing out of step with it, a little louder and the world held
  down under it longer, so it is known before the boss is seen; the all clear holds one lower
  steady tone; the end groans all the way down.
- **Explosions throw things.** A shock front, the air slammed up and sucked back in a few
  milliseconds; the fireball driven into distortion with its top end dying, a whump and a
  falling boom under it, crackling as it burns off; then what was thrown up raining back down
  for a second, clods thumping and stones ticking, metal ringing among them from the bigger
  ones, all of it sent back off the treeline over a rumble. A rocket leaves its tube with a
  crack and a backblast, its motor tearing and crackling as it flies off; a missile's motor
  lights with a pop and fizzes away.
- **The base and the pickups are tools and things handled.** Building is a nail hammered into
  a plank, its ring rising and the last blow a dead thump; an upgrade an impact gun rattling a
  bolt tight and the part seated with a clank; paying coins tipped onto a pile, the last one
  spinning down. A supply crate lands hard, its planks booming in their straps, and its
  parachute settles over it. A find knocks a latch up and creaks a hinge before its two
  glockenspiel notes; a jackpot runs up a chord and rains coins. A medkit is velcro ripped, a
  packet torn, antiseptic hissed and a bandage pulled tight; changing guns is webbing, a grip
  slapped into the palm and a safety thumbed off. Footsteps: a boot's heel then its toe on
  grit, a dead foot dragged then slapped down bare, a big one's weight crushing the dirt.
  What plays often is kept from tiring: the coins, heard on every buy and sell and often
  several in a row, ring briefly and below the harshest band, their spin a short rattle; a
  dead foot's drag is short, since a horde's steps are the commonest sound and long ones ran
  together into a hiss under everything.
- **Thunder rips, then booms, then rolls.** A close bolt crackles along its length faster and
  faster into the clap; the roll is that clap arriving again from each stretch of the bolt
  further off, later and darker, for five seconds. One in four is further off, all roll.
- **Heard round the camera, outdoors.** Distance makes a sound quieter, darker (low-passed)
  and wetter, and the screen position pans it. One shared reverb is open ground with buildings
  round it, not a hall.
- **Priorities, not first come.** At most 40 sounds play at once and six of one (more for the
  guns that fire in streams). A sound past those limits doesn't simply go unheard: every sound
  has a priority (footsteps, texture such as blows and groans, ordinary, heavy, your own, cues),
  and a new one takes the place of the least of those playing, a lower priority or the same one
  and quieter by now, with a fade of a few milliseconds. Past six of one sound, the oldest of
  them gives way once its first third (the part heard) is over, so a stream of fire stays
  current instead of the newest shots going missing. In a 3000-creep demo wave this took the
  sounds lost from 35% to under 7%, and none of them is yours or a cue.
- **Cues over noise.** A tick's events are thinned to the nearest few of each sound and spread
  across the tick. The more creeps are awake within earshot, the fewer of their groans, throws
  and deaths are played: from 6 to 30 awake they thin to about half, since a horde reads as a
  horde from a few voices. Blows landing were the commonest sound of a wave, eleven a second, a
  drum roll that hid the rest: now the nearest blow of a tick plays at most every 0.12 s alone
  and 0.28 s in a crowd. What needs attention gets its own sound that cuts through, and the
  world steps back a few dB under it: the siren, the generator's klaxon, the radio for pings
  and chat, a nest waking.
- **The ear warns before the eye.** A brute, an abomination or a broodmother drawing up to
  strike breathes in and growls, the nearest one that has just started, so at night a blow
  coming out of the dark is heard first.
- **Your own feedback.** A short, dry knock for each kill of your own shooting (at most 14 a
  second, rising a little with each in quick succession), a charge-up when your ultimate is
  full, your heart once your health is under a quarter, and the countdown's last beep higher
  and longer than the two before it.
- **Music only at the turns.** A few seconds of recorded music (`web/src/sound/cues/`, CC0,
  credited in its `CREDITS.md`; the one exception to synthesized) mark when the night turns: a
  wave starting, a boss wave, a wave cleared, a last stand (the generator under a quarter, or
  one survivor standing of several), the evac called, the Huey away with survivors, the game
  lost, the generator raised a tier. Each comes in after the siren it shares a moment with and
  under it, since the siren is the warning and the music only the mood; one plays at a time,
  the more telling cutting off the less. Dark orchestral cuts, most by one composer, brought to
  one loudness, so they sound of a piece.
- **Footsteps, barely there.** Survivors and creeps step once per step's length of ground
  covered (a survivor's lengthening with speed, a creep's with its size), some 30 dB under a
  pistol shot: enough to hear something coming in a quiet build phase, nothing in a fight.
  Only the nearest two of the dead are heard stepping each tick (one in a crowd), the big
  ones first, and steps are the first sounds dropped once 32 of the 40 voices are playing.
- **The weather and the night are heard.** Rain, wind (stronger in snow and a storm), the
  night's crickets, which fall quiet when the dead are about, and the generator's hum round the
  base. Rain and wind are two loops each, apart in time and either side, so they are wide
  rather than a point in the middle. The ambience is far under everything else and steps back
  as a fight fills the mix. Rain also muffles the whole world a little, as it muffles gunfire
  for the creeps, and a pause muffles it a lot.
- **Music that follows the fight, never in its way.** Four CC0 loops (credits in
  `web/src/sound/music/CREDITS.md`): an ambient piece for the build, a light and a pressing
  fight for a wave, and a boss's on every tenth. A wave's intensity (the dead awake, those
  near the generator, how hard it was just hit, how much of it is left) opens the track's
  low-pass and lifts it first, so the music thickens with the wave before it changes; between
  the light and the pressing fight there is a gap between thresholds and twelve seconds' hold,
  so it never flaps. Crossfades take three seconds. The music sits after the limiter, so the
  explosions do not pump it, and under the game at its own setting, so a player who wants the
  warnings alone turns it off. It streams from files beside the page once wanted (the next
  fight's loaded during the build), so nothing ever waits on it.
- **The same mix at every volume.** Three buses (the world, the cues, the ambience) meet in a
  gentle compressor and a clipper that is clean until the last 2 dB; the volume setting comes
  after them. Each player's volume is a setting like any other, saved from the menu.
- **Everything the game added is heard too** (`web/src/sound/coverage.ts`, `ambience.ts`). The
  host sends no sound events, so these sounds come from changes between frames: a gate's
  open bit, a turret's evolution, the tier and the gold paid in, a creep's flags and health,
  a creep stepping onto a trap tile, the blast kinds. That way the protocol stays as it was.
  The recipes use the same physical parts as the rest of the bank. Spikes are steel biting
  and a chain rattling. Tar is a slow glop and suck. A vent is gas hissing before the whump.
  A mine is its pressure plate clicking and then a soil geyser over the explosion's boom.
  Each evolution sounds like what it became: the gatling lighter and faster, the penetrator
  harder, the mortar a hollow thoomp, the anti-materiel rifle deeper than the .50. Napalm
  burns as it flies and lands with a soft liquid whump, not a shock front. Rounds glance off
  armoured creeps with a ring, a sapper's fuse sputters as a loop on the nearest one, and a
  splitter tears open with two squeals. Hasty waves need nothing new, since footsteps already
  follow ground covered. A rocket now sounds once as it leaves, not on every tick of its
  flight. Mix rules hold for all of it. Everything common (spikes, tar, ricochets) is a
  texture-priority sound, only the nearest one each tick plays, and it waits longer in a crowd.
  The pylon only buzzes close by. The hound, the mauler and the goliath, which had no voice,
  now groan and die like the other creeps.
- **The horde before the blows.** A distant horde bed (dozens of blurred moans, shuffling, a
  low swell) rises with the awake creeps of a wave, weighted by distance. Creeps still to
  come and those hidden in the dark count as far ones. It comes from where they are, or from
  the side the scouts reported, and it backs off when the nearby crowd and the mix fill up,
  because then each creep is heard on its own. The siren is the base's alarm, and a war horn
  from the wave's side answers it two seconds later; a boss wave gets two horns, lower. This
  complements the siren rather than duplicating it. Bosses roar on sight and every fourteen
  seconds or so after, never two within seven. Their tread thumps the ground and carries
  further than other creeps' sounds. A failing generator sparks more often the worse it gets
  and crackles below 30%. Its alarm is three rising whoops, unlike the klaxon of a hit, so a
  failing generator can be told from a struck one. The alarm sounds when health passes 50%,
  25% and 10%, then every 20 s while under 25%.

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
