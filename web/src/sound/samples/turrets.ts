// Turrets, the door gun and the missile battery, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled to
// each recipe's loudest 50 ms. 'over' layers them on the recipe's synthesized tail;
// 'replace' plays them instead of it.
import { registerSamples } from '../samples';
import turretGun0 from './turrets/turretGun_0.mp3';
import turretGun1 from './turrets/turretGun_1.mp3';
import turretGun2 from './turrets/turretGun_2.mp3';
import turretGun3 from './turrets/turretGun_3.mp3';
import turretGun4 from './turrets/turretGun_4.mp3';
import turretGun5 from './turrets/turretGun_5.mp3';
import doorGun0 from './turrets/doorGun_0.mp3';
import doorGun1 from './turrets/doorGun_1.mp3';
import doorGun2 from './turrets/doorGun_2.mp3';
import doorGun3 from './turrets/doorGun_3.mp3';
import doorGun4 from './turrets/doorGun_4.mp3';
import doorGun5 from './turrets/doorGun_5.mp3';
import sniper0 from './turrets/sniper_0.mp3';
import sniper1 from './turrets/sniper_1.mp3';
import sniper2 from './turrets/sniper_2.mp3';
import sniper3 from './turrets/sniper_3.mp3';
import cannon0 from './turrets/cannon_0.mp3';
import cannon1 from './turrets/cannon_1.mp3';
import cannon2 from './turrets/cannon_2.mp3';
import cannon3 from './turrets/cannon_3.mp3';
import pod0 from './turrets/pod_0.mp3';
import pod1 from './turrets/pod_1.mp3';
import pod2 from './turrets/pod_2.mp3';
import missile0 from './turrets/missile_0.mp3';
import missile1 from './turrets/missile_1.mp3';
import missile2 from './turrets/missile_2.mp3';
import missile3 from './turrets/missile_3.mp3';
import gatling0 from './turrets/gatling_0.mp3';
import gatling1 from './turrets/gatling_1.mp3';
import gatling2 from './turrets/gatling_2.mp3';
import gatling3 from './turrets/gatling_3.mp3';
import penetrator0 from './turrets/penetrator_0.mp3';
import penetrator1 from './turrets/penetrator_1.mp3';
import penetrator2 from './turrets/penetrator_2.mp3';
import penetrator3 from './turrets/penetrator_3.mp3';
import antiMat0 from './turrets/antiMat_0.mp3';
import antiMat1 from './turrets/antiMat_1.mp3';
import antiMat2 from './turrets/antiMat_2.mp3';

// The gun turret: an SKS, single shots.
registerSamples('turretGun', { files: [turretGun0, turretGun1, turretGun2, turretGun3, turretGun4, turretGun5], gain: 0.75, mode: 'over', jitter: 0.04 });
// The Huey's door gun: a .300 Blackout and an AK-47, single shots (not the minigun's takes).
registerSamples('doorGun', { files: [doorGun0, doorGun1, doorGun2, doorGun3, doorGun4, doorGun5], gain: 0.75, mode: 'over', jitter: 0.04 });
// The sniper tower: an Arisaka and a Mosin-Nagant played at 0.85, so it is a bigger gun
// than the player's rifle (whose takes are other guns and other shots).
registerSamples('sniper', { files: [sniper0, sniper1, sniper2, sniper3], gain: 0.8, mode: 'over', jitter: 0.03 });
// The cannon: a cannon and a tank gun; the recipe keeps its reload clanks.
registerSamples('cannon', { files: [cannon0, cannon1, cannon2, cannon3], gain: 0.8, mode: 'over', jitter: 0.03 });
// The tesla tower has none: the zaps that were here were either hiss above 8 kHz, which a
// tower firing every second must not be, or near silence over a rumble below 20 Hz.
// The missile battery's tubes: the launch pop of anti-tank missiles.
registerSamples('pod', { files: [pod0, pod1, pod2], gain: 0.8, mode: 'over', jitter: 0.05 });
// A missile from the battery: rocket launches.
registerSamples('missile', { files: [missile0, missile1, missile2, missile3], gain: 0.8, mode: 'over', jitter: 0.04 });
// The gatling evolution: a .22 semi-automatic, lighter rounds than the sentry's.
registerSamples('gatling', { files: [gatling0, gatling1, gatling2, gatling3], gain: 0.75, mode: 'over', jitter: 0.05 });
// The penetrator evolution: a .30-30 lever action, a harder crack and more behind it.
registerSamples('penetrator', { files: [penetrator0, penetrator1, penetrator2, penetrator3], gain: 0.8, mode: 'over', jitter: 0.04 });
// The anti-materiel evolution: a Tikka and a Mosin-Nagant played at 0.7, deeper than the sniper tower.
registerSamples('antiMat', { files: [antiMat0, antiMat1, antiMat2], gain: 0.8, mode: 'over', jitter: 0.03 });
