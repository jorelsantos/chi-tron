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
 * City landscape palettes. Shipping baseline: coldSteel (cold steel + cyan haze).
 */
const COLD_STEEL = {
  id: 'cold-steel',
  label: 'COLD STEEL + CYAN HAZE',
  bg: '#010206',
  landuse: '#03050a',
  water: '#020810', // deep teal-black lake
  roadMinor: '#060a14',
  roadMajor: '#0c1424',
  // Near-black mass, slight cool lift at height
  body: ['#010206', '#03050c', '#050812', '#08101c'],
  // Steel → ice cyan rims (readable without fighting Blue L)
  crown: ['#061018', '#0e3050', '#1a6a9a'],
  crownOpacity: 0.82,
  sky: {
    'sky-color': '#01030a',
    'sky-horizon-blend': 0.6,
    'horizon-color': '#0a2040',
    'horizon-fog-blend': 0.72,
    'fog-color': '#041220',
    'fog-ground-blend': 0.78,
  },
};

export const CITY_PALETTES = {
  coldSteel: COLD_STEEL,
  classic: { ...COLD_STEEL, id: 'classic', label: 'CLASSIC CYBERPUNK' },
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

// Shipping baseline: cold steel + cyan haze.
export const DARK_CITY_STYLE = makeCityStyle(CITY_PALETTES.coldSteel);

export const FALLBACK_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
