// U14 (R10, KTD10) — pure-logic coverage for the poll governor. No DOM, no
// real network: `document`, `localStorage` and `fetch` are all hand-rolled
// fakes stubbed via vi.stubGlobal, matching the plain-Node environment
// stations.test.js/layers.test.js already run in (no jsdom in this repo).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Poller, DEFAULT_DAILY_CEILING } from './poller.js';

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
}

// Minimal fake `document` exposing just what Poller touches: a mutable
// `hidden` flag and visibilitychange add/removeEventListener.
function makeDocument(initialHidden) {
  let hidden = initialHidden;
  const listeners = new Set();
  return {
    get hidden() {
      return hidden;
    },
    set hidden(v) {
      hidden = v;
    },
    addEventListener(type, cb) {
      if (type === 'visibilitychange') listeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'visibilitychange') listeners.delete(cb);
    },
    _fireVisibilityChange() {
      for (const cb of [...listeners]) cb();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Poller — visibility gate', () => {
  it('issues no fetch while the tab starts hidden, and resumes on visibilitychange back to visible', async () => {
    const doc = makeDocument(true);
    vi.stubGlobal('document', doc);
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller({ intervalMs: 5000, fetchFn, storage: makeStorage() });

    poller.start();
    await vi.advanceTimersByTimeAsync(20000); // several intervals' worth, still hidden
    expect(fetchFn).not.toHaveBeenCalled();

    doc.hidden = false;
    doc._fireVisibilityChange();
    // Resuming re-arms the normal interval but does NOT fire an immediate
    // catch-up fetch — nothing should happen until the next full interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stops issuing fetches once the tab is hidden again', async () => {
    const doc = makeDocument(false);
    vi.stubGlobal('document', doc);
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller({ intervalMs: 1000, fetchFn, storage: makeStorage() });

    poller.start(); // immediate attempt #1
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    doc.hidden = true;
    doc._fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchFn).toHaveBeenCalledTimes(1); // no further fetches while hidden
  });
});

describe('Poller — single-flight', () => {
  it('skips a poll attempt for the same feed while the previous one is still in flight, rather than queuing it', async () => {
    vi.stubGlobal('document', makeDocument(false));
    let resolveFetch;
    const fetchFn = vi.fn(() => new Promise((resolve) => (resolveFetch = resolve)));
    const poller = new Poller({ intervalMs: 1000, fetchFn, storage: makeStorage() });

    poller.start(); // immediate attempt #1, left pending on purpose
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // A full interval elapses while attempt #1 is still unresolved — this
    // tick must be skipped, not queued behind the first.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFetch();
    await vi.advanceTimersByTimeAsync(0); // let attempt #1's .then settle, clearing inFlight

    // Now that the previous attempt has settled, the next tick may proceed.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('Poller — exponential backoff', () => {
  it('backs off exponentially on consecutive failures, caps at maxBackoffMs, and recovers to the normal interval on the next success', async () => {
    vi.stubGlobal('document', makeDocument(false));
    let fail = true;
    const fetchFn = vi.fn(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve()));
    const onStatus = vi.fn();
    const poller = new Poller({
      intervalMs: 5000,
      maxBackoffMs: 60000,
      fetchFn,
      onStatus,
      storage: makeStorage(),
    });

    poller.start(); // attempt #1 fails
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith('error', expect.any(Error));

    // Backoff after 1 failure: min(60000, 5000*2^1) = 10000ms. A single
    // normal-cadence tick (5000ms) must NOT be enough to retry yet.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // total 10000ms since failure #1
    expect(fetchFn).toHaveBeenCalledTimes(2); // attempt #2 fails too

    // Backoff after 2 failures: min(60000, 5000*2^2) = 20000ms.
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); // total 20000ms since failure #2
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // Drive failures up until the delay is capped at maxBackoffMs (60000):
    // 2^3=40000, 2^4=80000->capped to 60000. Two more failures gets there.
    await vi.advanceTimersByTimeAsync(40000);
    expect(fetchFn).toHaveBeenCalledTimes(4); // attempt #4 fails (backoff was 40000)
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchFn).toHaveBeenCalledTimes(5); // attempt #5 fails (backoff capped at 60000)

    // Recovery: next attempt succeeds, so the cadence must fall back to the
    // plain intervalMs (5000ms), not remain at the 60s cap.
    fail = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(onStatus).toHaveBeenLastCalledWith('ok');

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(7); // back to the normal 5000ms cadence
  });
});

describe('Poller — daily ledger', () => {
  it('increments the ledger by exactly 1 per real outbound request, and the count persists across a simulated reload', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const storage = makeStorage();
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const poller1 = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-train',
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn,
      storage,
    });

    poller1.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller1.getLedgerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poller1.getLedgerCount()).toBe(2);
    poller1.stop();

    // Simulated reload: a brand-new Poller instance against the same
    // storage must see the prior count, not start over from 0.
    const poller2 = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-train',
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn,
      storage,
    });
    expect(poller2.getLedgerCount()).toBe(2);
  });

  it('increments the ledger by requestsPerCall when one fetchFn call fans out to more than one real request', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const storage = makeStorage();
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-bus',
      ceiling: DEFAULT_DAILY_CEILING,
      requestsPerCall: 2, // e.g. buses.js's 2 route-chunk getvehicles calls per attempt
      fetchFn,
      storage,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getLedgerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poller.getLedgerCount()).toBe(4);
  });

  it('never increments the ledger for a keyless feed (no storageKey), regardless of how many requests fire', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller({ intervalMs: 1000, ceiling: Infinity, fetchFn, storage: makeStorage() });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(poller.getLedgerCount()).toBe(0); // no storageKey => never tracked
  });

  it('resets when the local calendar date changes — a stale prior-day entry does not carry forward', () => {
    const storage = makeStorage();
    storage.setItem('chi-tron:ledger:cta-train', JSON.stringify({ date: '2026-07-27', count: 24999 }));

    const poller = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-train',
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn: vi.fn(),
      storage,
      now: () => new Date('2026-07-28T09:00:00').getTime(),
    });

    expect(poller.getLedgerCount()).toBe(0);
  });
});

describe('Poller — budget ceiling / BUDGET HOLD', () => {
  it('stops issuing requests entirely once the ledger meets the configured ceiling, and reports hold', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const storage = makeStorage();
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const onStatus = vi.fn();
    const poller = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-train',
      ceiling: 2,
      fetchFn,
      onStatus,
      storage,
    });

    poller.start(); // attempt #1 -> ledger 1
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); // attempt #2 -> ledger 2, now at ceiling
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000); // tick #3: at ceiling, must not fetch
    await vi.advanceTimersByTimeAsync(1000); // tick #4: still gated
    expect(fetchFn).toHaveBeenCalledTimes(2); // no growth past the ceiling
    expect(poller.getLedgerCount()).toBe(2); // gated ticks never increment the ledger
    expect(onStatus).toHaveBeenLastCalledWith('hold');
  });

  it('a keyless feed (ceiling: Infinity, no storageKey) never enters hold', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const onStatus = vi.fn();
    const poller = new Poller({ intervalMs: 1000, ceiling: Infinity, fetchFn, onStatus, storage: makeStorage() });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onStatus).not.toHaveBeenCalledWith('hold');
  });
});

describe('Poller — ledger write failures never wedge single-flight', () => {
  it('recovers inFlight and keeps polling even when storage.setItem throws', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const onStatus = vi.fn();
    const poller = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-train',
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn,
      onStatus,
      storage,
    });

    poller.start(); // attempt #1: ledger write throws before fetchFn ever runs
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith('error', expect.any(Error));

    // A throwing ledger write must still clear inFlight via finally, so the
    // next tick (after backoff) is not permanently skipped.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn.mock.calls.length + onStatus.mock.calls.filter((c) => c[0] === 'error').length).toBeGreaterThan(1);
  });
});

describe('Poller — request timeout and cancellation', () => {
  function makeAbortableFetch() {
    return vi.fn((signal) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      });
    });
  }

  it('aborts and reports error on a request that never settles once timeoutMs elapses', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const fetchFn = makeAbortableFetch();
    const onStatus = vi.fn();
    const poller = new Poller({ intervalMs: 5000, timeoutMs: 2000, fetchFn, onStatus, storage: makeStorage() });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled(); // still hung, not yet timed out

    await vi.advanceTimersByTimeAsync(2000); // timeout fires, aborts the signal
    expect(onStatus).toHaveBeenLastCalledWith('error', expect.any(Error));

    // inFlight must be released. Backoff after this failure is
    // min(maxBackoffMs, intervalMs*2^1) = 10000ms, due at the 2000ms mark
    // (12000ms total) -- but the timer only ticks on intervalMs' fixed
    // 5000ms cadence, so the first tick that actually clears the backoff
    // gate lands at 15000ms total, not 12000ms.
    await vi.advanceTimersByTimeAsync(13000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('stop() aborts the in-flight request, and its late rejection is not reported as a failure', async () => {
    vi.stubGlobal('document', makeDocument(false));
    const fetchFn = makeAbortableFetch();
    const onStatus = vi.fn();
    const poller = new Poller({ intervalMs: 5000, fetchFn, onStatus, storage: makeStorage() });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(0); // let the abort's rejection settle

    expect(onStatus).not.toHaveBeenCalled(); // a deliberate stop is not an error
    expect(poller.inFlight).toBe(false); // released, not wedged
  });
});

describe('Poller — gated attempts never cost the ledger', () => {
  it('a hidden tab keeps the ledger at 0 even though the timer keeps ticking', async () => {
    const doc = makeDocument(true);
    vi.stubGlobal('document', doc);
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller({
      intervalMs: 1000,
      storageKey: 'cta-train',
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn,
      storage: makeStorage(),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(poller.getLedgerCount()).toBe(0);
  });
});
