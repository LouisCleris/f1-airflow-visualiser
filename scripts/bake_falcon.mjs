// Bakes everything the Falcon 6X scene needs, with the placement from src/sceneConfig.js (so the distance field, the
// streamlines and the displayed aircraft can never disagree about scale or pitch):
//   1. scripts/bake_falcon_sdf.py  -> data/falcon/sdf.*, data/falcon/domain.json
//   2. scripts/bake_streamlines.mjs falcon -> data/falcon/streamlines_full.*
//
// Usage: npm run bake:falcon            (both steps)
//        npm run bake:falcon -- --lines (streamlines only, after editing data/falcon/rakes.json)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FALCON_PLACEMENT, SCENE_CONFIGS } from '../src/sceneConfig.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.platform === 'win32' ? join(ROOT, '.venv', 'Scripts', 'python.exe') : join(ROOT, '.venv', 'bin', 'python3');
const linesOnly = process.argv.includes('--lines');

if (!linesOnly) {
  if (!existsSync(python)) throw new Error(`no project venv at ${python} (see PROGRESS.md: python -m venv .venv, then pip install numpy scipy trimesh fast_simplification rtree)`);
  const f = SCENE_CONFIGS.falcon;
  execFileSync(python, [
    join(ROOT, 'scripts', 'bake_falcon_sdf.py'),
    '--scale', String(FALCON_PLACEMENT.modelScale),
    '--pitch', String(FALCON_PLACEMENT.pitchDeg),
    '--pivot', ...FALCON_PLACEMENT.pivot.map(String),
    '--flow-axis', f.flowAxis,
    '--flow-sign', String(f.flowSign),
  ], { stdio: 'inherit' });
}
execFileSync(process.execPath, [join(ROOT, 'scripts', 'bake_streamlines.mjs'), 'falcon'], { stdio: 'inherit' });
