/**
 * Live L nav: every line with live:true in catalog LINE_DEFS, plus the full
 * CTA bus tracker. Map-first (Maps / Pokémon Go philosophy).
 *
 * This file is wiring only. The substance lives in focused modules:
 *   src/map-stage.js  map, basemap layers, camera modes
 *   src/board.js      the single-line arrival sheet
 *   src/browse.js     Train | Bus → routes → stops navigation
 *   src/bus-data.js   the lazy 3.2 MB bus bake
 *   src/hud.js        instrument chrome
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import { now, TrainEngine } from './trains.js';
import { BusEngine } from './buses.js';
import { AlertsEngine } from './alerts.js';
import { buildLayers, LINE_COLORS, lineStressTreatment } from './layers.js';
import { createHud } from './hud.js';
import { ArrivalsSession } from './arrivals.js';
import { BusArrivalsSession } from './bus-arrivals.js';
import { startWatch, nearestStation, walkMinutes } from './geolocation.js';
import { snapStationsToRails } from './stations-rail.js';
import { liveLineKeys, liveStationsUnion } from './catalog.js';
import { activeSurface, listFabAction, searchFabAction, dismissTopAction } from './ui-nav.js';
import { createMapStage, TRACK_GLOW_LAYER_IDS } from './map-stage.js';
import { createBusData } from './bus-data.js';
import { createBoard } from './board.js';
import { createBrowse } from './browse.js';
import { DivvyEngine, normalizeStations } from './divvy.js';

const statusEl = document.getElementById('status');
const busStatusEl = document.getElementById('bus-status');
const clockEl = document.getElementById('clock');
const fpsEl = document.getElementById('fps');

let feedStatus = 'boot'; // read by hud.js's tick() to render the em-dash no-data state

// U14's states (mock/lost/hold/live) plus U9's bus-only 'disabled' all share
// one className rule and one "state -> label" lookup shape.
function renderFeedStatus(el, state, labels) {
  if (!el) return;
  // U14: 'hold' is the poll governor's BUDGET HOLD state (src/poller.js) —
  // the feed hit its self-imposed daily ceiling (R10) and has stopped
  // issuing requests until the ledger's local date rolls over.
  el.className = `hud ${state === 'lost' ? 'lost' : state === 'hold' ? 'hold' : state === 'disabled' ? 'disabled' : 'live'}`;
  el.textContent = labels[state] ?? labels.live;
}

const TRAIN_STATUS_LABELS = {
  mock: 'SIM MODE',
  lost: 'SIGNAL LOST',
  hold: 'BUDGET HOLD',
  live: 'LIVE · L',
};
function setStatus(state) {
  feedStatus = state;
  renderFeedStatus(statusEl, state, TRAIN_STATUS_LABELS);
}

const BUS_STATUS_LABELS = {
  mock: 'BUS SIM',
  lost: 'BUS LOST',
  hold: 'BUS HOLD',
  live: 'BUS LIVE',
  disabled: 'BUS OFF',
};
function setBusStatus(state = 'disabled') {
  renderFeedStatus(busStatusEl, state, BUS_STATUS_LABELS);
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}, 1000);

/** How long after the map is up to start the bus bake if the map never idles. */
const BUS_PREFETCH_FALLBACK_MS = 4000;

async function boot() {
  // Only tracks.json is load-bearing: the map cannot draw a line without it.
  // stations.json is optional (a failure just dims the ring layer) and the
  // 3.2 MB bus bake is deferred entirely — see src/bus-data.js for why.
  const tracksPromise = fetch('/data/tracks.json').then((r) => r.json());
  const stationsPromise = fetch('/data/stations.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch((err) => {
      console.warn('[chi-tron] stations.json failed to load, station markers disabled:', err.message);
      return {};
    });

  setBusStatus('disabled');

  const tracks = await tracksPromise;
  const stage = createMapStage({ tracks });
  const { map, overlay } = stage;

  // Snap markers onto rail geometry so the 3D world reads as one system.
  // Held in a box because stations arrive after the map is already live.
  let stations = {};
  const getStations = () => stations;
  stationsPromise.then((raw) => {
    stations = snapStationsToRails(tracks, raw);
  });

  const engine = new TrainEngine(tracks);
  const busEngine = new BusEngine();
  // Empty construct — cold open must not await bike bake (same rule as buses).
  const divvyEngine = new DivvyEngine();
  const alertsEngine = new AlertsEngine();
  const arrivals = new ArrivalsSession();
  const busArrivals = new BusArrivalsSession();

  let bikeStationsReady = false;
  /** @type {Promise<void>|null} */
  let bikeLoadInFlight = null;

  function ensureBikeData() {
    if (bikeStationsReady) return Promise.resolve();
    if (bikeLoadInFlight) return bikeLoadInFlight;
    bikeLoadInFlight = (async () => {
      try {
        const res = await fetch('/data/divvy-stations.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const stations = normalizeStations(raw);
        divvyEngine.loadStations(stations);
        bikeStationsReady = stations.length > 0;
        if (bikeStationsReady) {
          display.bikes = true;
          divvyEngine.onStatus = () => {
            // Re-render open bike browse/board when a poll lands.
            browse.onBikeDataChange();
            const live = divvyEngine.tick();
            board.refreshBikeIfOpen((id) => live.find((s) => s.id === id));
          };
          divvyEngine.startLive();
          hud.syncDisplayButtons();
          browse.onBikeDataChange();
        }
      } catch (err) {
        console.warn('[chi-tron] divvy-stations.json failed:', err?.message || err);
        bikeStationsReady = false;
        // Allow retry on next ensureBikeData() call.
        bikeLoadInFlight = null;
      }
    })();
    return bikeLoadInFlight;
  }

  const trackKeys = Object.keys(tracks);
  const visibleLines = new Set(liveLineKeys());
  const lastStressOpacity = new Map();
  const display = {
    trains: true,
    buses: false, // flipped on when the bus bake lands
    bikes: false, // flipped on when divvy stations land
    cars: false,
    buildings: true,
    stations: true,
  };

  const busData = createBusData({
    onChange: (data) => {
      if (data.status !== 'ready') return;
      display.buses = data.feedReady;
      // startLive() sizes its ledger from routePids, so patterns must be in
      // the engine before the first poll is scheduled.
      if (data.mapReady) {
        busEngine.loadPatterns(data.patterns);
        busEngine.onStatus = setBusStatus;
        busEngine.startLive();
      } else {
        setBusStatus('disabled');
      }
      hud.syncDisplayButtons(); // BUSES starts off; the bake turns it on
      browse.onBusDataChange();
    },
  });

  // Board and browse each need the other: opening a station closes browse,
  // and the board's back affordance reopens the list it came from. One of the
  // two must therefore be declared before it can be built. `board` is assigned
  // immediately below, and browse only ever reaches it from a click handler,
  // long after both exist.
  /** @type {ReturnType<typeof createBoard>} */
  // eslint-disable-next-line prefer-const -- late binding breaks the cycle
  let board;

  const browse = createBrowse({
    getStations,
    busData,
    // Prefer live status join; fall back to static bake so the list works
    // before the first 60s poll lands.
    getBikeStations: () => {
      const live = divvyEngine.tick();
      if (live.length) return live;
      return divvyEngine.stations.map((s) => ({
        ...s,
        classic: 0,
        ebikes: 0,
        docks: s.capacity || 0,
        renting: true,
        returning: true,
        reportedAt: 0,
      }));
    },
    bikeReady: () => bikeStationsReady,
    ensureBikeData,
    onOpenStation: (station, opts) => board.openStation(station, opts),
    onOpenBusStop: (stop, opts) => board.openBusStop(stop, opts),
    onOpenBikeStation: (station, opts) => board.openBikeStation(station, opts),
    isBoardOpen: () => board.isOpen(),
    closeBoard: () => board.close({ restoreBrowse: false }),
  });

  board = createBoard({
    stage,
    arrivals,
    busArrivals,
    getBusCatalog: () => busData.catalog,
    getLineStatus: () => alertsEngine.lineStatus,
    getBrowseLineKey: () => browse.lineKey,
    onOpen: () => browse.close(),
    onRestoreBrowse: (nav) => browse.restore(nav),
  });

  const currentSurface = () => activeSurface(browse.isOpen(), board.isOpen());

  function dismissTopSurface() {
    const act = dismissTopAction(currentSurface());
    if (act === 'close-board') board.close({ restoreBrowse: false });
    else if (act === 'close-browse') browse.close();
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

  // Nav chrome: collapse instrument sidebar noise — map is primary.
  document.getElementById('sidebar')?.classList.add('nav-compact');

  stage.whenReady(() => {
    stage.loadBuildings((layerIds) => hud.setBuildingLayerIds(layerIds));
    // Let the basemap tiles win the network first, then pull the bus bake in
    // the background so map vehicles appear without the user asking. `idle`
    // is the honest signal; the timer covers a map that never settles.
    map.once('idle', () => {
      busData.ensureLoaded();
      ensureBikeData();
    });
    setTimeout(() => {
      busData.ensureLoaded();
      ensureBikeData();
    }, BUS_PREFETCH_FALLBACK_MS);
  });

  // ---- vehicle follow ---------------------------------------------------
  /** @type {{kind: string, id: string}|null} */
  let followed = null;

  function releaseFollow() {
    if (!followed) return;
    followed = null;
    hud.setFollowLabel(null);
  }

  function followVehicle(kind, id, label) {
    stage.followMe = false;
    followed = { kind, id };
    hud.setFollowLabel(label);
  }

  // ---- geolocation (Maps follow) ----------------------------------------
  const nearestChip = document.getElementById('nearest-chip');
  const locChip = document.getElementById('loc-chip');
  let userFix = null;
  let geoWatch = null;

  // Walk distance uses GTFS (entrance) coords; map markers use snapped coords.
  const liveStationsForWalk = () =>
    liveStationsUnion(stations).map((s) => ({ ...s, id: s.id, coords: s.gtfsCoords || s.coords }));

  function updateNearestChip() {
    if (!nearestChip || !userFix) {
      nearestChip?.classList.remove('visible');
      return;
    }
    const hit = nearestStation([userFix.lon, userFix.lat], liveStationsForWalk());
    if (!hit) {
      nearestChip.classList.remove('visible');
      return;
    }
    nearestChip.textContent = `${hit.station.name} · ~${walkMinutes(hit.distM)} min walk`;
    nearestChip.classList.add('visible');
    nearestChip.onclick = () => board.openStation(hit.station, { source: 'map' });
  }

  function enableLocation() {
    if (geoWatch) return;
    locChip?.classList.remove('visible');
    geoWatch = startWatch({
      highAccuracy: true,
      onFix: (fix) => {
        userFix = fix;
        updateNearestChip();
        if (stage.followMe && fix) {
          map.easeTo({ center: [fix.lon, fix.lat], duration: 400, essential: true });
        }
      },
      onError: (err) => {
        console.warn('[chi-tron] geolocation:', err.message || err.code);
        locChip?.classList.add('visible');
        if (locChip) locChip.textContent = 'LOCATION OFF';
        stage.followMe = false;
      },
    });
    stage.followMe = true;
    releaseFollow();
  }

  // ---- chrome wiring ----------------------------------------------------
  document.getElementById('fab-locate')?.addEventListener('click', () => {
    browse.close();
    board.close({ restoreBrowse: false });
    enableLocation();
    if (userFix) {
      stage.followMe = true;
      stage.easeToPoint([userFix.lon, userFix.lat], { zoom: 15, duration: 600 });
    }
  });

  document.getElementById('fab-lines')?.addEventListener('click', () => {
    const act = listFabAction(currentSurface());
    if (act === 'close-browse') {
      browse.close();
      return;
    }
    if (act === 'board-to-browse') {
      board.close({ restoreBrowse: false });
      browse.setKind('train');
    }
    browse.open('lines');
  });

  document.getElementById('fab-search')?.addEventListener('click', () => {
    const act = searchFabAction(currentSurface(), browse.isSearch());
    if (act === 'close-browse') browse.close();
    else browse.open('search');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const surface = currentSurface();
    if (surface === 'browse' || surface === 'board') dismissTopSurface();
    else releaseFollow();
  });

  overlay.setProps({
    onClick: (info) => {
      if (!info.picked || !info.object) {
        // Empty map: dismiss the top sheet only (one surface at a time).
        dismissTopSurface();
        return;
      }
      if (info.layer?.id === 'station-ring') {
        board.openStation(info.object);
        return;
      }
      if (info.layer?.id === 'divvy-stations') {
        board.openBikeStation(info.object, { source: 'map' });
        return;
      }
      if (info.layer?.id === 'glow-core') {
        const t = info.object;
        followVehicle('train', t.id, `${t.destNm || 'ORG'} · #${t.rn || '—'}`);
      }
    },
  });

  // ---- feeds ------------------------------------------------------------
  engine.onStatus = setStatus;
  engine.startLive();
  setStatus('live');

  alertsEngine.onStatus = () => {
    hud.refreshSystemStatus(alertsEngine.lineStatus, alertsEngine.lineHeadline);
  };
  alertsEngine.startLive();

  // ---- render loop ------------------------------------------------------
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
      if (fpsEl) fpsEl.textContent = `${Math.round(fps)} FPS`;
    }

    const trains = engine.tick();
    const buses = busData.mapReady ? busEngine.tick() : [];
    const bikes = bikeStationsReady ? divvyEngine.tick() : [];

    if (followed) {
      const vehicle = trains.find((v) => v.id === followed.id);
      if (vehicle?.pos) map.setCenter(vehicle.pos);
      else releaseFollow();
    }

    hud.tick(trains);
    const center = map.getCenter();
    const currentTime = now();
    if (map.getSource('l-tracks')) {
      for (const key of trackKeys) {
        const tag = alertsEngine.lineStatus[key] ?? 'normal';
        let opacityMult = lineStressTreatment(tag, currentTime).opacityMult;
        if (!visibleLines.has(key)) opacityMult *= 0.12; // dim non-live tracks
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
        busTrailVersion: busEngine.trailVersion,
        viewportCenter: [center.lng, center.lat],
        viewportBounds: (() => {
          const b = map.getBounds();
          return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        })(),
        cars: [],
        bikes,
        zoom: map.getZoom(),
        lineStatus: alertsEngine.lineStatus,
        accessibilityStations: alertsEngine.stationFlags,
        user: userFix ? { pos: [userFix.lon, userFix.lat], accuracyM: userFix.accuracyM } : null,
        selectedStationId: board.selectedStationId,
      }),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Debug handles used by the QA scripts in docs/ and by browser dogfooding.
  window.__map = map;
  window.__engine = engine;
  window.__busEngine = busEngine;
  window.__busData = busData;
  window.__divvyEngine = divvyEngine;
  window.__hud = hud;
  window.__arrivals = arrivals;
  window.__alertsEngine = alertsEngine;
  window.__openStation = (station, opts) => board.openStation(station, opts);
  window.__openBikeStation = (station, opts) => board.openBikeStation(station, opts);
}

boot();
