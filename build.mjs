// Build: bundle src/ with esbuild, inline the result into shell/template.html,
// write dist/svu-run.html.
//
// The output is genuinely self-contained — Babylon is tree-shaken and inlined,
// so there is no CDN dependency, no network requirement beyond the initial
// load, and the file works when opened directly from disk. That is what makes
// "send someone the file" actually work.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = 'docs';   // GitHub Pages serves from / or /docs only
const OUT_NAME = 'svu-run.html';
const dev = process.argv.includes('--dev');

const result = await build({
  entryPoints: [join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'chrome90', 'safari15', 'firefox90'],
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  treeShaking: true,
  write: false,
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  logLevel: 'warning',
});

const js = result.outputFiles[0].text;

const template = await readFile(join(root, 'shell/template.html'), 'utf8');
if (!template.includes('/*__SVU_BUNDLE__*/')) {
  throw new Error('build: template is missing the /*__SVU_BUNDLE__*/ marker');
}

// A closing </script> anywhere in the bundle would terminate the inline script
// tag early. Escaping it is mandatory, not defensive.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

// The replacement MUST be a function. A string replacement would interpret
// "$&", "$`" and "$'" inside the minified bundle as special patterns and
// silently corrupt the output.
const html = template.replace('/*__SVU_BUNDLE__*/', () => safeJs);

await mkdir(join(root, OUT_DIR), { recursive: true });
const outPath = join(root, OUT_DIR, OUT_NAME);
await writeFile(outPath, html, 'utf8');

// A tiny redirect so the bare repo URL works too. The real file keeps its name.
await writeFile(
  join(root, OUT_DIR, 'index.html'),
  '<!DOCTYPE html><meta charset="utf-8">' +
  '<title>SVU RUN</title>' +
  '<meta http-equiv="refresh" content="0; url=./svu-run.html">' +
  '<link rel="canonical" href="./svu-run.html">' +
  '<body style="background:#f4efe8"><a href="./svu-run.html">SVU RUN</a></body>',
  'utf8',
);

const s = await stat(outPath);
const kb = (s.size / 1024).toFixed(0);
console.log(`build: ${OUT_DIR}/${OUT_NAME}  ${kb} KB${dev ? '  (dev, unminified)' : ''}`);

if (s.size > 6 * 1024 * 1024) {
  console.warn('build: WARNING output exceeds 6 MB — check what got pulled in');
}
