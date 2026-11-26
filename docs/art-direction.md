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
  (default).
- **Grade** (`scene/retro.ts`): nearly none, since colours are painted from the palette and lit
  to show as painted: saturation at 0.95, blue taken out of the darks (to 0.88 at black), a
  vignette of 16% in the very corners, 40 levels a channel behind unpatterned noise. Dusk and
  rain multiply by a cold `(0.5, 0.6, 0.86)`, up to half way; the sun, sky and fill dim and
  cool with them from the daylight values (default).
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
- **The base's yard** is old concrete in warm greys (`#5e5643` to `#7d725a`), stained, with
  short cracks and dirt drifted over it in patches: the yard of a camp, not a floor of tiles.
  House floors take the same.
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
