// Coverage for the pure/state-machine logic in trains.js that isn't a DOM or
// visual concern (which the plan correctly scoped to manual browser
// verification): toBool()'s CTA-payload normalization, and the mock
// isDly/isApp re-roll timer exercised through TrainEngine's public API.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toBool, TrainEngine, now } from './trains.js';

describe('toBool', () => {
  it('treats the CTA payload string "1" as true', () => {
    expect(toBool('1')).toBe(true);
  });

  it('treats the CTA payload string "0" as false', () => {
    expect(toBool('0')).toBe(false);
  });

  it('treats JS boolean true and the number 1 as true', () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(1)).toBe(true);
  });

  it('treats undefined, null, and other strings as false', () => {
    expect(toBool(undefined)).toBe(false);
    expect(toBool(null)).toBe(false);
    expect(toBool('yes')).toBe(false);
  });
});

// Minimal single-segment line so TrainEngine's geometry helpers (which this
// suite never exercises directly) have something valid to prepare.
const FAKE_TRACKS = {
  Red: { coords: [[-87.63, 41.88], [-87.62, 41.89]], cumDist: [0, 1000] },
};

describe('TrainEngine mock isDly/isApp re-roll', () => {
  it('re-rolls flags and advances nextFlagRoll strictly forward over repeated ticks', () => {
    const engine = new TrainEngine(FAKE_TRACKS);
    engine.seedMock(1);
    const [train] = engine.trains.values();

    // Force an immediate re-roll on the next tick, then confirm the new
    // nextFlagRoll always lands strictly after the roll time and within
    // the documented [10s, 30s) window. now() is real wall-clock seconds
    // since page/module load, not test-controlled, so bracket it rather
    // than assuming any particular value.
    const beforeRoll = now();
    train.nextFlagRoll = 0; // guarantees this tick's t >= nextFlagRoll
    engine.tick();
    const afterRoll = now();
    const firstRoll = train.nextFlagRoll;
    expect(firstRoll).toBeGreaterThanOrEqual(beforeRoll + 10);
    expect(firstRoll).toBeLessThan(afterRoll + 30);

    // A tick before the scheduled roll must not re-roll early.
    const before = { isDly: train.isDly, isApp: train.isApp, nextFlagRoll: train.nextFlagRoll };
    engine.tick();
    expect(train.nextFlagRoll).toBe(before.nextFlagRoll);
  });
});

describe('TrainEngine.clear (U16)', () => {
  it('drops every train regardless of mock/live origin', () => {
    const engine = new TrainEngine(FAKE_TRACKS);
    engine.seedMock(2);
    expect(engine.trains.size).toBeGreaterThan(0);
    engine.clear();
    expect(engine.trains.size).toBe(0);
  });
});

function redTrainBody(rn, errCd = '0') {
  return {
    ctatt: {
      errCd,
      route: {
        '@name': 'red',
        train: { rn, lon: '-87.63', lat: '41.88' },
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Poller backs off after a failure (5s, then 10s, then 20s, then 40s).
// Step one second at a time so the 20s abort timeout never fires mid-request.
async function untilStatuses(statuses, count) {
  for (let step = 0; step < 80 && statuses.length < count; step++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
}

describe('TrainEngine live errCd', () => {
  let engine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new TrainEngine(FAKE_TRACKS);
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends at lost after three errCd 100 polls and keeps Red-101, then returns to live on errCd 0', async () => {
    const bodies = [
      redTrainBody('101'),
      { ctatt: { errCd: '100' } },
      { ctatt: { errCd: '100' } },
      { ctatt: { errCd: '100' } },
      redTrainBody('101', '0'),
    ];
    let next = 0;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(bodies[next++])));

    const statuses = [];
    engine.onStatus = (status) => {
      statuses.push(status);
    };
    engine.startLive();

    await untilStatuses(statuses, 4);
    expect(statuses).toEqual(['live', 'live', 'live', 'lost']);
    expect(engine.trains.has('Red-101')).toBe(true);

    await untilStatuses(statuses, 5);
    expect(statuses.at(-1)).toBe('live');
    expect(engine.trains.has('Red-101')).toBe(true);
  });
});
