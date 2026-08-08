// The Tron pass: fading light trails (TripsLayer) + layered glow heads
// (stacked ScatterplotLayers = cheap bloom) + station-node rings. Additive
// blending on the trails so crossing trails brighten each other (R3);
// glow-head discs stay on standard alpha compositing (matches the pattern
// this extends) since additive white-hot cores would blow out to solid
// white wherever several trains cluster.

import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { capBuses } from './buses.js';
import { CAR_CAP } from './cars.js';
import { mPerDegLon, M_PER_DEG_LAT } from './tracks.js';

// Neon palette anchored to official CTA brand colors (transitchicago.com
// developers/branding, 2026) then boosted for cyberpunk readability on a
// near-black stage. Official RGB → neon:
//   Red    #c60c30 (227,25,55)   → hot neon red
//   Blue   #00a1de (0,157,220)   → ice cyan-blue
//   Brown  #62361b (118,66,0)    → copper-bronze (NOT chartreuse; that was a bug)
//   Green  #009b3a (0,169,79)    → electric green
//   Orange #f47836 (244,120,54)  → hot mango orange
//   Purple #522398 (73,47,146)   → vivid violet
//   Pink   #e27ea6 (243,139,185) → hot pink
//   Yellow (Skokie Swift gold)   → light amber-gold (lighter orange family,
//                                  not pure lemon — distinguishable from Brown copper)
export const LINE_COLORS = {
  Red: [255, 45, 72],
  Blue: [0, 196, 255],
  Brn: [210, 118, 48], // copper-brown — reads "Brown Line," not Yellow
  G: [20, 230, 95],
  Org: [255, 105, 28], // hot orange — distinct from Brown copper + Yellow gold
  P: [155, 78, 255],
  Pink: [255, 90, 185],
  Y: [255, 200, 70], // light amber / pale orange-gold (Skokie Swift energy)
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

// Aesthetic Tron pulses use a short bolt trail (matches PulseEngine.PULSE_TRAIL_SECONDS).
// Live vehicle trains (dormant this pass) used ~45s; keep pulse-first.
// Keep in sync with PulseEngine.PULSE_TRAIL_SECONDS.
// Tip-only aesthetic: trail *is* the vehicle (no disc heads).
const TRAIL_LENGTH = 8;

// U9 (R4, KTD12): buses read as a cool ice-blue/silver capsule against the
// trains' saturated line-color-plus-hot-white-core treatment. Hue ~225°
// sits in the untouched gap between Blue's ~195° and Purple's ~265° (a
// ~30°/~40° margin either side — the same "minimum ~28° gap" convention
// LINE_COLORS holds itself to), and its lightness (~0.71) is well above any
// line color's (~0.53-0.6), so buses are distinct on brightness alone even
// before hue registers. Verified via scripts run against rgbToHsl during
// this unit's build.
const BUS_COLOR = [150, 165, 210];
// Render-budget safety net (KTD8): the ~20 marquee routes' live vehicle
// count is unbounded by this app (unlike cars/trains) — CTA returns however
// many buses are actually running. capBuses() (src/buses.js) enforces this
// every frame, dropping whichever buses sit furthest from the viewport
// center first.
const BUS_CAP = 120;
// Elongated capsule dimensions (KTD12: shape carries the vehicle-kind
// distinction before color does). Deliberately stylized larger than a real
// ~12m bus, the same way trains' glow discs aren't to-scale either — sized
// so the capsule still reads as visibly elongated (not a dot) at
// LOOP_PRESET's zoom, per the plan's explicit legibility requirement.
const BUS_CAPSULE_HALF_LEN_M = 14;
const BUS_CAPSULE_WIDTH_M = 5;
// Buses get one dimmer, shorter trail pass — no 3-layer glow-head stack
// like trains (KTD12: buses are not second-class, but they are cooler and
// quieter).
const BUS_TRAIL_LENGTH = 18;

// U11 (KTD2, KTD8): cars are the smallest, quietest vehicle — a dark body
// legible only by its lights, so headline direction reads from the
// amber-headlight / red-taillight pair rather than from body color. Zoomed
// out past CAR_MIN_ZOOM the graph itself would start reading as a visible
// rectangle (scripts/build-roads.mjs's bbox is sized against exactly this
// zoom, not the whole city) — fading the layer out there, rather than at
// CITY_PRESET's zoom, is what keeps that boundary from ever being on screen.
const CAR_MIN_ZOOM = 14;
const CAR_BODY_HALF_LEN_M = 2.2;
const CAR_BODY_WIDTH_M = 1.7;
const CAR_LIGHT_LATERAL_M = 0.8; // half the headlight/taillight pair's spacing
const CAR_BODY_COLOR = [18, 18, 22];
const CAR_HEADLIGHT_COLOR = [255, 190, 90];
const CAR_TAILLIGHT_COLOR = [220, 35, 35];

// Offsets `[lon, lat]` by `meters` along compass bearing `headingDeg`
// (0 = north, clockwise) — used to build each bus's two-point capsule path
// from its center position and direction of travel. Small enough offsets
// (tens of meters) that the flat local-degrees approximation (tracks.js's
// shared mPerDegLon, also used by toMeters) is accurate well under a meter.
function offsetPoint([lon, lat], headingDeg, meters) {
  const rad = (headingDeg * Math.PI) / 180;
  return [lon + (Math.sin(rad) * meters) / mPerDegLon(lat), lat + (Math.cos(rad) * meters) / M_PER_DEG_LAT];
}

// Builds a headlight-or-taillight pair: two lights offset `lengthOffset`
// meters forward/back along the car's heading, then ±90° laterally by
// CAR_LIGHT_LATERAL_M. Replaces four near-identical nested offsetPoint()
// calls (front-left/front-right/back-left/back-right) with one call site
// per pair.
function lightPair(pos, headingDeg, lengthOffset) {
  const anchor = offsetPoint(pos, headingDeg, lengthOffset);
  return [
    offsetPoint(anchor, headingDeg - 90, CAR_LIGHT_LATERAL_M),
    offsetPoint(anchor, headingDeg + 90, CAR_LIGHT_LATERAL_M),
  ];
}

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

// U15 (R12): per-line disruption treatment for the train glow stack, keyed
// off alerts.js's classifyRouteStatus() tag. Mirrors trainStyle()'s shape
// (a pure function of state + currentTime) so a stressed line's glow
// animates the same way an isDly train's does, rather than introducing a
// second, differently-timed animation convention.
export function lineStressTreatment(tag, currentTime) {
  switch (tag) {
    case 'planned':
      // Slow breathing pulse, amber — "planned work" reads as calm, not urgent.
      return { color: [255, 180, 40], opacityMult: 0.55 + 0.45 * Math.sin(currentTime * Math.PI * 0.4) };
    case 'incident':
      // Fast, unstable flicker, red-shifted — an active incident reads as alarm.
      return { color: [255, 60, 40], opacityMult: 0.5 + 0.5 * Math.abs(Math.sin(currentTime * Math.PI * 2.5)) };
    case 'added':
      // Brighter, cooler cast, steady — more service is good news, not a warning.
      return { color: [140, 220, 255], opacityMult: 1 };
    default:
      return { color: null, opacityMult: 1 };
  }
}

const ACCESSIBILITY_GLYPH_COLOR = [255, 190, 60];
// Stable shared default for the `accessibilityStations` option below —
// avoids allocating a new empty Set every buildLayers() call (60x/sec) for
// every caller that doesn't pass one.
const EMPTY_SET = new Set();

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
  const {
    trailVersion = 0,
    stations = {},
    display = { trains: true, stations: true, buses: true, cars: true },
    buses = [],
    busTrailVersion = 0,
    viewportCenter = [0, 0],
    cars = [],
    zoom = 0,
    lineStatus = {},
    accessibilityStations = EMPTY_SET,
    // Live Nav: user geolocation fix { pos: [lon,lat], accuracyM } or null
    user = null,
    selectedStationId = null,
  } = options;

  // U12's DISPLAY toggles: `trains`/`stations` off means "don't draw this
  // layer at all," independent of the per-line `visibleLines` Set below.
  // Empty arrays keep the layer objects themselves stable (same layer
  // count every frame) rather than conditionally omitting them.
  const shown = display.trains
    ? trains.filter((t) => t.pos && visibleLines.has(t.line) && t.state !== 'removed')
    : [];
  // Tip-only: no disc heads. lineStatus drives MapLibre track stress in main.js;
  // trains here are trail-only energy packets.
  void lineStatus;

  // U9: same "off = empty array, not a conditionally-omitted layer" pattern
  // as trains/stations above. capBuses() is the render-budget safety net
  // (KTD8) — live bus count has no ceiling elsewhere in this app.
  const shownBuses = display.buses
    ? capBuses(buses.filter((b) => b.pos && b.state !== 'removed'), viewportCenter, BUS_CAP)
    : [];

  // U11: off = empty array below the fade zoom too, same "off = empty data"
  // convention as every other feed — not a conditionally-omitted layer, so
  // the layer count never changes frame to frame.
  const shownCars =
    display.cars && zoom >= CAR_MIN_ZOOM ? cars.filter((c) => c.pos).slice(0, CAR_CAP) : [];
  const headlights = shownCars.flatMap((c) => lightPair(c.pos, c.heading, CAR_BODY_HALF_LEN_M));
  const taillights = shownCars.flatMap((c) => lightPair(c.pos, c.heading, -CAR_BODY_HALF_LEN_M));

  // Live Nav: show stations for visible lines (Org-only MVP via visibleLines).
  const shownStations = getShownStations(stations, visibleLines, display);

  const userFixes = user?.pos ? [user] : [];

  return [
    new TripsLayer({
      id: 'trails',
      data: shown,
      getPath: (d) => d.trail.map((p) => [p.lon, p.lat]),
      getTimestamps: (d) => d.trail.map((p) => p.t),
      getColor: (d) => LINE_COLORS[d.line],
      currentTime,
      trailLength: TRAIL_LENGTH * 1.15,
      fadeTrail: true,
      capRounded: true,
      jointRounded: true,
      // Live trains: hot trail tip is the vehicle.
      widthMinPixels: 6,
      widthMaxPixels: 16,
      opacity: 1,
      updateTriggers: { getPath: trailVersion, getTimestamps: trailVersion },
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
    // U9: buses' own dimmer, shorter, single-pass trail — no 3-layer
    // glow-head stack like trains get (KTD12). Standard (non-additive)
    // alpha blending, unlike trains' additive trail above, is part of what
    // keeps this pass visually quieter.
    new TripsLayer({
      id: 'bus-trails',
      data: shownBuses,
      getPath: (d) => d.trail.map((p) => [p.lon, p.lat]),
      getTimestamps: (d) => d.trail.map((p) => p.t),
      getColor: BUS_COLOR,
      currentTime,
      trailLength: BUS_TRAIL_LENGTH,
      fadeTrail: true,
      capRounded: true,
      jointRounded: true,
      widthMinPixels: 2,
      opacity: 0.45,
      updateTriggers: { getPath: busTrailVersion, getTimestamps: busTrailVersion },
      parameters: { depthTest: false },
    }),
    // U9 (R4, KTD12): the elongated capsule that carries the trains/buses/
    // cars distinction by shape before color even registers. A two-point
    // PathLayer segment centered on the bus and built from its real
    // direction of travel — real geometry, so it orients correctly under
    // any map bearing with no screen-space rotation math needed (unlike an
    // IconLayer sprite, which would have to counter-rotate against the
    // map's own bearing to stay geographically oriented).
    // U17: the bus's own capsule body is its pickable target — already a
    // forgiving-enough click area (its real rendered length/width), unlike
    // cars below.
    new PathLayer({
      id: 'bus-capsules',
      data: shownBuses,
      pickable: true,
      getPath: (d) => [
        offsetPoint(d.pos, d.heading ?? 0, -BUS_CAPSULE_HALF_LEN_M),
        offsetPoint(d.pos, d.heading ?? 0, BUS_CAPSULE_HALF_LEN_M),
      ],
      getColor: [...BUS_COLOR, 235],
      getWidth: BUS_CAPSULE_WIDTH_M,
      widthUnits: 'meters',
      widthMinPixels: 4,
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getPath: busTrailVersion },
      parameters: { depthTest: false },
    }),
    // U11: ambient traffic — dark bodies so the amber/red light pairs (not
    // body color) carry the travel-direction read. Placed before the
    // transit glow stack below so trains/buses render on top of it.
    // U17: pickable, same as the bus/train targets above — cars' rendered
    // body is small (KTD2's intentional ambient-background scale), so this
    // is a genuinely tighter click target than the other two vehicle kinds;
    // an accepted tradeoff rather than something this unit re-sizes cars to
    // fix, since that would fight U11's own render-budget tuning.
    new PathLayer({
      id: 'car-bodies',
      data: shownCars,
      pickable: true,
      getPath: (d) => [
        offsetPoint(d.pos, d.heading, -CAR_BODY_HALF_LEN_M),
        offsetPoint(d.pos, d.heading, CAR_BODY_HALF_LEN_M),
      ],
      getColor: [...CAR_BODY_COLOR, 235],
      getWidth: CAR_BODY_WIDTH_M,
      widthUnits: 'meters',
      widthMinPixels: 2,
      capRounded: true,
      parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: 'car-headlights',
      data: headlights,
      getPosition: (d) => d,
      getFillColor: [...CAR_HEADLIGHT_COLOR, 235],
      getRadius: 1.1,
      radiusUnits: 'meters',
      radiusMinPixels: 1.4,
      parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: 'car-taillights',
      data: taillights,
      getPosition: (d) => d,
      getFillColor: [...CAR_TAILLIGHT_COLOR, 200],
      getRadius: 1,
      radiusUnits: 'meters',
      radiusMinPixels: 1.2,
      parameters: { depthTest: false },
    }),
    // Soft tip disc on live trains (pickable for run info).
    new ScatterplotLayer({
      id: 'glow-halo',
      data: shown,
      pickable: false,
      getPosition: (d) => d.pos,
      getFillColor: (d) => {
        const c = LINE_COLORS[d.line] ?? [255, 255, 255];
        return [...c, 90];
      },
      getRadius: 14,
      radiusMinPixels: 8,
      radiusMaxPixels: 22,
      parameters: { depthTest: false },
      updateTriggers: { getPosition: trailVersion, getFillColor: trailVersion },
    }),
    new ScatterplotLayer({
      id: 'glow-core',
      data: shown,
      pickable: true,
      getPosition: (d) => d.pos,
      getFillColor: [255, 255, 255, 240],
      getRadius: 5,
      radiusMinPixels: 3,
      radiusMaxPixels: 8,
      parameters: { depthTest: false },
      updateTriggers: { getPosition: trailVersion },
    }),
    // Orange stations — utility dots for nav (Maps place markers).
    new ScatterplotLayer({
      id: 'station-halo',
      data: shownStations,
      pickable: false,
      getPosition: (d) => d.coords,
      getFillColor: (d) =>
        d.id === selectedStationId ? [255, 160, 60, 100] : [255, 120, 40, 50],
      getRadius: (d) => (d.id === selectedStationId ? 22 : 14),
      radiusMinPixels: 6,
      radiusMaxPixels: 28,
      parameters: { depthTest: false },
      updateTriggers: { getFillColor: selectedStationId, getRadius: selectedStationId },
    }),
    new ScatterplotLayer({
      id: 'station-ring',
      data: shownStations,
      pickable: true,
      getPosition: (d) => d.coords,
      getFillColor: (d) =>
        d.id === selectedStationId ? [255, 180, 80, 255] : [255, 105, 28, 220],
      getLineColor: [255, 255, 255, 200],
      lineWidthMinPixels: 1,
      stroked: true,
      getRadius: (d) => (d.id === selectedStationId ? 9 : 6),
      radiusMinPixels: 4,
      radiusMaxPixels: 12,
      parameters: { depthTest: false },
      updateTriggers: { getFillColor: selectedStationId, getRadius: selectedStationId },
    }),
    new ScatterplotLayer({
      id: 'station-accessibility',
      data: shownStations.filter((s) => accessibilityStations.has?.(s.id)),
      getPosition: (d) => d.coords,
      getFillColor: [...ACCESSIBILITY_GLYPH_COLOR, 220],
      getRadius: 3,
      radiusMinPixels: 2,
      parameters: { depthTest: false },
    }),
    // Me-dot: Maps blue — never Orange (visual hierarchy law).
    new ScatterplotLayer({
      id: 'user-accuracy',
      data: userFixes,
      getPosition: (d) => d.pos,
      getFillColor: [66, 133, 244, 40],
      getRadius: (d) => Math.max(20, d.accuracyM ?? 30),
      radiusUnits: 'meters',
      radiusMinPixels: 12,
      parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: 'user-dot',
      data: userFixes,
      getPosition: (d) => d.pos,
      getFillColor: [66, 133, 244, 255],
      getLineColor: [255, 255, 255, 255],
      lineWidthMinPixels: 2,
      stroked: true,
      getRadius: 8,
      radiusMinPixels: 6,
      radiusMaxPixels: 10,
      parameters: { depthTest: false },
    }),
  ];
}
