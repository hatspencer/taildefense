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

## How the client gets there (defaults)

- The world stays 3D and the camera still turns; the picture is reached by how it is drawn:
  a small render target shown with nearest filtering, banded light, outlines from depth and
  normals, a grade to the palette above, and long sun shadows.
- **Size on screen:** a standing survivor is about 40 scene pixels tall at the default zoom
  (the picture's figures are about 45). That is the measure for pixel size and camera distance.
- **Light:** daylight is the picture: warm and clear, no gloom, no heavy vignette. Dusk and the
  weathers darken and cool it but keep the outlines and the palette.
- **Models** are built in code from parts on the shared 12-joint skeleton (`web/src/scene/rig.ts`),
  realistic in proportion, with the kit that makes each one readable. A horde still draws in one
  call per kind, so a creep's detail is paid in vertices: see the budgets in
  `.claude/agents/model-builder.md`.
- **Everything else** (walls, turrets, the generator, wrecks, ruins, trees, loot) is drawn to
  stand beside those figures: real proportions against a 1.8 m person, worn materials, the same
  palette, small true accents.

## Checking a look

`tools/shot.py '<hash>' screenshots/<name>.png` takes screenshots of the built client from a
headless Chrome (see `docs/development.md`). `#lab=art` lays the survivors and the dead out as
the picture does, at its camera, to hold beside it.
