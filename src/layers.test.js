// Coverage for pure/data-transform logic in layers.js.

import { describe, it, expect } from 'vitest';
import { trainStyle, buildLayers, lineStressTreatment, busBodyPolygon } from './layers.js';

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
      heading: 0,
      trail: [{ lon: -87.6, lat: 41.9, t: 0 }],
    },
  ];
  const stations = {
    a: { id: 'a', coords: [-87.6, 41.9], lines: ['Red'], weight: 0.5 },
    b: { id: 'b', coords: [-87.61, 41.91], lines: ['Blue'], weight: 0.5 },
  };

  it('draws live train trails and a three-car consist', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: true, stations: false },
    });
    expect(layerById(layers, 'trails').props.data.length).toBe(1);
    expect(layerById(layers, 'train-cars-core').props.data.length).toBe(3);
    expect(layerById(layers, 'train-cars-halo').props.data.length).toBe(3);
    expect(layerById(layers, 'train-couplers').props.data.length).toBe(2);
    expect(layerById(layers, 'train-bolt-core')).toBeUndefined();
  });

  it('empties trail data when display.trains is false', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: false },
    });
    expect(layerById(layers, 'trails').props.data.length).toBe(0);
  });

  it('shows station diamonds when display.stations is true', () => {
    const layers = buildLayers(trains, 0, visibleLines, {
      stations,
      display: { trains: false, stations: true },
    });
    const ring = layerById(layers, 'station-ring');
    expect(ring.props.data.length).toBe(1);
    expect(ring.props.data[0].path?.length).toBeGreaterThanOrEqual(4);
    const path = ring.props.data[0].path;
    const dLat = Math.abs(path[0][1] - path[2][1]);
    expect(dLat).toBeGreaterThan(0.0002);
    expect(dLat).toBeLessThan(0.00032);
  });

  it('draws one diamond per visible line on a shared stop', () => {
    const shared = {
      id: 'howard',
      coords: [-87.673, 42.019],
      lines: ['Red', 'P'],
      rails: {
        Red: { coords: [-87.672, 42.019], heading: 0 },
        P: { coords: [-87.674, 42.019], heading: 0 },
      },
    };
    const layers = buildLayers([], 0, new Set(['Red', 'P']), {
      stations: { howard: shared },
      display: { trains: false, stations: true },
      zoom: 14,
    });
    const marks = layerById(layers, 'station-ring').props.data;
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.railLine).sort()).toEqual(['P', 'Red']);
    expect(marks[0].coords[0]).not.toBe(marks[1].coords[0]);
  });

  it('shifts a Loop Pink station onto the inward ribbon', () => {
    const pinkStop = {
      id: 'p-loop',
      coords: [-87.6262, 41.882],
      lines: ['Pink'],
      railLine: 'Pink',
      railHeading: 0,
    };
    const layers = buildLayers([], 0, new Set(['Pink']), {
      stations: { 'p-loop': pinkStop },
      display: { trains: false, stations: true },
      zoom: 14,
    });
    const ring = layerById(layers, 'station-ring');
    expect(ring.props.data[0].coords[0]).toBeLessThan(pinkStop.coords[0]);
  });

  it('draws user me-dot when user fix provided', () => {
    const layers = buildLayers([], 0, visibleLines, {
      display: { trains: false, stations: false },
      user: { pos: [-87.6, 41.9], accuracyM: 25 },
    });
    expect(layerById(layers, 'user-dot').props.data.length).toBe(1);
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
  it('enables pickable on train car cores, bus capsules, car bodies', () => {
    const layers = buildLayers([], 0, new Set(['Red']), {});
    expect(layerById(layers, 'train-cars-halo').props.pickable).not.toBe(true);
    expect(layerById(layers, 'train-cars-core').props.pickable).toBe(true);
    expect(layerById(layers, 'train-couplers').props.pickable).not.toBe(true);
    const bus = layerById(layers, 'bus-capsules');
    expect(bus.props.pickable).toBe(true);
    expect(typeof bus.props.getPolygon).toBe('function');
    expect(layerById(layers, 'car-bodies').props.pickable).toBe(true);
    expect(layerById(layers, 'trails').props.pickable).not.toBe(true);
  });
});

describe('busBodyPolygon', () => {
  it('is a closed rounded rectangle, not a two-point pill', () => {
    const ring = busBodyPolygon([-87.63, 41.88], 0);
    expect(ring.length).toBeGreaterThan(16);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const lats = ring.map((p) => p[1]);
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0.0003);
  });
});

describe('stationLineRgb', () => {
  it('uses the visible line color for a station', async () => {
    const { stationLineRgb } = await import('./layers.js');
    const rgb = stationLineRgb({ lines: ['Blue'] }, new Set(['Blue', 'Org']));
    expect(rgb[2]).toBeGreaterThan(rgb[0]); // blue channel high for Blue line
  });
});

describe('buildLayers divvy dots', () => {
  const visibleLines = new Set(['Red']);
  const station = (i, lon, lat) => ({
    id: String(i),
    name: `S${i}`,
    lon,
    lat,
    capacity: 10,
    classic: 2,
    ebikes: 1,
    docks: 5,
    renting: true,
  });

  it('hides bikes below the zoom gate', () => {
    const layers = buildLayers([], 0, visibleLines, {
      bikes: [station(1, -87.63, 41.88)],
      zoom: 13.4,
      display: { bikes: true },
    });
    expect(layerById(layers, 'divvy-stations').props.data).toHaveLength(0);
  });

  it('shows bikes above the zoom gate', () => {
    const layers = buildLayers([], 0, visibleLines, {
      bikes: [station(1, -87.63, 41.88)],
      zoom: 13.6,
      display: { bikes: true },
    });
    expect(layerById(layers, 'divvy-stations').props.data.length).toBeGreaterThan(0);
  });

  it('drops stations outside viewportBounds', () => {
    const layers = buildLayers([], 0, visibleLines, {
      bikes: [station(1, -87.63, 41.88), station(2, -88.5, 42.2)],
      zoom: 14,
      display: { bikes: true },
      viewportBounds: [-87.7, 41.8, -87.5, 41.95],
    });
    const data = layerById(layers, 'divvy-stations').props.data;
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('1');
  });

  it('caps in-bounds stations at 400', () => {
    const bikes = Array.from({ length: 500 }, (_, i) =>
      station(i, -87.63 + (i % 20) * 0.001, 41.88 + Math.floor(i / 20) * 0.001),
    );
    const layers = buildLayers([], 0, visibleLines, {
      bikes,
      zoom: 14,
      display: { bikes: true },
      viewportCenter: [-87.63, 41.88],
      viewportBounds: [-88, 41.7, -87.4, 42.1],
    });
    expect(layerById(layers, 'divvy-stations').props.data).toHaveLength(400);
  });

  it('skips bounds filtering when viewportBounds is null', () => {
    const layers = buildLayers([], 0, visibleLines, {
      bikes: [station(1, -90, 40)],
      zoom: 14,
      display: { bikes: true },
      viewportBounds: null,
    });
    expect(layerById(layers, 'divvy-stations').props.data).toHaveLength(1);
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
