// Bundles the client into ../internal/web/dist, which the td binary embeds.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';

const out = '../internal/web/dist';
const dev = process.argv.includes('--dev');
mkdirSync(out, { recursive: true });
// The sound renderer's worker, inlined into app.js as a string the page starts from a blob:
// a separate file would not load as a worker from file://.
const worker = await esbuild.build({
  entryPoints: ['src/sound/worker.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
// The recorded sounds, src/sound/samples/<name>_<variant>.mp3, inlined as base64 by name for
// the same reason: the page fetches nothing beside itself.
const samples = {};
for (const f of readdirSync('src/sound/samples').filter((f) => f.endsWith('.mp3')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
  const name = f.slice(0, f.lastIndexOf('_'));
  (samples[name] ??= []).push(readFileSync(`src/sound/samples/${f}`).toString('base64'));
}
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  // A classic script, not a module: Chrome refuses module scripts from file://, and demo
  // mode must open straight from disk.
  format: 'iife',
  target: 'es2020',
  outfile: `${out}/app.js`,
  define: { __SOUND_WORKER__: JSON.stringify(worker.outputFiles[0].text), __SOUND_SAMPLES__: JSON.stringify(JSON.stringify(samples)) },
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync('index.html', `${out}/index.html`);
copyFileSync('app.css', `${out}/app.css`);
