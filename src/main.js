import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { DARK_CITY_STYLE, FALLBACK_STYLE, LOOP_PRESET } from './style.js';
import { now } from './trains.js';
import { PulseEngine } from './pulses.js';
import { BusEngine } from './buses.js';
import { CarEngine } from './cars.js';
import { AlertsEngine } from './alerts.js';
import {
  buildLayers,
  LINE_COLORS,
  rgbString,
  lineStressTreatment,
  PULSE_HEAD_TIP,
  PULSE_HEAD_JUNCTION,
} from './layers.js';
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

  // Side-by-side design compare: same pulse state, two head treatments.
  const mapOpts = {
    style: DARK_CITY_STYLE,
    center: LOOP_PRESET.center,
    zoom: LOOP_PRESET.zoom,
    pitch: LOOP_PRESET.pitch,
    bearing: LOOP_PRESET.bearing,
    maxPitch: 70,
    antialias: true,
    attributionControl: { compact: true },
  };
  const mapTip = new maplibregl.Map({ container: 'map-tip', ...mapOpts });
  const mapJunc = new maplibregl.Map({ container: 'map-junction', ...mapOpts });
  // Primary map for HUD camera / follow (left pane).
  const map = mapTip;

  for (const m of [mapTip, mapJunc]) {
    new ResizeObserver(() => m.resize()).observe(m.getContainer());
    m.on('error', (e) => {
      if (!m.__fellBack && /source|style|tile/i.test(String(e.error?.message))) {
        m.__fellBack = true;
        console.warn('[chi-tron] falling back to CARTO style:', e.error?.message);
        m.setStyle(FALLBACK_STYLE);
        m.once('styledata', () => addTrackUnderglow(m));
      }
    });
  }

  // Neon under-glow of the full network — applied to each compare pane.
  const TRACK_GLOW_LAYER_IDS = ['l-tracks-wide', 'l-tracks-mid', 'l-tracks-core'];
  function addTrackUnderglow(targetMap) {
    const features = Object.entries(tracks).map(([key, line]) => ({
      type: 'Feature',
      id: key,
      properties: {
        line: key,
        color: LINE_COLORS[key] ? rgbString(LINE_COLORS[key]) : 'rgb(80, 80, 120)',
      },
      geometry: { type: 'LineString', coordinates: line.coords },
    }));
    if (targetMap.getSource('l-tracks')) return;
    targetMap.addSource('l-tracks', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    const stressOpacity = ['coalesce', ['feature-state', 'stressOpacity'], 1];
    targetMap.addLayer({
      id: 'l-tracks-wide',
      type: 'line',
      source: 'l-tracks',
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['*', 0.18, stressOpacity],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 16, 14],
        'line-blur': 3,
      },
    });
    targetMap.addLayer({
      id: 'l-tracks-mid',
      type: 'line',
      source: 'l-tracks',
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['*', 0.45, stressOpacity],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 5],
        'line-blur': 1,
      },
    });
    targetMap.addLayer({
      id: 'l-tracks-core',
      type: 'line',
      source: 'l-tracks',
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['*', 0.92, stressOpacity],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 16, 1.8],
      },
    });
  }
  function onMapReady(m) {
    addTrackUnderglow(m);
    m.resize();
    m.jumpTo(LOOP_PRESET);
  }
  mapTip.on('load', () => onMapReady(mapTip));
  mapJunc.on('load', () => onMapReady(mapJunc));

  // Keep both panes on the same camera when the user pans the left (primary) map.
  let syncingCamera = false;
  mapTip.on('move', () => {
    if (syncingCamera) return;
    syncingCamera = true;
    const c = mapTip.getCenter();
    mapJunc.jumpTo({
      center: [c.lng, c.lat],
      zoom: mapTip.getZoom(),
      pitch: mapTip.getPitch(),
      bearing: mapTip.getBearing(),
    });
    syncingCamera = false;
  });
  mapJunc.on('move', () => {
    if (syncingCamera) return;
    syncingCamera = true;
    const c = mapJunc.getCenter();
    mapTip.jumpTo({
      center: [c.lng, c.lat],
      zoom: mapJunc.getZoom(),
      pitch: mapJunc.getPitch(),
      bearing: mapJunc.getBearing(),
    });
    syncingCamera = false;
  });

  const overlayTip = new MapboxOverlay({ interleaved: false, layers: [] });
  const overlayJunc = new MapboxOverlay({ interleaved: false, layers: [] });
  mapTip.addControl(overlayTip);
  mapJunc.addControl(overlayJunc);
  const overlay = overlayTip; // click-to-follow on primary pane

  // Tron line pulses (design-first). TrainEngine/LIVE pollers stay in the
  // tree for a later pass but are not started here.
  const engine = new PulseEngine(tracks);
  const trackKeys = Object.keys(tracks);
  const visibleLines = new Set(trackKeys);
  const lastStressOpacity = new Map();
  // Buses/cars off in compare so the pulse head treatments stay readable.
  const display = { trains: true, buses: false, cars: false, buildings: true, stations: false };

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
    trackMaps: [mapJunc],
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
  // 3 evenly spaced pulses per line.
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
    for (const m of [mapTip, mapJunc]) {
      if (!m.getSource('l-tracks')) continue;
      for (const key of trackKeys) {
        const tag = alertsEngine.lineStatus[key] ?? 'normal';
        const opacityMult = lineStressTreatment(tag, currentTime).opacityMult;
        const cacheKey = `${m.getContainer().id}:${key}`;
        if (lastStressOpacity.get(cacheKey) === opacityMult) continue;
        lastStressOpacity.set(cacheKey, opacityMult);
        m.setFeatureState({ source: 'l-tracks', id: key }, { stressOpacity: opacityMult });
      }
    }
    const layerBase = {
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
    };
    overlayTip.setProps({
      layers: buildLayers(trains, currentTime, visibleLines, {
        ...layerBase,
        pulseHead: PULSE_HEAD_TIP,
      }),
    });
    overlayJunc.setProps({
      layers: buildLayers(trains, currentTime, visibleLines, {
        ...layerBase,
        pulseHead: PULSE_HEAD_JUNCTION,
      }),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // debug handles (harmless in prod, invaluable in dev)
  window.__map = map;
  window.__mapTip = mapTip;
  window.__mapJunc = mapJunc;
  window.__engine = engine;
  window.__hud = hud;
  window.__busEngine = () => busEngine;
  window.__carEngine = () => carEngine;
  window.__alertsEngine = alertsEngine;
}

boot();
