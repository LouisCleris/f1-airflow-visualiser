#!/usr/bin/env node
// Interface checks (Phase 7, extended in Phase 6 to both scenes). Usage: node tests/ui_checks.mjs [dev|dist]
//   1. every mesh of the model maps to a component entry (and every listed mesh exists)
//   2. the page loads with no console errors
//   3. every card and every part button works (and a real click on either side of a part opens its card)
//   4. the camera never ends up inside the model, including during fly-to moves
//   5. no numbers in the interface, and none of the banned words anywhere in what is served
//   6. a screen too small for the layout shows only a notice (and downloads nothing); desktop sizes never show it
// Each check runs on the F1 (names as before) and on the Falcon 6X ("[falcon]" prefix), plus switching scenes both
// ways. The Falcon half is skipped, not failed, in a checkout without the Falcon model.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openApp, frames } from './browser.mjs';
import { PARTICLE_CONFIG } from '../src/particles/config.js';

// The two banned words from the project rules, built from pieces so they never appear literally in this file.
const WITHHELD_NAME = ['bre1', 'zh'].join('');
const WRONG_CAR_NAME = new RegExp('\\b' + ['F', '3'].join('') + '\\b');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] === 'dist' ? 'dist' : 'dev';
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); };

const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/expected-components.json'), 'utf8'));
const ALL_COMPONENTS = JSON.parse(readFileSync(join(ROOT, 'data/components.json'), 'utf8')).components;
const servedRoot = target === 'dist' ? join(ROOT, 'dist') : ROOT;
const HAS_FALCON = existsSync(join(servedRoot, FIXTURES.falcon.file));

// Per-scene details the checks need. `clickTargets`: parts clicked on the model from the top view, on both sides.
// `mirroredHalves`: the F1's left half is a runtime mirror (separate objects per side); the Falcon's meshes each span
// both sides, so its click points are found per half of a part's bounding box instead.
const SCENE_CHECKS = {
  f1: {
    prefix: '', model: 'car', fixture: FIXTURES.f1, nonMesh: new Set(['Steering Wheel Empty']), // an organisational empty, not a mesh (car.js)
    mirroredHalves: true,
    clickTargets: [['front-wing', 'Front wing'], ['rear-wing', 'Rear wing'], ['front-wheels', 'Front wheels'], ['rear-wheels', 'Rear wheels']],
    flyIds: ['front-wing', 'front-wheels', 'sidepods', 'floor', 'rear-wing', 'wake', 'diffuser', 'cockpit', 'rear-wheels', 'nose-chassis'],
    forced: [[0, 0.5, 0.3], [0.2, 0.6, -1], [0, 0.9, 2], [0.5, 0.4, 0]],
    zoom: [0.1, 0.6, 0.1],
    digitsCard: 'front-wing',
  },
  falcon: {
    prefix: '[falcon] ', model: 'aircraft', fixture: FIXTURES.falcon, nonMesh: new Set(),
    mirroredHalves: false,
    clickTargets: [['falcon-wings', 'Wings'], ['falcon-engines', 'Engines'], ['falcon-tail', 'Tail'], ['falcon-fuselage', 'Fuselage']],
    flyIds: ['falcon-fuselage', 'falcon-windows', 'falcon-door', 'falcon-wings', 'falcon-engines', 'falcon-tail', 'falcon-wake'],
    forced: [[0, -0.1, 0.5], [1.2, -0.45, -0.7], [0, 0.2, -2.2], [-0.45, -0.3, -1.5]],
    zoom: [0.1, -0.1, 0.1],
    digitsCard: 'falcon-wings',
  },
};
const componentsOf = (sceneId) => ALL_COMPONENTS.filter((c) => (c.scene || 'f1') === sceneId);

// ---- 1. mesh -> component (no browser needed)
function checkMeshMapping(sceneId) {
  const sc = SCENE_CHECKS[sceneId];
  const comps = componentsOf(sceneId);
  const mapped = new Set(comps.flatMap((c) => c.meshes));
  const unmapped = sc.fixture.componentNames.filter((n) => !mapped.has(n) && !sc.nonMesh.has(n));
  const unknown = [...mapped].filter((n) => !sc.fixture.componentNames.includes(n));
  const dupes = comps.flatMap((c) => c.meshes).filter((n, i, a) => a.indexOf(n) !== i);
  record(`${sc.prefix}every mesh of the ${sc.model === 'car' ? 'car' : 'aircraft'} maps to a component entry`, !unmapped.length && !unknown.length && !dupes.length,
    unmapped.length || unknown.length || dupes.length ? `unmapped: ${unmapped.join(', ') || '-'}; unknown: ${unknown.join(', ') || '-'}; duplicated: ${dupes.join(', ') || '-'}` : `${mapped.size} meshes, ${comps.length} entries`);
}

async function setScene(page, id) {
  await page.evaluate((sid) => document.querySelector(`#scenes button[data-id="${sid}"]`).click(), id);
  await page.waitForFunction((sid) => window.__airflow.ui.scene === sid && !document.body.classList.contains('switching'), { timeout: 240000 }, id);
  await frames(page, 2);
}

/** Checks 3 and 4 and the interface half of 5, on whichever scene the page is showing. */
async function checkScene(page, sceneId) {
  const sc = SCENE_CHECKS[sceneId];
  const P = sc.prefix;
  const halvesLabel = sc.mirroredHalves ? 'both mirrored halves' : 'all meshes';

  // runtime mesh mapping, on the live scene graph
  const live = await page.evaluate(() => {
    const A = window.__airflow;
    const bad = [];
    let n = 0;
    A.car.traverse((o) => {
      if (!o.isMesh) return;
      n++;
      if (!A.componentIndex.idForObject(o)) bad.push(o.name || o.parent?.userData?.name || '?');
    });
    return { n, bad };
  });
  record(`${P}every mesh in the live scene (${halvesLabel}) resolves to a component`, live.bad.length === 0, live.bad.length ? live.bad.join(', ') : `${live.n} meshes`);

  // ---- 3. cards and buttons
  const compIds = await page.evaluate(() => [...window.__airflow.componentIndex.byId.keys()]);
  const cardProblems = [];
  for (const id of compIds) {
    const r = await page.evaluate((cid) => {
      const A = window.__airflow;
      A.ui.selectComponent(cid);
      const c = A.componentIndex.byId.get(cid);
      const card = document.querySelector('#card');
      const text = document.querySelector('#cardText');
      return {
        open: card.classList.contains('open'),
        title: document.querySelector('#cardTitle').textContent === c.title,
        textOk: c.description ? (!text.hidden && text.textContent === c.description) : text.hidden,
      };
    }, id);
    if (!r.open || !r.title || !r.textOk) cardProblems.push(`${id}: ${JSON.stringify(r)}`);
  }
  const expectedIds = componentsOf(sceneId).map((c) => c.id).sort().join(',');
  if ([...compIds].sort().join(',') !== expectedIds) cardProblems.push(`cards shown ${compIds.join(',')} expected ${expectedIds}`);
  record(`${P}every component card opens with its own title and text`, cardProblems.length === 0, cardProblems.join('; ') || `${compIds.length} cards`);

  const parts = await page.$$eval('#parts button', (bs) => bs.map((b) => ({ id: b.dataset.part, label: b.textContent })));
  const btnProblems = [];
  // frozen clock, so a fly-to is still under way when it is checked however slowly the headless renderer draws frames
  await page.evaluate(() => { window.__realNow = performance.now.bind(performance); const t = window.__realNow(); performance.now = () => t; });
  for (const { id: partId, label } of parts) {
    await page.evaluate((pid) => document.querySelector(`#parts button[data-part="${pid}"]`).click(), partId);
    await frames(page, 1);
    const r = await page.evaluate(() => {
      const pressed = [...document.querySelectorAll('#parts button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
      return { pressed, open: document.querySelector('#card').classList.contains('open'), title: document.querySelector('#cardTitle').textContent, flying: window.__airflow.rig.isFlying() };
    });
    const expectOpen = partId !== 'full';
    if (r.pressed.length !== 1 || r.pressed[0] !== label || r.open !== expectOpen || (expectOpen && r.title !== label) || (expectOpen && !r.flying)) btnProblems.push(`${label}: ${JSON.stringify(r)}`);
  }
  await page.evaluate(() => { performance.now = window.__realNow; });
  record(`${P}every part button opens its card and flies the camera to it`, btnProblems.length === 0, btnProblems.join('; ') || parts.map((p) => p.label).join(', '));

  // "show flow around this part only" shows only that entry's flowGroups, both sides of a mirrored one (`<name>-mirror`)
  const flowProblems = await page.evaluate(() => {
    const A = window.__airflow;
    const out = [];
    const sl = A.streamlines;
    const uni = sl.object3D.material.uniforms.groupOn.value;
    const shown = () => sl.groupNames.filter((_, i) => uni[i] === 1);
    for (const c of A.componentIndex.byId.values()) {
      A.ui.selectComponent(c.id, { fly: false });
      document.querySelector('[data-action="only"]').click();
      const wanted = [...new Set(c.flowGroups.flatMap((g) => [g, `${g}-mirror`]))].filter((g) => sl.groupNames.includes(g)).sort().join(',');
      if (c.flowGroups.length) {
        if (!wanted) out.push(`${c.id}: none of its flow groups exist`);
        if (shown().sort().join(',') !== wanted) out.push(`${c.id}: shows ${shown().join(',')} expected ${wanted}`);
      } else if (c.showsWakeParticles) {
        if (sl.object3D.visible || !A.particles.object3D.visible) out.push(`${c.id}: wake only failed`);
      }
      if (c.flowGroups.length && A.particles.object3D.visible) out.push(`${c.id}: wake particles still shown`);
      A.ui.closeCard();
      if (shown().length !== sl.groupNames.length || !sl.object3D.visible || !A.particles.object3D.visible) out.push(`${c.id}: closing did not restore the full flow`);
    }
    return out;
  });
  const fullLabel = parts.find((p) => p.id === 'full').label;
  record(`${P}"Show flow around this part only" isolates exactly that entry's flow groups; ${fullLabel} / close restores`, flowProblems.length === 0, flowProblems.join('; '));

  // real clicks on the model, on both sides, from the top view
  await page.evaluate(() => { window.__airflow.ui.fullCar(); window.__airflow.ui.goPreset('top', true); });
  await frames(page, 1);
  const clickProblems = [];
  for (const [cid, title] of sc.clickTargets) {
    for (const side of [-1, 1]) {
      const pos = await page.evaluate((id, sd, mirrored) => {
        const A = window.__airflow;
        const canvas = document.querySelector('#viewport');
        const r = canvas.getBoundingClientRect();
        const names = new Set(A.componentIndex.byId.get(id).meshes);
        A.car.updateMatrixWorld(true);
        A.camera.updateMatrixWorld(true);
        const objs = [];
        A.car.traverse((o) => { if (o.userData && names.has(o.userData.name)) objs.push(o); });
        const centres = [];
        for (const o of objs) {
          const box = new A.THREE.Box3().setFromObject(o);
          const c = box.getCenter(new A.THREE.Vector3());
          if (mirrored) { if (Math.sign(c.x) === sd) centres.push(c); }
          else { c.x = sd > 0 ? Math.max(0, box.min.x) / 2 + box.max.x / 2 : Math.min(0, box.max.x) / 2 + box.min.x / 2; centres.push(c); } // middle of this side's half of the box
        }
        for (const c of centres) {
          const ndc = c.clone().project(A.camera);
          const cx = r.left + ((ndc.x + 1) / 2) * r.width, cy = r.top + ((1 - ndc.y) / 2) * r.height;
          for (let dy = -60; dy <= 60; dy += 6) for (let dx = -60; dx <= 60; dx += 6) {
            if (A.componentIndex.pick(cx + dx, cy + dy, canvas, A.camera) === id) return { x: cx + dx, y: cy + dy };
          }
        }
        return null;
      }, cid, side, sc.mirroredHalves);
      const sideName = side < 0 ? 'left' : 'right';
      if (!pos) { clickProblems.push(`${cid}/${sideName}: no clickable point found`); continue; }
      await page.evaluate(() => window.__airflow.ui.closeCard());
      await page.mouse.click(pos.x, pos.y);
      await frames(page, 1);
      const got = await page.evaluate(() => (document.querySelector('#card').classList.contains('open') ? document.querySelector('#cardTitle').textContent : null));
      if (got !== title) clickProblems.push(`${cid}/${sideName}: opened ${got}`);
      await page.evaluate(() => window.__airflow.ui.goPreset('top', true));
    }
  }
  record(`${P}clicking either ${sc.mirroredHalves ? 'mirrored half' : 'side'} of a part opens its card`, clickProblems.length === 0, clickProblems.join('; ') || sc.clickTargets.map((c) => c[1]).join(', '));

  // ---- 4. camera never inside the model
  const camera = await page.evaluate((flyIds, forced, zoom) => {
    const A = window.__airflow;
    const box = A.rig.keepOut;
    const inside = () => box.containsPoint(A.camera.position);
    const bad = [];
    // fake clock, so a whole fly-to is stepped through without rendering frames
    const realNow = performance.now.bind(performance);
    let fake = realNow();
    performance.now = () => fake;
    for (const id of flyIds) {
      A.ui.selectComponent(id);
      for (let i = 0; i < 60; i++) { fake += 20; A.rig.update(); if (inside()) { bad.push(`${id} (during the move)`); break; } }
      if (inside()) bad.push(`${id} (at the end)`);
    }
    for (const p of forced) {
      A.camera.position.set(...p);
      A.rig.update();
      if (inside()) bad.push(`forced to ${p}`);
    }
    A.ui.goPreset('side', true);
    const minDistance = A.controls.minDistance;
    A.controls.minDistance = 0.01;
    A.camera.position.set(...zoom);
    A.rig.update();
    if (inside()) bad.push('zoomed into the centre');
    A.controls.minDistance = minDistance;
    performance.now = realNow;
    return bad;
  }, sc.flyIds, sc.forced, sc.zoom);
  record(`${P}the camera never enters the ${sc.model} (fly-tos, forced positions, zooming in)`, camera.length === 0, camera.join('; '));

  // ---- 5. numbers
  await page.evaluate(() => window.__airflow.ui.fullCar());
  await frames(page, 1);
  const digits = await page.evaluate((cardId) => {
    const out = [];
    const check = () => {
      for (const el of document.querySelectorAll('body *')) {
        if (el.id === 'cardText' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        // "F1" is the car's name and "6X" part of the aircraft's, not numbers (any case: the title is in capitals)
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\bF1\b/g, '').replace(/\bFalcon 6X\b/gi, '');
        if (/\d/.test(own)) out.push(`${el.tagName}#${el.id}: ${own.trim()}`);
        for (const a of ['aria-label', 'title', 'placeholder']) if (/\d/.test((el.getAttribute(a) || '').replace(/\bF1\b/g, '').replace(/\bFalcon 6X\b/g, ''))) out.push(`${a}: ${el.getAttribute(a)}`);
      }
    };
    check();
    window.__airflow.ui.selectComponent(cardId);
    check();
    return out;
  }, sc.digitsCard);
  record(`${P}no numbers anywhere in the interface (card text aside, which is your own writing)`, digits.length === 0, digits.join('; '));
  await page.evaluate(() => window.__airflow.ui.fullCar());
}

/**
 * Screens too small for the layout: only the notice is shown (the title and one line, in the page's own style), the
 * models and data are never requested, and nothing is wider than the screen. Growing the window to desktop size then
 * starts the app.
 */
async function checkSmallScreen(browser, url, width, height) {
  const label = `${width}x${height}`;
  const page = await browser.newPage();
  const errors = [], heavy = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => { if (/\.(glb|bin)$|\/data\//.test(r.url())) heavy.push(r.url()); });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1500));
  const s = await page.evaluate(() => {
    const note = document.querySelector('#smallScreen');
    const r = note.getBoundingClientRect();
    const shown = [...document.body.children].filter((e) => e !== note && getComputedStyle(e).display !== 'none').map((e) => e.tagName + '#' + e.id);
    const over = [...note.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1; }).length;
    return { noteShown: getComputedStyle(note).display !== 'none' && r.width > 0, title: note.querySelector('.brand span').textContent, text: note.querySelector('p').textContent,
      othersShown: shown, over, scrollX: document.documentElement.scrollWidth > innerWidth, appStarted: !!window.__airflow };
  });
  record(`small screen (${label}): only the notice is shown, nothing is downloaded, nothing is wider than the screen, no console errors`,
    s.noteShown && s.title === 'F1 AIRFLOW' && s.text === 'Open this page on a computer to explore the airflow.' && !s.othersShown.length && !s.over && !s.scrollX && !s.appStarted && !heavy.length && !errors.length,
    JSON.stringify({ ...s, requested: heavy.slice(0, 3), errors }));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  let started = true;
  try { await page.waitForFunction('window.__airflow && window.__airflow.ui', { timeout: 120000 }); } catch { started = false; }
  const after = await page.evaluate(() => ({ noteShown: getComputedStyle(document.querySelector('#smallScreen')).display !== 'none', canvas: getComputedStyle(document.querySelector('#viewport')).display !== 'none' }));
  record(`small screen (${label}): growing the window to desktop size hides the notice and starts the app`, started && !after.noteShown && after.canvas && !errors.length, JSON.stringify({ started, ...after, errors }));
  await page.close();
}

/**
 * Phase 5: the Straight line / Cornering switch (F1 only). Clicked as a user would: the default is Straight line; a
 * click on Cornering swaps the lines and wake particles for the cornering set within a frame, steers the front wheels
 * and moves the track (never the car); the flow settings carry over; Straight line restores everything exactly.
 */
async function checkDrivingSwitch(page) {
  const snap = () => page.evaluate(() => {
    const A = window.__airflow, w = A.worlds.f1;
    const road = A.scene.getObjectByName('Road');
    const tyres = A.wheels.filter((x) => x.mesh.userData.name === 'Front Tire').map((x) => { x.mesh.updateWorldMatrix(true, false); return x.mesh.matrixWorld.elements.map((e) => +e.toFixed(5)); });
    const rears = A.wheels.filter((x) => x.mesh.userData.name === 'Rear Tire').map((x) => x.mesh.position.toArray().map((e) => +e.toFixed(5)));
    const lines = A.scene.getObjectByName('F1 scene').children.filter((o) => o.material && o.material.uniforms && o.material.uniforms.pulseWidth).map((o) => o.visible);
    const sl = A.streamlines;
    return {
      shown: !document.querySelector('#driving').hidden,
      labels: [...document.querySelectorAll('#driving button')].map((b) => b.textContent),
      pressed: [...document.querySelectorAll('#driving button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.id),
      driving: w.driving,
      activeLines: sl ? sl.streamlineCount : 0, activeVisible: sl ? sl.object3D.visible : false, lines,
      wakeVisible: A.particles ? A.particles.object3D.visible : false,
      pulseWidth: sl ? +sl.object3D.material.uniforms.pulseWidth.value.toFixed(4) : null,
      density: sl ? +sl.object3D.material.uniforms.density.value.toFixed(4) : null,
      roadPos: road.position.toArray().map((e) => +e.toFixed(3)), roadYaw: +road.rotation.y.toFixed(4), roadY: road.position.y,
      carPos: A.car.position.toArray(), tyres, rears,
    };
  });
  // paused, so the wheels' spin does not move them between snapshots and only the steer can
  await page.evaluate(() => { const A = window.__airflow; A.ui.fullCar(); A.ui.goPreset('three-quarter', true); if (A.ui.state.playing) document.querySelector('#controls [data-action="play"]').click(); });
  await frames(page, 2);
  const s0 = await snap();
  record('Straight line / Cornering switch: shown in the F1, Straight line pressed by default', s0.shown && s0.labels.join() === 'Straight line,Cornering' && s0.pressed.join() === 'straight' && s0.driving === 'straight' && s0.roadYaw === 0, JSON.stringify({ shown: s0.shown, labels: s0.labels, pressed: s0.pressed }));
  const ms = await page.evaluate(() => { const t = performance.now(); document.querySelector('#driving button[data-id="cornering"]').click(); return performance.now() - t; });
  await frames(page, 2);
  const s1 = await snap();
  const steered = s1.tyres.every((m, i) => m.some((e, k) => Math.abs(e - s0.tyres[i][k]) > 1e-3));
  const cornerOk = s1.pressed.join() === 'cornering' && s1.driving === 'cornering' && s1.activeVisible && s1.wakeVisible &&
    s1.lines.filter(Boolean).length === 1 && JSON.stringify(s1.lines) !== JSON.stringify(s0.lines) &&
    s1.roadYaw !== 0 && s1.roadY === 0 && JSON.stringify(s1.carPos) === JSON.stringify(s0.carPos) && steered &&
    JSON.stringify(s1.rears) === JSON.stringify(s0.rears) && s1.pulseWidth === s0.pulseWidth && s1.density === s0.density;
  record('clicking Cornering swaps in the cornering lines and wake, steers the front wheels and moves the track (not the car), keeping the flow settings', cornerOk && ms < 100,
    `${ms.toFixed(1)} ms to switch; ${JSON.stringify({ pressed: s1.pressed, lines: s1.lines, activeLines: s1.activeLines, roadYaw: s1.roadYaw, roadPos: s1.roadPos, steered, carPos: s1.carPos })}`);
  await page.evaluate(() => document.querySelector('#driving button[data-id="straight"]').click());
  await frames(page, 2);
  const s2 = await snap();
  const back = JSON.stringify({ ...s2, tyres: null }) === JSON.stringify({ ...s0, tyres: null }) && s2.tyres.every((m, i) => m.every((e, k) => Math.abs(e - s0.tyres[i][k]) < 1e-4));
  record('clicking Straight line restores the straight-line lines, wake, wheels and track exactly', back, back ? '' : `before ${JSON.stringify(s0)} after ${JSON.stringify(s2)}`);
  await page.evaluate(() => document.querySelector('#controls [data-action="play"]').click());
}

/**
 * Phase 5 review: the background moves. F1 Straight line and Cornering: the track streams past at the speed of the
 * oncoming air (metres travelled per second of the lines' own simulated time = the flow speed), at both Speed slider
 * settings; Pause stops it; Reset puts it back to the start. Falcon 6X: the cloud deck drifts the same way.
 */
async function checkMovingScenery(page, label, driving = null) {
  const r = await page.evaluate(async (driving) => {
    const A = window.__airflow;
    const twoFrames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const wait = async (n) => { for (let i = 0; i < n; i++) await new Promise((res) => requestAnimationFrame(res)); }; // n frames: headless frame rates vary
    if (driving) A.ui.setDriving(driving);
    if (!A.ui.state.playing) document.querySelector('#controls [data-action="play"]').click();
    const road = A.scene.getObjectByName('Road');
    const sky = A.scene.getObjectByName('Sky');
    const falcon = A.ui.scene === 'falcon';
    // what is on screen: the track's transform, or the deck's offset; and how far it has moved (metres)
    const look = () => (falcon ? sky.material.uniforms.drift.value.toArray().map((v) => +v.toFixed(6)).join()
      : [...road.position.toArray(), road.rotation.y].map((v) => +v.toFixed(5)).join());
    const moved = () => (falcon ? sky.material.uniforms.drift.value.length() * sky.userData.deckDepth : road.userData.travelled());
    const lineTime = () => A.streamlines.object3D.material.uniforms.time.value;
    const speed = (v) => { const el = document.getElementById('speed'); el.value = v; el.dispatchEvent(new Event('input')); };
    const rate = async (v) => {
      speed(v); await twoFrames();
      const m0 = moved(), t0 = lineTime(), l0 = look();
      await wait(20);
      return { metresPerSimSecond: +((moved() - m0) / (lineTime() - t0)).toFixed(3), simSeconds: +(lineTime() - t0).toFixed(3), changed: look() !== l0 };
    };
    const fast = await rate(70), slow = await rate(35);
    speed(70);
    document.querySelector('#controls [data-action="play"]').click(); // pause
    await twoFrames();
    const p0 = look(); await wait(10); const paused = look() === p0;
    document.querySelector('#controls [data-action="play"]').click(); // play again
    await wait(5);
    const start = look();
    document.querySelector('#controls [data-action="reset"]').click();
    const afterReset = { look: look(), moved: moved() };
    await twoFrames();
    if (driving) A.ui.setDriving(driving); // Reset returns the F1 to Straight line
    return { fast, slow, paused, start, afterReset };
  }, driving);
  return r;
}

/** What identifies the scene being shown, for comparing before and after a round trip. */
const sceneSignature = (page) => page.evaluate(() => {
  const A = window.__airflow;
  const visibleHolders = A.scene.children.filter((o) => /scene$/.test(o.name) && o.visible).map((o) => o.name);
  return {
    scene: A.ui.scene,
    pressed: [...document.querySelectorAll('#scenes button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.id),
    parts: [...document.querySelectorAll('#parts button')].map((b) => b.textContent),
    presets: [...document.querySelectorAll('#cameras button')].map((b) => b.dataset.preset),
    visibleHolders,
    lines: A.streamlines ? A.streamlines.groupNames.length : 0,
    linesVisible: A.streamlines ? A.streamlines.object3D.visible : false,
    meshes: (() => { let n = 0; A.car.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
    road: A.scene.getObjectByName('Road') ? A.scene.getObjectByName('Road').visible : null,
    drivingShown: !document.querySelector('#driving').hidden,
    driving: A.worlds.f1 ? A.worlds.f1.driving : null,
    background: A.scene.background && A.scene.background.getHexString ? A.scene.background.getHexString() : String(A.scene.background),
  };
});

checkMeshMapping('f1');
if (HAS_FALCON) checkMeshMapping('falcon');

const srv = await startServer(servedRoot, { dev: target === 'dev' });
const browser = await launch();
try {
  // ---- 2. loads clean (desktop)
  const t0 = Date.now();
  const { page, errors } = await openApp(browser, srv.url);
  await frames(page, 2);
  record('the page loads with no console errors', errors.length === 0, errors.length ? errors.join(' | ') : `loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s (${target})`);
  const desktopNote = await page.evaluate(() => getComputedStyle(document.querySelector('#smallScreen')).display);
  record('desktop size (1440x900): the small-screen notice is not shown', desktopNote === 'none', desktopNote);

  await checkScene(page, 'f1');
  await checkDrivingSwitch(page);
  const flowSpeed = PARTICLE_CONFIG.flowSpeed;
  const near = (x) => Math.abs(x - flowSpeed) / flowSpeed < 0.03;
  for (const driving of ['straight', 'cornering']) {
    const m = await checkMovingScenery(page, driving, driving);
    const atStart = driving === 'straight' ? m.afterReset.moved === 0 && m.afterReset.look === '0,0,0,0' : m.afterReset.moved === 0;
    record(`${driving === 'straight' ? 'Straight line' : 'Cornering'}: the track moves past at the speed of the oncoming air at both Speed settings, stops on Pause, and Reset puts it back`,
      m.fast.changed && m.slow.changed && near(m.fast.metresPerSimSecond) && near(m.slow.metresPerSimSecond) && m.slow.simSeconds < m.fast.simSeconds && m.paused && atStart,
      JSON.stringify(m));
  }
  await page.evaluate(() => window.__airflow.ui.setDriving('straight'));

  if (HAS_FALCON) {
    // ---- scene switch, both ways
    await page.evaluate(() => { window.__airflow.ui.fullCar(); window.__airflow.ui.goPreset('three-quarter', true); });
    await frames(page, 2);
    const f1Before = await sceneSignature(page);
    const errorsBefore = errors.length;
    const t1 = Date.now();
    await setScene(page, 'falcon');
    const falconSig = await sceneSignature(page);
    const newErrors = errors.slice(errorsBefore);
    const falconOk = falconSig.scene === 'falcon' && falconSig.pressed.join() === 'falcon' && falconSig.visibleHolders.join() === 'Falcon 6X scene' &&
      falconSig.parts[0] === 'Full aircraft' && falconSig.lines > 0 && falconSig.road === false && falconSig.drivingShown === false;
    record('[falcon] switching F1 -> Falcon 6X shows the aircraft, its flow, parts and sky (and hides the driving switch), with no console errors', falconOk && newErrors.length === 0,
      newErrors.length ? newErrors.join(' | ') : `${((Date.now() - t1) / 1000).toFixed(1)} s, ${JSON.stringify(falconSig)}`);

    await checkScene(page, 'falcon');
    {
      const m = await checkMovingScenery(page, 'falcon');
      const near = (x) => Math.abs(x - PARTICLE_CONFIG.flowSpeed) / PARTICLE_CONFIG.flowSpeed < 0.03;
      record('[falcon] the cloud deck drifts past at the speed of the oncoming air at both Speed settings, stops on Pause, and Reset puts it back',
        m.fast.changed && m.slow.changed && near(m.fast.metresPerSimSecond) && near(m.slow.metresPerSimSecond) && m.slow.simSeconds < m.fast.simSeconds && m.paused && m.afterReset.moved === 0,
        JSON.stringify(m));
    }

    // back to the F1 and over again: everything as it was
    await setScene(page, 'f1');
    await page.evaluate(() => { window.__airflow.ui.fullCar(); window.__airflow.ui.goPreset('three-quarter', true); });
    await frames(page, 2);
    const f1After = await sceneSignature(page);
    await setScene(page, 'falcon');
    const falconAgain = await sceneSignature(page);
    await setScene(page, 'f1');
    const same = JSON.stringify(f1Before) === JSON.stringify(f1After);
    // ... and a Cornering F1 comes back in Cornering
    await page.evaluate(() => document.querySelector('#driving button[data-id="cornering"]').click());
    await setScene(page, 'falcon');
    await setScene(page, 'f1');
    const kept = await page.evaluate(() => ({ driving: window.__airflow.worlds.f1.driving, pressed: [...document.querySelectorAll('#driving button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.id).join(), shown: !document.querySelector('#driving').hidden }));
    await page.evaluate(() => document.querySelector('#driving button[data-id="straight"]').click());
    record('the F1 keeps its driving state across a trip to the Falcon 6X', kept.driving === 'cornering' && kept.pressed === 'cornering' && kept.shown, JSON.stringify(kept));
    record('switching Falcon 6X -> F1 (and over again) restores the F1 exactly as it was', same && falconAgain.scene === 'falcon' && errors.length === errorsBefore,
      same ? `${JSON.stringify(f1After)}` : `before ${JSON.stringify(f1Before)} after ${JSON.stringify(f1After)}`);
  }

  // ---- 5. banned words
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  if (target === 'dist') walk(join(ROOT, 'dist'));
  else { walk(join(ROOT, 'src')); files.push(join(ROOT, 'data/components.json'), join(ROOT, 'data/rakes.json'), join(ROOT, 'data/falcon/rakes.json')); }
  const banned = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const raw = readFileSync(f);
    if (raw.toString('latin1').toLowerCase().includes(WITHHELD_NAME)) banned.push(`${f}: the withheld name`);
    if (['.html', '.js', '.json', '.css', '.md', '.txt', '.svg'].includes(extname(f))) {
      // base64 payloads (fonts) can contain any letters, so they are dropped before looking for the word
      const text = raw.toString('utf8').replace(/data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=]+/gi, '');
      if (WRONG_CAR_NAME.test(text)) banned.push(`${f}: the wrong car name`);
    }
  }
  record('none of the banned words (the wrong car name and the withheld name) appear in the build', banned.length === 0, banned.join('; ') || `${files.length} files scanned`);
  await page.close();

  // ---- 6. small screens: the notice only
  await checkSmallScreen(browser, srv.url, 390, 844);
  await checkSmallScreen(browser, srv.url, 844, 390);
} finally {
  await browser.close();
  await srv.close();
}
if (!HAS_FALCON) console.log(`\n[falcon] checks skipped: ${FIXTURES.falcon.file} is not in this ${target === 'dist' ? 'build' : 'checkout'}.`);
const failed = results.filter((r) => !r.ok);
console.log(`\nSummary (${target}): ${results.length - failed.length} passed, ${failed.length} failed.`);
process.exit(failed.length ? 1 : 0);
