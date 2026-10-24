// The HUD: countdown, switch, radio, alarms, recorded.
// CC0 recordings (see CREDITS-sfx.md) for the recipes of ../bank.ts, cut and levelled to
// each recipe's loudest 50 ms. 'over' layers them on the recipe's synthesized tail;
// 'replace' plays them instead of it.
import { registerSamples } from '../samples';
import beep0 from './ui/beep_0.mp3';
import beepGo0 from './ui/beepGo_0.mp3';
import ultReady0 from './ui/ultReady_0.mp3';
import ultReady1 from './ui/ultReady_1.mp3';
import error0 from './ui/error_0.mp3';
import error1 from './ui/error_1.mp3';
import tinnitus0 from './ui/tinnitus_0.mp3';
import heart0 from './ui/heart_0.mp3';
import klaxon0 from './ui/klaxon_0.mp3';
import klaxon1 from './ui/klaxon_1.mp3';
import radio0 from './ui/radio_0.mp3';
import radio1 from './ui/radio_1.mp3';
import radio2 from './ui/radio_2.mp3';
import radio3 from './ui/radio_3.mp3';

// The countdown before a wave.
registerSamples('beep', { files: [beep0], gain: 1, mode: 'replace' });
registerSamples('beepGo', { files: [beepGo0], gain: 1, mode: 'replace' });
// The ultimate charged.
registerSamples('ultReady', { files: [ultReady0, ultReady1], gain: 0.6, mode: 'over' });
// A refused order: an error blip over the recipe.
registerSamples('radio_error', { files: [error0, error1], gain: 0.6, mode: 'over' });
// Ears ringing after a slam: a recorded ringing, reversed so it dies away.
registerSamples('tinnitus', { files: [tinnitus0], gain: 0.6, mode: 'over' });
// A heartbeat, nearly down.
registerSamples('heart', { files: [heart0], gain: 1, mode: 'replace' });
// The generator's alarm: a klaxon and a factory buzzer.
registerSamples('klaxon', { files: [klaxon0, klaxon1], gain: 0.6, mode: 'over' });
// The walkie-talkie: a squelch, a roger beep and static under each of the recipe's tones.
for (const name of ['radio_chat', 'radio_here', 'radio_danger', 'radio_loot', 'radio_defend', 'radio_good', 'radio_bad']) {
  registerSamples(name, { files: [radio0, radio1, radio2, radio3], gain: 0.45, mode: 'over', jitter: 0.03 });
}
