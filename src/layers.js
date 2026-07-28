// The Tron pass: fading light trails (TripsLayer) + layered glow heads
// (stacked ScatterplotLayers = cheap bloom) + station-node rings. Additive
// blending on the trails so crossing trails brighten each other (R3);
// glow-head discs stay on standard alpha compositing (matches the pattern
// this extends) since additive white-hot cores would blow out to solid
// white wherever several trains cluster.

import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';

// U8: pushed past the literal CTA palette toward saturated neon (R2), and
// away from the amber/orange building-crown hue src/style.js adds in U7
// (crown ranges roughly hue 25°, e.g. #c4590f). Brn in particular used to
// sit at hue ~30° — nearly on top of the crown and only 4° from Org — so it
// moves to a yellow-green gold instead of a literal "brown," which doesn't
// exist as a vivid neon hue anyway. Org stays in the orange family (it's
// the Orange Line) but shifts redder/hotter and far more saturated than the
// crown's muted max (crown: ~86% sat/41% light at its brightest vs Org's
// 100%/53%) so the two still read apart despite the residual ~7° hue gap —
// the crown is also a small static rooftop highlight while Org is a long
// animated glowing line, which does a lot of the separating work on its own.
// All eight hues are now spread with a minimum ~28° gap around the wheel.
export const LINE_COLORS = {
  Red: [249, 31, 68],
  Blue: [26, 198, 255],
  Brn: [175, 244, 37],
  G: [21, 249, 78],
  Org: [255, 87, 15],
  P: [137, 56, 250],
  Pink: [255, 51, 180],
  Y: [255, 217, 26],
};

// Single source for "the 8 L lines, in a stable order" — hud.js, the vitest
// suite, and scripts/build-tracks.mjs all previously hardcoded their own
// copy of this exact list; derived from LINE_COLORS' keys instead so there
// is one place to add/rename a line.
export const LINE_KEYS = Object.keys(LINE_COLORS);

// Shared "RGB triple → CSS rgb() string" conversion — previously duplicated
// (with subtly different fallback behavior) between src/main.js's track
// underglow and src/hud.js's line-badge styling.
export function rgbString(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

const TRAIL_LENGTH = 45; // seconds of visible trail

// R3: delayed trains pulse red-shifted; approaching trains brighten. Both
// flags come from the CTA payload's isDly/isApp (surfaced in src/trains.js)
// or the mock generator's synthetic toggles. Returns per-train style
// multipliers consumed by every glow layer below so the treatment is
// consistent across the whole light-cycle stack. Every branch returns the
// same shape (including `brightBoost`) so callers can read it directly
// without an `?? 1` fallback.
export function trainStyle(t, currentTime) {
  const staleFade = t.state === 'stale' ? 0.35 : 1;
  if (t.isDly) {
    // Slow red-shifted pulse — distinct from the steady glow of a normal
    // train, and distinct from the brighter, steady isApp treatment below.
    const pulse = 0.55 + 0.45 * Math.sin(currentTime * Math.PI * 1.6);
    return {
      core: [255, 70, 70],
      fade: staleFade * pulse,
      radiusMult: 1,
      brightBoost: 1,
    };
  }
  if (t.isApp) {
    // Approaching its next station: brightens and swells rather than
    // pulsing, so "approaching" reads as a steady state, not a warning.
    return {
      core: [255, 255, 255],
      fade: staleFade,
      radiusMult: 1.45,
      brightBoost: 1.5,
    };
  }
  return { core: [255, 255, 255], fade: staleFade, radiusMult: 1, brightBoost: 1 };
}

// Stations only change when a line is toggled or the DISPLAY toggle flips —
// essentially never, frame-to-frame. Recomputing the ridership-filtered list
// from scratch every frame (60x/sec) is pure waste, so it's cached here
// against a cheap signature of the two things that can actually change it.
let stationsCacheKey = null;
let stationsCache = [];
function getShownStations(stations, visibleLines, display) {
  if (!display.stations) return [];
  const key = `${[...visibleLines].sort().join(',')}`;
  if (key !== stationsCacheKey) {
    stationsCacheKey = key;
    stationsCache = Object.values(stations).filter((s) => s.lines.some((l) => visibleLines.has(l)));
  }
  return stationsCache;
}

export function buildLayers(trains, currentTime, visibleLines, options = {}) {
  // Options object rather than positional params: Phase B (buses, cars,
  // alerts — see the neon-city plan) adds more feeds here, and a growing
  // positional signature means every future addition is another
  // ordering-fragile slot at the one call site in src/main.js.
  const { trailVersion = 0, stations = {}, display = { trains: true, stations: true } } = options;

  // U12's DISPLAY toggles: `trains`/`stations` off means "don't draw this
  // layer at all," independent of the per-line `visibleLines` Set below.
  // Empty arrays keep the layer objects themselves stable (same layer
  // count every frame) rather than conditionally omitting them.
  const shown = display.trains
    ? trains.filter((t) => t.pos && visibleLines.has(t.line) && t.state !== 'removed')
    : [];
  // Style computed once per frame per train and attached directly to a
  // {t, style} pair — the three glow-head layers below read d.style as a
  // plain field instead of doing a Map.get(d) per accessor call.
  const shownStyled = shown.map((t) => ({ t, style: trainStyle(t, currentTime) }));

  const shownStations = getShownStations(stations, visibleLines, display);
  // Color priority for a multi-line station: prefer a line the user hasn't
  // toggled off. Without this, a station keeps the color of a hidden line
  // for as long as any other served line stays visible — the ring looks
  // like it belongs to a line that isn't even rendering. shownStations is
  // already filtered to "at least one served line is visible", so find()
  // always succeeds; the ?? is a defensive fallback, not the normal path.
  const stationColorLine = (d) => d.lines.find((l) => visibleLines.has(l)) ?? d.lines[0];

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
      // R3: additive so two trails crossing (a junction, a shared
      // underglow segment) sum brightness instead of alpha-compositing —
      // the classic "light-cycle trail" look. luma.gl v9 (deck.gl 9.3)
      // takes WebGPU-style string blend factors, not raw GL enums.
      parameters: {
        depthTest: false,
        blend: true,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'src-alpha',
        blendColorDstFactor: 'one',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'src-alpha',
        blendAlphaDstFactor: 'one',
      },
    }),
    // wide halo
    new ScatterplotLayer({
      id: 'glow-halo',
      data: shownStyled,
      getPosition: (d) => d.t.pos,
      getFillColor: (d) => [...LINE_COLORS[d.t.line], 40 * d.style.fade * d.style.brightBoost],
      getRadius: (d) => 120 * d.style.radiusMult,
      radiusUnits: 'meters',
      radiusMinPixels: 10,
      parameters: { depthTest: false },
    }),
    // mid glow
    new ScatterplotLayer({
      id: 'glow-mid',
      data: shownStyled,
      getPosition: (d) => d.t.pos,
      getFillColor: (d) => [...LINE_COLORS[d.t.line], 110 * d.style.fade * d.style.brightBoost],
      getRadius: (d) => 45 * d.style.radiusMult,
      radiusUnits: 'meters',
      radiusMinPixels: 5,
      parameters: { depthTest: false },
    }),
    // bright core — hot white normally, red-shifted+pulsing when delayed
    new ScatterplotLayer({
      id: 'glow-core',
      data: shownStyled,
      getPosition: (d) => d.t.pos,
      getFillColor: (d) => [...d.style.core, 235 * d.style.fade],
      getRadius: (d) => 14 * d.style.radiusMult,
      radiusUnits: 'meters',
      radiusMinPixels: 2.5,
      parameters: { depthTest: false },
    }),
    // Station nodes (R11): a soft halo plus a stroke-only ring, both scaled
    // by each station's ridership weight (0.12 floor .. 1.0 ceiling — see
    // scripts/build-tracks.mjs) so the Loop's high-ridership cluster blazes
    // and outlying stops read as embers. Colored by the station's
    // highest-priority served line (LINE_KEYS order) — multi-line stations
    // (e.g. Belmont) get one ring in that line's color rather than one per
    // line, keeping the punctuation legible instead of stacking rings.
    new ScatterplotLayer({
      id: 'station-halo',
      data: shownStations,
      getPosition: (d) => d.coords,
      getFillColor: (d) => [...LINE_COLORS[stationColorLine(d)], 20 + 45 * d.weight],
      getRadius: (d) => 16 + 44 * d.weight,
      radiusUnits: 'meters',
      radiusMinPixels: 2,
      parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: 'station-ring',
      data: shownStations,
      getPosition: (d) => d.coords,
      filled: false,
      stroked: true,
      getLineColor: (d) => [...LINE_COLORS[stationColorLine(d)], 150 + 105 * d.weight],
      getLineWidth: (d) => 1.2 + 2.3 * d.weight,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 1,
      getRadius: (d) => 12 + 28 * d.weight,
      radiusUnits: 'meters',
      radiusMinPixels: 2,
      parameters: { depthTest: false },
    }),
  ];
}
