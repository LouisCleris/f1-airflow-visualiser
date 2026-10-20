#!/usr/bin/env node
// Portfolio screenshots at 2x, from the built site (dist/): two with the interface, four clean renders.
// Output: shots/portfolio/. Usage: node scripts/portfolio_shots.mjs

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openApp, frames } from '../tests/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'shots', 'portfolio');
mkdirSync(OUT, { recursive: true });

const srv = await startServer(join(ROOT, 'dist'));
const browser = await launch();

// A fly-to finishes by the clock; jump the clock so a shot never catches the camera mid-move.
const settle = (page) => page.evaluate(() => {
  const real = performance.now.bind(performance);
  const t = real() + 5000;
  performance.now = () => t;
  window.__airflow.rig.update();
  performance.now = real;
});

async function shot(page, name) {
  await frames(page, 6);
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  console.log(path);
}

// ---- with the interface
{
  const { page, errors } = await openApp(browser, srv.url, { width: 1440, height: 900, deviceScaleFactor: 2 });
  await frames(page, 40); // let the wake develop
  await shot(page, '01-desktop-three-quarter');
  await page.evaluate(() => window.__airflow.ui.selectComponent('front-wing'));
  await settle(page);
  await shot(page, '02-desktop-front-wing-card');
  console.log('errors:', errors);
  await page.close();
}

// ---- clean renders: no interface
{
  const { page } = await openApp(browser, srv.url, { width: 1600, height: 1000, deviceScaleFactor: 2 });
  await page.addStyleTag({ content: '#top, #controls, #card, #bottom, #status { display: none !important; }' });
  await frames(page, 40);
  const views = [
    ['03-clean-three-quarter', { position: [4.4, 2.3, 5.8], target: [0, 0.45, 0] }],
    ['04-clean-side', { position: [7.5, 1.0, 0], target: [0, 0.5, 0] }],
    ['05-clean-top', { position: [0, 11, 0.01], target: [0, 0.3, 0] }],
    ['06-clean-low-front', { position: [3.0, 0.45, 5.2], target: [0, 0.4, 0.4] }],
  ];
  for (const [name, v] of views) {
    await page.evaluate((p, t) => { const A = window.__airflow; A.rig.flyTo(p, t, true); }, v.position, v.target);
    await shot(page, name);
  }
  await page.close();
}
await browser.close();
await srv.close();
