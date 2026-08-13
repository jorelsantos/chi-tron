import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeStations, joinStatus, DivvyEngine, BAKE_DRIFT_THRESHOLD } from './divvy.js';

const BIG_ID = '2232759736070696510';
const BIG_ID_2 = '1934290380966283526';

describe('normalizeStations', () => {
  it('keeps station_id as a string — 19-digit ids lose precision as numbers', () => {
    const raw = {
      data: {
        stations: [
          {
            station_id: BIG_ID,
            name: 'Damen Ave & Ogden Ave',
            lat: 41.87317,
            lon: -87.67662,
            capacity: 15,
          },
        ],
      },
    };
    const [st] = normalizeStations(raw);
    expect(st.id).toBe(BIG_ID);
    expect(typeof st.id).toBe('string');
    // Prove the precision trap: Number(BIG_ID) !== the original digits.
    expect(String(Number(BIG_ID))).not.toBe(BIG_ID);
  });

  it('rounds lat/lon to 6 decimals', () => {
    const [st] = normalizeStations([
      {
        station_id: '1',
        name: 'Test',
        lat: 41.8731704,
        lon: -87.6766209,
        capacity: 10,
      },
    ]);
    expect(st.lat).toBe(41.87317);
    expect(st.lon).toBe(-87.676621);
  });

  it('drops entries missing lat, lon, or name', () => {
    const out = normalizeStations([
      { station_id: '1', name: 'Ok', lat: 41.8, lon: -87.6, capacity: 5 },
      { station_id: '2', name: 'No lat', lon: -87.6, capacity: 5 },
      { station_id: '3', name: 'No lon', lat: 41.8, capacity: 5 },
      { station_id: '4', lat: 41.8, lon: -87.6, capacity: 5 },
      { station_id: '5', name: '  ', lat: 41.8, lon: -87.6, capacity: 5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('1');
  });

  it('accepts the baked file shape {stations, bakedAt}', () => {
    const out = normalizeStations({
      stations: [{ id: '9', name: 'Baked', lat: 41.9, lon: -87.7, capacity: 12 }],
      bakedAt: '2026-08-11T00:00:00.000Z',
    });
    expect(out).toEqual([
      { id: '9', name: 'Baked', lat: 41.9, lon: -87.7, capacity: 12 },
    ]);
  });
});

describe('joinStatus classic vs e-bike split', () => {
  const stations = [
    {
      id: BIG_ID_2,
      name: 'Test Dock',
      lat: 41.88,
      lon: -87.63,
      capacity: 15,
    },
    {
      id: 'gone',
      name: 'Missing from status',
      lat: 41.89,
      lon: -87.64,
      capacity: 10,
    },
    {
      id: 'uninstalled',
      name: 'Torn down',
      lat: 41.87,
      lon: -87.65,
      capacity: 8,
    },
  ];

  it('classic = num_bikes_available - num_ebikes_available', () => {
    const live = joinStatus(stations, {
      data: {
        stations: [
          {
            station_id: BIG_ID_2,
            num_bikes_available: 8,
            num_ebikes_available: 2,
            num_docks_available: 6,
            is_installed: 1,
            is_renting: 1,
            is_returning: 1,
            last_reported: 1786479598,
          },
        ],
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0].classic).toBe(6);
    expect(live[0].ebikes).toBe(2);
    expect(live[0].docks).toBe(6);
    expect(live[0].id).toBe(BIG_ID_2);
    expect(typeof live[0].id).toBe('string');
  });

  it('clamps classic at 0 when e-bikes exceed available', () => {
    const live = joinStatus(stations, {
      data: {
        stations: [
          {
            station_id: BIG_ID_2,
            num_bikes_available: 1,
            num_ebikes_available: 3,
            num_docks_available: 0,
            is_installed: 1,
            is_renting: 1,
            is_returning: 0,
            last_reported: 1,
          },
        ],
      },
    });
    expect(live[0].classic).toBe(0);
    expect(live[0].ebikes).toBe(3);
    expect(live[0].returning).toBe(false);
  });

  it('skips is_installed === 0 and stations absent from status', () => {
    const live = joinStatus(stations, {
      data: {
        stations: [
          {
            station_id: BIG_ID_2,
            num_bikes_available: 0,
            num_ebikes_available: 0,
            num_docks_available: 10,
            is_installed: 1,
            is_renting: 0,
            is_returning: 1,
            last_reported: 1,
          },
          {
            station_id: 'uninstalled',
            num_bikes_available: 0,
            num_ebikes_available: 0,
            num_docks_available: 0,
            is_installed: 0,
            is_renting: 0,
            is_returning: 0,
            last_reported: 1,
          },
        ],
      },
    });
    expect(live.map((s) => s.id)).toEqual([BIG_ID_2]);
    expect(live[0].renting).toBe(false);
  });
});

describe('DivvyEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tick returns ingest result without advancing between frames', () => {
    const engine = new DivvyEngine([
      {
        id: '1',
        name: 'A',
        lat: 41.8,
        lon: -87.6,
        capacity: 10,
      },
    ]);
    engine.ingest({
      data: {
        stations: [
          {
            station_id: '1',
            num_bikes_available: 4,
            num_ebikes_available: 1,
            num_docks_available: 5,
            is_installed: 1,
            is_renting: 1,
            is_returning: 1,
            last_reported: 99,
          },
        ],
      },
    });
    const a = engine.tick();
    const b = engine.tick();
    expect(a).toHaveLength(1);
    expect(a[0].classic).toBe(3);
    expect(b).toBe(a);
  });

  it('loadStations hydrates after empty construct', () => {
    const engine = new DivvyEngine();
    expect(engine.tick()).toEqual([]);
    engine.loadStations([
      { id: '2', name: 'B', lat: 41.9, lon: -87.7, capacity: 8 },
    ]);
    engine.ingest({
      data: {
        stations: [
          {
            station_id: '2',
            num_bikes_available: 2,
            num_ebikes_available: 2,
            num_docks_available: 3,
            is_installed: 1,
            is_renting: 1,
            is_returning: 1,
            last_reported: 1,
          },
        ],
      },
    });
    expect(engine.tick()[0].classic).toBe(0);
    expect(engine.tick()[0].ebikes).toBe(2);
  });

  it('joinStatus matches on 1.1 and 2.3-shaped status rows', () => {
    const stations = [{ id: '9', name: 'Dock', lat: 41.8, lon: -87.6, capacity: 10 }];
    const classic11 = {
      data: {
        stations: [
          {
            station_id: '9',
            num_bikes_available: 5,
            num_ebikes_available: 2,
            num_docks_available: 4,
            is_installed: 1,
            is_renting: 1,
            is_returning: 1,
            last_reported: 10,
          },
        ],
      },
    };
    const classic23 = {
      data: {
        stations: [
          {
            ...classic11.data.stations[0],
            vehicle_types_available: [{ vehicle_type_id: '1', count: 3 }],
          },
        ],
      },
    };
    const a = joinStatus(stations, classic11)[0];
    const b = joinStatus(stations, classic23)[0];
    expect(a.classic).toBe(3);
    expect(a.ebikes).toBe(2);
    expect(b.classic).toBe(a.classic);
    expect(b.ebikes).toBe(a.ebikes);
  });

  it('reports bake drift and only self-heals once', async () => {
    const engine = new DivvyEngine([{ id: 'only', name: 'Old', lat: 41, lon: -87, capacity: 5 }]);
    const status = {
      data: {
        stations: [
          { station_id: 'only', num_bikes_available: 1, num_ebikes_available: 0, num_docks_available: 1, is_installed: 1, is_renting: 1, is_returning: 1, last_reported: 1 },
          { station_id: 'new1', num_bikes_available: 1, num_ebikes_available: 0, num_docks_available: 1, is_installed: 1, is_renting: 1, is_returning: 1, last_reported: 1 },
        ],
      },
    };
    expect(engine.driftRatio(status)).toBeGreaterThan(BAKE_DRIFT_THRESHOLD);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          stations: [
            { station_id: 'only', name: 'Old', lat: 41, lon: -87, capacity: 5 },
            { station_id: 'new1', name: 'New', lat: 41.1, lon: -87.1, capacity: 8 },
          ],
        },
      }),
    }));
    await engine.maybeHeal(status, fetchMock);
    await engine.maybeHeal(status, fetchMock);
    expect(engine.didSelfHeal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(engine.stations).toHaveLength(2);
  });

  it('does not self-heal at 0% drift', () => {
    const engine = new DivvyEngine([{ id: 'a', name: 'A', lat: 41, lon: -87, capacity: 5 }]);
    expect(
      engine.driftRatio({
        data: {
          stations: [{ station_id: 'a', num_bikes_available: 1, num_ebikes_available: 0 }],
        },
      }),
    ).toBe(0);
  });
});
