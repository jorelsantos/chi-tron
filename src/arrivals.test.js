import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  normalizeArrivals,
  parseChicagoArrT,
  minutesUntil,
  formatClock,
} from './arrivals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'src/fixtures/ttarrivals-halsted.json');

describe('arrivals normalize', () => {
  it('parses Halsted fixture into Org rows with minutes', () => {
    const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const rows = normalizeArrivals(data, { rtFilter: 'org', nowMs: Date.parse('2026-08-08T17:52:00Z') });
    // Fixture was recorded with local Chicago times; just assert shape + filter
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.rt.toLowerCase()).toBe('org');
      expect(r.destNm).toBeTruthy();
      expect(r.staId === '41130' || r.staId === '').toBe(true);
      expect(r.minutes === 'DUE' || typeof r.minutes === 'number').toBe(true);
    }
  });

  it('filters non-org when rtFilter set', () => {
    const data = {
      ctatt: {
        eta: [
          { rt: 'Red', destNm: 'Howard', arrT: '2026-08-08T12:00:00', isApp: '0', isDly: '0', isSch: '0', rn: '1' },
          { rt: 'Org', destNm: 'Midway', arrT: '2026-08-08T12:05:00', isApp: '0', isDly: '0', isSch: '0', rn: '2', staId: '41130' },
        ],
      },
    };
    const rows = normalizeArrivals(data, { rtFilter: 'org', nowMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].destNm).toBe('Midway');
  });

  it('marks isApp as DUE', () => {
    expect(minutesUntil(Date.now() + 120000, Date.now(), true)).toBe('DUE');
  });

  it('parseChicagoArrT returns finite ms', () => {
    const ms = parseChicagoArrT('2026-08-08T12:29:01');
    expect(Number.isFinite(ms)).toBe(true);
  });

  it('formatClock returns a string', () => {
    const ms = parseChicagoArrT('2026-08-08T12:29:01');
    expect(formatClock(ms).length).toBeGreaterThan(0);
  });
});
