/**
 * The map stage: MapLibre instance, its gesture policy, the layers painted
 * directly on the basemap (track underglow, downtown building mass), and the
 * camera modes the chrome drives (2D / 3D / LIVE overview).
 *
 * Extracted from boot() so main.js wires features together instead of also
 * owning several hundred lines of map plumbing. Nothing here knows about
 * boards, browse, or arrivals — it takes track geometry and returns a stage
 * other modules draw on.
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  DARK_CITY_STYLE,
  FALLBACK_STYLE,
  AERIAL_2D,
  CITY_2D,
  LOOP_3D,
  PITCH_3D,
  CHICAGOLAND_BOUNDS,
  CHICAGOLAND_MIN_ZOOM,
  HEIGHT_EXAGGERATION,
  CROWN_LIGHT_DELTA,
} from './style.js';
import { LINE_COLORS, rgbString } from './layers.js';
import { liveLineKeys } from './catalog.js';

export const TRACK_GLOW_LAYER_IDS = ['l-tracks-wide', 'l-tracks-mid', 'l-tracks-core'];

export const BUILDING_LAYER_IDS = ['chi-buildings-3d', 'chi-buildings-3d-crown'];

/**
 * @param {object} opts
 * @param {Record<string, {coords: number[][]}>} opts.tracks parsed tracks.json
 * @param {string} [opts.containerId]
 */
export function createMapStage({ tracks, containerId = 'map' }) {
  // Tracker cold-open: flat aerial Loop (2D). 3D via the map view control.
  // Mobile-first gestures: no double-click zoom; pinch only; no browser fight.
  const map = new maplibregl.Map({
    container: containerId,
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
    doubleClickZoom: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    // One-finger pan + two-finger pinch only (Maps-like)
    touchZoomRotate: true,
    cooperativeGestures: false,
  });

  // Phase C: Chicagoland hard stop (also re-asserted after a style swap).
  map.setMaxBounds(CHICAGOLAND_BOUNDS);
  map.setMinZoom(CHICAGOLAND_MIN_ZOOM);
  // Disable rotate on touch (keep pinch-zoom); pitch re-enabled only in 3D.
  map.touchZoomRotate.disableRotation();
  map.dragRotate.disable();
  map.touchPitch.disable();

  const container = document.getElementById(containerId);
  if (container) new ResizeObserver(() => map.resize()).observe(container);
  requestAnimationFrame(() => requestAnimationFrame(() => map.resize()));

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  /** @type {boolean} 2D (pitch 0) vs 3D instrument pitch */
  let is3d = false;
  /** @type {boolean} camera is tracking the user's GPS fix */
  let followMe = false;

  function syncViewButtons() {
    document.getElementById('btn-view-2d')?.setAttribute('aria-pressed', String(!is3d));
    document.getElementById('btn-view-3d')?.setAttribute('aria-pressed', String(is3d));
  }

  function addTrackUnderglow() {
    if (map.getSource('l-tracks')) return;
    const features = Object.entries(tracks).map(([key, line]) => ({
      type: 'Feature',
      id: key,
      properties: {
        line: key,
        color: LINE_COLORS[key] ? rgbString(LINE_COLORS[key]) : 'rgb(80, 80, 120)',
      },
      geometry: { type: 'LineString', coordinates: line.coords },
    }));
    map.addSource('l-tracks', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    const stressOpacity = ['coalesce', ['feature-state', 'stressOpacity'], 1];
    const glow = [
      { id: 'l-tracks-wide', opacity: 0.18, width: [12, 5, 16, 14], blur: 3 },
      { id: 'l-tracks-mid', opacity: 0.45, width: [12, 2, 16, 5], blur: 1 },
      { id: 'l-tracks-core', opacity: 0.92, width: [12, 0.7, 16, 1.8], blur: 0 },
    ];
    for (const g of glow) {
      map.addLayer({
        id: g.id,
        type: 'line',
        source: 'l-tracks',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': ['*', g.opacity, stressOpacity],
          'line-width': ['interpolate', ['linear'], ['zoom'], ...g.width],
          ...(g.blur ? { 'line-blur': g.blur } : {}),
        },
      });
    }
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
    // Chi sits on top of OFM downtown; leave OFM visible for metro outside
    // the bake. Keep track glow above the building mass.
    for (const id of TRACK_GLOW_LAYER_IDS) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  }

  // Underglow is drawn for every line in tracks.json; only the live ones stay
  // bright. Re-applied on style swap because a swap drops layer filters.
  function filterTracksToLive() {
    const live = liveLineKeys();
    for (const id of TRACK_GLOW_LAYER_IDS) {
      if (map.getLayer(id)) {
        map.setFilter(id, ['in', ['get', 'line'], ['literal', live]]);
      }
    }
  }

  map.on('error', (e) => {
    if (!map.__fellBack && /source|style|tile/i.test(String(e.error?.message))) {
      map.__fellBack = true;
      console.warn('[chi-tron] falling back to CARTO style:', e.error?.message);
      map.setStyle(FALLBACK_STYLE);
      map.once('styledata', () => {
        addTrackUnderglow();
        filterTracksToLive();
      });
    }
  });

  // Maps law: a user-initiated pan or zoom breaks follow-me.
  map.on('dragstart', () => {
    followMe = false;
  });
  map.on('zoomstart', (e) => {
    if (e.originalEvent) followMe = false;
  });

  function setMap2d() {
    is3d = false;
    followMe = false;
    map.touchPitch.disable();
    map.easeTo({ pitch: 0, bearing: 0, duration: 700, essential: true });
    syncViewButtons();
  }

  function setMap3d() {
    is3d = true;
    followMe = false;
    map.touchPitch.enable();
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
    is3d = false;
    followMe = false;
    map.touchPitch.disable();
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

  /**
   * Downtown building mass, fetched only once the basemap is up. Optional:
   * a failure leaves OpenFreeMap's own extrusions in place.
   * @param {(layerIds: string[]) => void} [onAdded]
   */
  function loadBuildings(onAdded = () => {}) {
    return fetch('/data/buildings.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((geojson) => {
        addChicagoBuildings(geojson);
        onAdded(BUILDING_LAYER_IDS);
      })
      .catch((err) => {
        console.warn('[chi-tron] buildings.json missing/failed — OFM extrusions stay:', err.message);
      });
  }

  // Stage-owned load wiring. `whenReady` also fires immediately for a caller
  // that registers after 'load' already happened, which is what the previous
  // `if (map.loaded()) …` guards at each call site were doing by hand.
  let ready = false;
  /** @type {Array<() => void>} */
  const readyCallbacks = [];
  map.on('load', () => {
    addTrackUnderglow();
    filterTracksToLive();
    map.resize();
    map.jumpTo(AERIAL_2D);
    map.setMaxBounds(CHICAGOLAND_BOUNDS);
    map.setMinZoom(CHICAGOLAND_MIN_ZOOM);
    ready = true;
    for (const cb of readyCallbacks.splice(0)) cb();
  });

  /** @param {() => void} cb */
  function whenReady(cb) {
    if (ready || map.loaded()) cb();
    else readyCallbacks.push(cb);
  }

  document.getElementById('btn-view-2d')?.addEventListener('click', setMap2d);
  document.getElementById('btn-view-3d')?.addEventListener('click', setMap3d);
  document.getElementById('btn-live-overview')?.addEventListener('click', liveOverview);
  syncViewButtons();

  return {
    map,
    overlay,
    addTrackUnderglow,
    filterTracksToLive,
    loadBuildings,
    whenReady,
    setMap2d,
    setMap3d,
    liveOverview,
    syncViewButtons,
    get is3d() {
      return is3d;
    },
    get followMe() {
      return followMe;
    },
    set followMe(v) {
      followMe = Boolean(v);
    },
    /** Centre on a point without disturbing zoom below a readable floor. */
    easeToPoint(coords, { zoom = 14.8, duration = 700 } = {}) {
      if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return;
      map.easeTo({
        center: coords,
        zoom: Math.max(map.getZoom(), zoom),
        duration,
        essential: true,
      });
    },
  };
}
