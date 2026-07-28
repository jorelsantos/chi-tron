// Custom MapLibre style — the Blade Runner stage.
// OpenFreeMap planet tiles (keyless), every color ours. No labels: the city
// reads as silhouette and light, not cartography.

export const CHICAGO_LOOP = [-87.6298, 41.8781];

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
    { id: 'bg', type: 'background', paint: { 'background-color': '#04050a' } },
    {
      id: 'landuse-dim',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'landuse',
      paint: { 'fill-color': '#060810', 'fill-opacity': 0.6 },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'water',
      paint: { 'fill-color': '#08111e' },
    },
    {
      id: 'roads-minor',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      filter: ['!', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]],
      paint: {
        'line-color': '#11131d',
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
        'line-color': '#1b1f31',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, 5],
      },
    },
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'ofm',
      'source-layer': 'building',
      minzoom: 12,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8],
          0, '#0d1024',
          60, '#141a3c',
          200, '#1d2760',
        ],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.92,
      },
    },
  ],
};

// Fallback stage if OpenFreeMap is unreachable — CARTO dark matter (also keyless).
export const FALLBACK_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
