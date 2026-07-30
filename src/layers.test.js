// Coverage for pure/data-transform logic in layers.js.

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

  it('red-shifts a delayed train and includes a defined brightBoost', () => {
    const s = trainStyle({ ...base, isDly: true }, 0);
    expect(s.core).toEqual([255, 70, 70]);
    expect(s.brightBoost).toBe(1);
  });

  it('prioritizes isDly over isApp when both flags are true', () => {
    const s = trainStyle({ ...base, isDly: true, isApp: true }, 0);
    expect(s.core).toEqual([255, 70, 70]);
    expect(s.radiusMult).toBe(1);
  });

  it('fades a stale train independent of its isDly/isApp state', () => {
    const normalStale = trainStyle({ ...base, state: 'stale' }, 0);
    expect(normalStale.fade).toBeLessThan(1);
  });
});

describe('buildLayers tip-only trains', () => {
  const visibleLines = new Set(['Red']);
  const trains = [
    {
      pos: [-87.6, 41.9],
      line: 'Red',
      state: 'tracking',
      trail: [{ lon: -87.6, lat: 41.9, t: 0 }],
    },
  ];
  const stations = {
    a: { coords: [-87.6, 41.9], lines: ['Red'], weight: 0.5 },
    b: { coords: [-87.61, 41.91], lines: ['Blue'], weight: 0.5 },
  };

  it('draws trails but no disc heads (tip-only)', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: true, stations: false },
    });
    expect(layerById(layers, 'trails').props.data.length).toBe(1);
    expect(layerById(layers, 'glow-core').props.data.length).toBe(0);
    expect(layerById(layers, 'glow-halo').props.data.length).toBe(0);
  });

  it('empties trail data when display.trains is false', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: false },
    });
    expect(layerById(layers, 'trails').props.data.length).toBe(0);
  });

  it('hard-disables station rings regardless of display.stations', () => {
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
    expect(t0).not.toBe(t1);
    expect(lineStressTreatment('added', 0).opacityMult).toBe(lineStressTreatment('added', 5).opacityMult);
  });
});

describe('buildLayers picking scope (U17)', () => {
  it('enables pickable on bus/car layers only (no train heads in tip-only)', () => {
    const layers = buildLayers([], 0, new Set(['Red']), {});
    expect(layerById(layers, 'glow-halo').props.pickable).not.toBe(true);
    expect(layerById(layers, 'bus-capsules').props.pickable).toBe(true);
    expect(layerById(layers, 'car-bodies').props.pickable).toBe(true);
    expect(layerById(layers, 'trails').props.pickable).not.toBe(true);
  });
});

describe('buildLayers car layer (U11)', () => {
  const visibleLines = new Set(['Red']);
  const cars = [{ pos: [-87.6, 41.9], heading: 90 }];

  it('renders car bodies and lights at/above the configured minimum zoom', () => {
    const layers = buildLayers([], 0, visibleLines, { cars, zoom: 14, display: { cars: true } });
    expect(layerById(layers, 'car-bodies').props.data.length).toBe(1);
    expect(layerById(layers, 'car-headlights').props.data.length).toBe(2);
    expect(layerById(layers, 'car-taillights').props.data.length).toBe(2);
  });
});
