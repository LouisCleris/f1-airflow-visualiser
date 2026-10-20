import fs from 'node:fs';
import { loadSdfSync } from '../src/particles/sdf.js';
const sdf = loadSdfSync('data/', fs, 0);
const [lat, z0, z1, y0, y1, dz = 0.02] = process.argv.slice(2).map(Number); // flow runs toward -z, so printed with z falling = rear on the right
const out = new Float64Array(4);
for (let y = y1; y >= y0; y -= dz) {
  let row = y.toFixed(2).padStart(5) + ' ';
  for (let z = z1; z >= z0; z -= dz) {
    const d = sdf.isNear(lat, y, z) ? sdf.sampleAt(lat, y, z, out) : 1;
    row += d <= 0.0 ? '#' : d < 0.04 ? '+' : ' ';
  }
  console.log(row);
}
console.log('     z from', z1, 'down to', z0);
