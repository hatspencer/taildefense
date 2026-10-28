// The player's guns, recorded (CC0; every file's source in CREDITS.md). The shots play over
// their recipes' tails, so the report rolling off, the echoes and the pump, bolt or brass stay
// the synthesized ones every gun shares; the rocket, the railgun and the crowbar over their
// whole recipes, half as loud, for the motor's roar, the rails' whine and the bar's ring; the
// reloads, the dry fire and the switch alone. The rifle's, the minigun's and the rocket's
// reloads have no recording and stay synthesized.
//
// Gains: each set's takes are cut to one level, driven into a soft clipper as the recipes are
// (no more than 9 dB for a shot), and what a recording still lacks against its recipe's
// loudness (max momentary and loudest 50 ms, averaged) is its gain, at most 2.
import { registerSamples } from '../samples';

import pistol_0 from './guns/pistol_0.mp3';
import pistol_1 from './guns/pistol_1.mp3';
import pistol_2 from './guns/pistol_2.mp3';
import pistol_3 from './guns/pistol_3.mp3';
import shotgun_0 from './guns/shotgun_0.mp3';
import shotgun_1 from './guns/shotgun_1.mp3';
import shotgun_2 from './guns/shotgun_2.mp3';
import shotgun_3 from './guns/shotgun_3.mp3';
import smg_0 from './guns/smg_0.mp3';
import smg_1 from './guns/smg_1.mp3';
import smg_2 from './guns/smg_2.mp3';
import smg_3 from './guns/smg_3.mp3';
import smg_4 from './guns/smg_4.mp3';
import rifle_0 from './guns/rifle_0.mp3';
import rifle_1 from './guns/rifle_1.mp3';
import rifle_2 from './guns/rifle_2.mp3';
import rifle_3 from './guns/rifle_3.mp3';
import minigun_0 from './guns/minigun_0.mp3';
import minigun_1 from './guns/minigun_1.mp3';
import minigun_2 from './guns/minigun_2.mp3';
import minigun_3 from './guns/minigun_3.mp3';
import minigun_4 from './guns/minigun_4.mp3';
import minigun_5 from './guns/minigun_5.mp3';
import rocket_0 from './guns/rocket_0.mp3';
import rocket_1 from './guns/rocket_1.mp3';
import rocket_2 from './guns/rocket_2.mp3';
import railgun_0 from './guns/railgun_0.mp3';
import crowbar_0 from './guns/crowbar_0.mp3';
import crowbar_1 from './guns/crowbar_1.mp3';
import crowbar_2 from './guns/crowbar_2.mp3';
import crowbar_3 from './guns/crowbar_3.mp3';
import reload0_0 from './guns/reload0_0.mp3';
import reloaded0_0 from './guns/reloaded0_0.mp3';
import reload1_0 from './guns/reload1_0.mp3';
import reloaded1_0 from './guns/reloaded1_0.mp3';
import reload2_0 from './guns/reload2_0.mp3';
import reloaded2_0 from './guns/reloaded2_0.mp3';
import dry_0 from './guns/dry_0.mp3';
import dry_1 from './guns/dry_1.mp3';
import dry_2 from './guns/dry_2.mp3';
import dry_3 from './guns/dry_3.mp3';
import switch_0 from './guns/switch_0.mp3';
import switch_1 from './guns/switch_1.mp3';
import switch_2 from './guns/switch_2.mp3';

registerSamples('pistol', { files: [pistol_0, pistol_1, pistol_2, pistol_3], gain: 2, mode: 'over', jitter: 0.06 });
registerSamples('shotgun', { files: [shotgun_0, shotgun_1, shotgun_2, shotgun_3], gain: 2, mode: 'over', jitter: 0.05 });
registerSamples('smg', { files: [smg_0, smg_1, smg_2, smg_3, smg_4], gain: 1.55, mode: 'over', jitter: 0.06 });
registerSamples('rifle', { files: [rifle_0, rifle_1, rifle_2, rifle_3], gain: 1.5, mode: 'over', jitter: 0.05 });
registerSamples('minigun', { files: [minigun_0, minigun_1, minigun_2, minigun_3, minigun_4, minigun_5], gain: 1.45, mode: 'over', jitter: 0.07 });
registerSamples('rocket', { files: [rocket_0, rocket_1, rocket_2], gain: 1.2, mode: 'over', underGain: 0.6, jitter: 0.06 });
registerSamples('railgun', { files: [railgun_0], mode: 'over', underGain: 0.6, jitter: 0.04 });
registerSamples('crowbar', { files: [crowbar_0, crowbar_1, crowbar_2, crowbar_3], gain: 0.9, mode: 'over', underGain: 0.5, jitter: 0.06 });
registerSamples('reload0', { files: [reload0_0], jitter: 0.04 });
registerSamples('reloaded0', { files: [reloaded0_0], gain: 1.15, jitter: 0.04 });
registerSamples('reload1', { files: [reload1_0], gain: 1.3, jitter: 0.04 });
registerSamples('reloaded1', { files: [reloaded1_0], gain: 1.25, jitter: 0.04 });
registerSamples('reload2', { files: [reload2_0], jitter: 0.04 });
registerSamples('reloaded2', { files: [reloaded2_0], gain: 1.05, jitter: 0.04 });
registerSamples('dry', { files: [dry_0, dry_1, dry_2, dry_3], jitter: 0.05 });
registerSamples('switch', { files: [switch_0, switch_1, switch_2], gain: 1.1, jitter: 0.05 });
