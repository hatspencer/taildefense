// Blows landing, kills, and survivors hit, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled to
// each recipe's loudest 50 ms. 'over' layers them on the recipe's synthesized tail;
// 'replace' plays them instead of it.
import { registerSamples } from '../samples';
import strike0 from './impacts/strike_0.mp3';
import strike1 from './impacts/strike_1.mp3';
import strike2 from './impacts/strike_2.mp3';
import strike3 from './impacts/strike_3.mp3';
import strike4 from './impacts/strike_4.mp3';
import strike5 from './impacts/strike_5.mp3';
import strike6 from './impacts/strike_6.mp3';
import strikeBig0 from './impacts/strikeBig_0.mp3';
import strikeBig1 from './impacts/strikeBig_1.mp3';
import strikeBig2 from './impacts/strikeBig_2.mp3';
import strikeBig3 from './impacts/strikeBig_3.mp3';
import strikeBig4 from './impacts/strikeBig_4.mp3';
import kill0 from './impacts/kill_0.mp3';
import kill1 from './impacts/kill_1.mp3';
import kill2 from './impacts/kill_2.mp3';
import kill3 from './impacts/kill_3.mp3';
import hurtM0 from './impacts/hurt_m_0.mp3';
import hurtM1 from './impacts/hurt_m_1.mp3';
import hurtM2 from './impacts/hurt_m_2.mp3';
import hurtM3 from './impacts/hurt_m_3.mp3';
import hurtM4 from './impacts/hurt_m_4.mp3';
import hurtF0 from './impacts/hurt_f_0.mp3';
import hurtF1 from './impacts/hurt_f_1.mp3';
import hurtF2 from './impacts/hurt_f_2.mp3';
import downM0 from './impacts/down_m_0.mp3';
import downM1 from './impacts/down_m_1.mp3';
import downF0 from './impacts/down_f_0.mp3';
import downF1 from './impacts/down_f_1.mp3';
import downF2 from './impacts/down_f_2.mp3';

// A creep's blow landing: punches.
registerSamples('strike', { files: [strike0, strike1, strike2, strike3, strike4, strike5, strike6], gain: 0.8, mode: 'over', jitter: 0.06 });
// A big one's blow: heavy punches, slowed.
registerSamples('strikeBig', { files: [strikeBig0, strikeBig1, strikeBig2, strikeBig3, strikeBig4], gain: 0.85, mode: 'over', jitter: 0.05 });
// Your shot killing something: a soft knock (no jitter: the game raises its pitch with a streak).
registerSamples('kill', { files: [kill0, kill1, kill2, kill3], gain: 0.6, mode: 'over' });
// A survivor hit.
registerSamples('hurt_m', { files: [hurtM0, hurtM1, hurtM2, hurtM3, hurtM4], gain: 1, mode: 'replace', jitter: 0.04 });
registerSamples('hurt_f', { files: [hurtF0, hurtF1, hurtF2], gain: 1, mode: 'replace', jitter: 0.04 });
// A survivor going down.
registerSamples('down_m', { files: [downM0, downM1], gain: 1, mode: 'replace', jitter: 0.03 });
registerSamples('down_f', { files: [downF0, downF1, downF2], gain: 1, mode: 'replace', jitter: 0.03 });
