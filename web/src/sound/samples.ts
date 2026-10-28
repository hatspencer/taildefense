// Recorded sounds, layered on the synthesized bank or standing in for it.
//
// THE CONTRACT. A category of recordings is a folder and a module beside it:
//
//   web/src/sound/samples/<category>/<name>_<n>.mp3   the cuts: short mono MP3s, CC0 only
//   web/src/sound/samples/<category>.ts                imports them and calls registerSamples
//   web/src/sound/samples/index.ts                     imports every category module
//   web/src/sound/samples/CREDITS.md                   a section per category: every file, its
//                                                      source, author, URL, licence and cut
//
// The build inlines each imported .mp3 as a base64 string (web/build.mjs, loader 'base64'), so
// the page still fetches nothing beside itself. A category module looks like this:
//
//   import { registerSamples } from '../samples';
//   import a from './guns/pistol_0.mp3';
//   import b from './guns/pistol_1.mp3';
//   registerSamples('pistol', { files: [a, b], gain: 0.9, mode: 'over', jitter: 0.06 });
//
// name is a recipe name in bank.ts (RECIPES), the name sound.ts plays. Whenever a set's
// recordings are decoded the synth plays one of them for that name, picked at random but
// never the same take twice running; until then, and for good if none of them decodes, it
// plays the recipe as before. So a recording can never cost a sound, only replace or thicken
// it. Two modes:
//
//   'replace' the recording alone.
//   'over'    the recording with a recipe under it, at the same rate and place: by default
//             the recipe `<name>Tail` where the bank has one (a gun's synthesized report,
//             echoes and mechanism, without its own shot), else the whole recipe. `under`
//             names another recipe, `underGain` sets its level (1 by default).
//
// gain scales the recordings (1 by default); cut and level the files so that it stays near 1
// against the recipe's own loudness, which sound.ts sets per sound. jitter is how far either
// way the playback rate is varied each play (by default the synth's own: 15%, 5% for voices,
// none for cues). Registering a name again replaces its set. Only recipe names the bank knows
// are played; the #lab=sound page lists every recipe and every registered set to audition.
//
// Decoding is lazy and happens once: nothing is decoded until the audio context starts, then
// every set is decoded off the page's thread by the browser.

import './samples/index';

export interface SampleSpec {
  files: string[];             // base64 MP3s, as the build's loader inlines them
  gain?: number;               // linear, on every take
  mode?: 'over' | 'replace';   // 'replace' by default
  jitter?: number;             // playback rate varied by up to this either way
  under?: string;              // 'over' only: the recipe played under the recording
  underGain?: number;          // 'over' only: its level
}

export interface SampleSet extends Readonly<Required<Omit<SampleSpec, 'jitter' | 'under'>>> {
  readonly name: string;
  readonly jitter: number | undefined;
  readonly under: string | undefined;
  // Each take once decoded; null while it is not, or if it would not decode.
  readonly bufs: (AudioBuffer | null)[];
  state: 'idle' | 'decoding' | 'ready' | 'failed';
  last: number;
}

// The sets by name. Held by a function rather than a module constant: the category modules run
// while this one is still being imported (it imports them), when a constant here would not
// exist yet but a function declaration does.
function registry(): Map<string, SampleSet> {
  const r = registry as { sets?: Map<string, SampleSet> };
  return r.sets ??= new Map();
}

export function registerSamples(name: string, spec: SampleSpec): void {
  registry().set(name, {
    name, files: spec.files.slice(), gain: spec.gain ?? 1, mode: spec.mode ?? 'replace',
    jitter: spec.jitter, under: spec.under, underGain: spec.underGain ?? 1,
    bufs: spec.files.map(() => null), state: 'idle', last: -1,
  });
}

// Every registered set, in the order registered.
export function sampleSets(): SampleSet[] { return [...registry().values()]; }

export function sampleSet(name: string): SampleSet | undefined { return registry().get(name); }

// decodeSamples starts decoding every set not yet started, on ctx. A take that fails is left
// out; a set none of whose takes decodes is failed, and its recipe plays.
export function decodeSamples(ctx: BaseAudioContext): void {
  for (const s of registry().values()) {
    if (s.state !== 'idle') continue;
    s.state = 'decoding';
    let left = s.files.length;
    const done = () => { if (--left === 0 && s.state === 'decoding') s.state = s.bufs.some((b) => b) ? 'ready' : 'failed'; };
    if (!left) { s.state = 'failed'; continue; }
    s.files.forEach((b64, i) => {
      let bytes: Uint8Array;
      try { bytes = fromBase64(b64); } catch { done(); return; }
      ctx.decodeAudioData(bytes.buffer as ArrayBuffer).then((b) => {
        if (s.gain !== 1) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let k = 0; k < d.length; k++) d[k] *= s.gain; }
        s.bufs[i] = b;
        // Playable as soon as one take is in.
        if (s.state === 'decoding') s.state = 'ready';
        done();
      }, done);
    });
  }
}

// take is a decoded take of name's set, never the one played last when there is another, or
// null when the set has none ready (or there is no set).
export function take(name: string): { set: SampleSet; buf: AudioBuffer } | null {
  const s = registry().get(name);
  if (!s || s.state !== 'ready') return null;
  const n = s.bufs.length;
  let i = Math.floor(Math.random() * n);
  if (i === s.last && n > 1) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n;
  for (let k = 0; k < n; k++) {
    const b = s.bufs[(i + k) % n];
    if (b) { s.last = (i + k) % n; return { set: s, buf: b }; }
  }
  return null;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
