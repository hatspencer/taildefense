// The creeps: voices, deaths, throws and feet, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled.
// 'over' layers them on the recipe's synthesized tail; 'replace' plays them instead of it.
// Each kind of dead is one performer and one character, told apart by pitch, breath,
// wetness and length: people gone wrong, not monsters.
import { registerSamples } from '../samples';
import horde_0 from './creeps/horde_0.mp3';
import bigStep_0 from './creeps/bigStep_0.mp3';
import bigStep_1 from './creeps/bigStep_1.mp3';
import bigStep_2 from './creeps/bigStep_2.mp3';
import bigStep_3 from './creeps/bigStep_3.mp3';
import bile_0 from './creeps/bile_0.mp3';
import bile_1 from './creeps/bile_1.mp3';
import bile_2 from './creeps/bile_2.mp3';
import boneLand_0 from './creeps/boneLand_0.mp3';
import boneLand_1 from './creeps/boneLand_1.mp3';
import boneLand_2 from './creeps/boneLand_2.mp3';
import boneLand_3 from './creeps/boneLand_3.mp3';
import boneThrow_0 from './creeps/boneThrow_0.mp3';
import boneThrow_1 from './creeps/boneThrow_1.mp3';
import creepStep_0 from './creeps/creepStep_0.mp3';
import creepStep_1 from './creeps/creepStep_1.mp3';
import creepStep_2 from './creeps/creepStep_2.mp3';
import creepStep_3 from './creeps/creepStep_3.mp3';
import creepStep_4 from './creeps/creepStep_4.mp3';
import creepStep_5 from './creeps/creepStep_5.mp3';
import death0_0 from './creeps/death0_0.mp3';
import death0_1 from './creeps/death0_1.mp3';
import death0_2 from './creeps/death0_2.mp3';
import death0_3 from './creeps/death0_3.mp3';
import death1_0 from './creeps/death1_0.mp3';
import death1_1 from './creeps/death1_1.mp3';
import death1_2 from './creeps/death1_2.mp3';
import death1_3 from './creeps/death1_3.mp3';
import death10_0 from './creeps/death10_0.mp3';
import death10_1 from './creeps/death10_1.mp3';
import death11_0 from './creeps/death11_0.mp3';
import death11_1 from './creeps/death11_1.mp3';
import death11_2 from './creeps/death11_2.mp3';
import death11_3 from './creeps/death11_3.mp3';
import death2_0 from './creeps/death2_0.mp3';
import death2_1 from './creeps/death2_1.mp3';
import death2_2 from './creeps/death2_2.mp3';
import death2_3 from './creeps/death2_3.mp3';
import death3_0 from './creeps/death3_0.mp3';
import death3_1 from './creeps/death3_1.mp3';
import death3_2 from './creeps/death3_2.mp3';
import death4_0 from './creeps/death4_0.mp3';
import death4_1 from './creeps/death4_1.mp3';
import death4_2 from './creeps/death4_2.mp3';
import death4_3 from './creeps/death4_3.mp3';
import death5_0 from './creeps/death5_0.mp3';
import death5_1 from './creeps/death5_1.mp3';
import death6_0 from './creeps/death6_0.mp3';
import death6_1 from './creeps/death6_1.mp3';
import death6_2 from './creeps/death6_2.mp3';
import death6_3 from './creeps/death6_3.mp3';
import death7_0 from './creeps/death7_0.mp3';
import death7_1 from './creeps/death7_1.mp3';
import death8_0 from './creeps/death8_0.mp3';
import death8_1 from './creeps/death8_1.mp3';
import death8_2 from './creeps/death8_2.mp3';
import death8_3 from './creeps/death8_3.mp3';
import death9_0 from './creeps/death9_0.mp3';
import death9_1 from './creeps/death9_1.mp3';
import groan0_0 from './creeps/groan0_0.mp3';
import groan0_1 from './creeps/groan0_1.mp3';
import groan0_2 from './creeps/groan0_2.mp3';
import groan0_3 from './creeps/groan0_3.mp3';
import groan0_4 from './creeps/groan0_4.mp3';
import groan1_0 from './creeps/groan1_0.mp3';
import groan1_1 from './creeps/groan1_1.mp3';
import groan1_2 from './creeps/groan1_2.mp3';
import groan1_3 from './creeps/groan1_3.mp3';
import groan1_4 from './creeps/groan1_4.mp3';
import groan10_0 from './creeps/groan10_0.mp3';
import groan10_1 from './creeps/groan10_1.mp3';
import groan10_2 from './creeps/groan10_2.mp3';
import groan11_0 from './creeps/groan11_0.mp3';
import groan11_1 from './creeps/groan11_1.mp3';
import groan11_2 from './creeps/groan11_2.mp3';
import groan11_3 from './creeps/groan11_3.mp3';
import groan11_4 from './creeps/groan11_4.mp3';
import groan2_0 from './creeps/groan2_0.mp3';
import groan2_1 from './creeps/groan2_1.mp3';
import groan2_2 from './creeps/groan2_2.mp3';
import groan2_3 from './creeps/groan2_3.mp3';
import groan2_4 from './creeps/groan2_4.mp3';
import groan3_0 from './creeps/groan3_0.mp3';
import groan3_1 from './creeps/groan3_1.mp3';
import groan3_2 from './creeps/groan3_2.mp3';
import groan3_3 from './creeps/groan3_3.mp3';
import groan4_0 from './creeps/groan4_0.mp3';
import groan4_1 from './creeps/groan4_1.mp3';
import groan4_2 from './creeps/groan4_2.mp3';
import groan4_3 from './creeps/groan4_3.mp3';
import groan5_0 from './creeps/groan5_0.mp3';
import groan5_1 from './creeps/groan5_1.mp3';
import groan5_2 from './creeps/groan5_2.mp3';
import groan6_0 from './creeps/groan6_0.mp3';
import groan6_1 from './creeps/groan6_1.mp3';
import groan6_2 from './creeps/groan6_2.mp3';
import groan6_3 from './creeps/groan6_3.mp3';
import groan6_4 from './creeps/groan6_4.mp3';
import groan7_0 from './creeps/groan7_0.mp3';
import groan7_1 from './creeps/groan7_1.mp3';
import groan7_2 from './creeps/groan7_2.mp3';
import groan7_3 from './creeps/groan7_3.mp3';
import groan8_0 from './creeps/groan8_0.mp3';
import groan8_1 from './creeps/groan8_1.mp3';
import groan8_2 from './creeps/groan8_2.mp3';
import groan8_3 from './creeps/groan8_3.mp3';
import groan8_4 from './creeps/groan8_4.mp3';
import groan9_0 from './creeps/groan9_0.mp3';
import groan9_1 from './creeps/groan9_1.mp3';
import groan9_2 from './creeps/groan9_2.mp3';
import groan9_3 from './creeps/groan9_3.mp3';
import groan9_4 from './creeps/groan9_4.mp3';
import retch_0 from './creeps/retch_0.mp3';
import retch_1 from './creeps/retch_1.mp3';
import spit_0 from './creeps/spit_0.mp3';
import spit_1 from './creeps/spit_1.mp3';
import spit_2 from './creeps/spit_2.mp3';
import windup_0 from './creeps/windup_0.mp3';
import windup_1 from './creeps/windup_1.mp3';

// Walker: one man, low, slow, a long moan through the nose; its death: a long falling moan.
registerSamples('groan0', { files: [groan0_0, groan0_1, groan0_2, groan0_3, groan0_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death0', { files: [death0_0, death0_1, death0_2, death0_3], gain: 1, mode: 'replace', jitter: 0.05 });
// Runner: short hard snarls, breath and teeth; its death: cut off mid-snarl.
registerSamples('groan1', { files: [groan1_0, groan1_1, groan1_2, groan1_3, groan1_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death1', { files: [death1_0, death1_1, death1_2, death1_3], gain: 1, mode: 'replace', jitter: 0.05 });
// Swarmer, the crawler: wet slobber and gurgle, close to the ground; its death: a choked gurgle.
registerSamples('groan2', { files: [groan2_0, groan2_1, groan2_2, groan2_3, groan2_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death2', { files: [death2_0, death2_1, death2_2, death2_3], gain: 1, mode: 'replace', jitter: 0.05 });
// Brute: a deep growl, slowed to a big chest; its death: a bellow that sinks.
registerSamples('groan3', { files: [groan3_0, groan3_1, groan3_2, groan3_3], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death3', { files: [death3_0, death3_1, death3_2], gain: 1, mode: 'replace', jitter: 0.05 });
// Spitter: a sick man hacking and wheezing; its death: a hawk and a slobbering fall.
registerSamples('groan4', { files: [groan4_0, groan4_1, groan4_2, groan4_3], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death4', { files: [death4_0, death4_1, death4_2, death4_3], gain: 1, mode: 'replace', jitter: 0.05 });
// Abomination: a growl slowed far down, a body far too big; its death: a long sinking roar.
registerSamples('groan5', { files: [groan5_0, groan5_1, groan5_2], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death5', { files: [death5_0, death5_1], gain: 1, mode: 'replace', jitter: 0.05 });
// Hurler: short strained grunts, the effort of a throw; its death: a grunt, pushed out.
registerSamples('groan6', { files: [groan6_0, groan6_1, groan6_2, groan6_3, groan6_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death6', { files: [death6_0, death6_1, death6_2, death6_3], gain: 1, mode: 'replace', jitter: 0.05 });
// Broodmother: a woman's voice, slowed; its death: a falling howl.
registerSamples('groan7', { files: [groan7_0, groan7_1, groan7_2, groan7_3], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death7', { files: [death7_0, death7_1], gain: 1, mode: 'replace', jitter: 0.05 });
// Hound: a dead dog growling and snarling; its death: a yelp and a whine.
registerSamples('groan8', { files: [groan8_0, groan8_1, groan8_2, groan8_3, groan8_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death8', { files: [death8_0, death8_1, death8_2, death8_3], gain: 1, mode: 'replace', jitter: 0.05 });
// Mauler, the grabber: hungry, straining, teeth; its death: a long strained rattle.
registerSamples('groan9', { files: [groan9_0, groan9_1, groan9_2, groan9_3, groan9_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death9', { files: [death9_0, death9_1], gain: 1, mode: 'replace', jitter: 0.05 });
// Goliath: a growl slowed by almost half; its death: a long sinking roar.
registerSamples('groan10', { files: [groan10_0, groan10_1, groan10_2], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death10', { files: [death10_0, death10_1], gain: 1, mode: 'replace', jitter: 0.05 });
// Burster: thin wheezes and hisses; its death: a choke.
registerSamples('groan11', { files: [groan11_0, groan11_1, groan11_2, groan11_3, groan11_4], gain: 1, mode: 'replace', jitter: 0.05 });
registerSamples('death11', { files: [death11_0, death11_1, death11_2, death11_3], gain: 1, mode: 'replace', jitter: 0.05 });

// The spitter's spit.
registerSamples('spit', { files: [spit_0, spit_1, spit_2], gain: 1, mode: 'replace', jitter: 0.06 });
// The hurler's bone torn out and thrown.
registerSamples('boneThrow', { files: [boneThrow_0, boneThrow_1], gain: 0.7, mode: 'over', jitter: 0.05 });
// The bone landing.
registerSamples('boneLand', { files: [boneLand_0, boneLand_1, boneLand_2, boneLand_3], gain: 1, mode: 'replace', jitter: 0.06 });
// A bile burst.
registerSamples('bile', { files: [bile_0, bile_1, bile_2], gain: 1, mode: 'replace', jitter: 0.05 });
// Retching.
registerSamples('retch', { files: [retch_0, retch_1], gain: 1, mode: 'replace', jitter: 0.04 });
// A big one drawing itself up to strike: a dead man's rattling breath in, slowed.
registerSamples('windup', { files: [windup_0, windup_1], gain: 0.7, mode: 'over', jitter: 0.04 });
// A creep's footstep: a dragged foot on dry dirt and gravel, slowed and dulled.
registerSamples('creepStep', { files: [creepStep_0, creepStep_1, creepStep_2, creepStep_3, creepStep_4, creepStep_5], gain: 1, mode: 'replace', jitter: 0.08 });
// A big one's footstep: a boot on gravel slowed to a heavy tread, over the recipe's thump.
registerSamples('bigStep', { files: [bigStep_0, bigStep_1, bigStep_2, bigStep_3], gain: 0.8, mode: 'over', jitter: 0.05 });
// Loop: the horde out of sight, a crowd of people moaning, slowed and dulled by distance, its
// tail crossfaded into its start (12 s).
registerSamples('horde', { files: [horde_0], gain: 1, mode: 'replace' });
