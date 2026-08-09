import { describe, it, expect } from 'vitest';
import {
  normalizeBusPredictions,
  parseBusPrdtm,
  groupBusByDirection,
} from './bus-arrivals.js';

describe('bus-arrivals', () => {
  it('parseBusPrdtm returns finite ms', () => {
    const ms = parseBusPrdtm('20260808 14:30');
    expect(Number.isFinite(ms)).toBe(true);
  });

  it('normalizeBusPredictions filters by rt and sorts', () => {
    const data = {
      'bustime-response': {
        prd: [
          {
            rt: '8',
            rtdir: 'Northbound',
            des: 'Waveland/Broadway',
            prdctdn: '5',
            prdtm: '20260808 14:35',
            stpid: '1',
            dly: false,
          },
          {
            rt: '62',
            rtdir: 'Eastbound',
            des: 'Archer',
            prdctdn: '2',
            prdtm: '20260808 14:32',
            stpid: '1',
            dly: false,
          },
          {
            rt: '8',
            rtdir: 'Northbound',
            des: 'Waveland/Broadway',
            prdctdn: 'DUE',
            prdtm: '20260808 14:30',
            stpid: '1',
            dly: false,
          },
        ],
      },
    };
    const rows = normalizeBusPredictions(data, { rtFilter: '8' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rt === '8')).toBe(true);
    expect(rows[0].minutes).toBe('DUE');
  });

  it('groupBusByDirection splits by rtdir', () => {
    const rows = [
      { rtdir: 'Northbound', minutes: 3, des: 'A' },
      { rtdir: 'Southbound', minutes: 5, des: 'B' },
      { rtdir: 'Northbound', minutes: 8, des: 'A' },
    ];
    const g = groupBusByDirection(rows);
    expect(g).toHaveLength(2);
  });
});
