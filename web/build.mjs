// Bundles the client into ../internal/web/dist, which the td binary embeds.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const out = '../internal/web/dist';
const dev = process.argv.includes('--dev');
mkdirSync(out, { recursive: true });
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
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync('index.html', `${out}/index.html`);
copyFileSync('app.css', `${out}/app.css`);
