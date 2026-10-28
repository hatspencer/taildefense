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
import tesla0 from './turrets/tesla_0.mp3';
import tesla1 from './turrets/tesla_1.mp3';
import tesla2 from './turrets/tesla_2.mp3';
import tesla3 from './turrets/tesla_3.mp3';
import tesla4 from './turrets/tesla_4.mp3';
import tesla5 from './turrets/tesla_5.mp3';
import pod0 from './turrets/pod_0.mp3';
import pod1 from './turrets/pod_1.mp3';
import pod2 from './turrets/pod_2.mp3';
import missile0 from './turrets/missile_0.mp3';
import missile1 from './turrets/missile_1.mp3';
import missile2 from './turrets/missile_2.mp3';
import missile3 from './turrets/missile_3.mp3';

// The gun turret: an SKS, single shots.
registerSamples('turretGun', { files: [turretGun0, turretGun1, turretGun2, turretGun3, turretGun4, turretGun5], gain: 0.75, mode: 'over', jitter: 0.04 });
// The Huey's door gun: AK-47 and AR-15 single shots.
registerSamples('doorGun', { files: [doorGun0, doorGun1, doorGun2, doorGun3, doorGun4, doorGun5], gain: 0.75, mode: 'over', jitter: 0.04 });
// The sniper tower: Mosin-Nagant and Tikka bolt actions.
registerSamples('sniper', { files: [sniper0, sniper1, sniper2, sniper3], gain: 0.8, mode: 'over', jitter: 0.03 });
// The cannon: a cannon and a tank gun; the recipe keeps its reload clanks.
registerSamples('cannon', { files: [cannon0, cannon1, cannon2, cannon3], gain: 0.8, mode: 'over', jitter: 0.03 });
// The tesla tower: zaps and high-voltage discharges.
registerSamples('tesla', { files: [tesla0, tesla1, tesla2, tesla3, tesla4, tesla5], gain: 0.7, mode: 'over', jitter: 0.06 });
// The missile battery's tubes: the launch pop of anti-tank missiles.
registerSamples('pod', { files: [pod0, pod1, pod2], gain: 0.8, mode: 'over', jitter: 0.05 });
// A missile from the battery: rocket launches.
registerSamples('missile', { files: [missile0, missile1, missile2, missile3], gain: 0.8, mode: 'over', jitter: 0.04 });
