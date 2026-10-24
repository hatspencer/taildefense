// Bundles the client into ../internal/web/dist, which the td binary embeds.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';

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
await esbuild.build({
  entryPoints: { app: 'src/main.ts', demo: 'src/demo.ts' },
  bundle: true,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  // A classic script, not a module: Chrome refuses module scripts from file://, and demo
  // mode must open straight from disk.
  format: 'iife',
  target: 'es2020',
  outdir: out,
  define: { __SOUND_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync('index.html', `${out}/index.html`);
copyFileSync('app.css', `${out}/app.css`);
// The music, files of their own beside the page rather than inlined: a few megabytes the page
// streams once it needs them, so nothing waits on them (src/sound/music.ts).
mkdirSync(`${out}/music`, { recursive: true });
for (const f of readdirSync('src/sound/music').filter((f) => f.endsWith('.ogg'))) copyFileSync(`src/sound/music/${f}`, `${out}/music/${f}`);
