// The interface: top bar (camera presets), controls, component cards, part buttons. Plain DOM, no framework.
// One state object; render() writes it to every element that shows it (buttons are bound by data-action).

import { SCENES, DRIVING_STATES, SLIDER_DEFAULTS, SLIDER_MAPPING } from './uiConfig.js';

const PLAY_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M8 5v14"></path><path d="M16 5v14"></path></svg>';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * @param {object} deps
 * @param {object} deps.world the scene shown first. A world carries { id, componentIndex: { byId, pick, boxFor }, rig, flow: { setStreamlinesVisible,
 *   setLineGroups, setLineFraction, setPulseWidth, setWakeVisible, setWakeCount, setSpeed, setPlaying, resetTime },
 *   limits: { wakeDefaultCount, wakeMaxCount }, ui: { presets, defaultPreset, parts, virtualViews } }
 * @param {(id: string) => Promise<object>} deps.loadWorld loads (once) and returns another scene's world
 * @param {(from: object, to: object) => void} deps.onSceneChange swaps what is drawn
 */
export function createUi({ world: firstWorld, loadWorld, onSceneChange }) {
  let world = firstWorld;
  const state = {
    scene: world.id,
    preset: world.ui.defaultPreset,
    selected: null, // component id, or null for the full car
    only: false, // "show flow around this part only"
    driving: world.driving || 'straight', // Phase 5, F1 only: 'straight' | 'cornering'
    streamlines: true,
    playing: true,
    ...SLIDER_DEFAULTS,
  };

  // ---- build the config-driven controls (the camera and part buttons belong to the scene shown)
  function buildSceneButtons() {
    const camerasEl = $('#cameras');
    camerasEl.replaceChildren();
    for (const p of world.ui.presets) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.preset = p.id;
      b.innerHTML = `<span class="long">${p.label}</span>`;
      b.dataset.long = p.label;
      camerasEl.appendChild(b);
    }
    const partsEl = $('#parts');
    partsEl.replaceChildren();
    for (const p of world.ui.parts) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.part = p.id; b.textContent = p.label;
      partsEl.appendChild(b);
    }
  }
  buildSceneButtons();
  buildSwitcher($('#scenes'), SCENES, 'Scene', 'panel seg');
  buildSwitcher($('#driving'), DRIVING_STATES, 'Driving state', 'seg driving', true);

  function buildSwitcher(host, entries, label, cls, withLabel = false) {
    const on = entries.filter((e) => e.enabled);
    if (on.length < 2) return; // nothing to switch between yet (Phases 5 and 6 add entries)
    const group = document.createElement('div');
    group.className = cls; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    on.forEach((e, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = e.label; b.dataset.id = e.id; b.setAttribute('aria-pressed', String(entries === SCENES ? e.id === state.scene : i === 0));
      group.appendChild(b);
    });
    if (withLabel) {
      const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
      const wrap = document.createElement('div'); wrap.className = 'group'; wrap.append(l, group);
      host.appendChild(wrap);
    } else host.appendChild(group);
  }

  // ---- camera
  function goPreset(id, immediate = false) {
    const p = world.ui.presets.find((x) => x.id === id);
    if (!p) return;
    state.preset = id;
    world.rig.flyTo(p.position, p.target, immediate, p.fov);
    render();
  }

  // ---- components
  function viewFor(id) {
    const btn = world.ui.parts.find((b) => b.component === id);
    if (btn && btn.view) return btn.view;
    if (world.ui.virtualViews[id]) return world.ui.virtualViews[id];
    const box = world.componentIndex.boxFor(id);
    return box.isEmpty() ? null : world.rig.frameBox(box);
  }

  function selectComponent(id, { fly = true } = {}) {
    if (!world.componentIndex.byId.has(id)) return;
    state.selected = id;
    state.preset = null;
    if (fly) {
      const v = viewFor(id);
      if (v) world.rig.flyTo(v.position, v.target);
    }
    render();
  }

  function fullCar() {
    state.selected = null;
    state.only = false;
    goPreset(world.ui.defaultPreset);
  }

  function closeCard() {
    state.selected = null;
    state.only = false;
    render();
  }

  // ---- state -> everything
  function render() {
    const comp = state.selected ? world.componentIndex.byId.get(state.selected) : null;

    for (const b of $$('#cameras button')) {
      b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
      b.firstChild.textContent = b.dataset.long;
    }
    for (const b of $$('#parts button')) {
      const part = world.ui.parts.find((p) => p.id === b.dataset.part);
      const pressed = part.id === 'full' ? !comp : !!comp && part.component === comp.id;
      b.setAttribute('aria-pressed', String(pressed));
    }

    const card = $('#card');
    card.classList.toggle('open', !!comp);
    if (comp) {
      $('#cardTitle').textContent = comp.title;
      const text = $('#cardText');
      text.textContent = comp.description || '';
      text.hidden = !comp.description;
    }
    const hasFlow = !!comp && (comp.flowGroups.length > 0 || !!comp.showsWakeParticles);
    for (const sw of $$('[data-action="only"]')) {
      sw.setAttribute('aria-checked', String(state.only && hasFlow));
      sw.setAttribute('aria-disabled', String(!hasFlow)); // a part with no flow group of its own has nothing to isolate
    }
    for (const sw of $$('[data-action="streamlines"]')) sw.setAttribute('aria-checked', String(state.streamlines));
    for (const b of $$('[data-action="play"]')) {
      b.innerHTML = state.playing ? PAUSE_ICON : PLAY_ICON;
      b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    }

    // driving state: only a scene that has one (the F1) shows the switch
    $('#driving').hidden = !world.setDriving;
    for (const b of $$('#driving button')) b.setAttribute('aria-pressed', String(b.dataset.id === state.driving));

    const title = SCENES.find((s) => s.id === world.id)?.title;
    if (title) $('#brandTitle').textContent = title;

    // flow
    const isolating = !!comp && state.only && hasFlow;
    const wakeOnly = isolating && !!comp.showsWakeParticles;
    const { flow, limits } = world;
    flow.setStreamlinesVisible(state.streamlines && !wakeOnly);
    // A mirrored seeding group traces its other side as `<name>-mirror` (seeding.js): isolate both sides.
    flow.setLineGroups(isolating && !wakeOnly ? comp.flowGroups.flatMap((g) => [g, `${g}-mirror`]) : null);
    flow.setWakeVisible(!isolating || wakeOnly);

    const m = SLIDER_MAPPING;
    flow.setLineFraction(m.minLineFraction + (1 - m.minLineFraction) * Math.min(1, state.density / m.fullDensityAt));
    const count = Math.round(limits.wakeDefaultCount * Math.pow(state.density / m.fullDensityAt, m.wakeCountExponent));
    flow.setWakeCount(Math.max(0, Math.min(limits.wakeMaxCount, count)));
    flow.setPulseWidth(m.pulseWidth[0] + (m.pulseWidth[1] - m.pulseWidth[0]) * (state.trail / 100));
    flow.setSpeed((state.speed / SLIDER_DEFAULTS.speed) * m.speedAtDefault);
    flow.setPlaying(state.playing);
    for (const k of ['density', 'trail', 'speed']) { const el = $('#' + k); if (+el.value !== state[k]) el.value = state[k]; }
  }

  // ---- events
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.id && t.closest('#scenes')) { setScene(t.dataset.id); return; }
    if (t.dataset.id && t.closest('#driving')) { setDriving(t.dataset.id); return; }
    if (t.dataset.preset) { state.selected = state.selected; goPreset(t.dataset.preset); return; }
    if (t.dataset.part) {
      const part = world.ui.parts.find((p) => p.id === t.dataset.part);
      if (part.id === 'full') fullCar(); else selectComponent(part.component);
      return;
    }
    switch (t.dataset.action) {
      case 'play': state.playing = !state.playing; break;
      case 'reset': reset(); return;
      case 'streamlines': state.streamlines = !state.streamlines; break;
      case 'only': if (t.getAttribute('aria-disabled') !== 'true') state.only = !state.only; break;
      case 'close': closeCard(); return;
      default: return;
    }
    render();
  });
  for (const k of ['density', 'trail', 'speed']) {
    $('#' + k).addEventListener('input', (e) => { state[k] = +e.target.value; render(); });
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeCard(); });
  window.matchMedia('(max-width: 760px)').addEventListener('change', render);

  // ---- driving state (F1): Straight line / Cornering. Instant: both states' lines are built up front.
  function setDriving(id) {
    if (!world.setDriving) return;
    state.driving = id === 'cornering' ? 'cornering' : 'straight';
    world.setDriving(state.driving);
    render();
  }

  function reset() {
    Object.assign(state, SLIDER_DEFAULTS, { selected: null, only: false, streamlines: true, playing: true });
    if (world.setDriving) { state.driving = 'straight'; world.setDriving('straight'); }
    world.flow.resetTime();
    goPreset(world.ui.defaultPreset);
  }

  // ---- scenes: F1 / Falcon 6X. The other scene is loaded the first time it is asked for.
  let switching = null;
  function setScene(id) {
    if (id === world.id) return Promise.resolve(world);
    if (switching) return switching;
    document.body.classList.add('switching');
    switching = (async () => {
      const next = await loadWorld(id);
      const prev = world;
      world = next;
      onSceneChange(prev, next);
      Object.assign(state, { scene: id, selected: null, only: false });
      if (world.driving) state.driving = world.driving; // the F1 keeps the driving state it was left in
      buildSceneButtons();
      for (const b of $$('#scenes button')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
      goPreset(world.ui.defaultPreset, true);
      return next;
    })().finally(() => { switching = null; document.body.classList.remove('switching'); });
    return switching;
  }

  // A tap on the car (not a drag) opens that part's card.
  function attachPicking(canvas, camera) {
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved > 6 || !quick) return;
      const id = world.componentIndex.pick(e.clientX, e.clientY, canvas, camera);
      if (id) selectComponent(id);
    });
  }

  render();
  return { state, setScene, setDriving, get scene() { return world.id; }, goPreset, selectComponent, fullCar, closeCard, reset, attachPicking, render };
}
