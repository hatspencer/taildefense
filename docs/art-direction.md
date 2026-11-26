# Art direction

The look of the game follows one picture, `docs/artdirection.png`: four survivors (paramedic,
mechanic, hunter, hiker) above five of the dead (walker, crawler, grabber, a brute in hi-vis and
a hard hat, a runner) on dry grass. Read the picture before changing anything drawn; this file
says what to take from it and the numbers agreed so far. A choice not made by the owner is
marked "default".

## What the picture is

- **Pixel art of real people.** Realistic proportions, about 7 heads tall, shoulders about two
  heads wide, hands and boots a little large. No chibi, no blocky toy figures. A figure reads by
  its silhouette and its kit first: cap, backpack, belt pouches, knee pads, a tool or gun in the
  hands.
- **A three-quarter view from above**, the camera about 40° above the horizon, nearly
  orthographic. A figure shows its front and one side, the top of its head, shoulders and pack.
- **One warm low sun** from the upper right of the screen. Every figure throws a long, soft-edged,
  dark olive shadow to the lower left, about as long as the figure is tall. Lit sides are warm,
  shaded sides fall to a dark olive brown, never to grey or black.
- **Outlines** are a darker shade of what they outline, near black only in the deepest folds.
  Inside a figure, creases and overlaps (strap over shirt, pouch over belt) get the same line.
- **Dry, mottled ground**: olive and ochre in patches of a few pixels, like dabs of paint, with
  darker damp patches, a few green tufts of grass, small stones and bare dirt. No tile grid shows.
- **Muted, earthy colour with a few true accents.** Clothes are worn and stained; the accents are
  small and saturated: a red medkit and cross, an orange cap, a yellow hard hat and pack, hi-vis
  orange with pale bands, a teal shirt, a purple one.
- **The dead** are the same people gone wrong: grey-green and ashen skin blotched dark red, torn
  and bloodied clothes (a white shirt with red hands on it), bare feet on some, hunched spines,
  arms hanging or reaching, heads forward. Each kind has its own posture: the walker stoops and
  drags, the crawler is on all fours, the grabber leans in with both arms out, the brute is a
  head taller and wide, the runner is thin and bent forward mid-stride.
- **Detail at the pixel**: a cross on a cap and a sleeve, pocket flaps, a belt buckle, boot
  soles, rolled sleeves, a rifle's wood and steel, a plaid lining. One or two pixels each; many
  of them.

## Palette (sampled from the picture)

| | hex |
|---|---|
| ground, lit | `#62552c` `#5e512a` `#574d29` |
| ground, dark patch | `#4d4325` `#453824` |
| grass tuft | `#5b5f3e` `#6c7a3a` |
| cast shadow on ground | `#342d1a` `#272315` |
| outline, deepest dark | `#18150f` `#1c1812` |
| skin, lit and shaded | `#b48f67` `#8a6a48` `#5e4630` |
| dead skin | `#a1845c` `#898c66` `#6c5d40`, blotches `#62381e` |
| denim | `#3a4450` `#26291e` |
| leather, boots | `#4e3621` `#62381e` |
| webbing, canvas | `#5b5f3e` `#766038` |
| accents | medkit red `#a8321e`, cap orange `#c8642a`, hard hat yellow `#d8a82a`, pack yellow `#ab8344`, teal `#2f7a66`, purple `#5a3e62`, hi-vis `#d0642a` with bands `#c8c2a0` |

The player's colour stays on the main garment (teams read by colour), but muted to sit in this
palette: about 55% saturation and worn, not a flat primary (default).

## How the client gets there

The world stays 3D and the camera still turns; the picture is reached by how it is drawn. What
is settled, with the file that holds it; "default" marks a choice the owner has not made.

- **Size on screen** (`world.ts` `autoPixel`, `camera.ts` `restDist`): a standing survivor is
  about 40 scene pixels tall at the default zoom (the picture's figures are about 45). A scene
  pixel is 2 screen pixels up to a 1250 px high window, then `round(height / 500)`: 2 at 800,
  1080 and 1200, 3 at 1440, 4 at 2160, so the scene is 400 to 650 pixels high. The default zoom
  goes by that count, so the figure is 40 pixels on any window and a bigger window shows more
  of the world: the ground in view is about 23 tiles wide and 21 deep on a 1280×800 window,
  34 by 29 at 1080p (it was 46 by 32 at any size) (default).
- **Camera** (`camera.ts`): 42° above the horizon (`TILT`) through a 12° lens (`FOV`), close to
  orthographic: the top of the screen is drawn at 0.8 of the scale of the bottom (it was 55°
  through 42°, and 0.58). A wall hides 1.1 times its height of ground behind it. Distances everywhere else
  (`rig.dist`, `#cam=`, `&dist=`, the zoom limits 12 to 75) still mean what a 42° lens would
  need for the same view; the real camera stands 3.65 times further (`LENS`), which only the
  fog, the far plane and the creeps' far model have to know (default).
- **Sun** (`world.ts`): one directional light 52° high, standing 28° round from the screen's
  right towards its top, so shadows fall to the lower left, about as long on screen as the
  figure is tall. It **turns with the camera**: the light and the shadows are the picture's
  from every side, and a model looked at from behind in the lab is lit as it is from the front.
  The cost is that shadows swing while the view is being turned (default). A weak second light
  from the camera's left, with no shadow, separates the side facing the camera from the side
  turned from the sun. In linear light on level ground the sun gives 0.75 and sky and fill
  0.27: a palette colour in the sun shows as painted, a touch warm, and its cast shadow at
  0.55 of it, a little bluer (`#5e512a` to `#342d1a`). A wall's side gets about 0.95 facing
  the sun, 0.4 facing the camera, 0.3 turned away. The shadow map is 2048 over 2.3 times the
  view's distance, 32 to 43 texels a tile at the default zoom against 28 scene pixels.
- **Painted light** (`scene/paint.ts`): `painted(material)` steps a lit material's diffuse
  light in three (none, 0.55, full; full within about 60° of the light), so a round limb has a
  lit side and a shaded side, not a gradient. The shared `litMaterial` (structures, survivors),
  the creeps and the ground use it; every new lit material should (default).
- **Lines** (`scene/retro.ts`): drawn after the scene, from depth and normals, one scene pixel
  wide. A silhouette's line lies outside the figure, on what is behind it, in the figure's own
  colour at 0.24 towards the ink `#18150f`; so it does not eat a 40-pixel figure's limbs.
  Where one part overlaps another (an arm over the chest, a strap that stands 4 cm or more
  proud of a shirt) the same line at 0.46; where a surface turns (a box's edge) its own colour
  at 0.74. So a model gets its creases by giving parts real depth, not by painting lines
  (default). A line goes into the haze with what it outlines: the fog node (`scene/fow.ts`)
  writes how far a surface is into the distance and weather haze to the normal target's alpha,
  and a line is mixed towards its fill by that much, so in fog a building fades whole instead
  of leaving its outline drawn on the fog colour.
- **Grade** (`scene/retro.ts`): nearly none, since colours are painted from the palette and lit
  to show as painted: saturation at 0.95, blue taken out of the darks (to 0.88 at black), a
  vignette of 16% in the very corners, 40 levels a channel behind unpatterned noise. Dusk and
  rain multiply by a cold `(0.5, 0.6, 0.86)`, up to half way; the sun, sky and fill dim and
  cool with them from the daylight values. The dusk sun is a pale warm `#f2d6b8`, not orange,
  and the generator's lamp a small pale pool (12, reaching 11 m), so the wave's ground stays
  the olive and ochre of the picture, darker, with its mottle (it went a flat rust under an
  orange sun and a lamp pool that read as a vignette). The low-health warning is the HUD's red
  edge only (`.hurt` in `web/app.css`), never a tint over the scene (default).
- **Palette** (`scene/palette.ts`): the table above as `PAL`, with `darker`, `lighter`, `blend`,
  `stained`, and `mute`/`garment` for a player's colour. Models take their colours from it.
- **Ground**: the terrain's grass is the picture's lit ground, `#5e532a`, and the ground's
  colours are no longer multiplied in twice (which was most of the old gloom). Its patches,
  tufts and props are still the old ones.
- **Models** are built in code from parts on the shared 12-joint skeleton (`web/src/scene/rig.ts`),
  realistic in proportion, with the kit that makes each one readable. A horde still draws in one
  call per kind, so a creep's detail is paid in vertices: see the budgets in
  `.claude/agents/model-builder.md`.
- **Everything else** (walls, turrets, the generator, wrecks, ruins, trees, loot) is drawn to
  stand beside those figures: real proportions against a 1.8 m person, worn materials, the same
  palette, small true accents.

## Checking a look

`tools/shot.py '<hash>' screenshots/<name>.png` takes screenshots of the built client from a
headless Chrome (see `docs/development.md`, which also lists the lab's parameters). `#lab=art`
lays the survivors and the dead out as the picture does, at its camera and on plain ground, to
hold beside it; `&fig=N` looks at one of them, `#lab=hN&still&plain&nohud&arch=A` at any
survivor archetype at rest and `#lab=kN&still&plain&nohud` at any creep kind, `&yaw=` from
the side and the back.

## The HUD and menus

The HUD is field kit, not a terminal (`web/app.css`, `web/menus.css`, the splash's palette in
`web/src/hud/splash.ts`). Panels are worn olive-brown canvas (`--soot` `#2a2615`, the ground's
`#62552c` for edges), labels are kraft-paper tape (`#b4905a`), all text is the pale band colour
`#c8c2a0`, outlines are the ink `#18150f`. Accents keep one job each: hard-hat yellow for
readouts and what can be spent, medkit red for danger, teal for state (stamina, reload), grass
green for health. No gradients, glows or blurred shadows; bars are chunky segmented pixels.
The bottom console is only as tall as its content and no longer has a backdrop, the top bar is
32 px, and the map, console and orders card are separate pieces so the world shows between
them (default).

## The base's structures

Built from what a camp would have dragged in, at true size against a 1.8 m person
(`scene/structs.ts`, `#lab=structs` to look at them; default throughout):

- **Walls** are a palisade of sharpened logs on a low dirt berm, wired to split rails behind,
  a thick post on each tile and half a run of logs towards each neighbour, so runs and corners
  join by themselves. One half-run in five carries a sheet of rusted corrugated iron and one run
  in nine a faded blue car door wired across it: three instanced arm meshes, chosen by a hash of
  the tile, about 150 to 400 triangles a tile. **Gates** are welded scrap, a steel post with an
  amber lamp on a concrete foot and leaves of square tube, plate, bars and a hazard-striped top
  rail on a caster; lower than the logs, so a gate reads as a gap in the palisade.
- **Turrets** are real guns on real mounts: a heavy machine gun on a tripod in a sandbag ring
  (gun), a small wheeled field gun with its shield on a plank turntable (cannon), nitrogen
  dewars and a reefer unit feeding a turning sprinkler head (frost), a home-made coil on an
  insulator stack fed by car batteries (tesla), a timber watchtower with the AWM (sniper), two
  helicopter rocket pods on a pedestal welded to a truck wheel (missile), a guyed scaffold mast
  with a turning yagi (pylon). Each about 450 to 1050 triangles (the sniper 1700 with its
  rifle). Their muzzles stand where `main.ts`'s `turretHeight` and the effects put the flash.
- **The generator** is a diesel generator set in a faded yellow canopy on a skid and a cracked
  slab, its fan turning under a roof grille, with fuel drums, red cans, a cable reel and a work
  light; the old reactor's glow is gone, and its one light is a small running lamp on the
  control panel, green while it holds and flickering red as it fails. Tier II adds a radio mast
  on a scaffold tower, tier III floodlights at the corners. About 2100 triangles.
- **The armory** is a rust-red ten-foot container with a hatch cut in its front, a rack of
  rifles inside, a workbench, ammo crates and a solar panel and tarp on the roof. About 1500.
- **Turrets are drawn bigger than their tile**: the kit grows by 1.25 to 1.35 (`GROW` in
  `structs.ts`) while the pallet, platform or sandbags it stands on keep their size, so a turret
  stands chest to head high among the survivors and still sits inside its tile. The sniper's
  tower is tall enough already. The sim's footprint is unchanged; the effects' muzzle heights
  grow with them (`turretDrawnY`).
- **The generator's slab** is worn concrete the colour of the dust round it (`#665839`),
  mottled with darker and paler patches, oil stains and drifted dirt, its edge sunk in dirt.
- The owner's colour stays as a line of paint on the ground round each footprint, flush and
  worn: half the ground's colour and darkened, so a pale player colour is no white selection
  box. The track pips stay.

## The Huey and the traps

- **The Huey** (`scene/heli.ts`) is a UH-1 at its true size: 12.8 m from nose to fin, the rotor
  14.6 m across with its hub 4 m up, skids 2.6 m apart, so it stands over a survivor as a real
  one would and overhangs the 6-tile helipad (it was drawn at 0.75 of a smaller size). The hull
  is lofted through cross-sections, so the nose is round and the cabin has a real open doorway
  with a floor, jambs and the dark behind it, not boxes. Worn olive drab, faded on top and grimy
  underneath, soot behind the exhaust, a faded U.S. ARMY and tail number in stencil blocks; the
  accents are the tail rotor's red and white tips, the yellow rotor tips, the red troop seat in
  the doorway, the gunner's headband and the surfboards. About 2 970 triangles with the gunner
  and his gun (budget 3 000) (default).
- **The main rotor is drawn as a blur, not blades** (default): at its speed a blade moves
  several metres between frames, so solid blades would stutter round as two black bars across
  whatever is under them. A faint disc, the yellow tips' thin ring, and each blade as a smear
  in three stepped layers, darkest at its leading edge, turn over the solid hub, blade roots and
  stabilizer bar, which throw the shadow. The tail rotor, small, keeps solid blades over a disc.
- **The crate** comes in on a 3 m sling under the belly, then down under an olive and white
  chute; the helipad is square concrete slabs a shade each, oil stains, a worn ring and H.
- **The traps** (`scene/traps.ts`): the bait pit is dug earth, spoil heaped round its rim with
  two sandbags, the floor wet and dark, four rough posts hanging haunches on chains; the
  catapult pit is a plank-lined pit edged in steel angle with yellow corner pegs, a banded timber
  arm, truck coil springs and a cut-down rusted drum for a bucket, the arrow sprayed on. The
  charge lamps are small bulbs. About 600 and 480 triangles (default).

## Effects, overlays, labels and weather

Effects are drawn in the scene's own pixels, in the palette, as things rather than light.

- **Coverage is dithered, never blended.** Effects, overlays and the fog-of-war edge cut
  their coverage against a 4x4 ordered dither (`scene/dither.ts`, alpha test at 0.5), so a
  thin puff is a sparse pattern of whole pixels, not a see-through smear. There is no additive
  blending; effects write no normal, so the outline pass leaves them alone. Colours go through
  `tame()`: saturation pulled to 0.78 and 6% of the canvas tone over them.
- **Gunfire**: a muzzle flash of two or three frames (a pale diamond, an orange one, a short
  tongue) and a wisp of smoke; short pale tracers; brass casings kicked out to the right; dust
  and a chip where a shot lands.
- **Gore**: dark blood (`#5a1810` and its neighbours; bile is olive) as specks that fall and a
  spatter on the ground that stays and dries away in patches.
- **Explosions**: a short ball of flash, rising tongues of fire stepped pale, orange and ember,
  black smoke, debris, a ring of dust and a scorch mark. Smoke is solid inside with a dithered
  rim, lit a step brighter on its sun side.
- **Domes and auras** (taunt, frost, overload...) are sparse dithered shells, not glowing
  bubbles.
- **Overlays** (`scene/overlays.ts`): one-pixel lines with a dark underline, dashed for range
  rings, area previews and footprints (crawling where something is about to happen), solid for
  the selection; bone `#d8cca0` for fine, `#c8402a` for not. Ghosts are dithered.
- **Labels and bars** (`hud/labels.ts`): a 3x5 pixel font and bars two scene pixels high in a
  one-pixel ink edge, snapped to the scene pixel grid, just over the head; names in the
  player's colour, tamed. A name the font cannot set falls back to the HUD face.
- **Weather**: rain is short streaks of a dim wet grey (a few scene pixels long, under a
  third covered), never the brightest marks on screen, and a storm is more of them, not a
  curtain; snow small bone flakes. Snow settles at most about half way over the ground's own
  colour, unevenly, so its mottle and palette still show, and only lightly brightens the sky's
  bounce. Rotor wash is the ground stirred up, a step off its colour (foliage dark over a
  forest), never pale stipple punched in the canopy. The haze gathers past
  the survivor's sight and in noise banks that drift with the wind (`scene/fow.ts`), instead of
  a wash by distance from the camera, which the long lens made even over the whole view.
- **Fog of war**: its edge is cut against a dither laid on the ground in cells of about two
  scene pixels (it stays put as the view moves); out of sight goes to a dark olive, not grey.

## Survivors

A survivor is a real person, 1.8 m tall and seven heads high, with shoulders two heads wide and
hands and boots a little large so they read at game zoom. The head is drawn 1.08 times true
size about the neck, for the face's sake. The body is built in metres in `figure()`
(`web/src/scene/heroes.ts`) from many small tapered boxes hung on the same joints the poses
use, so every animation and hold still fits it; `K` turns metres into the group's units.

- **Archetypes** (`web/src/scene/look.ts`) are the picture's people: the paramedic (collar shirt,
  cap with a cross, medic belt, daypack, knee pads), the mechanic (white tee under overalls,
  tool belt), the hunter (jacket over plaid, beanie, rucksack, scarf), the student (hoodie,
  beanie, a big yellow pack), then the builder (hi-vis vest, hard hat), the nurse (scrubs,
  scrub cap, stethoscope), the biker (leather vest, bandana, chain), the farmer (denim
  overalls, straw hat, wellies), the ex-soldier (plate carrier, helmet, assault pack, cargo
  trousers) and the office worker (shirt, tie, satchel).
- **Detail** is in many parts rather than texture: collars, rolled sleeves, belts with
  buckles, pockets, straps, boot soles, a brow shadow and a nose, eyes no bigger than a pixel.
  Every colour is muted from `PAL`; the player's colour stays on the main garment through
  `garment()`.
- **Held weapons** are at true size, in wood and steel with a sling or magazine where the real
  thing has one (`gunParts`). The held AWM is 1.2 m long.
- **Budget**: at most 2500 triangles per survivor with the held weapon; they come to about
  1500-2200.
- **Portraits** use the same figure from the chest up, with the face placed from `FACE`.

## The ground and what grows on it

`web/src/scene/terrain.ts`; the lab's `&plain` stage (`stage.ts`) is the same open ground.

- **One painted surface, no grid.** The ground mesh carries heights only; its colour is made in
  the shader from world position, so it stays put as the camera moves and turns. Four layers
  of one tiling noise texture (one fetch each): zones of about 14 m (greener, rustier, damper),
  patches of about 2 m, dabs of about 12 cm and flecks of 5 cm. Each dab is cut to one flat
  colour from the palette's ground values (`#4c4224` `#5a4e29` `#63552c` `#6d5c30`), with
  olive-green, rust and damp dabs over them, a pixel of green blade or pebble here and there
  (default).
- **Kinds of ground** come from a texture of the tiles (road, the base's yard, dry ground, damp
  forest floor and lake shore), read through a warp of about a metre and cut with dab noise, so
  the border between grass and road wanders and breaks into dabs instead of following tiles.
  Roads are trodden brown dirt with stones; dry ground paler ochre; the forest floor darker;
  shores mud.
- **The base's yard** is the same ground trodden bare, in the same palette: the lit ground
  (`#5e512a` `#62552c`) with darker scuffs (`#4d4325`), paler ochre where it has dried, browner
  bare dirt (`#5a4628`) where it is walked most, a rare dark crack, and no green but along its
  edge, where a straw tuft or a stone holds on (painted, and as props on the yard's edge tiles).
  It reads worn next to the grass by being flatter and browner, not by being another colour.
  House floors take the same (default).
- **The map's edge** is a forest: past the last tile the ground comes down to the world
  beyond with no step (a step drew the outline pass's black line along it), the floor there
  goes damp and dark, and a band of about 22 tiles of dark pines and broadleaves stands on it,
  thin at first and shoulder to shoulder further in, both its sides wandering by a few tiles.
  Zoomed right out, bare ground shows again past the band (default).
- **Trees** stand on tree tiles, sized against the survivors: dry pines about 2.6 to 3.6 m
  (tiers of drooping boughs, darker below, some thinning with dead stubs), broadleaves about
  2.4 to 3.3 m (a forked trunk under eleven lumps of olive), and a few dead grey ones. Crowns
  are muted olive (`#363b23` to `#606533`), each tree tinted a little greener or drier. They
  cast the sun's shadow.
- **On open ground**: knee-high bushes, grass tufts of five blades (green in grass, straw on
  dry ground), stones, and near woods fallen logs and stumps with pale cut ends. Bushes, logs
  and stumps cast shadows; tufts and stones are too small to be worth the shadow pass.
- **Ruined walls** keep their styles, their colours passed through `mute` so no paint is
  brighter than old cloth. Water is murky olive (`#29322a`, `#3b4838`) with a dull sheen.
- **Cost**: props are instanced and culled by block as before. Triangles rose about a fifth at
  the default zoom and nearly doubled zoomed right out (bigger trees with real tiers, and many
  more tufts); the ground's shader is a handful of texture fetches.

## The common dead

`web/src/scene/creeps/common.ts`: the walker, the runner, the crawler (the swarmer) and the
burster, built in the survivors' units (a person 1.33 tall, seven heads) and drawn at a
survivor's height (`CreepRig.scale`, the survivors' 1.15 and a twentieth more, as a survivor
stands 1.4 to the top of its hair), whatever their radius in the sim. Limbs are tapered prisms
between joints, five-sided (four on the burster), so a limb has a lit and a shaded side without
being a block; stains, blotches and hand prints are single-sided plates of two triangles. The
stoop, the head thrust forward and the hang of the arms are the joints' rest angles, so the
animation moves the pose they are drawn in; the crawler's pose is built in. Shirt, trousers,
skin and hair are the per-creep key colours (`creeps.ts`): mostly dirty white shirts and work
shirts, dark trousers, ashen and grey-green skin; the dark red blotches on arms and faces are
fixed. Near models 418 to 594 triangles, far ones 212 to 250: the hands, face, hems, boots and
blotches are each under a tenth of the figure's height, so `farParts` drops them (default).

## The bosses

The abomination, the broodmother and the goliath (`web/src/scene/creeps/bosses.ts`) are built in
metres against the 1.8 m survivor and set in the world by the rig's `scale`, so each stands at
its true size: big enough to read as a boss and to cover its sim radius. They are grounded body
horror made of people and what they wore, nothing that glows, dead skin from the palette,
blotched with blood, and one small true accent each.

- **Abomination**, about 3.1 m and as wide: four or five of the dead grown into one heap on two
  legs that were never the same person's. A man in a bloodied white shirt leads out of the
  front; a flannel shirt, a grey hoodie and an upside-down denim jacket (a leg in jeans kicking
  out of it) are fused into the mass; heads sunk into the shoulders; arms everywhere, two long
  ones it knuckles along on. The accent is a nurse's teal scrubs sleeve on a dead arm.
- **Broodmother**, about 2.6 m long: a woman's chest and head rising out of the front of a belly
  swollen to the ground and a back swollen behind it, the brood pressing out under the skin (a
  hand, a face, a knee), on all fours on her own thin limbs. Her dress, burst down the back, is
  stretched in strips over the swell; its faded plum is her accent.
- **Goliath**, about 4.8 m, near three survivors: a giant man still in his work clothes, a
  welder's leather apron and gauntlet, a rigger's harness, work trousers and steel-toed boots,
  stitched where he split, a chain wound round his right fist and dragging, the welding hood
  pushed up on his head with a yellow sticker on it, his accent.

Each keeps under 1600 triangles near and 250 far: the big shapes are open-ended prisms and a
lump or two, and anything long and thin that is not silhouette (veins, straps, a dead arm) is
made of short pieces, so the far model drops it.

## How the dead move

The common dead and the bosses are animated in their joint tables (`common.ts`, `bosses.ts`)
and the shared shader (`creeps.ts`); the picture's postures are the rest poses, and the motion
keeps them broken rather than square:

- **Never a straight limb or a square pose.** Every elbow and knee rests bent; a joint's `tilt`
  holds it off true (a listing spine, a head hung to one side, an elbow turned out) and lolls it
  slowly, each joint out of step with the next; the right side gets its own rest angles where a
  mirrored twin would stand too even.
- **Gaits** match each rig's `stride` so the planted foot does not skate: the walker steps with
  its left and drags its stiff, turned-out right, lurching over the good leg, one arm hanging
  loose and swinging late, the other half raised with the elbow bent; the runner sprints bent
  double, heels kicked up, the arms pumping with the claws hooked; the crawler goes hand and
  opposite knee together, the reaching hand lifting; the burster waddles on wide legs, the
  belly rolling after the hips; the abomination heaves on a leg and the opposite knuckled arm,
  its extra arms groping out of time; the broodmother walks like a beast, the elbows out like
  a crab's and the belly and back swinging after her steps; the goliath treads slowly, sinking
  into each step, the chained arm swinging less than the other.
- **Blows** wind up the other way first (an optional `crouch` sinks the pelvis) and land fast,
  the body carried forward (`lunge`); the burster swells, arms flung wide.
- **Deaths crumple** (default): the knees give and the body folds over 0.3 s, then it tips over
  (accelerating, as a fall does) about an edge ahead of the feet (`edge`), letting go of most
  of the fold, the arms less, and sinks (`lie`) to lie on the ground. A rig with `fall` 0 (the
  crawler, the broodmother) collapses flat where it is, its limbs giving.

## The heavy and special dead

The brute, mauler, hound, spitter and hurler (`web/src/scene/creeps/heavy.ts`) are built on the
same footing as the common dead, so all the dead read as one family: in the survivors' units (an
ordinary man 1.33 tall, seven heads, the walker's frame), limbs and trunks as tapered prisms
between joint points, the same head (the walker's, a seventh of the height, a little less on
the brute), bands, stains and blotches as plates lying on the prisms' faces. `scale` stands an
ordinary man at a survivor's 1.8 in the world. The stoop, the reach, the hang of the arms and
the bend of the knees are the joints' rest angles, so the gait moves the pose they are drawn in.
Their key colours (shirt, trousers, skin, hair) vary per creep; their kit is painted and fixed.

- **Spitter**: the picture's grabber, an ordinary man of a survivor's build leaning in with both
  arms out, elbows bent and hands drooping, one arm higher than the other, one foot ahead; a
  torn bloodied shirt and dark trousers, the throat swollen into a sac under a dropped jaw, a
  yellow-green run down the shirt from the mouth.
- **Brute**: the picture's: about 2.05 m, a head taller and broad, but a man's head on a bull
  neck, sloped shoulders, long arms hanging forward with the elbows out, real legs with the
  knees soft; the trunk is the hi-vis vest itself, open down the middle on the blue-grey work
  shirt, pale bands up each front and round the belly, the sleeves rolled, a yellow hard hat
  sitting up on the crown so the face shows under the brim. He lumbers: the body dips on each
  footfall and rolls over the standing leg, the shoulders counter the hips, and both fists come
  down together.
- **Mauler**: a slaughterman, a different shape from the brute: a barrel of a belly, hunched,
  bald and bull-necked with the head sunk forward, a long pale rubber apron bloodied to the
  knee, bare thick arms, wellingtons, a cleaver in the right fist. He charges low.
- **Hound**: a big dead dog, 0.75 m at the shoulder: a deep chest and tucked waist in prisms, a
  tan coat with a dark saddle (the instance's hair) worn through to ribs and raw skin, the head
  carried low with the lips gone from the teeth. It gallops, crouches and leaps.
- **Hurler**: tall and rangy in a torn canvas jacket open on the shirt, a swollen left shoulder
  and a long thick bare arm with a lump of concrete and rebar in the hand at the knee, the right
  arm thin in its sleeve.

Near models 330 to 580 triangles, far ones under 250: the far model keeps the trunk, limbs,
head and hat and drops the hands, boots, faces, bands and stains (default).

## The world's finds

Everything a survivor searches or picks up is in `web/src/scene/loot.ts` (sites) and
`web/src/scene/guns.ts` (dropped weapons), and `#lab=loot&plain&nohud` lines it all up, closed
above and searched below, with survivors among it for scale.

- **Scale.** Props (the fridge, the crate, the pump, the counter) are built in metres at 0.85
  units to the metre, which is the survivors' own size (a 1.8 m person is about 1.53 units). Vehicles are built in metres too, but at 0.55 units to the metre:
  the sim's solid box for each wreck (`wreckHalf` in `internal/game/wreck.go`) is about two
  thirds of a real car against a survivor, and the model has to fit the box a survivor walks
  round. So a wreck is a true-proportioned vehicle at two thirds of its size beside a person;
  growing the boxes would change play and the golden game, which is a decision for the game,
  not the art. The motorbike, whose box is small, gets 0.7 units to the metre, nearer its true
  size, upright on its side stand. The plane, its engine, the church and the shrine's altar are
  built in tiles, at the size their walls take on the map.
- **What makes them read.** Wheels sit in cut arches, with glass, door seams, handles, mirrors,
  lights and bumpers as real steps in depth (about 4 cm or more), so the outline pass draws them.
  Paint is one faded body colour per car, picked per instance from a dusty list; a company
  colour is the only bright thing on a vehicle: the cruiser's light bar, the ambulance's red
  band, the bus's yellow, the armoured van's teal stripe.
- **Searched.** The open model swings doors, bonnets, boots, lids and fridge doors on their
  hinges, empties what was inside onto the ground, and is drawn at 0.72 of its colour with no
  glint. The glint sits 0.4 over the closed model's top, measured from its geometry.
- **Cost.** Each kind and state is one instanced mesh in one material, so the finds cost at most
  one draw per kind and state on screen, plus one for the glints and one for the station's
  canopy. Closed / open triangles: house 276/308, car 1036/1168, crate 432/420, pickup
  1072/1064, cruiser 1072/1216, ambulance 1004/1112, bus 1056/1116, army truck 1352/1464, counter
  396/300, pump 364/196, fire engine 1492/1840, armoured van 1056/1128, camper 1066/1138,
  motorbike 532/568, plane 1564/1576, engine 232/88, church 1844/1812, shrine 656/468.
- **Not here.** The ruins' walls and the shrine's court are `web/src/scene/terrain.ts` (the
  shrine's plan is shared from `shrine.ts`); the airdropped crate on its way down and the Huey
  are the helicopter's and the effects'. A dropped weapon is the model the survivor carries
  (`gunParts` in `heroes.ts`), lying on its side on the ground, drawn at 1.3 where the hand holds it at 1.15.
