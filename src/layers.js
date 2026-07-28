// The Tron pass: fading light trails (TripsLayer) + layered glow heads
// (stacked ScatterplotLayers = cheap bloom). Additive-style transparency so
// crossing trails brighten each other.

import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';

export const LINE_COLORS = {
  Red: [255, 59, 78],
  Blue: [0, 212, 255],
  Brn: [255, 179, 92],
  G: [59, 255, 111],
  Org: [255, 122, 26],
  P: [180, 92, 255],
  Pink: [255, 92, 208],
  Y: [255, 233, 74],
};

const TRAIL_LENGTH = 45; // seconds of visible trail

export function buildLayers(trains, currentTime, visibleLines, trailVersion = 0) {
  const shown = trains.filter(
    (t) => t.pos && visibleLines.has(t.line) && t.state !== 'removed'
  );
  const fade = (t) => (t.state === 'stale' ? 0.35 : 1);

  return [
    new TripsLayer({
      id: 'trails',
      data: shown,
      getPath: (d) => d.trail.map((p) => [p.lon, p.lat]),
      getTimestamps: (d) => d.trail.map((p) => p.t),
      getColor: (d) => LINE_COLORS[d.line],
      currentTime,
      trailLength: TRAIL_LENGTH,
      fadeTrail: true,
      capRounded: true,
      jointRounded: true,
      widthMinPixels: 3,
      opacity: 0.85,
      updateTriggers: { getPath: trailVersion, getTimestamps: trailVersion },
      parameters: { depthTest: false },
    }),
    // wide halo
    new ScatterplotLayer({
      id: 'glow-halo',
      data: shown,
      getPosition: (d) => d.pos,
      getFillColor: (d) => [...LINE_COLORS[d.line], 40 * fade(d)],
      getRadius: 120,
      radiusUnits: 'meters',
      radiusMinPixels: 10,
      parameters: { depthTest: false },
    }),
    // mid glow
    new ScatterplotLayer({
      id: 'glow-mid',
      data: shown,
      getPosition: (d) => d.pos,
      getFillColor: (d) => [...LINE_COLORS[d.line], 110 * fade(d)],
      getRadius: 45,
      radiusUnits: 'meters',
      radiusMinPixels: 5,
      parameters: { depthTest: false },
    }),
    // bright core
    new ScatterplotLayer({
      id: 'glow-core',
      data: shown,
      getPosition: (d) => d.pos,
      getFillColor: (d) => [255, 255, 255, 235 * fade(d)],
      getRadius: 14,
      radiusUnits: 'meters',
      radiusMinPixels: 2.5,
      parameters: { depthTest: false },
    }),
  ];
}
