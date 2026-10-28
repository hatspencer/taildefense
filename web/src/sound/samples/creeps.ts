// The creeps: voices, deaths, throws and feet, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled to
// each recipe's loudest 50 ms. 'over' layers them on the recipe's synthesized tail;
// 'replace' plays them instead of it.
import { registerSamples } from '../samples';
import groan00 from './creeps/groan0_0.mp3';
import groan01 from './creeps/groan0_1.mp3';
import groan02 from './creeps/groan0_2.mp3';
import groan03 from './creeps/groan0_3.mp3';
import groan04 from './creeps/groan0_4.mp3';
import groan10 from './creeps/groan1_0.mp3';
import groan11 from './creeps/groan1_1.mp3';
import groan12 from './creeps/groan1_2.mp3';
import groan13 from './creeps/groan1_3.mp3';
import groan20 from './creeps/groan2_0.mp3';
import groan21 from './creeps/groan2_1.mp3';
import groan22 from './creeps/groan2_2.mp3';
import groan23 from './creeps/groan2_3.mp3';
import groan30 from './creeps/groan3_0.mp3';
import groan31 from './creeps/groan3_1.mp3';
import groan32 from './creeps/groan3_2.mp3';
import groan33 from './creeps/groan3_3.mp3';
import groan40 from './creeps/groan4_0.mp3';
import groan41 from './creeps/groan4_1.mp3';
import groan42 from './creeps/groan4_2.mp3';
import groan43 from './creeps/groan4_3.mp3';
import groan50 from './creeps/groan5_0.mp3';
import groan51 from './creeps/groan5_1.mp3';
import groan52 from './creeps/groan5_2.mp3';
import groan60 from './creeps/groan6_0.mp3';
import groan61 from './creeps/groan6_1.mp3';
import groan62 from './creeps/groan6_2.mp3';
import groan63 from './creeps/groan6_3.mp3';
import groan70 from './creeps/groan7_0.mp3';
import groan71 from './creeps/groan7_1.mp3';
import groan72 from './creeps/groan7_2.mp3';
import death00 from './creeps/death0_0.mp3';
import death01 from './creeps/death0_1.mp3';
import death02 from './creeps/death0_2.mp3';
import death03 from './creeps/death0_3.mp3';
import death10 from './creeps/death1_0.mp3';
import death11 from './creeps/death1_1.mp3';
import death12 from './creeps/death1_2.mp3';
import death13 from './creeps/death1_3.mp3';
import death20 from './creeps/death2_0.mp3';
import death21 from './creeps/death2_1.mp3';
import death22 from './creeps/death2_2.mp3';
import death23 from './creeps/death2_3.mp3';
import death30 from './creeps/death3_0.mp3';
import death31 from './creeps/death3_1.mp3';
import death40 from './creeps/death4_0.mp3';
import death41 from './creeps/death4_1.mp3';
import death42 from './creeps/death4_2.mp3';
import death43 from './creeps/death4_3.mp3';
import death50 from './creeps/death5_0.mp3';
import death51 from './creeps/death5_1.mp3';
import death60 from './creeps/death6_0.mp3';
import death61 from './creeps/death6_1.mp3';
import death62 from './creeps/death6_2.mp3';
import death63 from './creeps/death6_3.mp3';
import death70 from './creeps/death7_0.mp3';
import death71 from './creeps/death7_1.mp3';
import spit0 from './creeps/spit_0.mp3';
import spit1 from './creeps/spit_1.mp3';
import spit2 from './creeps/spit_2.mp3';
import boneThrow0 from './creeps/boneThrow_0.mp3';
import boneThrow1 from './creeps/boneThrow_1.mp3';
import boneLand0 from './creeps/boneLand_0.mp3';
import boneLand1 from './creeps/boneLand_1.mp3';
import boneLand2 from './creeps/boneLand_2.mp3';
import boneLand3 from './creeps/boneLand_3.mp3';
import bile0 from './creeps/bile_0.mp3';
import bile1 from './creeps/bile_1.mp3';
import bile2 from './creeps/bile_2.mp3';
import retch0 from './creeps/retch_0.mp3';
import retch1 from './creeps/retch_1.mp3';
import windup0 from './creeps/windup_0.mp3';
import windup1 from './creeps/windup_1.mp3';
import creepStep0 from './creeps/creepStep_0.mp3';
import creepStep1 from './creeps/creepStep_1.mp3';
import creepStep2 from './creeps/creepStep_2.mp3';
import creepStep3 from './creeps/creepStep_3.mp3';
import creepStep4 from './creeps/creepStep_4.mp3';
import creepStep5 from './creeps/creepStep_5.mp3';
import bigStep0 from './creeps/bigStep_0.mp3';
import bigStep1 from './creeps/bigStep_1.mp3';
import bigStep2 from './creeps/bigStep_2.mp3';
import bigStep3 from './creeps/bigStep_3.mp3';

// Walker.
registerSamples('groan0', { files: [groan00, groan01, groan02, groan03, groan04], gain: 1, mode: 'replace', jitter: 0.05 });
// Runner.
registerSamples('groan1', { files: [groan10, groan11, groan12, groan13], gain: 1, mode: 'replace', jitter: 0.05 });
// Swarmer.
registerSamples('groan2', { files: [groan20, groan21, groan22, groan23], gain: 1.3, mode: 'replace', jitter: 0.05 });
// Brute (slowed).
registerSamples('groan3', { files: [groan30, groan31, groan32, groan33], gain: 1, mode: 'replace', jitter: 0.05 });
// Spitter.
registerSamples('groan4', { files: [groan40, groan41, groan42, groan43], gain: 1, mode: 'replace', jitter: 0.05 });
// Abomination (slowed).
registerSamples('groan5', { files: [groan50, groan51, groan52], gain: 1, mode: 'replace', jitter: 0.05 });
// Hurler.
registerSamples('groan6', { files: [groan60, groan61, groan62, groan63], gain: 1, mode: 'replace', jitter: 0.05 });
// Broodmother (slowed).
registerSamples('groan7', { files: [groan70, groan71, groan72], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death0', { files: [death00, death01, death02, death03], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death1', { files: [death10, death11, death12, death13], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death2', { files: [death20, death21, death22, death23], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death3', { files: [death30, death31], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death4', { files: [death40, death41, death42, death43], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death5', { files: [death50, death51], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death6', { files: [death60, death61, death62, death63], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death7', { files: [death70, death71], gain: 1, mode: 'replace', jitter: 0.05 });
// The spitter's spit.
registerSamples('spit', { files: [spit0, spit1, spit2], gain: 1, mode: 'replace', jitter: 0.06 });
// The hurler's bone torn out and thrown.
registerSamples('boneThrow', { files: [boneThrow0, boneThrow1], gain: 0.7, mode: 'over', jitter: 0.05 });
// The bone landing.
registerSamples('boneLand', { files: [boneLand0, boneLand1, boneLand2, boneLand3], gain: 1, mode: 'replace', jitter: 0.06 });
// A bile burst.
registerSamples('bile', { files: [bile0, bile1, bile2], gain: 1, mode: 'replace', jitter: 0.05 });
// Retching.
registerSamples('retch', { files: [retch0, retch1], gain: 1, mode: 'replace', jitter: 0.04 });
// A big one drawing itself up to strike: a monster breathing in.
registerSamples('windup', { files: [windup0, windup1], gain: 0.7, mode: 'over', jitter: 0.04 });
// A creep's footstep: wet and grass.
registerSamples('creepStep', { files: [creepStep0, creepStep1, creepStep2, creepStep3, creepStep4, creepStep5], gain: 1, mode: 'replace', jitter: 0.08 });
// A big one's footstep.
registerSamples('bigStep', { files: [bigStep0, bigStep1, bigStep2, bigStep3], gain: 0.8, mode: 'over', jitter: 0.05 });
