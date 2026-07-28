// U14 — poll governor and API budget safety (R10, KTD10).
//
// One reusable module every outbound-polling feed instantiates its own
// `Poller` from — trains today, buses/alerts later in this same Phase B
// pass. Each instance owns exactly one feed's request cadence and knows
// nothing about what it's fetching; callers supply `fetchFn` (perform the
// actual request + ingest, throw on any failure) and read back status via
// `onStatus`. This keeps trains.js's snap/tween/ingest logic completely
// separate from "should a request go out right now."
//
// Four independent safety gates, checked on every tick, in this order:
//   1. visibility  — no fetch while the tab is hidden
//   2. single-flight — no fetch while this feed's previous fetch is pending
//   3. daily ceiling — no fetch once today's ledger meets the configured cap
//   4. backoff due-time — no fetch until the last failure's cooldown elapses
// Only a request that clears all four increments the ledger and actually
// calls `fetchFn`.
//
// Scheduling model: a single fixed-rate timer (`setInterval(intervalMs)`)
// drives every check. Backoff does NOT reschedule the timer itself — it
// works by making ticks no-ops until `nextAllowedAt` (a timestamp computed
// at attempt time) elapses. This keeps the timer's cadence simple and, as a
// side effect, is what makes single-flight overlap a real, testable
// scenario: if `fetchFn` takes longer than `intervalMs` to settle, the next
// tick fires right on schedule and must be skipped by the in-flight guard
// rather than by luck of a chained setTimeout never firing early.

// KTD10: CTA allows 100,000 requests/day/key on both Train and Bus Tracker.
// Self-imposed ceiling is ~25% of that, applied per keyed feed. Endpoints
// with no key (route status / alerts, added later in this plan) pass
// `ceiling: Infinity` (or omit `storageKey`) to opt out of ledger tracking
// entirely — ledger cost is zero for them by design, not by omission.
export const DEFAULT_DAILY_CEILING = 25000;

const LEDGER_PREFIX = 'chi-tron:ledger:';

function localDateStamp(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class Poller {
  /**
   * @param {object} opts
   * @param {string|null} [opts.storageKey] localStorage ledger namespace for
   *   this feed's key (e.g. 'cta-train'). Omit (or leave null) for a keyless
   *   endpoint — no ledger is read or written and the ceiling gate never
   *   trips.
   * @param {number} opts.intervalMs normal poll cadence.
   * @param {(signal: AbortSignal) => Promise<any>} opts.fetchFn performs one
   *   request + ingest; must throw/reject on any failure (network, non-2xx,
   *   malformed body). Receives an AbortSignal that fires on `stop()` or the
   *   per-attempt timeout -- pass it to every `fetch()` call so cancellation
   *   actually interrupts the in-flight request instead of merely being
   *   ignored downstream.
   * @param {(status: 'ok'|'error'|'hold', err?: Error) => void} [opts.onStatus]
   *   called after every attempt (or gated hold) with the outcome. `err` is
   *   only present on 'error'.
   * @param {number} [opts.ceiling] max requests/day for this feed's ledger.
   *   Infinity (default) = unmetered — keyless feeds want this.
   * @param {number} [opts.maxBackoffMs] backoff cap (default 60000, per R10).
   * @param {{getItem, setItem}} [opts.storage] defaults to global localStorage.
   * @param {() => number} [opts.now] defaults to Date.now; injectable so
   *   tests can move the ledger's calendar date without real timers.
   * @param {number} [opts.timeoutMs] per-attempt fetch timeout (default
   *   20000). A hung connection (accepted, never responded to) would
   *   otherwise leave `fetchFn`'s promise pending forever, wedging
   *   single-flight closed with no backoff (a real failure never occurs to
   *   trigger one) — code review finding, U-fix.
   * @param {number} [opts.requestsPerCall] real outbound HTTP requests one
   *   `fetchFn()` call actually issues (default 1). A feed whose fetchFn
   *   fans out to more than one real request (e.g. buses.js's per-chunk
   *   getvehicles calls) must report this so the ledger — and therefore
   *   the daily ceiling — tracks real request volume, not attempt count.
   */
  constructor({
    storageKey = null,
    intervalMs,
    fetchFn,
    onStatus = () => {},
    ceiling = Infinity,
    maxBackoffMs = 60000,
    storage = typeof localStorage !== 'undefined' ? localStorage : undefined,
    now = () => Date.now(),
    timeoutMs = 20000,
    requestsPerCall = 1,
  }) {
    this.storageKey = storageKey;
    this.intervalMs = intervalMs;
    this.fetchFn = fetchFn;
    this.onStatus = onStatus;
    this.ceiling = ceiling;
    this.maxBackoffMs = maxBackoffMs;
    this.storage = storage;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.requestsPerCall = requestsPerCall;

    this.running = false;
    this.inFlight = false;
    this.consecutiveFailures = 0;
    this.nextAllowedAt = 0; // due immediately on the first tick
    this.timer = null;
    this.controller = null; // AbortController for whichever attempt is currently in flight
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibility);
    }
    // Immediate first attempt (mirrors the pre-U14 poll() call pattern) —
    // but only if the tab is already visible; if it starts hidden, wait for
    // the first visibilitychange rather than firing on a hidden tab.
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden) this.#tick();
    this.#arm();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibility);
    }
    // Abort whatever attempt is in flight so a late response can never apply
    // stale data after this feed has been told to stop -- e.g. a mode switch
    // clearing this feed's vehicles moments before an already-issued fetch
    // resolves would otherwise resurrect them (code review finding).
    this.controller?.abort();
  }

  // Current ledger count for today, per this feed's storageKey. 0 for a
  // keyless feed (no storageKey) or a fresh/stale-dated entry.
  getLedgerCount() {
    return this.#readLedger();
  }

  #arm() {
    if (this.timer) return; // already armed
    if (typeof document !== 'undefined' && document.hidden) return; // stay paused while hidden
    this.timer = setInterval(() => this.#tick(), this.intervalMs);
  }

  // A private field (not a private method) so it's a stable bound-once
  // reference add/removeEventListener can target across start()/stop().
  #onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    } else if (this.running) {
      // Just resume the normal cadence — no immediate catch-up fetch, so
      // returning to the tab never bursts the missed polls.
      this.#arm();
    }
  };

  #tick() {
    if (typeof document !== 'undefined' && document.hidden) return; // belt-and-suspenders
    if (this.inFlight) return; // single-flight: skip, don't queue
    if (this.#atCeiling()) {
      this.onStatus('hold');
      return;
    }
    if (this.now() < this.nextAllowedAt) return; // backoff cooldown not elapsed
    this.#attempt();
  }

  async #attempt() {
    this.inFlight = true;
    // Optimistic default for the next normal-cadence request; overwritten
    // below on failure with the backoff delay instead.
    this.nextAllowedAt = this.now() + this.intervalMs;
    const controller = new AbortController();
    this.controller = controller;
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Poller: request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      // Ledger increment moved inside try: a throwing storage.setItem (quota
      // exceeded, private-browsing storage disabled) must still hit the
      // finally below and release inFlight, not deadlock single-flight
      // forever (code review finding).
      this.#incrementLedger();
      await this.fetchFn(controller.signal);
      this.consecutiveFailures = 0;
      this.onStatus('ok');
    } catch (err) {
      if (!this.running) return; // stop() aborted us deliberately -- not a real failure
      this.consecutiveFailures++;
      const backoff = Math.min(this.maxBackoffMs, this.intervalMs * 2 ** this.consecutiveFailures);
      this.nextAllowedAt = this.now() + backoff;
      this.onStatus('error', err);
    } finally {
      clearTimeout(timeoutId);
      if (this.controller === controller) this.controller = null;
      this.inFlight = false;
    }
  }

  #atCeiling() {
    if (!this.storageKey || !Number.isFinite(this.ceiling)) return false;
    return this.#readLedger() >= this.ceiling;
  }

  #ledgerKey() {
    return `${LEDGER_PREFIX}${this.storageKey}`;
  }

  #readLedger() {
    if (!this.storageKey || !this.storage) return 0;
    const raw = this.storage.getItem(this.#ledgerKey());
    if (!raw) return 0;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (!parsed || parsed.date !== localDateStamp(this.now())) return 0; // stale prior-day entry
    return Number.isFinite(parsed.count) ? parsed.count : 0;
  }

  #incrementLedger() {
    if (!this.storageKey || !this.storage) return; // keyless feed: zero ledger cost
    const date = localDateStamp(this.now());
    const count = this.#readLedger() + this.requestsPerCall;
    this.storage.setItem(this.#ledgerKey(), JSON.stringify({ date, count }));
  }
}
