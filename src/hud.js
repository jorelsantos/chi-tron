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
// Only trains/buildings/stations exist as feeds today (see the neon-city
// plan's Phase B for buses/cars/alerts) — this module deliberately does not
// build toggles or status rows for anything that doesn't render yet.

import { LOOP_PRESET, CITY_PRESET } from './style.js';

const LINE_ORDER = ['Red', 'Blue', 'Brn', 'G', 'Org', 'P', 'Pink', 'Y'];

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

const BUILDING_LAYER_IDS = ['buildings-3d', 'buildings-3d-crown'];
const DISPLAY_TOGGLES = [
  { key: 'trains', label: 'Trains' },
  { key: 'buildings', label: 'Buildings' },
  { key: 'stations', label: 'Stations' },
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

function rgb(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * @param {object} opts
 * @param {import('maplibre-gl').Map} opts.map
 * @param {Record<string, number[]>} opts.lineColors  LINE_COLORS from layers.js
 * @param {Set<string>} opts.visibleLines  shared with main.js's buildLayers() call
 * @param {{trains: boolean, buildings: boolean, stations: boolean}} opts.display
 * @param {string[]} opts.trackGlowLayerIds  the l-tracks-* MapLibre layer ids
 * @param {() => string} opts.getStatus  returns 'live' | 'mock' | 'lost' | 'boot'
 */
export function createHud({ map, lineColors, visibleLines, display, trackGlowLayerIds, getStatus }) {
  const lineRowsEl = document.getElementById('line-rows');
  const displayRowsEl = document.getElementById('display-rows');
  const telemetryCountEl = document.getElementById('telemetry-count');
  const compassRose = document.getElementById('compass-rose');

  const lineButtons = new Map();
  const lineCountEls = new Map();
  const displayButtons = new Map();

  // ---- LINES section -----------------------------------------------------

  function applyLineFilters() {
    if (!trackGlowLayerIds) return;
    const filter = ['in', ['get', 'line'], ['literal', [...visibleLines]]];
    for (const id of trackGlowLayerIds) {
      if (map.getLayer(id)) map.setFilter(id, filter);
    }
  }

  function toggleLine(key) {
    if (visibleLines.has(key)) visibleLines.delete(key);
    else visibleLines.add(key);
    lineButtons.get(key)?.setAttribute('aria-pressed', String(visibleLines.has(key)));
    applyLineFilters();
  }

  for (const key of LINE_ORDER) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'line-row';
    btn.style.setProperty('--line-color', rgb(lineColors[key] ?? [160, 160, 160]));
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
  map.on('styledata', applyLineFilters);

  // ---- DISPLAY section ----------------------------------------------------

  function setBuildingsVisible(on) {
    for (const id of BUILDING_LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }

  function toggleDisplay(key) {
    display[key] = !display[key];
    displayButtons.get(key)?.setAttribute('aria-pressed', String(display[key]));
    if (key === 'buildings') setBuildingsVisible(display[key]);
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
    btn.classList.add('is-flying');
    const onMoveEnd = () => {
      btn.classList.remove('is-flying');
      map.off('moveend', onMoveEnd);
    };
    map.on('moveend', onMoveEnd);
    map.flyTo({ ...preset, duration: FLY_DURATION_MS, essential: true });
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

  // ---- Compass ------------------------------------------------------------

  function updateCompass() {
    if (compassRose) compassRose.style.transform = `rotate(${-map.getBearing()}deg)`;
  }
  map.on('rotate', updateCompass);
  updateCompass();

  // ---- Per-frame tick -------------------------------------------------------

  /**
   * Called once per animation frame from main.js with the engine's current
   * (non-removed) train list. Updates the LINES section's system-wide
   * counts and the top-right IN VIEW telemetry.
   */
  function tick(trains) {
    const status = getStatus ? getStatus() : null;
    const noData = status === 'lost';

    const counts = new Map(LINE_ORDER.map((k) => [k, 0]));
    const bounds = map.getBounds();
    let inView = 0;

    for (const t of trains) {
      if (!t.pos || t.state === 'removed') continue;
      counts.set(t.line, (counts.get(t.line) ?? 0) + 1);
      // "In view" means visibly on the map right now, so it respects both
      // the trains DISPLAY toggle and each line's own visibility — an
      // invisible train isn't "in view" just because it's inside the
      // viewport rectangle.
      if (display.trains && visibleLines.has(t.line) && bounds.contains(t.pos)) {
        inView++;
      }
    }

    for (const key of LINE_ORDER) {
      const el = lineCountEls.get(key);
      if (!el) continue;
      const c = counts.get(key) ?? 0;
      el.textContent = noData || c === 0 ? EM_DASH : String(c);
    }

    if (telemetryCountEl) telemetryCountEl.textContent = String(inView);
  }

  return { tick, applyLineFilters, setBuildingsVisible };
}
