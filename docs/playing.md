# Playing

The player's guide: what is out there, what comes for you and how a game runs. The keys are in
the README, and in the terminal too: `td keys` prints them, and Keys in the launcher shows them;
in the game F1 lists them. `docs/game-design.md` says why things work the way they do.

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
into the report, so a last word does not restart the game. Restart on a new map, or on the same
map to try it again.

The field report says how it ended: the wave that broke through and what stood at the generator
when it fell, or who the Huey left behind. Under the tally it names the MVP (most kills) and
whoever revived, built, turret-killed, hunted bosses or searched the most. The picture td keeps of
it says the same.

If the page loses the td on this machine it says so and keeps trying, counting the seconds; after
a few it says what to check (is td still running in its terminal?) and offers a reload. When the
game ends for the tab it says why in words, the host gone, you left, the game opened in another
tab or td stopped, and what to do next.

When your packets to the host go through a Tailscale DERP relay, or the ping averages over
120 ms, a small badge in the top bar says so (`DERP fra · 61 ms`, `lag 140 ms`); hover it for
what to try, starting with `td doctor`.

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
Handling is a bigger magazine and a faster reload on a gun, and longer reach on a blade.
A weapon you find or pick up does not go in your hands: you keep what you hold until you switch
to it with its number key. Find a second pistol in the loot, or pick up one someone dropped, and it goes in your other hand:
dual pistols, each as upgraded as yours, fire twice as fast from twice the magazine. Dropping
one leaves you the other.

Each gun has its range. The shotgun is brutal within a few tiles and loses up to two thirds of
its punch by the end of its reach; the rifle hits as hard at 28 tiles as at 1, and once all four of its tracks are at 5 it is drawn as
the sniper tower's huge green rifle, with a bigger kick and flash (it hits no harder for it). The minigun
starts at under a third of its rate and takes two seconds of firing to spin up, so bring it up
before the crowd arrives, not after; the SMG fires full from the first round. A rocket bursting
near you hurts you too, up to 15 health a rocket, so switch guns when creeps reach you. The
crowbar hits up to four creeps a swing.

**Critical hits.** Every hit of the crowbar, the katana or the greatsword (and their weapon
arts) may land critical, with a white-gold flash on the creep: 1.8 times the damage and twice
the stun. One just found crits 5% of the time; every level bought on it adds 1.2% and raises the
damage towards 2.5 times, its evolution adds 6% and a second katana 5%, so a full pair of
katanas crits two hits in five. Guns and turrets never crit.

### Legendary blades

Two blades are never sold: the katana (8) and the greatsword (9). They are found, and only where
the map is most dangerous: now and then on the gas station's counter or in the plane's hold, and
always on the altar of a shrine (see below). A second katana goes in your other hand, and the pair
cuts 1.7 times as fast; a second greatsword is forged into the first, a **tempered** greatsword
(still one blade, counted as a second katana is for mastery and crits). Once you carry everything
there is, an altar sharpens the blade in your hand instead. Each levels at the armory like any weapon, and each has more to it than a swing:

- **Katana:** quick cuts through up to five creeps that build up blood loss. When a creep's fills,
  it bursts for a sixth of its health (less on a boss). Its special track builds bleed faster.
- **Greatsword:** slow, wide, heavy blows through up to eight that stagger and shove what they
  hit. It stuns longer than any blade, and a blow landing on a creep already stunned renews the
  stun, so whatever you keep swinging at stays held, a goliath included once the blade is
  fully bought. Every swing sends a shockwave out from where the blade lands, about 2 tiles round, that
  hurts, stuns and pushes back. Every third swing in a row is a follow-through that hits harder
  still, shakes the ground further and cleaves a share of each creep's health (3%, up to 10% with
  mastery; a boss 1% to 8%). Every blow **sunders** what it lands on: each stack strips a fifth of
  its armour and makes every hit on it 8% harder, yours, your team's and the turrets', up to 5
  stacks (9 with mastery, +72%), for 5 s after the last blow. Creeps shown cracked are sundered.

**Mastery.** The further you take a katana or a greatsword, the more it does: every track level
counts, its evolution counts as five more, and a second katana (or a tempered greatsword) as five
more again. A little at
first and a great deal at the top, it:

- hits harder (up to 60% at full, 86% for a full pair of katanas or a tempered greatsword);
- stuns longer, and can stun the same creep again sooner, so a full pair of katanas keeps a
  mauler or even a goliath nearly still;
- breaks a slam: a long enough stun on a creep winding one up stops it, ring and all; and a creep
  holding someone lets go. A katana just found can't do this to a mauler; four tenths of the way
  it can, and a full katana or greatsword can to a goliath. The greatsword's stagger breaks a
  mauler's after a level or two;
- takes up to a third of every blow off you while it is in hand, and gets you up from a slam or
  a fall far sooner (up to 60% less stun);
- brings its art back sooner: a full katana's Flash Draw in under a second, a full greatsword's
  Skyfall in about one;
- for the greatsword, widens its shockwave to 5 tiles and makes it hit and stun far harder, and
  turns its push into a pull: a mastered blow drags the crowd into the crater for the next one;
  and lands Skyfall over 4.4 tiles.

With a legendary or the crowbar in hand, **F is its weapon art** in place of the dash (with any
other weapon F is still the dash):

- **Flash Draw** (katana): a breath with the blade sheathed, then one drawn cut that carries you
  up to 7 tiles to the cursor, through every creep on the way: triple damage and heavy bleed.
  Nothing stuns or grabs you while you draw it, so it is the way out of a slam's ring or a
  mauler's reach. 6 s to come back, less with mastery.
- **Skyfall** (greatsword): leap to the cursor, untouchable in the air, and come down on
  everything within 3 tiles, stunning and throwing it back. 9 s to come back, less with mastery.
- **Home Run** (crowbar): wind the bar back over your shoulder, then one swing with everything
  behind it, 3.2 tiles round in front of you: triple damage, a long stun, and what it hits is
  hurled tiles away. You don't move. 7 s to come back.

Once a legendary's (or the crowbar's) four tracks add up to 12 levels, the armory offers it two
evolutions, as a turret has; you pick one, for 1500 gold:

| blade | evolution | what it does |
|---|---|---|
| Katana | Crimson Fang | bleed builds 60% faster; each burst heals you and spatters bleed onto the creeps round it |
| Katana | Moonlit Edge | every swing looses a crescent 5.5 tiles out through six creeps; Flash Draw reaches 3 tiles further |
| Greatsword | Ashen Colossus | every hit sets its creep burning, follow-throughs leave the ground on fire, Skyfall lands in a ring of flame |
| Greatsword | Stormbreaker | every swing throws lightning on to three more creeps; Skyfall calls a thunderbolt down, wider and stunning longer |
| Crowbar | Bonebreaker | every hit stuns twice as long and knocks its creep back; Home Run swings all the way round you |
| Crowbar | Scrap King | every kill with the bar pays half its bounty again and heals you 4%; Home Run comes back 3 s sooner |

A greatsword with every track full and an evolution can take one more thing at the armory,
**Worldbreaker** (3000 gold, once): its ultimate's cracked ground no longer just closes, it goes
off in a shockwave 10 tiles round the blade, and every creep the shockwave catches carries a Tesla
charge that leaps on from creep to creep, 5 times. With Stormbreaker they leap 7 times and hit
harder, 9 times while you stand within 5 tiles of a Tesla coil (anyone's); with Ashen Colossus
every creep a charge strikes is set burning.

### Blades games

A host can pick the blades mode (`td host --mode blades`, or `m` on Host a game in the
launcher): no guns at all. When you join you choose your blade, the crowbar, the katana or the
greatsword (1, 2 and 3 pick too); until you do you hold the crowbar. The armory sells no gun and
no loot gives one; the gas station's counter always has a legendary blade you can take, and the
shrines and the plane are as ever. The crowbar is the plain choice, but it evolves too.

### Bots

A host can bring up to three bots (`td host --bots 2`; `td --bots 2` and `td serve --bots 2`
too). They join as `bot-1`, `bot-2` and `bot-3` once the first person is in, and play as the
playtests' bots do: they shop; build frost towers beside the way the creeps come in and missile
batteries behind them (never walls), and spend what is left upgrading and evolving those; fight;
go exploring for loot and new ground with free time in a break or once a wave is down to its
last few creeps; revive whoever is down near them, sticking at it until they are up; and get to
the Huey. They ready up as soon as everyone else has, never ping, pause or
restart, and count as players: the waves grow with them, and they take their share of the gold.

Pressing E again, or clicking revive twice, during a revive carries on with it rather than
starting it over, and a second quick E there never sends you off looting.

## Turrets

Six turrets, from the build bar (B, then the number):

| | | |
|---|---|---|
| Gun turret (3) | 120 | fast single shots at the nearest creep |
| Cannon (4) | 240 | slow, heavy shells that burst on a crowd |
| Frost tower (5) | 180 | pulses cold round itself, slowing everything in reach by nearly half; it barely hurts, but whatever else covers its reach gets twice as long at them |
| Tesla coil (6) | 280 | lightning that jumps from creep to creep, three at a time to start; the more of them bunched together, the better |
| Sniper tower (7) | 380 | a heavy round every few seconds from far off, at the toughest creep it can see, tearing out a share of its health besides, armour and all: the bigger the creep the harder it hits, so it is the boss killer. Its watchtower stands over every other turret, with a huge rifle that kicks back hard and blasts out of its brake on every shot, and a red laser sight on it rests on its mark |
| Missile battery (8) | 420 | a salvo of rockets, each at a different creep, with a wide blast; they come down where the creep stood, give or take a tile or so, so they wreck a crowd and waste themselves on a lone or a quick one |

A turret goes up the way a weapon does: four tracks, damage, fire rate, range and a special,
each to level 5, bought one at a time from the buttons on its card (select it, or T to step
through your turrets). The special is the turret's own: pierce for the gun and the sniper, blast
radius for the cannon, a deeper slow for frost (up to three quarters of a creep's pace), two more jumps and a longer reach for the tesla
coil, one more missile for the battery. Each button shows what the next level changes and costs;
the coloured pips on the turret's side show its levels, a column per track. Every upgrade also
gives the turret a little more health. Selling returns half of everything that went into it, less for a damaged one, to whoever
sells it: anyone can sell anything but the generator and the armory, a teammate's too, and the
team is told. To sell, press Delete twice on the selected structure (the first press
says what it will fetch), or use Sell on its card. Repairing costs gold by the hit point, never more
than half of what went into the structure for a full mend, so it is always cheaper than selling
and building again.

### Traps

Traps line a maze. Each is three by three and lies flat: the dead walk over them, and so do
you, and they never change the way in. Nothing breaks them, they cost nothing to keep, and they
go off by themselves; the lamps round the rim fill as one recharges and burn green when it is
ready. What a trap kills pays the team, as a turret's kill does, and a trap never draws a creep
onto you.

| | | |
|---|---|---|
| Bait pit (9) | 250 | when 4 or more creeps are within 7 tiles, drags them all into a knot at its middle and holds them there 4 seconds, then recharges for 9; no damage, so build it under a cannon, a missile battery or a tesla coil |
| Catapult pit (0) | 450 | flings up to 3 small creeps standing on it 6 to 10 tiles the way it faces (X turns it while you place it); the fall takes 35% of their health, whatever the wave and whatever their armour, and stuns them a second; again every 3 seconds |

The bait pit only pulls what has a straight walk to it: nothing comes through a wall or a gate,
and a creep that walks into one on the way stops there. Bosses can't be moved; brutes and
maulers come in slower. A creep in the knot doesn't attack. Two pits whose reach
overlaps don't fight over a creep: the first to take it keeps it.

The catapult never throws brutes, maulers or bosses, and never more than three at once. It
throws the way you placed it facing, one of eight: while its ghost is up, X turns it an eighth
of a turn, and a yellow band on the ground shows where they will come down, each within 15
degrees of the arrow. The next catapult you place faces the same way. Aim it back up the road
the way they came, into a bait pit under your guns, or anywhere else, the base included: it
throws where you point it. A throw that would come down on a wall, a building, water or off the
map falls short, on the last open ground along its line; with none past 2 tiles, that creep
stays put. It flies over walls and gates: only where it lands counts. A thrown creep can't be hit in the air, nor hurt anyone. It is the dearest thing
you can build: worth it once the waves are big, not as a first buy.

Both go up levels. A bait pit's each reach 0.75 tiles further and hold half a second longer; a
catapult's each rearm 0.4 seconds sooner and fall 5% harder.

### Evolutions and the pylon

Once the generator is at tier III, a turret whose tracks add up to 12 can evolve, once, for its
price again: its card shows the two branches when it can. Each turret has two, and each answers
a different wave: the gun's Gatling (fast) or Penetrator (ignores armour), the cannon's Mortar
(far, over walls) or Shrapnel (wide), the frost tower's Cryo (freezes) or Blizzard (wider and
deeper), the tesla's Storm conductor (harder, and stronger still in rain) or Arc web (jumps
further), the sniper's Spotter
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
moment; the shock grows with the waves, enough to kill the small ones at any wave and to dent a
brute. The base chip glows violet while it is ready.

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
field manual, a piece of kit and something rare or better. Now and then the gas station's counter
and the plane's hold have a legendary blade in them instead.

Far out in the wilds stand two shrines: overgrown courts of broken stone, pillars down their
length and a pair of gate posts at the mouth, older than the church. A blade stands in the altar
at the far end, between guttering candles. The dead keep them: a lair's guards sleep round a
champion, and more rise from the court when you walk in and again when you kneel at the altar.
The altar always gives a legendary blade you can take.

On the outskirts, far from the base, stands an old church. Press E at the bell rope inside, under
the tower, and the bell rings out over the whole map: for a minute every creep there is, the wave
on its way in, the wanderers and the guards at their sites, heads for the church. Use it to pull a
wave off the base or to empty the sites for a raid, and don't be there when they arrive. The bell
can be rung again after a couple of minutes.

Along the roads stand three hamlets: a few houses either side of the road, terraces and burnt-out
shells among them, every door to the street. They are easy pickings close together, and the dead
come down the street from both ends.

Across one road, out past the middle, the army set up a checkpoint and never left: a chicane of
concrete barriers, sandbagged posts, a command tent and their trucks. The dead in uniform still
hold it. The tent gives guns, mostly, and a medkit.

Far out lies a cemetery behind iron railings, the family crypt at the back. Rob the crypt for its
gold and something rare, and the graves open: the dead climb out all over the yard and come for
you: the first time, and again whenever the crypt is restocked.

Out past the middle is a quarantine camp: a wire fence, rows of small tents and a field hospital.
Searching the hospital patches you up and turns up kit and a medkit, but the camp's sick are often
still in the tents.

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

Gold can change hands too: hold Tab and click 50, 250 or half on a teammate's card to send them
that much of yours, from anywhere. What your turrets kill, and what dies in a fuel pump or a plane
engine you set off, pays the whole team, split evenly; what you kill yourself is yours.

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
even at a sprint, so turn and shoot. Bursters, the dead swollen to bursting with a light blinking over them,
come from wave 7: they sprint at you, and the one that reaches you stops, its light blinking
fast with a hiss, and blows up half a second later. Shoot them before they get there (shot
down, they just fall), or run the moment one lights: the blast hurts and stuns you close in, but
2.4 tiles away you're clear. The fire it leaves burns the creeps behind it. Maulers, brutes
that charge, come from wave 12. From wave 10 the bosses come.

Brutes and abominations slam the ground when you come near: a ring shows where it will land a
moment before. Get out of it, and don't fight them next to your turrets: the slam wrecks those
too. The broodmother, the other boss, fights from afar instead: she lobs sacs of bile over walls
at where you stand. Keep moving when the ring shows under you; a sac leaves a pool of acid and
a few swarmers behind, and every quarter of her life you shoot away spills a brood of them.

Maulers and the goliath, the third boss, charge, and their slams stun longest. Worse, get within
arm's reach and they reach for you: they stop and put their arms out for a moment (under half a
second) first. Step back out of reach then and their hands close on nothing, and hit them hard
enough while they reach and they flinch and drop their arms; any blow you land puts their next
reach off a moment. Stay, and you are
held up, helpless, then thrown far behind them into the crowd, and the fall hurts and stuns you.
Back on your feet after any stun you have a second and a half before another stun or a grab can
take you, so get clear while it lasts. If a teammate is caught, shoot whatever holds them: enough
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

On hard and brutal, don't all go down together: if every survivor in the game is down at once,
there is nobody left to hold the base, the generator falls and the game is over. Only the evac
is spared, where whoever is aboard still gets away.

## Weather

The weather changes between waves and is the same for everyone. Fog shortens everyone's range
and hides teammates from the map and their health bars, rain dampens fire and slows creeps a
little, a storm throws lightning at creeps out in the open, and snow slows everything down.
Wet weather is mostly light, a drizzle or a passing thunder shower, and snow mostly a thin
fall. Fog, heavy rain, full storms and heavy snow are rare.

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
| Crowbar (brutal, blades) | Berserk: 8 s of double swings that heal you and can't be slowed or stunned |
| Katana | Crimson Tempest: 8 s of cutting half again as fast, every swing a sweep of blood 4.5 tiles out through up to eight creeps, bleed building twice as fast |
| Greatsword | Worldsplitter: raise the blade 0.8 s, untouchable, then slam it into the ground where you stand: a shockwave 7 tiles every way, everything in it taking five swings' worth and a quarter of its health (a boss 8%), a little less at the edge, sundered to the full, stunned, and thrown back if it lives (a boss stands firm); the ground 4 tiles round the blade stays cracked and erupts every half second for 4 s, holding what walks back onto it. Nothing slows, stuns or grabs you till it closes. With Worldbreaker it ends in a wider shockwave and leaping charges |

No ultimate spends ammo while it runs.

## Abilities

Grenade (Shift), dash (F) and airstrike (V) are bought and levelled at the armory. Shift aims the
grenade: its range rings your hero and its blast follows the cursor (grey out of range), a
left-click throws it, and Esc, a right-click or Shift again puts it away. It works with the build
bar open too; while placing or pinging, a tap of Shift aims it and Shift held through a click keeps
placing. Dash and airstrike cast
at the cursor the moment you press the key; point at the ground. A small reticle lies on the
ground under the cursor wherever it points on the map, drawn over creeps and roofs, so you can
see the spot a dash, a weapon art or an airstrike will go. It is there only once you have one
of those: the dash or the airstrike bought, the crowbar or a legendary blade in hand, or a
weapon whose ultimate is aimed at a point (the rocket launcher's Cluster MIRV). The menu (F10) turns it off or makes it
bigger or smaller (`RETICLE` and `RETICLE_SIZE`). The grenade goes to level 5, each
level hitting harder (120 damage at the first, 400 at the fifth), throwing wider and coming back
sooner; from level 4 it leaves a fire burning where it lands. After wave 10 the grenade and the
airstrike hit harder as the creeps get tougher. Dash and airstrike go to level 3. With a
legendary blade or the crowbar in hand, F is its weapon art instead of the dash, and needs no
buying.

## Waves

Creeps walk to the generator round every wall, however long the way round, as long as there is
one: open a gate and build a maze outside it, and they walk the maze under your turrets' guns.
Only a base sealed tight gets broken into, where the walls are weakest. The base starts sealed,
its gates shut, except on brutal, where it starts with no walls or gates. The waves grow every time, faster the longer
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
