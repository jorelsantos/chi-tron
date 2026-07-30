import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { DARK_CITY_STYLE, FALLBACK_STYLE, LOOP_PRESET } from './style.js';
import { now } from './trains.js';
import { PulseEngine } from './pulses.js';
import { BusEngine } from './buses.js';
import { CarEngine } from './cars.js';
import { AlertsEngine } from './alerts.js';
import { buildLayers, LINE_COLORS, rgbString, lineStressTreatment } from './layers.js';
import { createHud } from './hud.js';

// Design-first pass: always aesthetic simulation. LIVE is dormant (R1/R2).
// `?live=1` is ignored so deep links cannot start polling.
const statusEl = document.getElementById('status');
const busStatusEl = document.getElementById('bus-status');
const clockEl = document.getElementById('clock');
const fpsEl = document.getElementById('fps');

let feedStatus = 'boot'; // read by hud.js's tick() to render the em-dash no-data state

// U14's states (mock/lost/hold/live) plus U9's bus-only 'disabled' all share
// one className rule and one "state -> label" lookup shape — this replaced
// two independently-written copies of the same ternary chain (trains' and
// buses' status pills differed only in label text).
function renderFeedStatus(el, state, labels) {
  if (!el) return;
  // U14: 'hold' is the poll governor's BUDGET HOLD state (src/poller.js) —
  // the feed hit its self-imposed daily ceiling (R10) and has stopped
  // issuing requests until the ledger's local date rolls over.
  el.className = `hud ${state === 'lost' ? 'lost' : state === 'hold' ? 'hold' : state === 'disabled' ? 'disabled' : 'live'}`;
  el.textContent = labels[state] ?? labels.live;
}

const TRAIN_STATUS_LABELS = { mock: 'SIM MODE', lost: 'SIGNAL LOST', hold: 'BUDGET HOLD', live: 'LIVE FEED' };
function setStatus(state) {
  feedStatus = state;
  renderFeedStatus(statusEl, state, TRAIN_STATUS_LABELS);
}

// U9: the bus feed's own status, distinct from the trains status above — a
// missing/bad CTA_BUS_KEY must flip THIS indicator, not silently leave
// #status reading LIVE FEED while the bus layer is empty (buses.js's
// isAuthError() is what turns that failure mode into a real 'error' status
// here, via BusEngine's onStatus callback).
const BUS_STATUS_LABELS = { mock: 'BUS SIM', lost: 'BUS LOST', hold: 'BUS HOLD', disabled: 'BUS OFF', live: 'BUS LIVE' };
function setBusStatus(state) {
  renderFeedStatus(busStatusEl, state, BUS_STATUS_LABELS);
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}, 1000);

async function boot() {
  // tracks.json is load-bearing — the map can't render anything without it,
  // so boot() awaits it below. It's issued here, alongside every other
  // fetch, rather than awaited immediately: stations/patterns/roads don't
  // depend on tracks at all, so starting them only after tracks resolves
  // (simplify pass: they previously did) needlessly serializes four
  // independent round-trips into one. stations.json is NOT awaited at all:
  // it's optional (a missing/failed load only dims the ring layer, never
  // blocks the map), and gating boot on it via Promise.all would let a
  // stalled — not even failed — connection to it hang map init forever,
  // since a fetch that never settles never reaches the .catch that would
  // otherwise turn it into {}. Fetching it independently means boot only
  // ever waits on the resource that's actually required.
  const tracksPromise = fetch('/data/tracks.json').then((r) => r.json());
  let stations = {};
  fetch('/data/stations.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((data) => {
      stations = data; // picked up by frame()'s closure on the next tick
    })
    .catch((err) => {
      console.warn('[chi-tron] stations.json failed to load, station rings disabled:', err.message);
    });

  // U9: same guarded, non-blocking fetch pattern as stations.json above —
  // patterns.json is required for buses to render at all (both live and
  // mock mode interpolate against it), but a missing/failed build artifact
  // must only disable the bus subsystem, never black-screen the whole map
  // for anyone who hasn't run `npm run patterns` yet.
  let busEngine = null;
  fetch('/data/patterns.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((patternsData) => {
      busEngine = new BusEngine(patternsData);
      busEngine.onStatus = setBusStatus;
      // Always aesthetic this pass — LIVE bus polling stays dormant.
      busEngine.seedMock(3);
      setBusStatus('mock');
    })
    .catch((err) => {
      console.warn('[chi-tron] patterns.json failed to load, buses disabled:', err.message);
      setBusStatus('disabled');
    });

  // U11: cars have no live feed in either mode (they're simulated always),
  // so there's no status indicator to wire up here — only presence/absence.
  // Same guarded, non-blocking fetch pattern as patterns.json above: a
  // missing/failed roads.json disables only the car layer.
  let carEngine = null;
  fetch('/data/roads.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((roadsData) => {
      carEngine = new CarEngine(roadsData);
      carEngine.seed();
    })
    .catch((err) => {
      console.warn('[chi-tron] roads.json failed to load, cars disabled:', err.message);
    });

  const tracks = await tracksPromise;

  const map = new maplibregl.Map({
    container: 'map',
    style: DARK_CITY_STYLE,
    // U7: boot at LOOP_PRESET (not the raw CHICAGO_LOOP center) so the
    // shipping framing — biased east for the sidebar U12 will add — is
    // what every later unit (traffic tuning, frame budget, camera presets)
    // tunes against from the start.
    center: LOOP_PRESET.center,
    zoom: LOOP_PRESET.zoom,
    pitch: LOOP_PRESET.pitch,
    bearing: LOOP_PRESET.bearing,
    maxPitch: 70,
    antialias: true,
    attributionControl: { compact: true },
  });
  // The browser pane can settle its layout after init — keep canvas full-bleed.
  new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));

  map.on('error', (e) => {
    // OpenFreeMap unreachable → fall back to CARTO dark matter once.
    if (!map.__fellBack && /source|style|tile/i.test(String(e.error?.message))) {
      map.__fellBack = true;
      console.warn('[chi-tron] falling back to CARTO style:', e.error?.message);
      map.setStyle(FALLBACK_STYLE);
      map.once('styledata', addTrackUnderglow);
    }
  });

  // Neon under-glow of the full network: three stacked passes per line —
  // wide/very-low-opacity bloom halo, a mid pass to soften the falloff, and
  // a hairline bright core — so lines read as *glowing*, not drawn (R2).
  // All three passes share one GeoJSON source (`l-tracks`) and every
  // feature carries `properties.line`, so hud.js's per-line sidebar toggle
  // (U12) can hide one line's whole glow stack with a single shared
  // mechanism (map.setFilter on each id in this list) via the
  // `trackGlowLayerIds` param passed to createHud() below.
  const TRACK_GLOW_LAYER_IDS = ['l-tracks-wide', 'l-tracks-mid', 'l-tracks-core'];
  function addTrackUnderglow() {
    // U15: a stable string `id` per feature is what lets the frame loop
    // below target this exact feature with setFeatureState() every frame —
    // GeoJSON sources need an explicit id for that; the line key is already
    // unique so it doubles as one with no extra bookkeeping.
    const features = Object.entries(tracks).map(([key, line]) => ({
      type: 'Feature',
      id: key,
      properties: {
        line: key,
        color: LINE_COLORS[key] ? rgbString(LINE_COLORS[key]) : 'rgb(80, 80, 120)',
      },
      geometry: { type: 'LineString', coordinates: line.coords },
    }));
    if (map.getSource('l-tracks')) return;
    map.addSource('l-tracks', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    // U15: every pass's opacity carries an extra multiplier read from
    // per-feature state (default 1 — untouched until the frame loop below
    // has ever called setFeatureState for that line). Only opacity, not
    // color, is feature-state driven here: unlike the deck.gl train glow in
    // layers.js (plain JS, recomputed every frame with no such limit),
    // animating a MapLibre paint *color* smoothly via feature-state risks a
    // gap before the first frame writes a value — a numeric multiplier
    // defaulting safely to 1 via `coalesce` has no such failure mode. The
    // moving trains' own glow already carries the full color shift (R12);
    // this is a subtler, opacity-only echo on the static network.
    const stressOpacity = ['coalesce', ['feature-state', 'stressOpacity'], 1];
    // Wide soft bloom halo — most of the "glow" read comes from this pass.
    map.addLayer({
      id: 'l-tracks-wide',
      type: 'line',
      source: 'l-tracks',
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['*', 0.22, stressOpacity],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 16, 18],
        'line-blur': 3.5,
      },
    });
    // Mid pass — softens the step between the wide halo and the hairline
    // core so the falloff reads as continuous bloom rather than two rings.
    map.addLayer({
      id: 'l-tracks-mid',
      type: 'line',
      source: 'l-tracks',
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['*', 0.55, stressOpacity],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 6],
        'line-blur': 1.2,
      },
    });
    // Hairline bright core — the actual "line" a viewer's eye follows.
    // Near-opaque at its own saturated color (not white) so each line's
    // hue stays identifiable at a glance, even crossing a building crown.
    map.addLayer({
      id: 'l-tracks-core',
      type: 'line',
      source: 'l-tracks',
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['*', 0.95, stressOpacity],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1.6],
      },
    });
  }
  map.on('load', () => {
    addTrackUnderglow();
    // Re-assert the intended camera: pane layout can shift during init and
    // leave the map at a stale transform.
    map.resize();
    map.jumpTo(LOOP_PRESET);
  });

  // Depth/occlusion decision (U7): interleaved stays false. With it false,
  // deck.gl composites its whole canvas over MapLibre's, so fill-extrusion
  // buildings never occlude train glow — at 1.9x heights and pitch 60 the
  // trails visibly glow through tower faces. Verified visually and judged
  // to read as part of the Blade Runner aesthetic (light overpowering
  // structure) rather than as a bug, so we keep interleaved: false rather
  // than pay for a shared depth buffer. Revisit only if a later unit's
  // visual gate calls the x-ray read out as a problem — switching to
  // interleaved: true is a bigger change (shared depth buffer with every
  // layer's `depthTest: false` in src/layers.js) with real risk to verify.
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  // Tron line pulses (design-first). TrainEngine/LIVE pollers stay in the
  // tree for a later pass but are not started here.
  const engine = new PulseEngine(tracks);
  const trackKeys = Object.keys(tracks);
  const visibleLines = new Set(trackKeys);
  const lastStressOpacity = new Map();
  const display = { trains: true, buses: true, cars: true, buildings: true, stations: false };

  let followed = null;

  function releaseFollow() {
    if (!followed) return;
    followed = null;
    hud.setFollowLabel(null);
  }

  function trailingId(id) {
    return String(id).replace(/^pulse-/, '').replace(/^mock-/, '').split('-').pop();
  }

  function followVehicle(kind, id, label) {
    followed = { kind, id };
    hud.setFollowLabel(label);
  }

  const hud = createHud({
    map,
    lineColors: LINE_COLORS,
    visibleLines,
    display,
    trackGlowLayerIds: TRACK_GLOW_LAYER_IDS,
    getStatus: () => feedStatus,
    onReleaseFollow: releaseFollow,
  });

  function handleVehicleClick(info) {
    if (!info.picked || !info.object) {
      releaseFollow();
      return;
    }
    if (info.layer?.id === 'glow-halo') {
      const t = info.object.t;
      followVehicle('train', t.id, `${t.line.toUpperCase()} · PULSE ${trailingId(t.id)}`);
    } else if (info.layer?.id === 'bus-capsules') {
      const b = info.object;
      followVehicle('bus', b.id, `ROUTE ${b.rt}`);
    } else if (info.layer?.id === 'car-bodies') {
      followVehicle('car', info.object.id, 'CAR');
    } else {
      releaseFollow();
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') releaseFollow();
  });

  overlay.setProps({ onClick: handleVehicleClick });

  engine.onStatus = setStatus;
  engine.seed(3);
  setStatus('mock');

  // U15: no EXPLORE/LIVE split here — the High-Level Technical Design's
  // alerts path (AL -> SS) isn't gated by MODE like trains/buses are; it's
  // real, keyless and cheap in both modes, so there's nothing to simulate.
  const alertsEngine = new AlertsEngine();
  alertsEngine.onStatus = () => {
    hud.refreshSystemStatus(alertsEngine.lineStatus, alertsEngine.lineHeadline);
  };
  alertsEngine.startLive();

  // Rolling FPS meter — nothing in the repo measures frame rate yet, and
  // KTD8's 30fps floor is unmeasurable without it. Exponential moving
  // average of instantaneous per-frame rate, smoothed enough to read
  // steadily but responsive enough to show real drops. Exposed on
  // `window.__fps` for scripted checks, rendered in the `.hud` #fps element.
  let lastFrameTime = performance.now();
  let fps = 0;
  let fpsLastPaint = lastFrameTime;

  function frame() {
    const t = performance.now();
    const dt = t - lastFrameTime;
    lastFrameTime = t;
    if (dt > 0) {
      const instantFps = 1000 / dt;
      fps = fps === 0 ? instantFps : fps + (instantFps - fps) * 0.1;
    }
    if (t - fpsLastPaint > 250) {
      fpsLastPaint = t;
      window.__fps = fps;
      fpsEl.textContent = `${Math.round(fps)} FPS`;
    }

    const trains = engine.tick();
    // busEngine/carEngine are null until their build artifact resolves (or
    // forever, if it failed to load — see the guarded fetches above); an
    // empty array here keeps buildLayers()'s "off = empty data, not an
    // omitted layer" convention intact rather than needing a special
    // no-engine branch per feed.
    const buses = busEngine ? busEngine.tick() : [];
    // U11: bounds gates which cars get updated at all (frozen off-viewport,
    // per the plan's viewport-culling requirement) — reads hud.js's own
    // cached bounds (updated on map 'move', not per frame) rather than
    // calling the allocating map.getBounds() a second time this frame.
    const cars = carEngine ? carEngine.tick(now(), hud.getBounds()) : [];

    // U17 step 2/3: recenters on the followed vehicle's *this-frame*
    // position, preserving zoom/pitch/bearing (setCenter touches only
    // center) — and releases cleanly the instant that vehicle isn't in this
    // frame's list at all, which covers both "stale/removed" and "a mode
    // switch cleared it" with the same one check, since either way it's
    // just absent now.
    if (followed) {
      const list = followed.kind === 'train' ? trains : followed.kind === 'bus' ? buses : cars;
      const vehicle = list.find((v) => v.id === followed.id);
      if (vehicle?.pos) map.setCenter(vehicle.pos);
      else releaseFollow();
    }

    hud.tick(trains);
    const center = map.getCenter();
    const currentTime = now();
    // U15: pushes each line's current opacity pulse onto its l-tracks-* GeoJSON
    // feature every frame — see addTrackUnderglow()'s stressOpacity comment for
    // why this is opacity-only, not a color change, on this particular layer.
    if (map.getSource('l-tracks')) {
      for (const key of trackKeys) {
        const tag = alertsEngine.lineStatus[key] ?? 'normal';
        const opacityMult = lineStressTreatment(tag, currentTime).opacityMult;
        if (lastStressOpacity.get(key) === opacityMult) continue;
        lastStressOpacity.set(key, opacityMult);
        map.setFeatureState({ source: 'l-tracks', id: key }, { stressOpacity: opacityMult });
      }
    }
    overlay.setProps({
      layers: buildLayers(trains, currentTime, visibleLines, {
        trailVersion: engine.trailVersion,
        stations,
        display,
        buses,
        busTrailVersion: busEngine?.trailVersion ?? 0,
        viewportCenter: [center.lng, center.lat],
        cars,
        zoom: map.getZoom(),
        lineStatus: alertsEngine.lineStatus,
        accessibilityStations: alertsEngine.stationFlags,
      }),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // debug handles (harmless in prod, invaluable in dev)
  window.__map = map;
  window.__engine = engine;
  window.__hud = hud;
  window.__busEngine = () => busEngine; // a getter, since busEngine is reassigned once patterns.json resolves
  window.__carEngine = () => carEngine; // same shape, for roads.json
  window.__alertsEngine = alertsEngine;
}

boot();
