// Custom MapLibre styles — dark 3D stage for CHI-TRON.
// OpenFreeMap planet tiles (keyless). No labels: silhouette and light only.

const SIDEBAR_BIASED_CENTER = [-87.6198, 41.8781]; // ~0.008deg east of Loop for sidebar

export const LOOP_PRESET = {
  center: SIDEBAR_BIASED_CENTER,
  zoom: 15.4,
  pitch: 60,
  bearing: -12,
};

export const CITY_PRESET = {
  center: SIDEBAR_BIASED_CENTER,
  zoom: 11.2,
  pitch: 35,
  bearing: 0,
};

const HEIGHT_EXAGGERATION = 1.9;
const CROWN_LIGHT_DELTA = 14;
const BUILDING_FILTER = ['!=', ['get', 'hide_3d'], true];
const RENDER_HEIGHT = ['coalesce', ['get', 'render_height'], 8];
const EXAGGERATED_HEIGHT = ['*', RENDER_HEIGHT, HEIGHT_EXAGGERATION];

/**
 * City landscape palettes for A/B compare.
 * Bodies stay near-black; crowns + fog carry the vibe.
 */
export const CITY_PALETTES = {
  // Cold steel + cyan haze — classic cyberpunk / Tron night.
  classic: {
    id: 'classic',
    label: 'CLASSIC CYBERPUNK',
    bg: '#020308',
    landuse: '#04060c',
    water: '#030a12',
    roadMinor: '#080c16',
    roadMajor: '#0e1422',
    body: ['#020208', '#04060e', '#060a14', '#0a101c'],
    crown: ['#060a14', '#0e2238', '#1a4a6a'],
    crownOpacity: 0.78,
    sky: {
      'sky-color': '#02040c',
      'sky-horizon-blend': 0.55,
      'horizon-color': '#0a1830',
      'horizon-fog-blend': 0.65,
      'fog-color': '#061018',
      'fog-ground-blend': 0.72,
    },
  },
  // Magenta night — Edgerunners energy; dim crowns so Pink L still wins.
  magenta: {
    id: 'magenta',
    label: 'MAGENTA NIGHT',
    bg: '#060208',
    landuse: '#0a040c',
    water: '#08040e',
    roadMinor: '#100812',
    roadMajor: '#180c1a',
    body: ['#040208', '#08040c', '#0c0610', '#120818'],
    crown: ['#100610', '#3a1030', '#7a2060'],
    crownOpacity: 0.72,
    sky: {
      'sky-color': '#080210',
      'sky-horizon-blend': 0.55,
      'horizon-color': '#1a0a22',
      'horizon-fog-blend': 0.65,
      'fog-color': '#100818',
      'fog-ground-blend': 0.72,
    },
  },
  // Wet Magenta = Magenta Night DNA + Blade Runner weight/rain-noir.
  // ~70% atmosphere/mass noir, ~30% magenta on fog + rare crowns.
  wetMagenta: {
    id: 'wet-magenta',
    label: 'WET MAGENTA',
    bg: '#020104',
    landuse: '#050308',
    water: '#030208', // black-mirror lake
    roadMinor: '#060408',
    roadMajor: '#0a060e', // wet asphalt, almost gone
    // Heavier, less chroma — dead industrial mass
    body: ['#020104', '#040208', '#06030a', '#0a0510'],
    // Dim merlot rims; never hot pink
    crown: ['#08040c', '#1a0a18', '#4a1838'],
    crownOpacity: 0.48,
    sky: {
      'sky-color': '#030108',
      'sky-horizon-blend': 0.72,
      'horizon-color': '#0c0614',
      'horizon-fog-blend': 0.82,
      'fog-color': '#080410',
      'fog-ground-blend': 0.85,
    },
  },
};

/** Build a full MapLibre style for one landscape palette. */
export function makeCityStyle(palette) {
  const p = typeof palette === 'string' ? CITY_PALETTES[palette] : palette;
  if (!p) throw new Error(`Unknown city palette: ${palette}`);

  return {
    version: 8,
    name: `chi-tron-${p.id}`,
    sources: {
      ofm: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.bg } },
      {
        id: 'landuse-dim',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'landuse',
        paint: { 'fill-color': p.landuse, 'fill-opacity': 0.6 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'water',
        paint: { 'fill-color': p.water },
      },
      {
        id: 'roads-minor',
        type: 'line',
        source: 'ofm',
        'source-layer': 'transportation',
        filter: ['!', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]],
        paint: {
          'line-color': p.roadMinor,
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
          'line-color': p.roadMajor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, 5],
        },
      },
      {
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 13,
        filter: BUILDING_FILTER,
        paint: {
          // Kept darker than visual target — MapLibre side lighting lifts faces.
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            EXAGGERATED_HEIGHT,
            0,
            p.body[0],
            80,
            p.body[1],
            250,
            p.body[2],
            600,
            p.body[3],
          ],
          'fill-extrusion-height': EXAGGERATED_HEIGHT,
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.97,
        },
      },
      {
        id: 'buildings-3d-crown',
        type: 'fill-extrusion',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 13,
        filter: BUILDING_FILTER,
        paint: {
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            EXAGGERATED_HEIGHT,
            0,
            p.crown[0],
            150,
            p.crown[1],
            600,
            p.crown[2],
          ],
          'fill-extrusion-height': ['+', EXAGGERATED_HEIGHT, CROWN_LIGHT_DELTA],
          'fill-extrusion-base': EXAGGERATED_HEIGHT,
          'fill-extrusion-opacity': p.crownOpacity,
        },
      },
    ],
    sky: {
      'sky-color': p.sky['sky-color'],
      'sky-horizon-blend': p.sky['sky-horizon-blend'],
      'horizon-color': p.sky['horizon-color'],
      'horizon-fog-blend': p.sky['horizon-fog-blend'],
      'fog-color': p.sky['fog-color'],
      'fog-ground-blend': p.sky['fog-ground-blend'],
    },
  };
}

// Default export for single-map mode / fallbacks.
export const DARK_CITY_STYLE = makeCityStyle(CITY_PALETTES.classic);

export const FALLBACK_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
