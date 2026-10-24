// Explosions and blasts, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled to
// each recipe's loudest 50 ms. 'over' layers them on the recipe's synthesized tail;
// 'replace' plays them instead of it.
import { registerSamples } from '../samples';
import explosionS0 from './explosions/explosionS_0.mp3';
import explosionS1 from './explosions/explosionS_1.mp3';
import explosionS2 from './explosions/explosionS_2.mp3';
import explosionS3 from './explosions/explosionS_3.mp3';
import explosionS4 from './explosions/explosionS_4.mp3';
import explosion0 from './explosions/explosion_0.mp3';
import explosion1 from './explosions/explosion_1.mp3';
import explosion2 from './explosions/explosion_2.mp3';
import explosion3 from './explosions/explosion_3.mp3';
import explosion4 from './explosions/explosion_4.mp3';
import explosionL0 from './explosions/explosionL_0.mp3';
import explosionL1 from './explosions/explosionL_1.mp3';
import explosionL2 from './explosions/explosionL_2.mp3';
import explosionL3 from './explosions/explosionL_3.mp3';
import explosionL4 from './explosions/explosionL_4.mp3';
import concussion0 from './explosions/concussion_0.mp3';
import concussion1 from './explosions/concussion_1.mp3';
import concussion2 from './explosions/concussion_2.mp3';
import slam0 from './explosions/slam_0.mp3';
import slam1 from './explosions/slam_1.mp3';
import slam2 from './explosions/slam_2.mp3';

// A small blast: rockets, grenades.
registerSamples('explosionS', { files: [explosionS0, explosionS1, explosionS2, explosionS3, explosionS4], gain: 0.85, mode: 'over', jitter: 0.04 });
// A blast.
registerSamples('explosion', { files: [explosion0, explosion1, explosion2, explosion3, explosion4], gain: 0.85, mode: 'over', jitter: 0.04 });
// A big blast and the airstrike; the recipe keeps its echoes.
registerSamples('explosionL', { files: [explosionL0, explosionL1, explosionL2, explosionL3, explosionL4], gain: 0.85, mode: 'over', jitter: 0.04 });
// A concussion blast: low, muffled booms.
registerSamples('concussion', { files: [concussion0, concussion1, concussion2], gain: 0.8, mode: 'over', jitter: 0.04 });
// A big one's ground slam: heavy, slowed thuds.
registerSamples('slam', { files: [slam0, slam1, slam2], gain: 0.8, mode: 'over', jitter: 0.05 });
