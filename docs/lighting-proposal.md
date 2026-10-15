# Proposal: gun flashes that pop in the dark and in fog

Branch `lighting-proposal`. Step A is prototyped there (`web/src/scene/glow.ts`); the rest is
the plan. Screenshots in `screenshots/lighting-before-*` and `screenshots/lighting-proto2-*`.

## Why flashes are flat now

1. **The haze erases the light a shot throws.** The muzzle `PointLight`s light the ground, and
   then the fog node (`fow.ts`) mixes every lit pixel towards one flat fog colour past about
   half your sight. In fog your sight is 0.4 × 12 tiles, so beyond about 3 tiles any light pool
   is painted over with grey. A teammate's SMG across the base lights nothing you can see.
2. **The air never lights up.** The fog colour is a constant, so nothing between the camera and
   the ground reacts to a shot. But a glow in the haze is what makes a flash read in fog.
3. **Few, small and short lights.** 4 pooled lights, 7 m reach, 60 ms each, skipped when the
   pool is busy, and none at all while `dark < 0.1`. Fog only counts as `dark` 0.3, so in fog by
   day flashes are drawn at about 0.77× size and half brightness.
4. **The grade flattens hot pixels.** `retro.ts` desaturates everything by 26%, multiplies by the
   cold dusk tint and quantizes to 24 levels. A warm flash comes out beige-white like
   everything else bright.
5. **The gun's own flash mesh has fog on** (`heroes.ts` `flashMat`), so it is hazed out on
   teammates.

## The plan

**A. Light in the air (prototyped).** `Glow` keeps the 16 most recent flashes (muzzles,
explosions, lightning) in a uniform array. The fog node adds two terms for each flash, after
the haze and fog of war, so they show through both:
- *in-scatter*: the closed-form integral of a point light's glow along the view ray, through a
  5 m ground layer of fog, attenuated so the halo is a few metres across. Thickness comes from
  the weather: fog 0.09, rain 0.03, and a smoky 0.012 at dusk even when it's clear.
- *ground pool*: a warm falloff on surfaces near the flash, weighted by how much the haze hides
  (fog and rain only), standing in for the light three's lights gave that the haze took away.
  The sum is soft-saturated, so a minigun burst brightens towards white without washing the
  whole screen out.
It covers every lit surface (ground, walls, bushes, creeps) at no extra draw cost: one 16-step
loop in a shader that already runs. Still to do: skip the loop when both weights are 0 (clear
daylight), and measure full-resolution mode on a big screen; 8 slots would also be enough.

**B. Keep flash colour hot through the grade.** The scene pass renders to half float, so a
flash's pixels are above 1. In `retro.ts`, mask pixels whose max channel is over about 1.1 and
skip the desaturation and dusk tint for them, so the core stays white with saturated orange
round it against the cold blue dusk. That contrast in colour is most of what "pop" is. It's a
few lines and needs no new render target.

**C. A small selective bloom (optional, after B).** Additive effects write an `emissive` MRT
target. A `BloomNode` on the low-res scene target blurs only that, before the dither, so stars
and tracers get a pixel-art halo that dithers into the palette. A does this in fog; C does it
at a clear dusk. Costs one more MRT target and a mip chain at about 1/9 of screen size.

**D. Flash sprites scale with fog as well as darkness.** Star size +40% in fog (in the
prototype). Also: streak and star brightness keyed on fog, not only on `dark`; tracers stay
unfogged so they still cut through.

**E. Darker night fog, so the glow is the brightest thing.** At dusk, fog's colour lerps
towards a lighter grey (`FOG_SKY`, eased only by `1 - 0.6·night`). Keep fog at night near
`0x2a2e30` and lower the hemisphere light a little in fog, so the scene sits lower and the halos
have room above it.

**F. A light per shooter instead of per shot.** Sustained fire (SMG, minigun) currently grabs
pool slots at random, so it flickers unevenly and starves teammates. Give each survivor one
`PointLight` that flickers while they fire, and keep the 4-light pool for turrets and blasts.
The light count stays fixed (8 for 8 players), so shaders don't recompile; check the cost on
the WebGL path first.

**G. Small fixes.** `flashMat.fog = false` and a colour above 1 on the gun's flash mesh.

**H. A tuning bench.** A flash lasts 70 ms, so neither a screenshot nor the eye can judge it.
Add `#lab=flash`: one survivor per weapon firing on a loop at dusk, with `&weather=` and
`&hold` to freeze the glows. Every step above gets tuned there.

## Order and risk

A + G + H first (A is done but untuned), then B, then D/E as tuning. C and F only if A + B
aren't enough. All of this is client-side: the golden game and protocol don't change. The
halos centre on shots, which are always in team sight. Light spills into unseen ground, but
creeps there stay hidden, so the glow gives nothing away. Only tested on the WebGL 2 path
(SwiftShader, headless); WebGPU and a real GPU still to check. When it lands,
`docs/game-design.md` gets the why.
