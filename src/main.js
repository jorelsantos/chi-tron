import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { DARK_CITY_STYLE, FALLBACK_STYLE, LOOP_PRESET } from './style.js';
import { TrainEngine, now } from './trains.js';
import { buildLayers, LINE_COLORS } from './layers.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const statusEl = document.getElementById('status');
const clockEl = document.getElementById('clock');
const fpsEl = document.getElementById('fps');

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

  const engine = new TrainEngine(tracks);
  engine.onStatus = setStatus;
  const visibleLines = new Set(Object.keys(tracks));

  if (MOCK) {
    engine.seedMock(4);
    setStatus('mock');
  } else {
    engine.startLive();
  }

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
