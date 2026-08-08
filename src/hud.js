// U12: instrument sidebar (LINES + DISPLAY) and top-right telemetry/compass
// chrome (R6, R8). This module owns the DOM for that chrome and the toggle
// interactions; main.js just wires the map/engine into it and calls
// `hud.tick(trains)` once per animation frame.
//
// State it mutates in place rather than owning outright, so main.js's
// existing frame loop (which already closes over `visibleLines` and reads
// it from `buildLayers()`) keeps working unchanged:
//   - `visibleLines` (Set<lineKey>) — the same Set main.js already threads
//     into buildLayers(). Toggling a line row adds/removes from this Set.
//   - `display` (plain object {trains, buildings, stations}) — a new flags
//     object main.js passes into buildLayers() so the render layers know
//     whether to draw trains/stations at all, independent of the per-line
//     Set. Buildings aren't part of the deck.gl layer stack, so that toggle
//     is applied directly to the MapLibre style here instead.
//
// Trains, buses (U9) and cars (U11) all read `display` the same way inside
// buildLayers() — this module doesn't special-case any of them beyond the
// buildings side effect below. Alerts (see the neon-city plan) still have no
// toggle here; this module deliberately does not build one for a feed that
// doesn't render yet.

import { LOOP_PRESET, CITY_PRESET } from './style.js';
import { LINE_KEYS, rgbString } from './layers.js';
import { CHALLENGES } from './pulse-run/challenges.js';
import { formatTime } from './pulse-run/scoring.js';

const LINE_NAMES = {
  Red: 'Red Line',
  Blue: 'Blue Line',
  Brn: 'Brown Line',
  G: 'Green Line',
  Org: 'Orange Line',
  P: 'Purple Line',
  Pink: 'Pink Line',
  Y: 'Yellow Line',
};

// Mutable: starts as OpenFreeMap extrusion ids; main may swap to chi-buildings-* after load.
let buildingLayerIds = ['buildings-3d', 'buildings-3d-crown'];
const DISPLAY_TOGGLES = [
  { key: 'trains', label: 'Trains' }, // line pulses this pass
  { key: 'buses', label: 'Buses' },
  { key: 'cars', label: 'Cars' },
  { key: 'buildings', label: 'Buildings' },
  // Stations toggle removed — rings hard-off for Tron grid aesthetic.
];

// U13: the two camera presets the CAMERA section's buttons fly to. LOOP is
// U7's boot framing (tight, dramatic); CITY is U13's new wide default. Both
// constants live in style.js — flyTo consumes them exactly, no new numbers
// invented here.
const CAMERA_PRESETS = [
  { key: 'loop', label: 'LOOP', preset: LOOP_PRESET },
  { key: 'city', label: 'CITY', preset: CITY_PRESET },
];
// Fixed flight duration rather than MapLibre's distance-based default, so
// LOOP<->CITY always reads as one deliberate, dramatic move regardless of
// which preset the camera happens to be sitting at when clicked.
const FLY_DURATION_MS = 2200;

const EM_DASH = '—';

/**
 * @param {object} opts
 * @param {import('maplibre-gl').Map} opts.map
 * @param {Record<string, number[]>} opts.lineColors  LINE_COLORS from layers.js
 * @param {Set<string>} opts.visibleLines  shared with main.js's buildLayers() call
 * @param {{trains: boolean, buildings: boolean, stations: boolean}} opts.display
 * @param {string[]} opts.trackGlowLayerIds  the l-tracks-* MapLibre layer ids
 * @param {() => string} opts.getStatus  returns 'live' | 'mock' | 'lost' | 'boot'
 */
export function createHud({
  map,
  lineColors,
  visibleLines,
  display,
  trackGlowLayerIds,
  getStatus,
  onReleaseFollow,
  trackMaps = [],
  // Pulse Run hooks (optional — GRID-only if omitted)
  onAppModeChange,
  onStartChallenge,
  onRetryRun,
  onExitRun,
  isStationsReady = () => false,
  isRunActive = () => false,
}) {
  const allTrackMaps = [map, ...trackMaps.filter((m) => m && m !== map)];
  const lineRowsEl = document.getElementById('line-rows');
  const displayRowsEl = document.getElementById('display-rows');
  const telemetryCountEl = document.getElementById('telemetry-count');
  const compassRose = document.getElementById('compass-rose');

  const lineButtons = new Map();
  const lineCountEls = new Map();
  const displayButtons = new Map();

  // MODE (EXPLORE/LIVE) removed this pass — always aesthetic sim. Keep no-op
  // hooks so older call sites / tests don't crash if they still pass them.
  function setMode() {}
  function flashFallbackNote() {}
  const modeSection = document.getElementById('mode-section');
  if (modeSection) modeSection.style.display = 'none';

  // ---- GRID | PULSE RUN -------------------------------------------------

  let appMode = 'grid'; // 'grid' | 'pulse-run'
  const appModeRows = document.getElementById('app-mode-rows');
  const pulseRunSection = document.getElementById('pulse-run-section');
  const challengeRows = document.getElementById('challenge-rows');
  const challengesGate = document.getElementById('challenges-gate');
  const runPanel = document.getElementById('run-panel');
  const runRouteEl = document.getElementById('run-route');
  const runTimerEl = document.getElementById('run-timer');
  const runParEl = document.getElementById('run-par');
  const countdownEl = document.getElementById('countdown-overlay');
  const resultCard = document.getElementById('result-card');
  const resultTitle = document.getElementById('result-title');
  const resultGrade = document.getElementById('result-grade');
  const resultTime = document.getElementById('result-time');
  const resultShare = document.getElementById('result-share');

  function setAppModeUi(mode) {
    appMode = mode;
    for (const btn of appModeRows?.querySelectorAll('.app-mode-btn') ?? []) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    }
    pulseRunSection?.classList.toggle('visible', mode === 'pulse-run');
  }

  for (const { mode, label } of [
    { mode: 'grid', label: 'GRID' },
    { mode: 'pulse-run', label: 'PULSE RUN' },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-mode-btn';
    btn.dataset.mode = mode;
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(mode === 'grid'));
    btn.addEventListener('click', () => {
      if (mode === appMode) return;
      if (mode === 'grid' && isRunActive()) {
        onExitRun?.();
      }
      setAppModeUi(mode);
      onAppModeChange?.(mode);
    });
    appModeRows?.appendChild(btn);
  }

  function rebuildChallenges() {
    if (!challengeRows) return;
    challengeRows.replaceChildren();
    const ready = isStationsReady();
    if (challengesGate) challengesGate.textContent = ready ? 'READY' : 'LOADING';
    for (const card of CHALLENGES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'challenge-row';
      btn.disabled = !ready || isRunActive();
      const color = lineColors[card.line] ?? [0, 212, 255];
      btn.style.setProperty('--line-color', rgbString(color));
      btn.innerHTML = `<span class="ch-label"><span class="ch-badge"></span>${card.label}</span>
        <span class="ch-route">${card.startName} → ${card.goalName}</span>`;
      btn.addEventListener('click', () => {
        if (!isStationsReady() || isRunActive()) return;
        onStartChallenge?.(card.id);
      });
      challengeRows.appendChild(btn);
    }
  }
  rebuildChallenges();

  document.getElementById('run-retry')?.addEventListener('click', () => onRetryRun?.());
  document.getElementById('run-exit')?.addEventListener('click', () => onExitRun?.());
  document.getElementById('result-retry')?.addEventListener('click', () => onRetryRun?.());
  document.getElementById('result-exit')?.addEventListener('click', () => onExitRun?.());
  document.getElementById('result-copy')?.addEventListener('click', async () => {
    const text = resultShare?.textContent ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  });

  function setStationsReadyUi() {
    rebuildChallenges();
  }

  function showRunPanel(challenge) {
    if (!runPanel) return;
    runPanel.classList.add('visible');
    if (runRouteEl && challenge) {
      runRouteEl.textContent = `${challenge.startName} → ${challenge.goalName}`;
    }
    if (runParEl && challenge) {
      runParEl.textContent = `PAR ${formatTime(challenge.parTimeS)} · LIMIT ${formatTime(challenge.timeLimitS)}`;
    }
    rebuildChallenges();
  }

  function hideRunPanel() {
    runPanel?.classList.remove('visible');
    hideCountdown();
    hideResult();
    rebuildChallenges();
  }

  function updateRunTimer(elapsedS) {
    if (runTimerEl) runTimerEl.textContent = formatTime(elapsedS);
  }

  function showCountdown(n, lineColor) {
    if (!countdownEl) return;
    countdownEl.classList.add('visible');
    const shown = n <= 0 ? 'GO' : String(Math.ceil(n));
    countdownEl.textContent = shown;
    if (lineColor) countdownEl.style.color = rgbString(lineColor);
  }

  function hideCountdown() {
    countdownEl?.classList.remove('visible');
  }

  function showResult({ grade, elapsedS, share, failed }) {
    if (!resultCard) return;
    resultCard.classList.add('visible');
    resultCard.classList.toggle('failed', !!failed);
    if (resultTitle) resultTitle.textContent = failed ? 'SIGNAL LOST' : 'RUN COMPLETE';
    if (resultGrade) resultGrade.textContent = failed ? '—' : grade ?? 'C';
    if (resultTime) resultTime.textContent = formatTime(elapsedS ?? 0);
    if (resultShare) resultShare.textContent = share ?? '';
  }

  function hideResult() {
    resultCard?.classList.remove('visible');
  }

  // ---- LINES section -----------------------------------------------------

  function applyLineFilters() {
    if (!trackGlowLayerIds) return;
    const filter = ['in', ['get', 'line'], ['literal', [...visibleLines]]];
    for (const m of allTrackMaps) {
      for (const id of trackGlowLayerIds) {
        if (m.getLayer(id)) m.setFilter(id, filter);
      }
    }
  }

  function toggleLine(key) {
    if (visibleLines.has(key)) visibleLines.delete(key);
    else visibleLines.add(key);
    lineButtons.get(key)?.setAttribute('aria-pressed', String(visibleLines.has(key)));
    applyLineFilters();
  }

  for (const key of LINE_KEYS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'line-row';
    btn.style.setProperty('--line-color', rgbString(lineColors[key] ?? [160, 160, 160]));
    btn.setAttribute('aria-pressed', String(visibleLines.has(key)));

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = LINE_NAMES[key] ?? key;

    const count = document.createElement('span');
    count.className = 'row-count';
    count.textContent = '0';

    btn.append(badge, name, count);
    btn.addEventListener('click', () => toggleLine(key));
    lineRowsEl?.appendChild(btn);
    lineButtons.set(key, btn);
    lineCountEls.set(key, count);
  }

  // Track glow layers get (re)added on map 'load' and again after the CARTO
  // fallback — apply the current toggle state as soon as they exist so a
  // reload never starts every line un-filtered.
  applyLineFilters();
  for (const m of allTrackMaps) m.on('styledata', applyLineFilters);

  // ---- DISPLAY section ----------------------------------------------------

  function setBuildingsVisible(on) {
    for (const m of allTrackMaps) {
      for (const id of buildingLayerIds) {
        if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
    }
  }

  function setBuildingLayerIds(ids) {
    buildingLayerIds = ids?.length ? [...ids] : buildingLayerIds;
    // Re-apply current buildings toggle against the new layer set.
    setBuildingsVisible(!!display.buildings);
  }

  // Side effects a DISPLAY toggle needs beyond flipping `display[key]` —
  // only "buildings" has one today (it's a MapLibre style layer, not part
  // of the deck.gl stack buildLayers() reads), but keying this off a lookup
  // rather than an `if (key === ...)` chain in toggleDisplay means the next
  // style-backed toggle is a new table entry, not a new branch.
  const onDisplayToggle = { buildings: setBuildingsVisible };

  function toggleDisplay(key) {
    display[key] = !display[key];
    displayButtons.get(key)?.setAttribute('aria-pressed', String(display[key]));
    onDisplayToggle[key]?.(display[key]);
  }

  for (const { key, label } of DISPLAY_TOGGLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-row';
    btn.setAttribute('aria-pressed', String(!!display[key]));

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = label;

    btn.append(dot, name);
    btn.addEventListener('click', () => toggleDisplay(key));
    displayRowsEl?.appendChild(btn);
    displayButtons.set(key, btn);
  }
  // Reapply buildings visibility if the style reloads (CARTO fallback ships
  // its own building layers under different ids, so this is a no-op there —
  // guarded by the getLayer() check in setBuildingsVisible).
  map.on('styledata', () => setBuildingsVisible(display.buildings));

  // ---- CAMERA section -------------------------------------------------------

  const cameraRowsEl = document.getElementById('camera-rows');

  // Momentary flash while a flyTo is in flight, cleared on the map's own
  // `moveend` (fires whether the flight completes naturally or a user
  // gesture interrupts it) — never a persistent "active" state, since a
  // sticky highlight would misreport the camera the instant the user pans
  // away (R7).
  function flyToPreset(btn, preset) {
    // Pulse Run owns the camera — ignore presets while a run is active.
    if (isRunActive()) return;
    // U17 step 5: a camera preset click releases follow mode first — R7's
    // "camera stays put" is overridden by follow, but a preset is an even
    // more explicit "take me somewhere specific" than free panning is, so
    // it wins over an active follow outright rather than fighting it.
    onReleaseFollow?.();
    btn.classList.add('is-flying');
    // Call flyTo BEFORE registering this button's listener. Interrupting an
    // in-flight ease fires 'moveend' synchronously, inside this same call,
    // for every listener already registered — which correctly clears the
    // previous button's highlight. Registering our own listener first would
    // let that same synchronous fire also catch (and instantly clear) this
    // button's just-added highlight, before its own flight even starts.
    map.flyTo({ ...preset, duration: FLY_DURATION_MS, essential: true });
    const onMoveEnd = () => {
      btn.classList.remove('is-flying');
      map.off('moveend', onMoveEnd);
    };
    map.on('moveend', onMoveEnd);
  }

  for (const { label, preset } of CAMERA_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'camera-row';

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = label;

    btn.append(name);
    btn.addEventListener('click', () => flyToPreset(btn, preset));
    cameraRowsEl?.appendChild(btn);
  }

  // ---- System status (U15, R12) -----------------------------------------
  // Rebuilt on demand (main.js calls this once per AlertsEngine poll, every
  // 120s) rather than every animation frame — the sidebar text itself isn't
  // part of the 60x/sec render loop, only the map's own light treatment is.

  const statusRowsEl = document.getElementById('status-rows');

  function refreshSystemStatus(lineStatus = {}, lineHeadline = {}) {
    if (!statusRowsEl) return;
    statusRowsEl.replaceChildren();
    const stressedKeys = LINE_KEYS.filter((k) => (lineStatus[k] ?? 'normal') !== 'normal');

    if (stressedKeys.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'status-empty';
      empty.textContent = 'ALL LINES NORMAL';
      statusRowsEl.appendChild(empty);
      return;
    }

    for (const key of stressedKeys) {
      const row = document.createElement('div');
      row.className = 'status-row';

      const name = document.createElement('span');
      name.className = 'status-line';
      name.style.color = rgbString(lineColors[key] ?? [160, 160, 160]);
      name.textContent = LINE_NAMES[key] ?? key;

      const headline = document.createElement('span');
      headline.className = 'status-headline';
      const text = lineHeadline[key] || lineStatus[key];
      headline.textContent = text;
      headline.title = text; // full text on hover — the CSS truncation is visual-only

      row.append(name, headline);
      statusRowsEl.appendChild(row);
    }
  }

  // ---- Follow indicator (U17, R14) ---------------------------------------

  const followIndicatorEl = document.getElementById('follow-indicator');
  const followLabelEl = document.getElementById('follow-label');
  document.getElementById('follow-release')?.addEventListener('click', () => onReleaseFollow?.());

  /** Shows/updates the indicator with `label` (e.g. "RED LINE · RUN 042"),
   * or hides it entirely when `label` is null/undefined — main.js calls
   * this once at pick time and once on release, not every frame (the
   * displayed text doesn't change frame-to-frame). */
  function setFollowLabel(label) {
    if (!followIndicatorEl) return;
    if (label) {
      followLabelEl.textContent = label;
      followIndicatorEl.classList.add('visible');
    } else {
      followIndicatorEl.classList.remove('visible');
    }
  }

  // ---- Compass ------------------------------------------------------------

  function updateCompass() {
    if (compassRose) compassRose.style.transform = `rotate(${-map.getBearing()}deg)`;
  }
  map.on('rotate', updateCompass);
  updateCompass();

  // ---- Per-frame tick -------------------------------------------------------

  // Reused every tick() call instead of allocating a fresh Map 60x/sec just
  // to hold 8 counters that get zeroed and refilled each time anyway.
  const lineCounts = Object.fromEntries(LINE_KEYS.map((k) => [k, 0]));
  // The viewport only changes on an actual camera move, not every animation
  // frame, so cache it there instead of calling map.getBounds() (an
  // allocation) inside the 60x/sec tick().
  let cachedBounds = map.getBounds();
  map.on('move', () => {
    cachedBounds = map.getBounds();
  });
  // U11's car tick also needs the current viewport bounds every frame for
  // its own off-viewport freeze check — exposed here rather than main.js
  // calling map.getBounds() a second time per frame for the same value.
  function getBounds() {
    return cachedBounds;
  }

  /**
   * Called once per animation frame from main.js with the engine's current
   * (non-removed) train list. Updates the LINES section's system-wide
   * counts and the top-right IN VIEW telemetry.
   */
  function tick(trains) {
    const status = getStatus ? getStatus() : null;
    const noData = status === 'lost';

    for (const key of LINE_KEYS) lineCounts[key] = 0;
    let inView = 0;

    for (const t of trains) {
      if (!t.pos || t.state === 'removed') continue;
      lineCounts[t.line] = (lineCounts[t.line] ?? 0) + 1;
      // "In view" means visibly on the map right now, so it respects both
      // the trains DISPLAY toggle and each line's own visibility — an
      // invisible train isn't "in view" just because it's inside the
      // viewport rectangle.
      if (display.trains && visibleLines.has(t.line) && cachedBounds.contains(t.pos)) {
        inView++;
      }
    }

    for (const key of LINE_KEYS) {
      const el = lineCountEls.get(key);
      if (!el) continue;
      const c = lineCounts[key] ?? 0;
      el.textContent = noData || c === 0 ? EM_DASH : String(c);
    }

    if (telemetryCountEl) telemetryCountEl.textContent = String(inView);
  }

  refreshSystemStatus(); // empty state until the first alerts poll resolves

  return {
    tick,
    applyLineFilters,
    setBuildingsVisible,
    setBuildingLayerIds,
    refreshSystemStatus,
    setMode,
    flashFallbackNote,
    setFollowLabel,
    getBounds,
    setAppModeUi,
    setStationsReadyUi,
    showRunPanel,
    hideRunPanel,
    updateRunTimer,
    showCountdown,
    hideCountdown,
    showResult,
    hideResult,
  };
}
