import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  DARK_CITY_STYLE,
  FALLBACK_STYLE,
  LOOP_PRESET,
  CHICAGOLAND_BOUNDS,
  CHICAGOLAND_MIN_ZOOM,
  HEIGHT_EXAGGERATION,
  CROWN_LIGHT_DELTA,
} from './style.js';
import { now } from './trains.js';
import { PulseEngine } from './pulses.js';
import { BusEngine } from './buses.js';
import { CarEngine } from './cars.js';
import { AlertsEngine } from './alerts.js';
import { buildLayers, LINE_COLORS, rgbString, lineStressTreatment } from './layers.js';
import { createHud } from './hud.js';
import { prepareLine, pointAtDist } from './tracks.js';
import { RunSession } from './pulse-run/run-session.js';

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
  el.className = `hud ${
    state === 'lost' ? 'lost'
      : state === 'hold' ? 'hold'
        : state === 'disabled' ? 'disabled'
          : state === 'run' ? 'run'
            : 'live'
  }`;
  el.textContent = labels[state] ?? labels.live;
}

const TRAIN_STATUS_LABELS = {
  mock: 'SIM MODE',
  lost: 'SIGNAL LOST',
  hold: 'BUDGET HOLD',
  live: 'LIVE FEED',
  run: 'PULSE RUN',
};
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

  // Single full-bleed map — cold steel + cyan haze baseline, tip-only pulses.
  const map = new maplibregl.Map({
    container: 'map',
    style: DARK_CITY_STYLE,
    center: LOOP_PRESET.center,
    zoom: LOOP_PRESET.zoom,
    pitch: LOOP_PRESET.pitch,
    bearing: LOOP_PRESET.bearing,
    maxPitch: 70,
    minZoom: CHICAGOLAND_MIN_ZOOM,
    maxBounds: CHICAGOLAND_BOUNDS,
    antialias: true,
    attributionControl: { compact: true },
  });
  // Phase C: Chicagoland hard stop (also re-assert after style swap).
  map.setMaxBounds(CHICAGOLAND_BOUNDS);
  map.setMinZoom(CHICAGOLAND_MIN_ZOOM);
  new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));
  requestAnimationFrame(() => requestAnimationFrame(() => map.resize()));

  map.on('error', (e) => {
    if (!map.__fellBack && /source|style|tile/i.test(String(e.error?.message))) {
      map.__fellBack = true;
      console.warn('[chi-tron] falling back to CARTO style:', e.error?.message);
      map.setStyle(FALLBACK_STYLE);
      map.once('styledata', addTrackUnderglow);
    }
  });

  const TRACK_GLOW_LAYER_IDS = ['l-tracks-wide', 'l-tracks-mid', 'l-tracks-core'];
  function addTrackUnderglow() {
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
    const stressOpacity = ['coalesce', ['feature-state', 'stressOpacity'], 1];
    map.addLayer({
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
    map.addLayer({
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
    map.addLayer({
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
  // Phase B: OSM shapes × City stories (honest heights). Same cold-steel
  // paint as OFM extrusions. OFM stays on outside the bake so CITY isn't void.
  function addChicagoBuildings(geojson) {
    if (map.getSource('chi-buildings')) return;
    map.addSource('chi-buildings', { type: 'geojson', data: geojson });
    const H = ['*', ['coalesce', ['get', 'h'], 8], HEIGHT_EXAGGERATION];
    const bodyStops = ['interpolate', ['linear'], H, 0, '#000104', 80, '#020308', 250, '#03050c', 600, '#050810'];
    const crownStops = ['interpolate', ['linear'], H, 0, '#040a14', 150, '#0a2038', 600, '#124868'];
    map.addLayer({
      id: 'chi-buildings-3d',
      type: 'fill-extrusion',
      source: 'chi-buildings',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': bodyStops,
        'fill-extrusion-height': H,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.97,
      },
    });
    map.addLayer({
      id: 'chi-buildings-3d-crown',
      type: 'fill-extrusion',
      source: 'chi-buildings',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': crownStops,
        'fill-extrusion-height': ['+', H, CROWN_LIGHT_DELTA],
        'fill-extrusion-base': H,
        'fill-extrusion-opacity': 0.58,
      },
    });
    // Chi sits on top of OFM downtown; leave OFM visible for metro outside bake.
    // Keep track glow above building mass.
    for (const id of TRACK_GLOW_LAYER_IDS) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  }

  let loadChicagoBuildings = null; // set after createHud so layer toggle rebinds safely
  map.on('load', () => {
    addTrackUnderglow();
    map.resize();
    map.jumpTo(LOOP_PRESET);
    map.setMaxBounds(CHICAGOLAND_BOUNDS);
    map.setMinZoom(CHICAGOLAND_MIN_ZOOM);
    loadChicagoBuildings?.();
  });

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  // Tip-only Tron pulses — trail is the vehicle (no disc heads).
  const engine = new PulseEngine(tracks);
  const runSession = new RunSession(tracks);
  const trackKeys = Object.keys(tracks);
  const visibleLines = new Set(trackKeys);
  const lastStressOpacity = new Map();
  const display = { trains: true, buses: true, cars: true, buildings: true, stations: false };

  /** @type {{ display: object } | null} */
  let runSnapshot = null;
  let followed = null;
  let keys = { space: false };
  let resultShownForPhase = null;

  function releaseFollow() {
    if (!followed) return;
    followed = null;
    hud.setFollowLabel(null);
  }

  function followVehicle(kind, id, label) {
    followed = { kind, id };
    hud.setFollowLabel(label);
  }

  function stationsReady() {
    return stations && Object.keys(stations).length > 0;
  }

  function sampleSegmentCoords(lineKey, startDist, goalDist, stepM = 25) {
    const prepared = prepareLine(tracks[lineKey]);
    const a = Math.min(startDist, goalDist);
    const b = Math.max(startDist, goalDist);
    const coords = [];
    for (let d = a; d <= b; d += stepM) {
      coords.push(pointAtDist(prepared, d));
    }
    coords.push(pointAtDist(prepared, b));
    return coords;
  }

  function setChallengeSegment(lineKey, startDist, goalDist) {
    const color = LINE_COLORS[lineKey] ? rgbString(LINE_COLORS[lineKey]) : 'rgb(0,212,255)';
    const coords = sampleSegmentCoords(lineKey, startDist, goalDist);
    const data = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { color },
          geometry: { type: 'LineString', coordinates: coords },
        },
      ],
    };
    if (!map.getSource('run-segment')) {
      map.addSource('run-segment', { type: 'geojson', data });
      map.addLayer({
        id: 'run-segment-glow',
        type: 'line',
        source: 'run-segment',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 16, 16],
          'line-blur': 2.5,
        },
      });
      map.addLayer({
        id: 'run-segment-core',
        type: 'line',
        source: 'run-segment',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, 3],
        },
      });
    } else {
      map.getSource('run-segment').setData(data);
      if (map.getLayer('run-segment-glow')) {
        map.setLayoutProperty('run-segment-glow', 'visibility', 'visible');
        map.setLayoutProperty('run-segment-core', 'visibility', 'visible');
      }
    }
  }

  function clearChallengeSegment() {
    if (map.getLayer('run-segment-glow')) {
      map.setLayoutProperty('run-segment-glow', 'visibility', 'none');
      map.setLayoutProperty('run-segment-core', 'visibility', 'none');
    }
  }

  function dimTracksForRun(challengeLine) {
    if (!map.getSource('l-tracks')) return;
    for (const key of trackKeys) {
      const mult = key === challengeLine ? 1 : 0.4;
      map.setFeatureState({ source: 'l-tracks', id: key }, { stressOpacity: mult });
      lastStressOpacity.set(key, mult);
    }
  }

  function enterRun(challengeId) {
    if (!stationsReady()) return;
    if (runSession.active) return;
    const result = runSession.start(challengeId, stations);
    if (!result.ok) {
      console.warn('[chi-tron] Pulse Run start failed:', result.error);
      return;
    }
    runSnapshot = {
      display: { ...display },
    };
    releaseFollow();
    display.buses = false;
    display.cars = false;
    display.trains = true;
    map.dragPan.disable();
    keys.space = false;

    const { challenge, baked, playerBolt } = {
      challenge: runSession.challenge,
      baked: runSession.baked,
      playerBolt: runSession.player,
    };
    setChallengeSegment(challenge.line, baked.startDist, baked.goalDist);
    dimTracksForRun(challenge.line);
    // Own-the-wire: no ambient pulses on challenge line
    engine.seed(3);
    for (const [id, p] of [...engine.pulses.entries()]) {
      if (p.line === challenge.line) engine.pulses.delete(id);
    }

    const cam = playerBolt.cameraTarget();
    map.jumpTo({
      center: cam.center,
      zoom: Math.max(map.getZoom(), 14.5),
      pitch: 58,
      bearing: cam.bearing,
    });

    setStatus('run');
    hud.showRunPanel(challenge);
    hud.hideResult();
    resultShownForPhase = null;
    hud.setFollowLabel(`PULSE · ${challenge.line.toUpperCase()}`);
  }

  function exitRun() {
    if (!runSession.active && !runSnapshot) {
      hud.hideRunPanel();
      return;
    }
    runSession.exit();
    if (runSnapshot) {
      Object.assign(display, runSnapshot.display);
      runSnapshot = null;
    }
    clearChallengeSegment();
    engine.seed(3);
    map.dragPan.enable();
    keys.space = false;
    resultShownForPhase = null;
    hud.hideRunPanel();
    hud.setFollowLabel(null);
    setStatus('mock');
    // restore stress opacity baseline
    lastStressOpacity.clear();
  }

  function retryRun() {
    if (!runSession.active && !runSession.challenge) return;
    if (!runSession.challenge) return;
    runSession.retry();
    keys.space = false;
    resultShownForPhase = null;
    hud.hideResult();
    const cam = runSession.player.cameraTarget();
    map.jumpTo({
      center: cam.center,
      zoom: Math.max(map.getZoom(), 14.5),
      pitch: 58,
      bearing: cam.bearing,
    });
    hud.showRunPanel(runSession.challenge);
  }

  const hud = createHud({
    map,
    lineColors: LINE_COLORS,
    visibleLines,
    display,
    trackGlowLayerIds: TRACK_GLOW_LAYER_IDS,
    getStatus: () => feedStatus,
    onReleaseFollow: releaseFollow,
    isStationsReady: stationsReady,
    isRunActive: () => runSession.active,
    onAppModeChange: (mode) => {
      if (mode === 'grid') exitRun();
    },
    onStartChallenge: (id) => enterRun(id),
    onRetryRun: () => retryRun(),
    onExitRun: () => {
      exitRun();
      hud.setAppModeUi('grid');
    },
  });

  // stations may arrive after boot — refresh challenge buttons
  const stationsReadyPoll = setInterval(() => {
    if (stationsReady()) {
      hud.setStationsReadyUi();
      clearInterval(stationsReadyPoll);
    }
  }, 200);

  loadChicagoBuildings = () => {
    fetch('/data/buildings.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((geojson) => {
        addChicagoBuildings(geojson);
        hud.setBuildingLayerIds(['chi-buildings-3d', 'chi-buildings-3d-crown']);
      })
      .catch((err) => {
        console.warn('[chi-tron] buildings.json missing/failed — OFM extrusions stay:', err.message);
      });
  };
  if (map.loaded()) loadChicagoBuildings();

  // Tip-only: no train head layer to pick — bus/car follow still works.
  function handleVehicleClick(info) {
    if (runSession.active) return;
    if (!info.picked || !info.object) {
      releaseFollow();
      return;
    }
    if (info.layer?.id === 'bus-capsules') {
      const b = info.object;
      followVehicle('bus', b.id, `ROUTE ${b.rt}`);
    } else if (info.layer?.id === 'car-bodies') {
      followVehicle('car', info.object.id, 'CAR');
    } else {
      releaseFollow();
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      if (runSession.active) {
        e.preventDefault();
        keys.space = true;
        runSession.setBoosting(true);
      }
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      if (runSession.phase === 'running') {
        e.preventDefault();
        runSession.reverse();
      }
      return;
    }
    if (e.key === 'Enter') {
      if (runSession.phase === 'finished' || runSession.phase === 'failed') {
        e.preventDefault();
        retryRun();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (runSession.active) {
        e.preventDefault();
        exitRun();
        hud.setAppModeUi('grid');
        return;
      }
      releaseFollow();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      keys.space = false;
      runSession.setBoosting(false);
    }
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

    const runSnap = runSession.active ? runSession.tick() : null;
    if (runSnap) {
      runSession.setBoosting(keys.space);
      hud.updateRunTimer(runSnap.elapsedS);
      if (runSnap.phase === 'countdown') {
        const color = LINE_COLORS[runSnap.challenge.line];
        hud.showCountdown(runSnap.countdownLeft, color);
      } else {
        hud.hideCountdown();
      }
      if (
        (runSnap.phase === 'finished' || runSnap.phase === 'failed') &&
        resultShownForPhase !== runSnap.phase
      ) {
        // Finish freeze: wait briefly before showing card
        if (performance.now() >= (runSnap.finishFreezeUntil || 0)) {
          resultShownForPhase = runSnap.phase;
          hud.showResult({
            grade: runSnap.grade,
            elapsedS: runSnap.elapsedS,
            share: runSnap.share,
            failed: runSnap.phase === 'failed',
          });
        }
      }
      if (runSnap.playerBolt) {
        const cam = runSnap.playerBolt.cameraTarget();
        map.setCenter(cam.center);
        map.setBearing(cam.bearing);
      }
    }

    let trains = engine.tick();
    // Own-the-wire: suppress ambient pulses on the challenge line during RUN
    if (runSnap?.challenge) {
      trains = trains.filter((p) => p.line !== runSnap.challenge.line);
    }
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
    if (followed && !runSession.active) {
      const list = followed.kind === 'train' ? trains : followed.kind === 'bus' ? buses : cars;
      const vehicle = list.find((v) => v.id === followed.id);
      if (vehicle?.pos) map.setCenter(vehicle.pos);
      else releaseFollow();
    }

    hud.tick(runSnap?.player ? [...trains, runSnap.player] : trains);
    const center = map.getCenter();
    const currentTime = now();
    // U15: pushes each line's current opacity pulse onto its l-tracks-* GeoJSON
    // feature every frame — see addTrackUnderglow()'s stressOpacity comment for
    // why this is opacity-only, not a color change, on this particular layer.
    // During RUN we own stressOpacity for dimming; skip alert pulse overwrite.
    if (map.getSource('l-tracks') && !runSession.active) {
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
        player: runSnap?.player ?? null,
        playerTrailVersion: runSession.player?.trailVersion ?? 0,
      }),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__map = map;
  window.__engine = engine;
  window.__hud = hud;
  window.__runSession = runSession;
  window.__busEngine = () => busEngine;
  window.__carEngine = () => carEngine;
  window.__alertsEngine = alertsEngine;
}

boot();
