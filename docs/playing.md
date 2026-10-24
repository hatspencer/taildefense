# Playing

The player's guide: what is out there, what comes for you and how a game runs. The keys are in
the README; `docs/game-design.md` says why things work the way they do.

## Sound

The fight is heard round where the camera looks: closer is louder, off to the side is to that
side, and far away is quieter, darker and more echo. Some sounds are there to warn you:

- **A siren winds up** when a wave starts and a lower one sounds the all-clear; three beeps count
  down the last seconds before a wave.
- **A klaxon** means the generator is taking hits.
- **The radio** chirps for a chat line, a ping (three quick beeps for danger) and the game's news.
- **A shriek and a crowd of groans** is a nest waking; a single growl is a site's guards.
- **A ringing in your ears** is a slam that knocked you flat.

Sound starts with your first click or key press (browsers insist). `VOLUME` in
`docs/settings.md` sets it, and so does the slider in the menu (F10); 0 is off.

The music follows the fight: a quiet track while you build, a fight that grows as more of the
dead wake and close on the generator and as it takes hits, and a boss's music on every tenth
wave. `MUSIC` (and its slider) sets it apart from the rest of the sound.

## The screen

The top bar always shows the base's health, the generator's, next to the wave. Click it to look at
the base.

On the minimap, left-drag moves the view, right-click walks you there and Alt+click pings.

A ping shows for 5 s: rings on the ground and a beacon with your name over the spot, a pulse on
everyone's minimap, and an arrow at the edge of the screen for anyone looking elsewhere. Pings
show through fog. Three can go back to back, then one a second.

North is the top of the map. The compass strip at the top of the view shows which way the camera
faces as you rotate it, and clicking it turns the view north up again. The minimap is always north
up, and a downed teammate's call says where they fell, so "brute coming in from the NW" means
the same thing to everyone.

## Windows, and when the link goes

A first game on a machine opens with four first steps: keep the generator standing, walk with
WASD, build and shop between waves, E for what is beside you. The menu (F10 or Esc) has them
again, beside the controls (F1), which are grouped by what you are doing.

The menu, the controls, the first steps and the field report work without the mouse: the arrows
or Tab move between the buttons, Enter presses one, Esc closes. A controller does the same with
the d-pad or left stick, A to press, B to go back and Start for the menu; the game itself is
played on the keyboard and mouse. Over the field report Enter is still the chat until you move
into the report, so a last word does not restart the game.

The field report says how it ended: the wave that broke through and what stood at the generator
when it fell, or who the Huey left behind. Under the tally it names the MVP (most kills) and
whoever revived, built, turret-killed, hunted bosses or searched the most. The picture td keeps of
it says the same.

If the page loses the td on this machine it says so and keeps trying, counting the seconds; after
a few it says what to check (is td still running in its terminal?) and offers a reload. When the
game ends for the tab it says why in words, the host gone, you left, the game opened in another
tab or td stopped, and what to do next.

## Weapons and kit

A weapon run dry reloads in the background: switch to another and keep shooting, and the empty
one comes back full a moment later. Its slot shows a moving strip while it reloads.

Medkits (1) heal 40% of your health over 3 s, unless a hit cuts it short. You start with one and
carry up to three. Buy them at the armory for 60 gold, or find them in places with a first-aid
kit, like an ambulance. The gear row that raises regeneration is Vitamins.

On hard and brutal the armory also sells night vision goggles, for 3000 gold. Worn, they let you
see as far at night as by day, in place of brutal's flashlight; everyone sees you wearing them,
and you keep them when you go down.

Weapons go up at the armory by track: damage, fire rate, handling and a special of their own.
Find a second pistol in the loot, or pick up one someone dropped, and it goes in your other hand:
dual pistols, each as upgraded as yours, fire twice as fast from twice the magazine. Dropping
one leaves you the other.

Each gun has its range. The shotgun is brutal within a few tiles and loses up to two thirds of
its punch by the end of its reach; the rifle hits as hard at 28 tiles as at 1. The minigun
starts at under a third of its rate and takes two seconds of firing to spin up, so bring it up
before the crowd arrives, not after; the SMG fires full from the first round. A rocket bursting
near you hurts you too, up to 15 health a rocket, so switch guns when creeps reach you. The
crowbar hits up to four creeps a swing.

## Turrets

Six turrets, from the build bar (B, then the number):

| | | |
|---|---|---|
| Gun turret (3) | 120 | fast single shots at the nearest creep |
| Cannon (4) | 240 | slow shells that burst on a crowd |
| Frost tower (5) | 180 | pulses cold round itself, slowing everything in reach |
| Tesla coil (6) | 320 | lightning that jumps from creep to creep |
| Sniper tower (7) | 380 | a heavy round every few seconds from far off, at the toughest creep it can see; the answer to brutes and bosses, whose armour shrugs off a gun turret |
| Missile battery (8) | 420 | a salvo of small rockets, each at a different creep |

A turret goes up the way a weapon does: four tracks, damage, fire rate, range and a special,
each to level 5, bought one at a time from the buttons on its card (select it, or T to step
through your turrets). The special is the turret's own: pierce for the gun and the sniper, blast
radius for the cannon, longer slow for frost, two more jumps and a longer reach for the tesla
coil, one more missile for the battery. Each button shows what the next level changes and costs;
the coloured pips on the turret's side show its levels, a column per track. Every upgrade also
gives the turret a little more health. Selling returns half of everything that went into it, less for a damaged one, to whoever
sells it: anyone can sell anything but the generator and the armory, a teammate's too, and the
team is told. To sell, press Delete twice on the selected structure (the first press
says what it will fetch), or use Sell on its card. Repairing costs gold by the hit point, never more
than half of what went into the structure for a full mend, so it is always cheaper than selling
and building again.

### Traps

Traps line a maze. They lie flat: the dead walk over them, and so do you, and they never change
the way in.

| | | |
|---|---|---|
| Spike strip (9) | 60 | cuts every creep standing on it, and wears down as it does |
| Tar pit (0) | 50 | slows every creep wading through it, so they spend longer under the guns |
| Flame vent (-) | 150 | bursts into flame when a creep steps on it, setting everything round it alight; again every few seconds |
| Mine (=) | 40 | blows up under the first creep to step on it, and is gone |

A spike strip worn out or a mine gone off leaves a ghost, which H lays again between waves.
Spike strips and flame vents go up levels: tougher, and each level adds about a third to their
damage.

### Evolutions and the pylon

Once the generator is at tier III, a turret whose tracks add up to 12 can evolve, once, for its
price again: its card shows the two branches when it can. Each turret has two, and each answers
a different wave: the gun's Gatling (fast) or Penetrator (ignores armour), the cannon's Mortar
(far, over walls) or Shrapnel (wide), the frost tower's Cryo (freezes) or Blizzard (wide), the
tesla's Storm conductor (stronger in rain) or Arc web (jumps further), the sniper's Spotter
(marks its target to take more from everything) or Anti-materiel (through everything), and the
missile battery's Swarm (twice the missiles) or Napalm (fire). An evolved turret wears a brass
collar and a lamp, amber or violet by branch.

The amplifier pylon ([ on the build bar, 200, from tier II) makes every turret within 3 tiles
fire 15% faster. Two in reach of the same turret don't add up: spread them.

### The generator

The generator grows with the team. Click the base chip at the top (or the generator itself) and
Pay in puts 100 of your gold into its next tier; everyone's pay-ins add up. Tier II (600, more
with more players) makes it tougher and unlocks the amplifier pylon; tier III (1600) makes it
tougher again and unlocks evolutions and the Overload. Once a wave, anyone can set off the
Overload from its card: everything within 18 tiles of the generator is shocked and frozen for a
moment. The base chip glows violet while it is ready.

### Gates and mazes

A gate is a wall to the dead and a doorway to survivors. E on a gate (or Open gate on its card)
walks you to it and swings it open: open, the dead walk through it too, rather than break the
walls. It takes a moment to work and can't swing again for 4 s, and it won't shut on a creep
standing in it. While you place a building, or with a gate picked out, orange dots show the way
the dead walk in and the prompt says how far that is, and how much the building being placed adds;
red dots mean the base is sealed and they will break in.

Three things keep a maze honest. Brutes and bosses need lanes two tiles wide: where the only way
round is one tile wide, they smash through. A creep that can't reach a survivor behind a wall
doesn't claw at the wall, but wanting them wears its patience. And patience runs out: a creep
inside the build ring that has walked about three times as far as the straight way in (more on
easy, less on brutal) frenzies, turns red, runs faster, hits harder and breaks through anything
in its way. A maze should be long, but not endless.

Walls (1) and gates (2) keep placing after each one goes down, so a line goes down click after
click; Esc stops. A turret places once, unless you hold Shift.

A destroyed building leaves a pale ghost where it stood. Between waves, H (or Rebuild on the top
bar, or Rebuild all on the card with nothing selected, both showing the price) shows what it
costs to rebuild every ghost and repair everything damaged; H again pays it.
Rebuilt buildings come back at their first level, owned by whoever built them. Building on a
ghost clears it, and when the gold runs short the rest waits.

## Out past the walls

Outside the walls are ruined houses, wrecks and supply crates worth looting. The wrecks on the
roads differ: a pickup's bed holds tools and gear, a police cruiser or an army truck guns (the
army trucks are far out, and always guarded), an ambulance's kit patches you up, and a school
bus is slow to search but gives two finds, if nothing is nesting in it. A fire engine's lockers
always hold a medkit, an armoured cash van is slow to crack but pays out in gold, a camper van
may still have somebody living in it, and a motorbike's panniers take a second. Wrecks lie along the
roads and are solid: you walk round them, and search one from its side. A glint marks
the ones nobody has searched yet. Sites are not on the map: you find them by going out and looking. Press E on one to walk over and search it, or E twice to make for the nearest one in sight, which takes a few
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

After every tenth wave a Huey gunship (surfboards strapped to its side) flies a supply crate out
beyond the walls, its door gunner working over the zone with a minigun on the way in. The crate comes down under
a chute and marks itself with green smoke. Stand by it for a few seconds, unhurt, to open it:
gold and full medkits for everyone, and a rare find for the one who opened it. E walks you to a
crate nearby.

A weapon can change hands. Hold G for a second and the one you hold drops in front of you, with
every upgrade on it; it lies there with a glint over it, taped in your colour, until someone
walks up and picks it up with E, which takes a fifth of a second. The rifle you sank your gold into can go to whoever
holds the back line, and come back when you want it. You always keep one weapon, and you can't
pick up a kind you already carry.

## The dead

The dead wander the wastes on their own, in small packs, shambling about away from the base.
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
from twice as far, from wave 8. Hounds, dead dogs in packs, come from wave 5: they run you down
even at a sprint, so turn and shoot. Maulers, brutes that charge, come from wave 12. From wave 10
the bosses come.

Brutes and abominations slam the ground when you come near: a ring shows where it will land a
moment before. Get out of it, and don't fight them next to your turrets: the slam wrecks those
too. The broodmother, the other boss, fights from afar instead: she lobs sacs of bile over walls
at where you stand. Keep moving when the ring shows under you; a sac leaves a pool of acid and
a few swarmers behind, and every quarter of her life you shoot away spills a brood of them.

Maulers and the goliath, the third boss, charge, and their slams stun longest. Worse, get within
arm's reach and they catch you: held up, helpless, then thrown far behind them into the crowd,
and the fall hurts and stuns you. If a teammate is caught, shoot whatever holds them: enough
damage makes it let go. The evac Huey's door gunner does the same, firing first at anything
holding a survivor.

Gunfire is loud. Shooting wakes guards nearby and pulls wave creeps in earshot towards you; rain
and storms muffle it.

Creeps can be pulled. Shooting one may make it come for you instead of the generator (at a
quickened walk until it is close enough to see you, then at a run), and a
taunt (J) pulls everything around you. Creeps also take against things by themselves now and
then: a turret or wall they pass, or a survivor further off than they'd normally notice.

## Going down

When you go down you can be revived where you fell: a teammate presses E on you and stays
next to you for a few seconds, and a hit starts it over. If nobody does, you're back at the base
when the countdown runs out, blinking: for 5 seconds nothing can hurt, slow or stun you, and
you can shoot.

## Weather

The weather changes between waves and is the same for everyone. Fog shortens everyone's range
and hides teammates from the map and their health bars, rain dampens fire and slows creeps a
little, a storm throws lightning at creeps out in the open, and snow slows everything down.
Wet weather is mostly light, a drizzle or a passing thunder shower, and snow mostly a thin
fall. Heavy rain, full storms and heavy snow are rare.

## Ultimates

Each weapon has an ultimate on Q. Its meter, on the Q slot, fills as you deal damage and revive
teammates (turrets don't fill it), about once every three waves; it doesn't fill while one is
running, and going down ends it.

| weapon | ultimate (Q) |
|---|---|
| Pistol | Dead Eye: slow down and mark everything in sight for 1.5 s, then shoot them all; lethal to all but brutes and bosses, which take a heavy hit |
| Shotgun | Dragon's breath: 8 s of fast fire that sets creeps alight and shoves them back |
| SMG | Run and gun: 10 s of double fire rate, quicker feet, no stamina drain and no reloads |
| Rifle | Railgun: for 10 s every shot goes through everything in its line |
| Minigun | Overdrive: 10 s faster, tighter and piercing, in red tracers, with no reloads |
| Rocket launcher | Cluster MIRV: a rocket to the cursor that splits into ten bomblets |
| Crowbar (brutal) | Berserk: 8 s of double swings that heal you and can't be slowed or stunned |

No ultimate spends ammo while it runs.

## Abilities

Grenade (Shift), dash (F) and airstrike (V) are bought and levelled at the armory. Shift aims the
grenade: its range rings your hero and its blast follows the cursor (grey out of range), a
left-click throws it, and Esc, a right-click or Shift again puts it away. Dash and airstrike cast
at the cursor the moment you press the key; point at the ground. The grenade goes to level 5, each
level hitting harder (120 damage at the first, 400 at the fifth), throwing wider and coming back
sooner; from level 4 it leaves a fire burning where it lands. After wave 10 the grenade and the
airstrike hit harder as the creeps get tougher. Dash and airstrike go to level 3.

## Waves

Creeps walk to the generator round every wall, however long the way round, as long as there is
one: open a gate and build a maze outside it, and they walk the maze under your turrets' guns.
Only a base sealed tight gets broken into, where the walls are weakest. The base starts sealed,
its gates shut. The waves grow every time, faster the longer
the game goes, and with every player who is actually playing (anyone idle for 90 s doesn't
count). Each wave comes in from one side of the map, or from two or three later on, and seldom
from the side the last one did; the wave's notice says where ("incoming from the north and
east"), except on hard and brutal, where you find out when they arrive. Every fifth wave is a swarm that swells as the game goes on; from wave 10 they are
hordes, a third of which pours out of every point on the wave's sides at once. Every tenth wave
brings a boss: an abomination, a broodmother or a goliath, taking turns.

From wave 4 a wave comes with an affix, and from wave 15 with two. During the break the scouts
report what is coming, and the wave label at the top shows it, along with the sides it comes from:

- **Armoured**: every creep shrugs off more of each hit. Gun turrets suffer; snipers and cannons
  don't.
- **Hasty**: every creep a fifth faster.
- **Sappers** (a blinking red marker): they ignore your maze and walk straight for the walls,
  blowing up against the first thing they reach. Kill them out in front.
- **Splitters** (a green marker): they burst into two swarmers when they die.

A wave holds until it is dead: the break before the next one starts only once every creep of it
is gone (sleeping guards don't count), so two waves never land on the base at once. Stragglers
don't stall the game: if nothing of the wave has died for 30 s and at most 10 are left, they
give up.

Between waves there is a short break, 15 s on Normal, and after every fifth wave a long one,
a minute on Normal, to go out exploring and looting; ten seconds before it ends everyone is
called home. The last seconds of every break count down in the middle of the screen. When
everyone is ready the countdown jumps to 3 s.

## Get to the choppa

A game is won by holding out to its last wave: 40 by default, or 20 or 30 if the host picked
a shorter one (an endless game has none, and goes on until the generator falls). Clearing it
calls the evac Huey to the helipad, a concrete square with an H on it out past the walls: in the
build ring on easy and normal, further out on hard and brutal. At night (hard and brutal) the
pad has to be found first: it shows on the map and the minimap only once someone's light has
fallen on it, so go and look for it before the end.

The Huey lands a minute after the call, and the last of the dead come for the pad, not the
generator, which can't fall now. Hold the pad. Once it is down, press E (from anywhere: it walks
you there) and stand by it a second, unhurt, to get aboard. It waits up to 90 s; once someone is
aboard it goes when everyone still playing is aboard, or 30 s later, with or without the rest.
Then it lifts off and flies away, and the field report says who got out.
