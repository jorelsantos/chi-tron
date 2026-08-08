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
import { now, TrainEngine } from './trains.js';
import { AlertsEngine } from './alerts.js';
import { buildLayers, LINE_COLORS, rgbString, lineStressTreatment } from './layers.js';
import { createHud } from './hud.js';
import { ArrivalsSession, groupArrivalsByDirection } from './arrivals.js';
import { startWatch, nearestStation, walkMinutes } from './geolocation.js';
import { snapStationsToRails } from './stations-rail.js';
import { orgStationsOrdered, searchStations, BROWSE_LINES } from './catalog.js';

// Live Nav MVP: Orange Line trains + station arrivals + user location.
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
  live: 'LIVE · ORANGE',
};
function setStatus(state) {
  feedStatus = state;
  renderFeedStatus(statusEl, state, TRAIN_STATUS_LABELS);
}

function setBusStatus() {
  // Buses deferred past Orange MVP — keep pill quiet.
  if (busStatusEl) {
    busStatusEl.className = 'hud disabled';
    busStatusEl.textContent = 'BUS SOON';
  }
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

  setBusStatus();

  const tracks = await tracksPromise;
  stationsRaw = await stationsPromise;
  // Snap markers onto rail geometry so the 3D world reads as one system.
  stations = snapStationsToRails(tracks, stationsRaw);

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

  // Live Orange trains only — map is the product.
  const engine = new TrainEngine(tracks);
  const trackKeys = Object.keys(tracks);
  const visibleLines = new Set(['Org']);
  const lastStressOpacity = new Map();
  const display = {
    trains: true,
    buses: false,
    cars: false,
    buildings: true,
    stations: true,
  };

  // Filter underglow to Org only once source exists
  function filterTracksToOrg() {
    for (const id of TRACK_GLOW_LAYER_IDS) {
      if (map.getLayer(id)) {
        map.setFilter(id, ['==', ['get', 'line'], 'Org']);
      }
    }
  }
  map.on('load', filterTracksToOrg);
  if (map.loaded()) filterTracksToOrg();

  let followed = null; // vehicle follow (train)
  let followMe = false;
  let userFix = null;
  let geoWatch = null;
  let selectedStationId = null;
  const arrivals = new ArrivalsSession();

  // Walk distance uses GTFS (entrance) coords; map markers use rail-snapped coords.
  const orgStationsForWalk = () =>
    Object.values(stations)
      .filter((s) => s.lines?.includes('Org'))
      .map((s) => ({ ...s, id: s.id, coords: s.gtfsCoords || s.coords }));

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

  function renderSheetRows(rows, error) {
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
      empty.textContent = 'LOADING…';
      sheetRows.appendChild(empty);
      return;
    }
    const groups = groupArrivalsByDirection(rows);
    for (const g of groups) {
      if (groups.length > 1 || (g.title && g.title !== 'Arrivals')) {
        const h = document.createElement('div');
        h.className = 'dir-header';
        h.textContent = g.title;
        sheetRows.appendChild(h);
      }
      for (const r of g.rows) {
        const row = document.createElement('div');
        row.className = 'arrival-row';
        if (r.isDly) row.classList.add('delayed');
        if (r.isApp) row.classList.add('approaching');
        const minsLabel = r.minutes === 'DUE' || r.isApp ? 'DUE' : String(r.minutes);
        const minsClass = minsLabel === 'DUE' ? 'arr-mins due' : 'arr-mins';
        const liveTag = r.isSch ? 'SCHEDULED' : 'LIVE';
        const appTag = r.isApp ? ' · approaching' : '';
        const unit = minsLabel === 'DUE' ? '' : ' min';
        row.innerHTML = `
          <span class="arr-dest">→ ${r.destNm || '—'}</span>
          <span class="${minsClass}">${minsLabel}</span>
          <span class="arr-meta">${r.clock || ''}${unit ? '' : ''}${r.rn ? ` · #${r.rn}` : ''} · ${liveTag}${appTag}${r.isDly ? ' · delayed' : ''}${unit ? ` · ${r.minutes} min` : ''}</span>
        `;
        sheetRows.appendChild(row);
      }
    }
  }

  function openStation(station, { fly = true } = {}) {
    if (!station?.id) return;
    closeBrowse();
    selectedStationId = station.id;
    sheetEl?.classList.add('open');
    if (sheetTitle) sheetTitle.textContent = (station.name || station.id).replace(/\s*\(Orange\)\s*/i, '');
    if (sheetMeta) {
      const tag = alertsEngine.lineStatus?.Org ?? 'normal';
      sheetMeta.textContent = `ORANGE · ${String(tag).toUpperCase()}`;
    }
    renderSheetRows([], null);
    if (sheetUpdated) sheetUpdated.textContent = 'AS OF —';
    arrivals.onUpdate = ({ rows, updatedAt, error }) => {
      renderSheetRows(rows, error);
      if (sheetUpdated && updatedAt) {
        sheetUpdated.textContent = `AS OF ${new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      }
    };
    arrivals.open(station.id, 'org');
    if (fly && station.coords) {
      map.easeTo({
        center: station.coords,
        zoom: Math.max(map.getZoom(), 14.8),
        duration: 700,
        essential: true,
      });
    }
  }

  function closeStation() {
    selectedStationId = null;
    arrivals.close();
    sheetEl?.classList.remove('open');
  }

  document.getElementById('sheet-close')?.addEventListener('click', closeStation);

  // ---- Browse: Lines → stations / Search --------------------------------
  const browseEl = document.getElementById('browse-sheet');
  const browseList = document.getElementById('browse-list');
  const browseTitle = document.getElementById('browse-title');
  const browseBack = document.getElementById('browse-back');
  const browseSearchInput = document.getElementById('browse-search-input');
  /** @type {'lines'|'stations'|'search'} */
  let browseMode = 'lines';
  let browseLineKey = 'Org';

  function orderedOrg() {
    return orgStationsOrdered(stations);
  }

  function closeBrowse() {
    browseEl?.classList.remove('open');
    browseEl?.classList.remove('mode-search');
    document.getElementById('fab-lines')?.setAttribute('aria-pressed', 'false');
    document.getElementById('fab-search')?.setAttribute('aria-pressed', 'false');
    if (browseSearchInput) browseSearchInput.value = '';
  }

  function openBrowse(mode = 'lines') {
    browseMode = mode;
    browseEl?.classList.add('open');
    browseEl?.classList.toggle('mode-search', mode === 'search');
    document.getElementById('fab-lines')?.setAttribute('aria-pressed', String(mode !== 'search'));
    document.getElementById('fab-search')?.setAttribute('aria-pressed', String(mode === 'search'));
    if (mode === 'lines') renderBrowseLines();
    else if (mode === 'stations') renderBrowseStations(browseLineKey);
    else renderBrowseSearch('');
    if (mode === 'search') {
      browseSearchInput?.focus();
    }
  }

  function renderBrowseLines() {
    if (!browseList) return;
    browseMode = 'lines';
    if (browseTitle) browseTitle.textContent = 'Lines';
    if (browseBack) browseBack.hidden = true;
    browseEl?.classList.remove('mode-search');
    browseList.replaceChildren();
    for (const line of BROWSE_LINES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-row';
      btn.disabled = !line.live;
      const sw = document.createElement('span');
      sw.className = 'browse-swatch';
      sw.style.background = `rgb(${line.color.join(',')})`;
      sw.style.color = `rgb(${line.color.join(',')})`;
      btn.appendChild(sw);
      const name = document.createElement('span');
      name.textContent = line.name;
      btn.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = line.live ? 'LIVE' : 'SOON';
      btn.appendChild(meta);
      const chev = document.createElement('span');
      chev.className = 'browse-chevron';
      chev.textContent = '›';
      btn.appendChild(chev);
      if (line.live) {
        btn.addEventListener('click', () => {
          browseLineKey = line.key;
          renderBrowseStations(line.key);
        });
      }
      browseList.appendChild(btn);
    }
  }

  function renderBrowseStations(lineKey) {
    if (!browseList) return;
    browseMode = 'stations';
    const line = BROWSE_LINES.find((l) => l.key === lineKey) || BROWSE_LINES[0];
    if (browseTitle) browseTitle.textContent = line.name;
    if (browseBack) browseBack.hidden = false;
    browseEl?.classList.remove('mode-search');
    browseList.replaceChildren();
    const list = lineKey === 'Org' ? orderedOrg() : [];
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
      const sw = document.createElement('span');
      sw.className = 'browse-swatch';
      sw.style.background = `rgb(${line.color.join(',')})`;
      btn.appendChild(sw);
      const name = document.createElement('span');
      name.textContent = String(s.name || s.id).replace(/\s*\(Orange\)\s*/i, '');
      btn.appendChild(name);
      const chev = document.createElement('span');
      chev.className = 'browse-chevron';
      chev.textContent = '›';
      btn.appendChild(chev);
      btn.addEventListener('click', () => openStation(s, { fly: true }));
      browseList.appendChild(btn);
    }
  }

  function renderBrowseSearch(q) {
    if (!browseList) return;
    browseMode = 'search';
    if (browseTitle) browseTitle.textContent = 'Search';
    if (browseBack) browseBack.hidden = true;
    browseEl?.classList.add('mode-search');
    browseList.replaceChildren();
    const hits = searchStations(orderedOrg(), q);
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
      const sw = document.createElement('span');
      sw.className = 'browse-swatch';
      sw.style.background = 'rgb(255,105,28)';
      btn.appendChild(sw);
      const name = document.createElement('span');
      name.textContent = String(s.name || s.id).replace(/\s*\(Orange\)\s*/i, '');
      btn.appendChild(name);
      btn.addEventListener('click', () => openStation(s, { fly: true }));
      browseList.appendChild(btn);
    }
  }

  document.getElementById('browse-close')?.addEventListener('click', closeBrowse);
  document.getElementById('browse-back')?.addEventListener('click', () => {
    if (browseMode === 'stations') renderBrowseLines();
  });
  document.getElementById('fab-lines')?.addEventListener('click', () => {
    if (browseEl?.classList.contains('open') && browseMode !== 'search') closeBrowse();
    else openBrowse('lines');
  });
  document.getElementById('fab-search')?.addEventListener('click', () => {
    if (browseEl?.classList.contains('open') && browseMode === 'search') closeBrowse();
    else openBrowse('search');
  });
  browseSearchInput?.addEventListener('input', () => {
    renderBrowseSearch(browseSearchInput.value);
  });

  // ---- Geolocation (Maps follow) ---------------------------------------
  function updateNearestChip() {
    if (!nearestChip || !userFix) {
      nearestChip?.classList.remove('visible');
      return;
    }
    const hit = nearestStation([userFix.lon, userFix.lat], orgStationsForWalk());
    if (!hit) {
      nearestChip.classList.remove('visible');
      return;
    }
    const mins = walkMinutes(hit.distM);
    nearestChip.textContent = `${hit.station.name} · ~${mins} min walk`;
    nearestChip.classList.add('visible');
    nearestChip.onclick = () => openStation(hit.station);
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
      // empty map tap: do not force-close sheet (user may be reading board)
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
      if (browseEl?.classList.contains('open')) closeBrowse();
      else if (selectedStationId) closeStation();
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
        // Dim non-Org tracks hard
        if (key !== 'Org') opacityMult *= 0.15;
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
        buses: [],
        busTrailVersion: 0,
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
  window.__hud = hud;
  window.__arrivals = arrivals;
  window.__alertsEngine = alertsEngine;
  window.__openStation = openStation;
}

boot();
