// The base, the pickups, the field and the weather, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled to
// each recipe's loudest 50 ms. 'over' layers them on the recipe's synthesized tail;
// 'replace' plays them instead of it.
// The loops (rain, wind, fire, crickets, rotor) are crossfaded into their own start. MP3
// pads the start with the encoder's delay (1105 samples, LAME header written): a decoder
// that does not trim it leaves a gap each time round, so check, or skip that much.
import { registerSamples } from '../samples';
import hammer0 from './world/hammer_0.mp3';
import hammer1 from './world/hammer_1.mp3';
import hammer2 from './world/hammer_2.mp3';
import hammer3 from './world/hammer_3.mp3';
import hammer4 from './world/hammer_4.mp3';
import upgrade0 from './world/upgrade_0.mp3';
import upgrade1 from './world/upgrade_1.mp3';
import upgrade2 from './world/upgrade_2.mp3';
import crumble0 from './world/crumble_0.mp3';
import crumble1 from './world/crumble_1.mp3';
import crumble2 from './world/crumble_2.mp3';
import crateLand0 from './world/crateLand_0.mp3';
import crateLand1 from './world/crateLand_1.mp3';
import crateLand2 from './world/crateLand_2.mp3';
import coins0 from './world/coins_0.mp3';
import coins1 from './world/coins_1.mp3';
import coins2 from './world/coins_2.mp3';
import coins3 from './world/coins_3.mp3';
import coins4 from './world/coins_4.mp3';
import coins5 from './world/coins_5.mp3';
import coins6 from './world/coins_6.mp3';
import lootFound0 from './world/lootFound_0.mp3';
import lootFound1 from './world/lootFound_1.mp3';
import jackpot0 from './world/jackpot_0.mp3';
import jackpot1 from './world/jackpot_1.mp3';
import medkit0 from './world/medkit_0.mp3';
import medkit1 from './world/medkit_1.mp3';
import medkit2 from './world/medkit_2.mp3';
import step0 from './world/step_0.mp3';
import step1 from './world/step_1.mp3';
import step2 from './world/step_2.mp3';
import step3 from './world/step_3.mp3';
import step4 from './world/step_4.mp3';
import step5 from './world/step_5.mp3';
import frost0 from './world/frost_0.mp3';
import frost1 from './world/frost_1.mp3';
import frost2 from './world/frost_2.mp3';
import ignite0 from './world/ignite_0.mp3';
import sizzle0 from './world/sizzle_0.mp3';
import sizzle1 from './world/sizzle_1.mp3';
import dash0 from './world/dash_0.mp3';
import dash1 from './world/dash_1.mp3';
import dash2 from './world/dash_2.mp3';
import bell0 from './world/bell_0.mp3';
import bell1 from './world/bell_1.mp3';
import jets0 from './world/jets_0.mp3';
import thunder0 from './world/thunder_0.mp3';
import thunder1 from './world/thunder_1.mp3';
import thunder2 from './world/thunder_2.mp3';
import thunder3 from './world/thunder_3.mp3';
import rain0 from './world/rain_0.mp3';
import wind0 from './world/wind_0.mp3';
import fire0 from './world/fire_0.mp3';
import crickets0 from './world/crickets_0.mp3';
import rotor0 from './world/rotor_0.mp3';

// Building: hammer blows on wood.
registerSamples('hammer', { files: [hammer0, hammer1, hammer2, hammer3, hammer4], gain: 1, mode: 'replace', jitter: 0.05 });
// An upgrade: a power tool run up under the recipe's impact gun.
registerSamples('upgrade', { files: [upgrade0, upgrade1, upgrade2], gain: 0.6, mode: 'over', jitter: 0.04 });
// A building destroyed: wood breaking.
registerSamples('crumble', { files: [crumble0, crumble1, crumble2], gain: 0.8, mode: 'over', jitter: 0.05 });
// A supply crate landing: heavy wood.
registerSamples('crateLand', { files: [crateLand0, crateLand1, crateLand2], gain: 0.8, mode: 'over', jitter: 0.04 });
// Paying: coins handled and dropped onto coins.
registerSamples('coins', { files: [coins0, coins1, coins2, coins3, coins4, coins5, coins6], gain: 1, mode: 'replace', jitter: 0.05 });
// A find: a chest opening under the recipe's glockenspiel.
registerSamples('lootFound', { files: [lootFound0, lootFound1], gain: 0.7, mode: 'over', jitter: 0.03 });
// A jackpot: a slot machine paying out, a coin pile.
registerSamples('jackpot', { files: [jackpot0, jackpot1], gain: 0.7, mode: 'over', jitter: 0.02 });
// A medkit: cloth and a belt.
registerSamples('medkit', { files: [medkit0, medkit1, medkit2], gain: 1, mode: 'replace', jitter: 0.04 });
// A survivor's footstep.
registerSamples('step', { files: [step0, step1, step2, step3, step4, step5], gain: 1, mode: 'replace', jitter: 0.08 });
// A frost blast: ice spells.
registerSamples('frost', { files: [frost0, frost1, frost2], gain: 0.7, mode: 'over', jitter: 0.04 });
// Fire catching: a fire whoosh.
registerSamples('ignite', { files: [ignite0], gain: 0.7, mode: 'over', jitter: 0.04 });
// Burning: acid sizzle.
registerSamples('sizzle', { files: [sizzle0, sizzle1], gain: 0.7, mode: 'over', jitter: 0.04 });
// A dash: whooshes.
registerSamples('dash', { files: [dash0, dash1, dash2], gain: 0.7, mode: 'over', jitter: 0.06 });
// The bell: a tolling bell and a church bell.
registerSamples('bell', { files: [bell0, bell1], gain: 1, mode: 'replace', jitter: 0.02 });
// The jets of an airstrike: a recorded flyby.
registerSamples('jets', { files: [jets0], gain: 0.7, mode: 'over', jitter: 0.02 });
// Lightning: thunder claps rolling away.
registerSamples('thunder', { files: [thunder0, thunder1, thunder2, thunder3], gain: 1, mode: 'replace', jitter: 0.05 });
// Loop: heavy rain (crossfaded into its own start).
registerSamples('rain', { files: [rain0], gain: 1, mode: 'replace' });
// Loop: winter wind.
registerSamples('wind', { files: [wind0], gain: 1, mode: 'replace' });
// Loop: a fire crackling.
registerSamples('fire', { files: [fire0], gain: 1, mode: 'replace' });
// Loop: crickets at night.
registerSamples('crickets', { files: [crickets0], gain: 1, mode: 'replace' });
// Loop: a helicopter's rotor under the recipe's Huey.
registerSamples('rotor', { files: [rotor0], gain: 0.7, mode: 'over' });
