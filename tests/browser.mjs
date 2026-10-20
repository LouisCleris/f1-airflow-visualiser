// Shared helpers for the browser checks and the screenshot scripts: a static server for the dev tree or dist/, and a
// headless Chrome (see chromePath: CHROME_PATH, Chrome for Testing, or an installed Chrome) with software GL.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };

/** Serves `root`; `dev` maps / to src/index.html like scripts/dev-server.js. */
export async function startServer(root = ROOT, { dev = false, port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = dev ? '/src/index.html' : '/index.html';
      const file = normalize(join(root, p));
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const { port: actual } = server.address();
  return { url: `http://127.0.0.1:${actual}/`, close: () => new Promise((r) => server.close(r)) };
}

// Order: CHROME_PATH, then the newest Chrome for Testing in ~/.cache/puppeteer (any platform), then an installed Chrome.
export function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome');
  const builds = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win32', 'chrome.exe'],
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-linux64', 'chrome'],
  ];
  const versions = existsSync(base) ? readdirSync(base).sort().reverse() : [];
  for (const v of versions) {
    for (const b of builds) {
      const p = join(base, v, ...b);
      if (existsSync(p)) return p;
    }
  }
  const installed = [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ];
  for (const p of installed) if (existsSync(p)) return p;
  throw new Error('no Chrome found: set CHROME_PATH, install Chrome, or run `npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer`');
}

export async function launch() {
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
}

/** Opens `url`, collecting console errors and page errors. Resolves once the app has finished loading (window.__airflow set). */
export async function openApp(browser, url, { width = 1440, height = 900, deviceScaleFactor = 1, timeout = 120000 } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.setViewport({ width, height, deviceScaleFactor });
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction('window.__airflow && window.__airflow.ui', { timeout });
  return { page, errors };
}

/** Lets the scene run a few frames. */
export const frames = (page, n = 30) => page.evaluate((k) => new Promise((res) => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
