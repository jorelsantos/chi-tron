// Coverage for the pure/data-transform logic in layers.js that isn't a
// rendering concern (which the plan correctly scoped to manual browser
// verification): trainStyle()'s branch selection, and buildLayers()'s
// DISPLAY-toggle and station-cache behavior via its returned deck.gl layer
// `data` arrays (layer construction alone touches no WebGL/canvas).

import { describe, it, expect } from 'vitest';
import { trainStyle, buildLayers, lineStressTreatment } from './layers.js';

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

  it('hard-disables station rings this pass regardless of display.stations', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: true },
    });
    expect(layerById(layers, 'station-ring').props.data.length).toBe(0);
    expect(layerById(layers, 'station-halo').props.data.length).toBe(0);
  });
});

describe('lineStressTreatment (U15)', () => {
  it('returns no color override and full opacity for a normal/unknown tag', () => {
    expect(lineStressTreatment('normal', 0)).toEqual({ color: null, opacityMult: 1 });
    expect(lineStressTreatment(undefined, 0)).toEqual({ color: null, opacityMult: 1 });
  });

  it('overrides color for planned, incident and added, each distinctly', () => {
    const planned = lineStressTreatment('planned', 0);
    const incident = lineStressTreatment('incident', 0);
    const added = lineStressTreatment('added', 0);
    expect(planned.color).not.toBeNull();
    expect(incident.color).not.toBeNull();
    expect(added.color).not.toBeNull();
    expect(planned.color).not.toEqual(incident.color);
    expect(planned.color).not.toEqual(added.color);
  });

  it('animates opacity over time for planned/incident, but holds steady for added', () => {
    const t0 = lineStressTreatment('planned', 0).opacityMult;
    const t1 = lineStressTreatment('planned', 1).opacityMult;
    expect(t0).not.toBe(t1); // the breathing pulse actually moves
    expect(lineStressTreatment('added', 0).opacityMult).toBe(lineStressTreatment('added', 5).opacityMult);
  });
});

describe('buildLayers line stress and accessibility glyph (U15)', () => {
  const visibleLines = new Set(['Red']);
  const trains = [
    { pos: [-87.6, 41.9], line: 'Red', state: 'tracking', trail: [{ lon: -87.6, lat: 41.9, t: 0 }] },
  ];
  const stations = { a: { id: 'a', coords: [-87.6, 41.9], lines: ['Red'], weight: 0.5 } };

  it("uses the stressed line's override color on the glow-halo layer", () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      display: { trains: true },
      lineStatus: { Red: 'incident' },
    });
    const [r, g, b] = layerById(layers, 'glow-halo').props.getFillColor(
      layerById(layers, 'glow-halo').props.data[0]
    );
    expect([r, g, b]).toEqual(lineStressTreatment('incident', 0).color);
  });

  it('does not render accessibility glyphs while stations are hard-off', () => {
    const layers = buildLayers([], 0, visibleLines, {
      stations,
      display: { stations: true },
      accessibilityStations: new Set(['a']),
    });
    expect(layerById(layers, 'station-accessibility').props.data).toHaveLength(0);
  });
});

describe('buildLayers picking scope (U17)', () => {
  it('enables pickable on vehicle layers, not trail/station layers', () => {
    const layers = buildLayers([], 0, new Set(['Red']), {});
    const pickableIds = ['glow-halo', 'bus-capsules', 'car-bodies'];
    const notPickableIds = ['trails', 'bus-trails', 'glow-core', 'station-halo', 'station-ring'];
    for (const id of pickableIds) {
      expect(layerById(layers, id).props.pickable).toBe(true);
    }
    for (const id of notPickableIds) {
      expect(layerById(layers, id).props.pickable).not.toBe(true);
    }
  });
});

describe('buildLayers car layer (U11)', () => {
  const visibleLines = new Set(['Red']);
  const cars = [{ pos: [-87.6, 41.9], heading: 90 }];

  it('renders car bodies and lights at/above the configured minimum zoom', () => {
    const layers = buildLayers([], 0, visibleLines, { cars, zoom: 14, display: { cars: true } });
    expect(layerById(layers, 'car-bodies').props.data.length).toBe(1);
    expect(layerById(layers, 'car-headlights').props.data.length).toBe(2); // a headlight pair per car
    expect(layerById(layers, 'car-taillights').props.data.length).toBe(2);
  });

  it('renders nothing below the configured minimum zoom, even with display.cars on', () => {
    const layers = buildLayers([], 0, visibleLines, { cars, zoom: 13.9, display: { cars: true } });
    expect(layerById(layers, 'car-bodies').props.data.length).toBe(0);
    expect(layerById(layers, 'car-headlights').props.data.length).toBe(0);
  });

  it('renders nothing when display.cars is false, regardless of zoom', () => {
    const layers = buildLayers([], 0, visibleLines, { cars, zoom: 16, display: { cars: false } });
    expect(layerById(layers, 'car-bodies').props.data.length).toBe(0);
  });
});
