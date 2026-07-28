import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { DARK_CITY_STYLE, FALLBACK_STYLE, CHICAGO_LOOP } from './style.js';
import { TrainEngine, now } from './trains.js';
import { buildLayers, LINE_COLORS } from './layers.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const statusEl = document.getElementById('status');
const clockEl = document.getElementById('clock');

function setStatus(state) {
  statusEl.className = `hud ${state === 'lost' ? 'lost' : 'live'}`;
  statusEl.textContent =
    state === 'mock' ? 'SIM MODE' : state === 'lost' ? 'SIGNAL LOST' : 'LIVE FEED';
}

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}, 1000);

async function boot() {
  const tracks = await fetch('/data/tracks.json').then((r) => r.json());

  const map = new maplibregl.Map({
    container: 'map',
    style: DARK_CITY_STYLE,
    center: CHICAGO_LOOP,
    zoom: 13.6,
    pitch: 57,
    bearing: -12,
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

  // Dim under-glow of the full network so the track grid reads everywhere.
  function addTrackUnderglow() {
    const features = Object.entries(tracks).map(([key, line]) => ({
      type: 'Feature',
      properties: {
        color: `rgb(${LINE_COLORS[key]?.join(',') ?? '80,80,120'})`,
      },
      geometry: { type: 'LineString', coordinates: line.coords },
    }));
    if (map.getSource('l-tracks')) return;
    map.addSource('l-tracks', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    map.addLayer({
      id: 'l-tracks-wide',
      type: 'line',
      source: 'l-tracks',
      paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.10, 'line-width': 6 },
    });
    map.addLayer({
      id: 'l-tracks-core',
      type: 'line',
      source: 'l-tracks',
      paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.35, 'line-width': 1.2 },
    });
  }
  map.on('load', () => {
    addTrackUnderglow();
    // Re-assert the intended camera: pane layout can shift during init and
    // leave the map at a stale transform.
    map.resize();
    map.jumpTo({ center: CHICAGO_LOOP, zoom: 13.6, pitch: 57, bearing: -12 });
  });

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  const engine = new TrainEngine(tracks);
  engine.onStatus = setStatus;
  const visibleLines = new Set(Object.keys(tracks));

  if (MOCK) {
    engine.seedMock(4);
    setStatus('mock');
  } else {
    engine.startLive();
  }

  function frame() {
    const trains = engine.tick();
    overlay.setProps({
      layers: buildLayers(trains, now(), visibleLines, engine.trailVersion),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // debug handles (harmless in prod, invaluable in dev)
  window.__map = map;
  window.__engine = engine;
}

boot();
