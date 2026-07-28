// Coverage for the pure/data-transform logic in layers.js that isn't a
// rendering concern (which the plan correctly scoped to manual browser
// verification): trainStyle()'s branch selection, and buildLayers()'s
// DISPLAY-toggle and station-cache behavior via its returned deck.gl layer
// `data` arrays (layer construction alone touches no WebGL/canvas).

import { describe, it, expect } from 'vitest';
import { trainStyle, buildLayers } from './layers.js';

function layerById(layers, id) {
  return layers.find((l) => l.id === id);
}

describe('trainStyle', () => {
  const base = { state: 'tracking', isDly: false, isApp: false };

  it('returns the steady white-core style for a normal train', () => {
    const s = trainStyle(base, 0);
    expect(s.core).toEqual([255, 255, 255]);
    expect(s.radiusMult).toBe(1);
    expect(s.brightBoost).toBe(1);
  });

  it('brightens and swells an approaching train without pulsing', () => {
    const s = trainStyle({ ...base, isApp: true }, 0);
    expect(s.radiusMult).toBeGreaterThan(1);
    expect(s.brightBoost).toBeGreaterThan(1);
  });

  it('red-shifts a delayed train and includes a defined brightBoost (no ?? 1 fallback needed)', () => {
    const s = trainStyle({ ...base, isDly: true }, 0);
    expect(s.core).toEqual([255, 70, 70]);
    expect(s.brightBoost).toBe(1);
  });

  it('prioritizes isDly over isApp when both flags are true', () => {
    const s = trainStyle({ ...base, isDly: true, isApp: true }, 0);
    expect(s.core).toEqual([255, 70, 70]); // the isDly (red) treatment, not isApp's white swell
    expect(s.radiusMult).toBe(1); // isApp's radius bump does not apply
  });

  it('fades a stale train independent of its isDly/isApp state', () => {
    const normalStale = trainStyle({ ...base, state: 'stale' }, 0);
    expect(normalStale.fade).toBeLessThan(1);
  });
});

describe('buildLayers DISPLAY toggles and station cache', () => {
  const visibleLines = new Set(['Red']);
  const trains = [
    { pos: [-87.6, 41.9], line: 'Red', state: 'tracking', trail: [{ lon: -87.6, lat: 41.9, t: 0 }] },
  ];
  const stations = {
    a: { coords: [-87.6, 41.9], lines: ['Red'], weight: 0.5 },
    b: { coords: [-87.61, 41.91], lines: ['Blue'], weight: 0.5 },
  };

  it('renders trains and their glow when display.trains is true', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: true, stations: false },
    });
    expect(layerById(layers, 'trails').props.data.length).toBe(1);
    expect(layerById(layers, 'glow-core').props.data.length).toBe(1);
  });

  it('empties train and glow layer data when display.trains is false', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: false },
    });
    expect(layerById(layers, 'trails').props.data.length).toBe(0);
    expect(layerById(layers, 'glow-core').props.data.length).toBe(0);
  });

  it('shows only stations on a visible line when display.stations is true', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: true },
    });
    const shown = layerById(layers, 'station-ring').props.data;
    expect(shown).toHaveLength(1);
    expect(shown[0].lines).toEqual(['Red']); // station "b" (Blue-only) is filtered out
  });

  it('empties station layer data when display.stations is false', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: false },
    });
    expect(layerById(layers, 'station-ring').props.data.length).toBe(0);
  });

  it('does not serve a stale station list after visibleLines changes (cache invalidation)', () => {
    const first = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: true },
    });
    expect(layerById(first, 'station-ring').props.data.length).toBe(1); // just station "a" (Red)

    visibleLines.add('Blue');
    const second = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: true },
    });
    expect(layerById(second, 'station-ring').props.data.length).toBe(2); // now "a" and "b"
    visibleLines.delete('Blue'); // restore for any later test in this file
  });

  it('colors a multi-line station by a line the user has NOT hidden, not always lines[0]', () => {
    // getShownStations() caches keyed only on the visibleLines signature
    // (see its own comment in layers.js -- a known, accepted limitation),
    // not on the `stations` object's identity. Reusing visibleLines=['Red']
    // from earlier tests here would silently return THEIR cached station
    // list instead of computing fresh against multiLineStations below, so
    // this test deliberately uses a visibleLines signature ('Org') no
    // other test in this file touches.
    const multiLineStations = {
      x: { coords: [-87.6, 41.9], lines: ['Blue', 'Org'], weight: 0.5 },
    };
    const onlyOrgVisible = new Set(['Org']);
    const layers = buildLayers([], 0, onlyOrgVisible, {
      stations: multiLineStations,
      display: { trains: false, stations: true },
    });
    const [station] = layerById(layers, 'station-ring').props.data;
    const [r, , b] = layerById(layers, 'station-ring').props.getLineColor(station);
    // Org's LINE_COLORS entry is [255, 87, 15] (high red, low blue) --
    // distinct enough from Blue's [26, 198, 255] that checking both
    // channels is unambiguous.
    expect(r).toBeGreaterThan(100);
    expect(b).toBeLessThan(100);
  });
});
