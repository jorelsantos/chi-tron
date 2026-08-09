import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  DARK_CITY_STYLE,
  FALLBACK_STYLE,
  LOOP_PRESET,
  AERIAL_2D,
  CITY_2D,
  LOOP_3D,
  PITCH_3D,
  CHICAGOLAND_BOUNDS,
  CHICAGOLAND_MIN_ZOOM,
  HEIGHT_EXAGGERATION,
  CROWN_LIGHT_DELTA,
} from './style.js';
import {
  activeSurface,
  listFabAction,
  searchFabAction,
  dismissTopAction,
} from './ui-nav.js';
import { now, TrainEngine } from './trains.js';
import { BusEngine } from './buses.js';
import { AlertsEngine } from './alerts.js';
import { buildLayers, LINE_COLORS, rgbString, lineStressTreatment } from './layers.js';
import { createHud } from './hud.js';
import {
  ArrivalsSession,
  groupArrivalsByDirection,
  shortDestName,
} from './arrivals.js';
import {
  BusArrivalsSession,
  groupBusByDirection,
} from './bus-arrivals.js';
import { startWatch, nearestStation, walkMinutes } from './geolocation.js';
import { snapStationsToRails } from './stations-rail.js';
import {
  stationsOrdered,
  searchStations,
  browseLinesLive,
  liveLineKeys,
  liveStationsUnion,
  lineDefByKey,
  lineColor,
  cleanStationName,
} from './catalog.js';
import {
  liveBusRoutes,
  mapLiveBusRouteIds,
  filterPatternsToRoutes,
  directionsForRoute,
  stopsForRoute,
  busRouteDef,
  normalizeBusCatalog,
  searchBusRoutes,
  routesWithDirections,
} from './bus-catalog.js';

// Live L nav: all lines with live:true in catalog LINE_DEFS.
// Map-first (Maps / Pokémon Go philosophy).
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
  let stationsRaw = {};
  const stationsPromise = fetch('/data/stations.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch((err) => {
      console.warn('[chi-tron] stations.json failed to load, station markers disabled:', err.message);
      return {};
    });
  const patternsPromise = fetch('/data/patterns.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch((err) => {
      console.warn('[chi-tron] patterns.json failed — bus layer off:', err.message);
      return {};
    });
  const busRoutesPromise = fetch('/data/bus-routes.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));

  setBusStatus('disabled');

  const tracks = await tracksPromise;
  stationsRaw = await stationsPromise;
  const patternsRaw = await patternsPromise;
  const busRoutesRaw = await busRoutesPromise;
  // Snap markers onto rail geometry so the 3D world reads as one system.
  stations = snapStationsToRails(tracks, stationsRaw);
  const busCatalog = normalizeBusCatalog(busRoutesRaw);
  // Map poll = mapLive only; routeDirections kept for full tracker browse.
  const busPatterns = filterPatternsToRoutes(patternsRaw, mapLiveBusRouteIds(busCatalog));
  const busEngine = new BusEngine(busPatterns);
  const busArrivals = new BusArrivalsSession();
  const busBoardRoutes = routesWithDirections(busPatterns, busCatalog);
  const busFeedReady = busBoardRoutes.length > 0;
  const busMapReady = Object.keys(busPatterns.routes || {}).length > 0;

  // Tracker cold-open: flat aerial Loop (2D). 3D via map view control.
  const map = new maplibregl.Map({
    container: 'map',
    style: DARK_CITY_STYLE,
    center: AERIAL_2D.center,
    zoom: AERIAL_2D.zoom,
    pitch: AERIAL_2D.pitch,
    bearing: AERIAL_2D.bearing,
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

  /** @type {boolean} 2D (pitch 0) vs 3D instrument pitch */
  let mapIs3d = false;
  function syncViewButtons() {
    document.getElementById('btn-view-2d')?.setAttribute('aria-pressed', String(!mapIs3d));
    document.getElementById('btn-view-3d')?.setAttribute('aria-pressed', String(mapIs3d));
  }
  // Wired after followMe exists (see below).

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
    map.jumpTo(AERIAL_2D);
    map.setMaxBounds(CHICAGOLAND_BOUNDS);
    map.setMinZoom(CHICAGOLAND_MIN_ZOOM);
    loadChicagoBuildings?.();
  });

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  // Live L trains + MVP buses (8 + 62 only).
  const engine = new TrainEngine(tracks);
  const trackKeys = Object.keys(tracks);
  const visibleLines = new Set(liveLineKeys());
  const lastStressOpacity = new Map();
  const display = {
    trains: true,
    buses: busFeedReady,
    cars: false,
    buildings: true,
    stations: true,
  };

  if (busMapReady) {
    busEngine.onStatus = (state) => setBusStatus(state);
    busEngine.startLive();
  } else if (busFeedReady) {
    // Tracker boards work without map vehicles.
    setBusStatus('disabled');
  } else {
    setBusStatus('disabled');
  }

  // Filter underglow to live lines only
  function filterTracksToLive() {
    const live = liveLineKeys();
    for (const id of TRACK_GLOW_LAYER_IDS) {
      if (map.getLayer(id)) {
        map.setFilter(id, ['in', ['get', 'line'], ['literal', live]]);
      }
    }
  }
  map.on('load', filterTracksToLive);
  if (map.loaded()) filterTracksToLive();

  let followed = null; // vehicle follow (train)
  let followMe = false;

  function setMap2d() {
    mapIs3d = false;
    followMe = false;
    map.easeTo({ pitch: 0, bearing: 0, duration: 700, essential: true });
    syncViewButtons();
  }
  function setMap3d() {
    mapIs3d = true;
    followMe = false;
    map.easeTo({
      pitch: PITCH_3D,
      bearing: LOOP_3D.bearing,
      zoom: Math.max(map.getZoom(), 14.2),
      duration: 900,
      essential: true,
    });
    syncViewButtons();
  }
  function liveOverview() {
    followMe = false;
    mapIs3d = false;
    syncViewButtons();
    map.easeTo({
      center: CITY_2D.center,
      zoom: CITY_2D.zoom,
      pitch: 0,
      bearing: 0,
      duration: 1100,
      essential: true,
    });
  }
  document.getElementById('btn-view-2d')?.addEventListener('click', setMap2d);
  document.getElementById('btn-view-3d')?.addEventListener('click', setMap3d);
  document.getElementById('btn-live-overview')?.addEventListener('click', liveOverview);
  syncViewButtons();
  let userFix = null;
  let geoWatch = null;
  let selectedStationId = null;
  const arrivals = new ArrivalsSession();

  // Walk distance uses GTFS (entrance) coords; map markers use rail-snapped coords.
  const liveStationsForWalk = () =>
    liveStationsUnion(stations).map((s) => ({
      ...s,
      id: s.id,
      coords: s.gtfsCoords || s.coords,
    }));

  function releaseFollow() {
    if (!followed) return;
    followed = null;
    hud.setFollowLabel(null);
  }

  function followVehicle(kind, id, label) {
    followMe = false;
    followed = { kind, id };
    hud.setFollowLabel(label);
  }

  // ---- Station sheet (Maps place card) ---------------------------------
  const sheetEl = document.getElementById('station-sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetMeta = document.getElementById('sheet-meta');
  const sheetRows = document.getElementById('sheet-rows');
  const sheetUpdated = document.getElementById('sheet-updated');
  const nearestChip = document.getElementById('nearest-chip');
  const locChip = document.getElementById('loc-chip');
  /** @type {{ source: 'map'|'stations'|'search', lineKey?: string, query?: string }|null} */
  let boardNav = null;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Board is always one line: the line you entered from (browse), or a
   * resolved single line for map/search. No multi-line transfer dump.
   * @param {object} station
   * @param {string} [preferredKey]
   */
  function resolveBoardLineKey(station, preferredKey) {
    const live = liveLineKeys();
    const onStation = (station?.lines || []).filter((k) => live.includes(k));
    if (preferredKey && onStation.includes(preferredKey)) return preferredKey;
    if (preferredKey && live.includes(preferredKey) && !(station?.lines?.length)) return preferredKey;
    if (browseLineKey && onStation.includes(browseLineKey)) return browseLineKey;
    if (onStation.length === 1) return onStation[0];
    if (onStation.includes('Org')) return 'Org';
    return onStation[0] || live[0] || 'Org';
  }

  function renderSheetRows(rows, error, loaded = false, boardLineKey = 'Org') {
    if (!sheetRows) return;
    sheetRows.replaceChildren();
    if (error && !rows?.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = error === 'BUDGET HOLD' ? 'BUDGET HOLD' : 'NO PREDICTIONS';
      sheetRows.appendChild(empty);
      return;
    }
    if (!rows?.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = loaded ? 'NO PREDICTIONS' : 'LOADING…';
      sheetRows.appendChild(empty);
      return;
    }
    const orbColor = lineColor(boardLineKey);
    const groups = groupArrivalsByDirection(rows);
    for (const g of groups) {
      const section = document.createElement('section');
      section.className = 'dir-section';
      section.setAttribute('aria-label', g.title);

      const h = document.createElement('div');
      h.className = `dir-header dir-${g.kind || 'other'}`;
      const count = g.rows.length;
      h.innerHTML = `
        <span class="dir-title">${escapeHtml(g.title)}</span>
        <span class="dir-count">${count} ${count === 1 ? 'train' : 'trains'}</span>
      `;
      section.appendChild(h);

      for (const r of g.rows) {
        const row = document.createElement('div');
        row.className = 'arrival-row';
        if (r.isDly) row.classList.add('delayed');
        if (r.isApp) row.classList.add('approaching');
        const minsLabel = r.minutes === 'DUE' || r.isApp ? 'DUE' : String(r.minutes);
        const minsClass = minsLabel === 'DUE' ? 'arr-mins due' : 'arr-mins';
        const dest = shortDestName(r);
        const clock = r.clock || '';
        row.innerHTML = `
          <span class="arr-orb" style="background:radial-gradient(circle at 32% 28%, rgba(255,255,255,0.4) 0%, transparent 42%), rgb(${orbColor.join(',')})" aria-hidden="true"></span>
          <span class="arr-dest">${escapeHtml(dest)}</span>
          <span class="arr-clock">${escapeHtml(clock)}</span>
          <span class="${minsClass}">${escapeHtml(minsLabel)}</span>
        `;
        section.appendChild(row);
      }
      sheetRows.appendChild(section);
    }
  }

  function syncSheetBackUi() {
    const showBack = boardNav && boardNav.source !== 'map';
    sheetEl?.classList.toggle('has-back', Boolean(showBack));
  }

  /**
   * @param {object} station
   * @param {{ fly?: boolean, source?: 'map'|'stations'|'search', lineKey?: string, query?: string }} [opts]
   */
  function openStation(station, { fly = true, source = 'map', lineKey, query } = {}) {
    if (!station?.id) return;
    const boardLineKey = resolveBoardLineKey(station, lineKey);
    const def = lineDefByKey(boardLineKey);
    const rt = def?.rt || null;
    boardNav = { source, kind: 'train', lineKey: boardLineKey, query: query || '' };
    closeBrowse();
    busArrivals.close();
    selectedStationId = station.id;
    sheetEl?.classList.add('open');
    syncSheetBackUi();
    if (sheetTitle) sheetTitle.textContent = cleanStationName(station.name || station.id);
    if (sheetMeta) {
      const st = alertsEngine.lineStatus?.[boardLineKey] ?? 'normal';
      const label = (def?.name || boardLineKey).replace(/ Line$/i, '').toUpperCase();
      sheetMeta.textContent = `${label} · ${String(st).toUpperCase()}`;
    }
    renderSheetRows([], null, false, boardLineKey);
    if (sheetUpdated) sheetUpdated.textContent = 'AS OF —';
    arrivals.onUpdate = ({ rows, updatedAt, error, loaded }) => {
      renderSheetRows(rows, error, Boolean(loaded), boardLineKey);
      if (sheetUpdated && updatedAt) {
        sheetUpdated.textContent = `AS OF ${new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      }
    };
    // Single-line board: only the line you entered from (browse Red/Orange/etc.)
    arrivals.open(station.id, rt);
    if (fly && station.coords) {
      map.easeTo({
        center: station.coords,
        zoom: Math.max(map.getZoom(), 14.8),
        duration: 700,
        essential: true,
      });
    }
  }

  function closeStation({ restoreBrowse = false } = {}) {
    const nav = boardNav;
    selectedStationId = null;
    arrivals.close();
    busArrivals.close();
    sheetEl?.classList.remove('open');
    sheetEl?.classList.remove('has-back');
    boardNav = null;
    if (restoreBrowse && nav && nav.source !== 'map') {
      if (nav.kind === 'bus') {
        browseKind = 'bus';
        browseBusRt = nav.busRt || browseBusRt;
        browseBusRtdir = nav.busRtdir || browseBusRtdir;
        openBrowse('stations');
      } else if (nav.source === 'search') {
        browseKind = 'train';
        openBrowse('search');
        if (browseSearchInput && nav.query) {
          browseSearchInput.value = nav.query;
          renderBrowseSearch(nav.query);
        }
      } else {
        browseKind = 'train';
        browseLineKey = nav.lineKey || 'Org';
        openBrowse('stations');
      }
    }
  }

  /** Bus stop board — single route only (same rule as trains). */
  function openBusStop(stop, { rt, rtdir, source = 'stations' } = {}) {
    if (!stop?.stpid) return;
    const routeRt = String(rt || browseBusRt);
    const dir = rtdir || browseBusRtdir || '';
    const def = busRouteDef(busCatalog, routeRt) || busRouteDef(routeRt);
    boardNav = {
      source,
      kind: 'bus',
      busRt: routeRt,
      busRtdir: dir,
      lineKey: null,
      query: '',
    };
    closeBrowse();
    selectedStationId = null;
    arrivals.close();
    sheetEl?.classList.add('open');
    syncSheetBackUi();
    if (sheetTitle) sheetTitle.textContent = stop.name || `Stop ${stop.stpid}`;
    const dirBit = dir ? ` · ${dir.toUpperCase()}` : '';
    if (sheetMeta) {
      sheetMeta.textContent = `${routeRt} · ${(def?.name || 'BUS').toUpperCase()}${dirBit}`;
    }
    renderBusSheetRows([], null, false);
    if (sheetUpdated) sheetUpdated.textContent = 'AS OF —';
    busArrivals.onUpdate = ({ rows, updatedAt, error, loaded }) => {
      renderBusSheetRows(rows, error, Boolean(loaded));
      if (sheetUpdated && updatedAt) {
        sheetUpdated.textContent = `AS OF ${new Date(updatedAt).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        })}`;
      }
    };
    busArrivals.open(stop.stpid, routeRt);
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
      map.easeTo({
        center: [stop.lon, stop.lat],
        zoom: Math.max(map.getZoom(), 14.8),
        duration: 700,
        essential: true,
      });
    }
  }

  function renderBusSheetRows(rows, error, loaded = false) {
    if (!sheetRows) return;
    sheetRows.replaceChildren();
    if (error && !rows?.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent =
        error === 'BUDGET HOLD'
          ? 'BUDGET HOLD'
          : /key|HTTP|failed|network/i.test(String(error))
            ? 'FEED ERROR'
            : 'NO PREDICTIONS';
      sheetRows.appendChild(empty);
      return;
    }
    if (!rows?.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = loaded ? 'NO PREDICTIONS' : 'LOADING…';
      sheetRows.appendChild(empty);
      return;
    }
    const groups = groupBusByDirection(rows);
    for (const g of groups) {
      const section = document.createElement('section');
      section.className = 'dir-section';
      const h = document.createElement('div');
      h.className = 'dir-header';
      h.innerHTML = `
        <span class="dir-title">${escapeHtml(g.title)}</span>
        <span class="dir-count">${g.rows.length}</span>
      `;
      section.appendChild(h);
      for (const r of g.rows) {
        const row = document.createElement('div');
        row.className = 'arrival-row';
        if (r.delayed) row.classList.add('delayed');
        const minsLabel = r.minutes === 'DUE' ? 'DUE' : String(r.minutes);
        const minsClass = minsLabel === 'DUE' ? 'arr-mins due' : 'arr-mins';
        const dest = r.des || r.rtdir || '—';
        row.innerHTML = `
          <span class="arr-orb arr-orb-bus" aria-hidden="true"></span>
          <span class="arr-dest">${escapeHtml(dest)}</span>
          <span class="arr-clock">${escapeHtml(r.clock || '')}</span>
          <span class="${minsClass}">${escapeHtml(minsLabel)}</span>
        `;
        section.appendChild(row);
      }
      sheetRows.appendChild(section);
    }
  }

  document.getElementById('sheet-close')?.addEventListener('click', () => closeStation());
  document.getElementById('sheet-back')?.addEventListener('click', () => {
    closeStation({ restoreBrowse: true });
  });

  // ---- Browse: Train | Bus → routes/lines → stops/stations / Search ----
  const browseEl = document.getElementById('browse-sheet');
  const browseList = document.getElementById('browse-list');
  const browseTitle = document.getElementById('browse-title');
  const browseBack = document.getElementById('browse-back');
  const browseSearchInput = document.getElementById('browse-search-input');
  /** @type {'train'|'bus'} */
  let browseKind = 'train';
  /** @type {'lines'|'directions'|'stations'|'search'} */
  let browseMode = 'lines';
  let browseLineKey = liveLineKeys()[0] || 'Org';
  let browseBusRt = liveBusRoutes(busCatalog)[0]?.rt || '8';
  /** @type {string} CTA rtdir e.g. Northbound */
  let browseBusRtdir = '';
  let browseBusQuery = '';

  function orderedForLine(lineKey) {
    return stationsOrdered(stations, lineKey);
  }

  function appendLineOrbs(parent, lineKeys) {
    const wrap = document.createElement('span');
    wrap.className = 'line-orbs';
    const keys = lineKeys || [];
    const max = 5;
    const show = keys.slice(0, max);
    for (const k of show) {
      const orb = document.createElement('span');
      orb.className = 'line-orb';
      const c = lineColor(k);
      orb.style.background = `rgb(${c.join(',')})`;
      orb.title = lineDefByKey(k)?.name || k;
      wrap.appendChild(orb);
    }
    if (keys.length > max) {
      const more = document.createElement('span');
      more.className = 'line-orb-more';
      more.textContent = `+${keys.length - max}`;
      wrap.appendChild(more);
    }
    parent.appendChild(wrap);
  }

  function syncBrowseKindUi() {
    document.getElementById('browse-kind-train')?.classList.toggle('active', browseKind === 'train');
    document.getElementById('browse-kind-bus')?.classList.toggle('active', browseKind === 'bus');
    document.getElementById('browse-kind-train')?.setAttribute('aria-pressed', String(browseKind === 'train'));
    document.getElementById('browse-kind-bus')?.setAttribute('aria-pressed', String(browseKind === 'bus'));
  }

  function closeBrowse() {
    browseEl?.classList.remove('open');
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    document.getElementById('fab-lines')?.setAttribute('aria-pressed', 'false');
    document.getElementById('fab-search')?.setAttribute('aria-pressed', 'false');
    if (browseSearchInput) browseSearchInput.value = '';
    browseBusQuery = '';
  }

  function isBrowseOpen() {
    return Boolean(browseEl?.classList.contains('open'));
  }
  function isBoardOpen() {
    return Boolean(sheetEl?.classList.contains('open'));
  }
  function currentSurface() {
    return activeSurface(isBrowseOpen(), isBoardOpen());
  }

  function openBrowse(mode = 'lines') {
    // Exclusive surface: never stack board + browse.
    if (isBoardOpen()) closeStation({ restoreBrowse: false });
    browseMode = mode;
    browseEl?.classList.add('open');
    const showBusSearch = browseKind === 'bus' && mode === 'lines';
    browseEl?.classList.toggle('mode-search', mode === 'search' && browseKind === 'train');
    browseEl?.classList.toggle('mode-bus-list', showBusSearch);
    document.getElementById('fab-lines')?.setAttribute('aria-pressed', String(mode !== 'search'));
    document.getElementById('fab-search')?.setAttribute('aria-pressed', String(mode === 'search'));
    syncBrowseKindUi();
    if (mode === 'lines') {
      if (browseKind === 'bus' && browseSearchInput) {
        browseSearchInput.placeholder = 'Route # or name…';
        browseSearchInput.value = browseBusQuery;
      }
      renderBrowseLines();
    } else if (mode === 'directions' && browseKind === 'bus') {
      renderBrowseBusDirections(browseBusRt);
    } else if (mode === 'stations') {
      if (browseKind === 'bus') renderBrowseBusStops(browseBusRt, browseBusRtdir);
      else renderBrowseStations(browseLineKey);
    } else {
      browseKind = 'train';
      syncBrowseKindUi();
      if (browseSearchInput) browseSearchInput.placeholder = 'Station name…';
      renderBrowseSearch('');
    }
    if (mode === 'search' || showBusSearch) browseSearchInput?.focus();
  }

  function dismissTopSurface() {
    const act = dismissTopAction(currentSurface());
    if (act === 'close-board') closeStation({ restoreBrowse: false });
    else if (act === 'close-browse') closeBrowse();
  }

  function renderBrowseLines() {
    if (!browseList) return;
    browseMode = 'lines';
    if (browseBack) browseBack.hidden = true;
    browseList.replaceChildren();
    if (browseKind === 'bus') {
      browseEl?.classList.add('mode-bus-list');
      browseEl?.classList.remove('mode-search');
      if (browseTitle) browseTitle.textContent = 'Bus routes';
      if (browseSearchInput) {
        browseSearchInput.placeholder = 'Route # or name…';
        browseSearchInput.value = browseBusQuery;
      }
      const routes = searchBusRoutes(busBoardRoutes, browseBusQuery);
      if (!busFeedReady) {
        const empty = document.createElement('div');
        empty.className = 'sheet-empty';
        empty.textContent = 'BUS DATA OFF';
        browseList.appendChild(empty);
        return;
      }
      if (!routes.length) {
        const empty = document.createElement('div');
        empty.className = 'sheet-empty';
        empty.textContent = browseBusQuery.trim() ? 'NO MATCH' : 'NO LIVE ROUTES';
        browseList.appendChild(empty);
        return;
      }
      for (const route of routes) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'browse-row';
        const badge = document.createElement('span');
        badge.className = 'bus-route-badge';
        badge.textContent = route.rt;
        btn.appendChild(badge);
        const name = document.createElement('span');
        name.className = 'browse-name';
        name.textContent = route.name;
        btn.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = route.mapLive ? 'MAP' : 'LIVE';
        btn.appendChild(meta);
        const chev = document.createElement('span');
        chev.className = 'browse-chevron';
        chev.textContent = '›';
        btn.appendChild(chev);
        btn.addEventListener('click', () => {
          browseBusRt = route.rt;
          browseBusRtdir = '';
          renderBrowseBusDirections(route.rt);
        });
        browseList.appendChild(btn);
      }
      return;
    }

    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');

    if (browseTitle) browseTitle.textContent = 'Train lines';
    const lines = browseLinesLive();
    if (!lines.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'NO LIVE LINES';
      browseList.appendChild(empty);
      return;
    }
    for (const line of lines) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-row';
      const sw = document.createElement('span');
      sw.className = 'browse-swatch';
      sw.style.background = `rgb(${line.color.join(',')})`;
      sw.style.color = `rgb(${line.color.join(',')})`;
      btn.appendChild(sw);
      const name = document.createElement('span');
      name.className = 'browse-name';
      name.textContent = line.name;
      btn.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = 'LIVE';
      btn.appendChild(meta);
      const chev = document.createElement('span');
      chev.className = 'browse-chevron';
      chev.textContent = '›';
      btn.appendChild(chev);
      btn.addEventListener('click', () => {
        browseLineKey = line.key;
        renderBrowseStations(line.key);
      });
      browseList.appendChild(btn);
    }
  }

  function renderBrowseStations(lineKey) {
    if (!browseList) return;
    browseMode = 'stations';
    browseKind = 'train';
    syncBrowseKindUi();
    const line = lineDefByKey(lineKey) || browseLinesLive()[0];
    if (browseTitle) browseTitle.textContent = line?.name || lineKey;
    if (browseBack) browseBack.hidden = false;
    browseEl?.classList.remove('mode-search');
    browseList.replaceChildren();
    const list = orderedForLine(lineKey);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'NO STATIONS';
      browseList.appendChild(empty);
      return;
    }
    for (const s of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-row';
      appendLineOrbs(btn, s.lines || [lineKey]);
      const name = document.createElement('span');
      name.className = 'browse-name';
      name.textContent = cleanStationName(s.name || s.id);
      btn.appendChild(name);
      const chev = document.createElement('span');
      chev.className = 'browse-chevron';
      chev.textContent = '›';
      btn.appendChild(chev);
      btn.addEventListener('click', () => openStation(s, { fly: true, source: 'stations', lineKey: browseLineKey }));
      browseList.appendChild(btn);
    }
  }

  /** CTA-style: pick Northbound / Southbound before the stop list. */
  function renderBrowseBusDirections(rt) {
    if (!browseList) return;
    browseMode = 'directions';
    browseKind = 'bus';
    browseBusRt = String(rt);
    browseBusRtdir = '';
    syncBrowseKindUi();
    const def = busRouteDef(busCatalog, rt) || busRouteDef(rt);
    if (browseTitle) browseTitle.textContent = `${rt} · ${def?.name || 'Bus'}`;
    if (browseBack) browseBack.hidden = false;
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    browseList.replaceChildren();
    const dirs = directionsForRoute(busPatterns, rt);
    if (!dirs.length) {
      // Legacy bake without directions — fall through to flat list if any.
      renderBrowseBusStops(rt, '');
      return;
    }
    for (const d of dirs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-row';
      const name = document.createElement('span');
      name.className = 'browse-name';
      name.textContent = d.rtdir;
      btn.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${d.stops?.length || 0} STOPS`;
      btn.appendChild(meta);
      const chev = document.createElement('span');
      chev.className = 'browse-chevron';
      chev.textContent = '›';
      btn.appendChild(chev);
      btn.addEventListener('click', () => {
        browseBusRtdir = d.rtdir;
        renderBrowseBusStops(rt, d.rtdir);
      });
      browseList.appendChild(btn);
    }
  }

  function renderBrowseBusStops(rt, rtdir = browseBusRtdir) {
    if (!browseList) return;
    browseMode = 'stations';
    browseKind = 'bus';
    browseBusRt = String(rt);
    browseBusRtdir = String(rtdir || '');
    syncBrowseKindUi();
    const def = busRouteDef(busCatalog, rt) || busRouteDef(rt);
    const dirLabel = browseBusRtdir ? ` · ${browseBusRtdir}` : '';
    if (browseTitle) browseTitle.textContent = `${rt} · ${def?.name || 'Bus'}${dirLabel}`;
    if (browseBack) browseBack.hidden = false;
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    browseList.replaceChildren();
    const list = stopsForRoute(busPatterns, rt, browseBusRtdir || undefined);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'NO STOPS';
      browseList.appendChild(empty);
      return;
    }
    for (const stop of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-row';
      const badge = document.createElement('span');
      badge.className = 'bus-route-badge bus-route-badge-sm';
      badge.textContent = rt;
      btn.appendChild(badge);
      const name = document.createElement('span');
      name.className = 'browse-name';
      name.textContent = stop.name || stop.stpid;
      btn.appendChild(name);
      const chev = document.createElement('span');
      chev.className = 'browse-chevron';
      chev.textContent = '›';
      btn.appendChild(chev);
      btn.addEventListener('click', () =>
        openBusStop(stop, { rt, rtdir: browseBusRtdir, source: 'stations' }),
      );
      browseList.appendChild(btn);
    }
  }

  function renderBrowseSearch(q) {
    if (!browseList) return;
    browseMode = 'search';
    browseKind = 'train';
    syncBrowseKindUi();
    if (browseTitle) browseTitle.textContent = 'Search stations';
    if (browseBack) browseBack.hidden = true;
    browseEl?.classList.add('mode-search');
    browseList.replaceChildren();
    const hits = searchStations(liveStationsUnion(stations), q);
    if (!q.trim()) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'TYPE A STATION';
      browseList.appendChild(empty);
      return;
    }
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'NO MATCH';
      browseList.appendChild(empty);
      return;
    }
    for (const s of hits) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-row';
      appendLineOrbs(btn, s.lines || []);
      const name = document.createElement('span');
      name.className = 'browse-name';
      name.textContent = cleanStationName(s.name || s.id);
      btn.appendChild(name);
      btn.addEventListener('click', () =>
        openStation(s, {
          fly: true,
          source: 'search',
          query: browseSearchInput?.value || '',
        }),
      );
      browseList.appendChild(btn);
    }
  }

  document.getElementById('browse-close')?.addEventListener('click', closeBrowse);
  document.getElementById('browse-back')?.addEventListener('click', () => {
    if (browseKind === 'bus' && browseMode === 'stations') {
      renderBrowseBusDirections(browseBusRt);
      return;
    }
    if (browseMode === 'stations' || browseMode === 'directions') renderBrowseLines();
  });
  document.getElementById('browse-kind-train')?.addEventListener('click', () => {
    browseKind = 'train';
    openBrowse('lines');
  });
  document.getElementById('browse-kind-bus')?.addEventListener('click', () => {
    browseKind = 'bus';
    openBrowse('lines');
  });
  document.getElementById('fab-lines')?.addEventListener('click', () => {
    const act = listFabAction(currentSurface());
    if (act === 'close-browse') closeBrowse();
    else if (act === 'board-to-browse') {
      closeStation({ restoreBrowse: false });
      browseKind = 'train';
      openBrowse('lines');
    } else {
      browseKind = browseKind === 'bus' ? 'bus' : 'train';
      openBrowse('lines');
    }
  });
  document.getElementById('fab-search')?.addEventListener('click', () => {
    const act = searchFabAction(currentSurface(), browseMode === 'search' && isBrowseOpen());
    if (act === 'close-browse') closeBrowse();
    else openBrowse('search');
  });
  browseSearchInput?.addEventListener('input', () => {
    if (browseKind === 'bus' && browseMode === 'lines') {
      browseBusQuery = browseSearchInput.value;
      renderBrowseLines();
      return;
    }
    renderBrowseSearch(browseSearchInput.value);
  });

  // ---- Geolocation (Maps follow) ---------------------------------------
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
    const mins = walkMinutes(hit.distM);
    nearestChip.textContent = `${hit.station.name} · ~${mins} min walk`;
    nearestChip.classList.add('visible');
    nearestChip.onclick = () => openStation(hit.station, { source: 'map' });
  }

  function enableLocation() {
    if (geoWatch) return;
    locChip?.classList.remove('visible');
    geoWatch = startWatch({
      highAccuracy: true,
      onFix: (fix) => {
        userFix = fix;
        updateNearestChip();
        if (followMe && fix) {
          map.easeTo({
            center: [fix.lon, fix.lat],
            duration: 400,
            essential: true,
          });
        }
      },
      onError: (err) => {
        console.warn('[chi-tron] geolocation:', err.message || err.code);
        locChip?.classList.add('visible');
        if (locChip) locChip.textContent = 'LOCATION OFF';
        followMe = false;
      },
    });
    followMe = true;
    releaseFollow();
  }

  document.getElementById('fab-locate')?.addEventListener('click', () => {
    closeBrowse();
    closeStation({ restoreBrowse: false });
    enableLocation();
    if (userFix) {
      followMe = true;
      map.easeTo({ center: [userFix.lon, userFix.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
    }
  });

  // Maps law: user pan breaks follow-me
  map.on('dragstart', () => {
    followMe = false;
  });
  map.on('zoomstart', (e) => {
    if (e.originalEvent) followMe = false;
  });

  const hud = createHud({
    map,
    lineColors: LINE_COLORS,
    visibleLines,
    display,
    trackGlowLayerIds: TRACK_GLOW_LAYER_IDS,
    getStatus: () => feedStatus,
    onReleaseFollow: releaseFollow,
  });

  // Nav chrome: collapse instrument sidebar noise — map is primary
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.add('nav-compact');

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

  function handleMapClick(info) {
    if (!info.picked || !info.object) {
      // Empty map: dismiss top sheet only (one surface at a time).
      dismissTopSurface();
      return;
    }
    if (info.layer?.id === 'station-ring') {
      openStation(info.object);
      return;
    }
    if (info.layer?.id === 'glow-core') {
      const t = info.object;
      followVehicle(
        'train',
        t.id,
        `${t.destNm || 'ORG'} · #${t.rn || '—'}`,
      );
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const surface = currentSurface();
      if (surface === 'browse' || surface === 'board') dismissTopSurface();
      else releaseFollow();
    }
  });

  overlay.setProps({ onClick: handleMapClick });

  engine.onStatus = setStatus;
  engine.startLive();
  setStatus('live');

  const alertsEngine = new AlertsEngine();
  alertsEngine.onStatus = () => {
    hud.refreshSystemStatus(alertsEngine.lineStatus, alertsEngine.lineHeadline);
  };
  alertsEngine.startLive();

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
    const buses = busFeedReady ? busEngine.tick() : [];

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
        // Dim non-live tracks
        if (!visibleLines.has(key)) opacityMult *= 0.12;
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
        cars: [],
        zoom: map.getZoom(),
        lineStatus: alertsEngine.lineStatus,
        accessibilityStations: alertsEngine.stationFlags,
        user: userFix
          ? { pos: [userFix.lon, userFix.lat], accuracyM: userFix.accuracyM }
          : null,
        selectedStationId,
      }),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__map = map;
  window.__engine = engine;
  window.__busEngine = busEngine;
  window.__hud = hud;
  window.__arrivals = arrivals;
  window.__alertsEngine = alertsEngine;
  window.__openStation = openStation;
}

boot();
