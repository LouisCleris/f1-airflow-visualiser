#!/usr/bin/env node
// Build step for GitHub Pages: bundles src/main.js (and three.js) with esbuild into one script, inlines that script,
// the styles and the Geist fonts into dist/index.html. The models and the baked
// data stay as separate files (they are tens of megabytes; inlining them as text would make the page far heavier to
// load), copied read-only into dist/. Streamlines are traced ahead of time (scripts/bake_streamlines.mjs) so the
// page does not trace them on load.
//
// Usage: node scripts/build.js [--rebake]   (the bake is skipped when its output is newer than its inputs)

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// What the page fetches at run time. The Falcon 6X scene's data lives in data/falcon/ (loaded the first time the
// scene is opened).
const DIST_MODELS = ['F1 model.glb', 'Falcon 6X.glb'];
const DIST_DATA = [
  'components.json', 'rakes.json', 'occupancy_grid.json', 'occupancy_grid.bin', 'sdf.json', 'sdf.bin', 'sdf_floor.json', 'sdf_floor.bin',
  'streamlines_full.json', 'streamlines_full.bin',
  'streamlines_corner_full.json', 'streamlines_corner_full.bin',
  'falcon/rakes.json', 'falcon/domain.json', 'falcon/sdf.json', 'falcon/sdf.bin',
  'falcon/streamlines_full.json', 'falcon/streamlines_full.bin',
];

const newest = (paths) => Math.max(...paths.map((p) => statSync(p).mtimeMs));
function sourceFiles(dir, out = []) {
  for (const f of readdirSync(dir)) { const p = join(dir, f); statSync(p).isDirectory() ? sourceFiles(p, out) : f.endsWith('.js') && out.push(p); }
  return out;
}

// Each set of lines is re-baked when its rakes, its distance field or the shared flow code is newer than it. The
// Falcon's distance field itself needs Python (npm run bake:falcon) and is not re-baked here. The F1 has two sets:
// Straight line (streamlines_*) and Cornering (streamlines_corner_*, the same inputs with the yaw applied).
function ensureBaked(force) {
  const sets = [
    ['f1', 'data', ['sdf.bin', 'sdf_floor.bin'], 'streamlines', []],
    ['f1', 'data', ['sdf.bin', 'sdf_floor.bin'], 'streamlines_corner', ['--cornering']],
    ['falcon', 'data/falcon', ['sdf.bin', 'domain.json'], 'streamlines', []],
  ];
  for (const [scene, dir, fields, prefix, flags] of sets) {
    const outputs = ['_full.json', '_full.bin'].map((f) => join(ROOT, dir, prefix + f));
    const inputs = [join(ROOT, dir, 'rakes.json'), ...fields.map((f) => join(ROOT, dir, f)), ...sourceFiles(join(SRC, 'particles'))];
    const stale = force || outputs.some((p) => !existsSync(p)) || newest(outputs) < newest(inputs);
    if (!stale) { console.log(`[build] baked ${prefix} (${scene}) are up to date`); continue; }
    console.log(`[build] baking ${prefix} (${scene}, a few minutes)...`);
    execFileSync(process.execPath, [join(__dirname, 'bake_streamlines.mjs'), scene, ...flags], { stdio: 'inherit' });
  }
}

const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(file).toString('base64')}`;

async function main() {
  ensureBaked(process.argv.includes('--rebake'));

  console.log('[build] bundling src/main.js with esbuild...');
  const result = await build({
    entryPoints: [join(SRC, 'main.js')], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false, sourcemap: false, logLevel: 'info',
  });
  const bundleCode = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

  let html = readFileSync(join(SRC, 'index.html'), 'utf8');

  const devBlockRe = /<!-- DEV_ONLY_START:[\s\S]*?<!-- DEV_ONLY_END -->\n?/;
  if (!devBlockRe.test(html)) throw new Error('build: DEV_ONLY block markers not found in src/index.html');
  html = html.replace(devBlockRe, '');

  // Fonts inline, so the page works offline and needs no font host.
  for (const [name, file] of [['Geist-Variable', 'Geist-Variable.woff2'], ['GeistMono-Variable', 'GeistMono-Variable.woff2']]) {
    const url = `url('/src/fonts/${name}.woff2')`;
    if (!html.includes(url)) throw new Error(`build: font reference for ${name} not found`);
    html = html.replace(url, `url('${dataUri(join(SRC, 'fonts', file), 'font/woff2')}')`);
  }

  const iconTag = '  <link rel="icon" href="data:," />\n';
  if (!html.includes(iconTag)) throw new Error('build: icon tag not found in src/index.html');
  html = html.replace(iconTag, iconTag +
    '  <meta name="description" content="An approximate visualisation of the airflow around an F1 car and a Falcon 6X jet. Not a computational fluid dynamics simulation." />\n');

  const marker = '<!-- BUILD_INLINE_SCRIPT: scripts/build.js inserts the bundled <script> here -->';
  if (!html.includes(marker)) throw new Error('build: BUILD_INLINE_SCRIPT marker not found in src/index.html');
  html = html.replace(marker, () => `<script>\n${bundleCode}\n</script>`);

  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, 'index.html'), html, 'utf8');

  // Models and data: read-only copies; the originals are never written.
  mkdirSync(join(DIST, 'models'), { recursive: true });
  for (const f of DIST_MODELS) cpSync(join(ROOT, 'models', f), join(DIST, 'models', f));
  mkdirSync(join(DIST, 'data', 'falcon'), { recursive: true });
  for (const f of DIST_DATA) cpSync(join(ROOT, 'data', f), join(DIST, 'data', f));
  writeFileSync(join(DIST, '.nojekyll'), '');

  const sizes = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : sizes.push([p.slice(DIST.length + 1), statSync(p).size]); } };
  walk(DIST);
  let total = 0;
  for (const [p, s] of sizes) { total += s; console.log(`[build]   ${p.padEnd(34)} ${(s / 1048576).toFixed(2)} MB`); }
  console.log(`[build] dist/ total ${(total / 1048576).toFixed(1)} MB. done.`);
}

main().catch((err) => { console.error('[build] FAILED:', err); process.exit(1); });
