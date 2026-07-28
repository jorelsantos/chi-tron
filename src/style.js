// Custom MapLibre style — the Blade Runner stage.
// OpenFreeMap planet tiles (keyless), every color ours. No labels: the city
// reads as silhouette and light, not cartography.

// Both camera presets below share this center — U12's sidebar docks left at
// ~300px, so every framing is biased east of the true Chicago Loop
// (-87.6298, 41.8781) to keep the downtown core in the visible map area
// rather than behind the panel. One constant, not a copy per preset, so the
// two can't drift apart.
const SIDEBAR_BIASED_CENTER = [-87.6198, 41.8781]; // ~0.008deg (~660m) east of the Loop

// U7: fixed framing for the "shipping" view. Later units (sidebar in U12,
// camera presets in U13) tune against this exact constant rather than
// re-deriving numbers.
export const LOOP_PRESET = {
  center: SIDEBAR_BIASED_CENTER,
  zoom: 15.4,
  pitch: 60,
  bearing: -12,
};

// U13: the "zoomed out to see the whole city" camera preset the CAMERA
// section's CITY button flies to — meant to read as a real alternative to
// the tight, dramatic LOOP_PRESET framing, not a minor variation on it.
// zoom 11.2 brings most of the city (Loop through the North Side and out
// past Midway/O'Hare's inbound approach) into frame; pitch 35 keeps some of
// the 3D skyline read without the steep, cinematic tilt of LOOP_PRESET's 60.
// Bearing 0 (true north-up) contrasts with LOOP_PRESET's rotated -12 and
// gives the compass a visible reason to move on flight.
export const CITY_PRESET = {
  center: SIDEBAR_BIASED_CENTER,
  zoom: 11.2,
  pitch: 35,
  bearing: 0,
};

// Building extrusion height exaggeration. OpenFreeMap's render_height is
// generic/modeled, not surveyed — multiplying it lets the downtown core
// dominate the skyline the way the reference does. Tuned by eye.
const HEIGHT_EXAGGERATION = 1.9;
const CROWN_LIGHT_DELTA = 14; // meters of extra height for the lit-crown pass

// hide_3d: OpenMapTiles sets this on building features meant to be excluded
// from 3D rendering (e.g. footprints under a bridge/overpass) — extruding
// them anyway produces phantom boxes.
const BUILDING_FILTER = ['!=', ['get', 'hide_3d'], true];

const RENDER_HEIGHT = ['coalesce', ['get', 'render_height'], 8];
const EXAGGERATED_HEIGHT = ['*', RENDER_HEIGHT, HEIGHT_EXAGGERATION];

export const DARK_CITY_STYLE = {
  version: 8,
  name: 'chi-tron-dark',
  sources: {
    ofm: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#020306' } },
    {
      id: 'landuse-dim',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'landuse',
      paint: { 'fill-color': '#040509', 'fill-opacity': 0.6 },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'water',
      paint: { 'fill-color': '#040a13' },
    },
    {
      id: 'roads-minor',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      filter: ['!', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]],
      paint: {
        'line-color': '#0a0c15',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 2.5],
      },
    },
    {
      id: 'roads-major',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
      paint: {
        'line-color': '#12141f',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, 5],
      },
    },
    {
      // Bodies: near-black, ramping toward a dim warm-amber tint at height
      // so mass reads by silhouette, not by flat color. The ramp's hue
      // (amber/orange) sits well outside the Blue (#00d4ff-ish cyan) and
      // Purple (#b45cff-ish) line hues in src/layers.js LINE_COLORS, so
      // lit building edges are never mistaken for transit lines.
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'ofm',
      'source-layer': 'building',
      minzoom: 13, // OpenFreeMap's `building` source-layer has no data below z13
      filter: BUILDING_FILTER,
      paint: {
        // maplibre's default light shades fill-extrusion side faces up
        // noticeably brighter than the raw paint color at this pitch, so
        // these stops are kept much darker than the visual target — near
        // black even at the top of the domain — and let the crown layer
        // below carry the actual neon punch.
        'fill-extrusion-color': [
          'interpolate', ['linear'], EXAGGERATED_HEIGHT,
          0, '#020203',
          80, '#040305',
          250, '#070408',
          600, '#0c060a',
        ],
        'fill-extrusion-height': EXAGGERATED_HEIGHT,
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.97,
      },
    },
    {
      // Crown light: a second fill-extrusion slab sitting just above each
      // building's exaggerated roofline, so only the tops catch a hot
      // amber glint. A `line` layer can't do this — maplibre-gl 5.24's
      // style spec has no `line-z-offset`, so a line pass would render
      // flat at the footprint and never reach the crowns.
      id: 'buildings-3d-crown',
      type: 'fill-extrusion',
      source: 'ofm',
      'source-layer': 'building',
      minzoom: 13,
      filter: BUILDING_FILTER,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], EXAGGERATED_HEIGHT,
          0, '#0a0503',
          150, '#331a08',
          600, '#c4590f',
        ],
        'fill-extrusion-height': ['+', EXAGGERATED_HEIGHT, CROWN_LIGHT_DELTA],
        'fill-extrusion-base': EXAGGERATED_HEIGHT,
        'fill-extrusion-opacity': 0.85,
      },
    },
  ],
  sky: {
    'sky-color': '#02030a',
    'sky-horizon-blend': 0.5,
    'horizon-color': '#0a0f1e',
    'horizon-fog-blend': 0.6,
    'fog-color': '#060a14',
    'fog-ground-blend': 0.7,
  },
};

// Fallback stage if OpenFreeMap is unreachable — CARTO dark matter (also keyless).
export const FALLBACK_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
