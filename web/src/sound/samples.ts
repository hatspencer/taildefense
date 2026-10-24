// STUB, to be replaced at merge by the sample pipeline's own samples.ts, which plays these.
// Here it only records what the modules under ./samples/ register, so they type-check and
// can be inspected; nothing is decoded or played.
//
// A sound's recordings: files are the bundled audio (data URLs), gain scales them against the
// recipe's level, mode says whether they play over the recipe in ./bank.ts ('over', layered
// on its synthesized tail) or instead of it ('replace'), and jitter is how far the playback
// rate may wander from one play to the next.
export interface SampleSet { files: string[]; gain: number; mode: 'over' | 'replace'; jitter?: number }

export const SAMPLE_SETS = new Map<string, SampleSet>();

export function registerSamples(name: string, opts: SampleSet): void {
  SAMPLE_SETS.set(name, opts);
}
