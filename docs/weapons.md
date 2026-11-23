# Weapons

A breakdown of the six weapons the armory sells, from `internal/game/defs.go` (`Weapons`,
`WeaponStats`, `UpgradeCost`). The crowbar and the legendary blades are in `docs/playing.md`.

"Raw DPS" is damage x pellets x rate, before reloads, spread, misses, pierce and the minigun's
spin-up, so it says what a weapon can do, not what it does to a moving crowd.

## Base stats

| Weapon | Price | Damage | Rate /s | Range | Mag | Reload | Pellets | Spread | Pierce | Raw DPS |
|---|---|---|---|---|---|---|---|---|---|---|
| Pistol | free | 15 | 3 | 14 | 12 | 1.1 s | 1 | .03 | 0 | 45 |
| Shotgun | 250 | 13 | 1.3 | 10 | 6 | 1.8 s | 7 | .30 | 1 | 118 |
| SMG | 400 | 11 | 12 | 12 | 50 | 1.6 s | 1 | .09 | 0 | 132 |
| Rifle | 650 | 80 | 1.5 | 28 | 5 | 2.0 s | 1 | .01 | 3 | 120 |
| Minigun | 1400 | 9 | 22 | 16 | 150 | 3.5 s | 1 | .12 | 0 | 198 |
| Rocket launcher | 2000 | 120 | .8 | 24 | 4 | 2.6 s | 1 | .02 | blast 3 | 96 |

Spread is radians either side of the aim. The launcher's rocket explodes in a blast radius of 3
and hits everything inside it.

## Upgrades

Every weapon has four tracks, each up to level 5:

| Track | Per level |
|---|---|
| Damage | +22% of base (the pistol: +30%) |
| Fire rate | +13% of base |
| Handling | magazine +25% of base, reload -11% of base |
| Special | per weapon, below |

At level 5 handling that is a magazine 2.25x as big and a reload at 45%.

| Weapon | Special track, per level | At level 5 |
|---|---|---|
| Pistol | +1 pierce | 5 pierce |
| Shotgun | +2 pellets, longer stun, more knockback | 17 pellets |
| SMG | +1 pierce | 5 pierce |
| Rifle | +2 pierce | 13 pierce |
| Minigun | +1 pierce, +2 burn damage a second | 5 pierce, 10 burn/s |
| Rocket launcher | +.6 blast radius | 6 blast |

A shotgun load stops a creep 2.5x as long as other weapons' hits, and +.3x more per special level.
Two pistols (a second found or bought) double the rate and the magazine.

### Cost

One track's step from level L to L+1 costs `(60 + price/4) x 1.55^L`, rounded:

| Weapon | L0 to 1 | 1 to 2 | 2 to 3 | 3 to 4 | 4 to 5 | One track maxed | All four maxed |
|---|---|---|---|---|---|---|---|
| Pistol | 60 | 93 | 144 | 223 | 346 | 866 | 3,464 |
| Shotgun | 122 | 190 | 294 | 456 | 707 | 1,769 | 7,076 |
| SMG | 160 | 248 | 384 | 596 | 924 | 2,312 | 9,248 |
| Rifle | 222 | 345 | 535 | 829 | 1,284 | 3,215 | 12,860 |
| Minigun | 410 | 636 | 985 | 1,527 | 2,367 | 5,925 | 23,700 |
| Rocket launcher | 560 | 868 | 1,345 | 2,085 | 3,232 | 8,090 | 32,360 |

### Raw DPS at damage 5 and rate 5

With only those two tracks maxed (damage x2.1, rate x1.65; the pistol damage x2.5):

| Weapon | Raw DPS |
|---|---|
| Pistol | 186 |
| Shotgun | 410 |
| SMG | 457 |
| Rifle | 416 |
| Minigun | 686 |
| Rocket launcher | 333 |

## What each is for

- **Pistol**: free and the cheapest to upgrade, so it carries the early game. A pair of fully
  bought pistols is meant to keep up late (`weapon_balance_test.go`).
- **Shotgun**: the close-range crowd stopper. Seven pellets and a long stun hold things off, but
  range is 10 and the magazine is 6.
- **SMG**: steady and cheap. Full rate from the first shot.
- **Rifle**: 80 a hit at range 28 with 3 pierce, which makes it the pick for brutes, bosses and
  anything armored, and for a line of creeps. Slow to fire, small magazine.
- **Minigun**: the most damage in the game, with the biggest magazine, and the burn on its special
  track. Its barrels spin up (see below), the reload is the longest, and it costs 1400.
- **Rocket launcher**: the area weapon. Lowest single-target DPS of the six, but a blast of 3
  (6 maxed) hits a whole pack at once.

## SMG against the minigun

The minigun's barrels start at 30% of its rate, reach full rate after 2 s of firing, and spin back
down over 1.5 s of not firing, a reload included (`spinIdle`, `spinUp`, `spinDown` in
`orders.go`). Overdrive spins it up at once. So:

- Sustained, the minigun wins: 198 raw DPS to 132, three times the magazine, and burn once its
  special track is bought.
- From cold, the SMG wins the first two seconds. A minigun brought up on a creep already in your
  face fires at under a third of its rate.

`TestMinigunOutlastsTheSMGButSpinsUp` holds both.
