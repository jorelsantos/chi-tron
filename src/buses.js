// Bus engine: live poller + per-run tween state machine, and the mock
// generator. Mirrors src/trains.js's shape closely so render code (and the
// U14 Poller) treat trains and buses identically — the two differ only in
// how a reported position is placed on the baked geometry: trains snap a
// live lat/lon onto the nearest point of their line's polyline (tracks.js's
// snapToLine); buses need no snapping at all, because CTA's getvehicles
// reports `pdist` — distance in feet along the bus's own `pid` pattern —
// which is a direct index into that pattern's baked polyline. See
// build-patterns.mjs for why the *raw* per-point pdist in getpatterns can't
// be used for that polyline and had to be recomputed at build time.

import { Poller, DEFAULT_DAILY_CEILING } from './poller.js';
import { now } from './trains.js';

const POLL_MS = 15000;
// U14 ledger namespace for this feed's key (CTA_BUS_KEY) — kept distinct
// from trains.js's 'cta-train' so the two feeds' daily budgets never share
// one counter (KTD10, R10).
const BUS_LEDGER_KEY = 'cta-bus';
const STALE_POLLS = 2; // absent this many polls -> stale -> removed (mirrors trains.js)
const TRAIL_SECONDS = 30; // shorter than trains' 60s — buses get a dimmer, briefer trail (KTD12)
const MAX_ROUTES_PER_CALL = 10; // KTD5: getvehicles hard cap

// The ~20 marquee high-frequency routes this feed polls live and the mock
// generator walks. Must match scripts/build-patterns.mjs's MARQUEE_ROUTES
// exactly — that script is what actually produces patterns.json's `routes`
// keys, so this copy exists only for callers (main.js, tests) that want the
// list without loading the built JSON, and for #pollOnce's fallback when a
// caller constructs a BusEngine with no patterns data at all.
export const MARQUEE_ROUTES = [
  '22', '4', '8', '9', '20', '49', '151', '6', '3', '66',
  '77', '79', '80', '82', '146', '147', '152', '55', '63', 'X9',
];

// Plausible bus road speed range in feet/sec (patterns.json's distance unit
// — see build-patterns.mjs), used only by seedMock/EXPLORE mode. ~10-17mph
// average including stops — slower than trains.js's mock L-train speed,
// which never stops mid-line.
const MOCK_SPEED_MIN_FTPS = 15;
const MOCK_SPEED_MAX_FTPS = 24;

/** Splits a route id list into chunks of at most `size` — guards KTD5's
 * 10-route-per-call cap on getvehicles. Pure and exported so it's directly
 * testable without a network. */
export function chunkRoutes(routeIds, size = MAX_ROUTES_PER_CALL) {
  const out = [];
  for (let i = 0; i < routeIds.length; i += size) out.push(routeIds.slice(i, i + size));
  return out;
}

/** Extracts the `vehicle` array from a raw CTA getvehicles JSON body.
 * Returns [] for both of CTA's "no buses" shapes — a `bustime-response`
 * carrying an `error` array (its documented no-service response), and one
 * with a missing/non-array `vehicle` field — rather than assuming either
 * shape. Never throws. */
export function extractVehicles(payload) {
  const vehicles = payload?.['bustime-response']?.vehicle;
  return Array.isArray(vehicles) ? vehicles : [];
}

/** True if `payload` is CTA's auth-error shape (invalid/missing key) rather
 * than a benign no-service response. CTA answers a bad key with HTTP 200
 * and a `bustime-response.error` array naming the key — indistinguishable
 * from "no buses right now" by status code alone — so #pollOnce checks this
 * to decide whether to throw (flip the bus feed to lost) or treat the
 * response as merely empty (leave prior state intact, per CTA's normal
 * off-hours/no-service behavior). */
export function isAuthError(payload) {
  const errors = payload?.['bustime-response']?.error;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => /key/i.test(String(e?.msg ?? '')));
}

// Prepares one baked pattern for interpolation: ensures points are sorted by
// pdist ascending (they already are out of build-patterns.mjs, but this
// keeps interpolatePattern's binary search correct even if that invariant
// ever slips) and derives totalDist defensively rather than trusting the
// stored value blindly.
function preparePattern(pattern) {
  const points = [...pattern.points].sort((a, b) => a.pdist - b.pdist);
  const totalDist = points.length ? points[points.length - 1].pdist : 0;
  return { ...pattern, points, totalDist };
}

/** Distance-along-pattern (feet) -> [lon, lat]. Binary search over the
 * baked points' pdist, mirroring tracks.js's pointAtDist exactly (same
 * clamp-at-both-ends behavior), but reading a plain points array with an
 * inline `pdist` per point instead of a parallel cumDist array — that's the
 * only shape difference, since buses interpolate directly instead of
 * snapping. Returns null for a pattern with no points at all (defensive;
 * build-patterns.mjs never emits one, since it drops any pattern under 2
 * points before writing patterns.json). */
export function interpolatePattern(pattern, pdist) {
  const { points, totalDist } = pattern;
  if (!points || points.length === 0) return null;
  if (points.length === 1) return [points[0].lon, points[0].lat];
  const d = Math.max(0, Math.min(pdist, totalDist));
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].pdist <= d) lo = mid;
    else hi = mid;
  }
  const segLen = points[hi].pdist - points[lo].pdist;
  const t = segLen > 0 ? (d - points[lo].pdist) / segLen : 0;
  return [
    points[lo].lon + t * (points[hi].lon - points[lo].lon),
    points[lo].lat + t * (points[hi].lat - points[lo].lat),
  ];
}

// Compass bearing (degrees, clockwise from north) from point a to point b —
// standard flat-earth approximation, accurate well under a degree at the
// short (tens-of-meters) distances this is used over.
function bearingDeg([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * rad);
  const dLat = lat2 - lat1;
  let deg = Math.atan2(dLon, dLat) / rad;
  if (deg < 0) deg += 360;
  return deg;
}

// Feet to sample ahead along the pattern when deriving a bus's heading —
// far enough that adjacent baked points' coordinate rounding doesn't
// dominate the bearing, short enough to still reflect the bus's local
// direction of travel (not the pattern's shape ten blocks away).
const HEADING_SAMPLE_FT = 15;

/** The bus's compass heading (degrees, clockwise from north) at `dist` along
 * `pattern`, in the direction `dirSign` is currently traveling — derived
 * from the baked pattern geometry itself rather than trusting a live `hdg`
 * field, so live and mock buses compute heading identically. Returns `null`
 * right at a pattern endpoint, where the forward sample point clamps to the
 * same coordinate as the current position and no direction is available;
 * callers should keep the bus's previous heading in that case. Exported for
 * direct testing. */
export function headingAt(pattern, dist, dirSign = 1) {
  const a = interpolatePattern(pattern, dist);
  const b = interpolatePattern(pattern, dist + HEADING_SAMPLE_FT * dirSign);
  if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return null;
  return bearingDeg(a, b);
}

/** Caps a list of buses to at most `cap` entries, dropping whichever are
 * furthest from `center` (`[lon, lat]`, typically the current viewport
 * center) first (KTD8). Unlike cars and trains, live bus count is simply
 * whatever CTA returns for the marquee routes — nothing else in this app
 * enforces an upper bound — so this is the one layer standing between a
 * real high-traffic poll and an uncapped render. A bus with no `pos` yet
 * (just ingested, not ticked) sorts as if it were exactly at `center`
 * rather than being excluded, so it's never unfairly penalized before its
 * first tick places it. Returns `buses` unchanged (no copy) when already at
 * or under the cap. */
export function capBuses(buses, center, cap) {
  if (buses.length <= cap) return buses;
  const [cx, cy] = center;
  return buses
    .map((b) => {
      const [lon, lat] = b.pos ?? [cx, cy];
      const dx = lon - cx;
      const dy = lat - cy;
      return { b, d2: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, cap)
    .map((x) => x.b);
}

export class BusEngine {
  /**
   * @param {{patterns?: Record<string, object>, routes?: Record<string, string[]>}} patternsData
   *   the parsed public/data/patterns.json. Tolerates a missing/empty
   *   object entirely (an engine with zero patterns just skips every
   *   vehicle it's fed and seeds no mock buses) — main.js's boot() guards
   *   the fetch itself and passes {} on failure, mirroring how a missing
   *   stations.json only dims the ring layer rather than blocking boot.
   */
  constructor(patternsData = {}) {
    this.patterns = new Map();
    for (const [pid, p] of Object.entries(patternsData.patterns ?? {})) {
      this.patterns.set(pid, preparePattern(p));
    }
    this.routePids = patternsData.routes ?? {};
    this.buses = new Map(); // vehicle id -> bus state
    this.onStatus = () => {};
    this.trailVersion = 0;
    this.failures = 0;
  }

  // ---- shared per-frame advance (mirrors trains.js's tick/#tickLive/#tickMock) ----

  tick() {
    const t = now();
    for (const bus of this.buses.values()) {
      if (bus.mock) this.#tickMock(bus, t);
      else this.#tickLive(bus, t);
      this.#appendTrail(bus, t);
    }
    return [...this.buses.values()].filter((b) => b.state !== 'removed');
  }

  #tickLive(bus, t) {
    const dt = Math.max(0.001, t - bus.lastTick);
    const rate = Math.min(1, (dt / (POLL_MS / 1000)) * 1.5);
    bus.dist += (bus.targetDist - bus.dist) * rate;
    bus.lastTick = t;
    const pattern = this.patterns.get(bus.pid);
    if (!pattern) return;
    const pos = interpolatePattern(pattern, bus.dist);
    if (pos) bus.pos = pos;
    const heading = headingAt(pattern, bus.dist, bus.dirSign);
    if (heading != null) bus.heading = heading;
  }

  #tickMock(bus, t) {
    const dt = t - bus.lastTick;
    const pattern = this.patterns.get(bus.pid);
    if (!pattern) return; // shouldn't happen — seedMock only seeds buses with a resolved pattern
    bus.dist += bus.speed * bus.dirSign * dt;
    if (bus.dist >= pattern.totalDist || bus.dist <= 0) {
      bus.dirSign *= -1; // bounce at terminals, same as trains' mock mode
      bus.dist = Math.max(0, Math.min(bus.dist, pattern.totalDist));
    }
    bus.lastTick = t;
    const pos = interpolatePattern(pattern, bus.dist);
    if (pos) bus.pos = pos;
    const heading = headingAt(pattern, bus.dist, bus.dirSign);
    if (heading != null) bus.heading = heading;
  }

  #appendTrail(bus, t) {
    if (!bus.pos) return;
    if (t - (bus.lastTrailT ?? -Infinity) < 0.4) return; // ~2.5Hz sample, matches trains.js
    bus.lastTrailT = t;
    bus.trail.push({ lon: bus.pos[0], lat: bus.pos[1], t });
    const cutoff = t - TRAIL_SECONDS;
    while (bus.trail.length > 2 && bus.trail[0].t < cutoff) bus.trail.shift();
    this.trailVersion++;
  }

  // ---- mock mode (also EXPLORE mode's bus renderer, per the plan's KTD11) ----

  seedMock(perRoute = 2) {
    for (const [rt, pids] of Object.entries(this.routePids)) {
      for (let i = 0; i < perRoute; i++) {
        const pid = pids[i % pids.length];
        const pattern = this.patterns.get(pid);
        if (!pattern || pattern.totalDist <= 0) continue;
        const id = `mock-bus-${rt}-${i}`;
        this.buses.set(id, {
          id,
          rt,
          pid,
          mock: true,
          state: 'tracking',
          dist: ((i + 0.5) / perRoute) * pattern.totalDist,
          targetDist: 0,
          dirSign: i % 2 === 0 ? 1 : -1,
          speed: MOCK_SPEED_MIN_FTPS + Math.random() * (MOCK_SPEED_MAX_FTPS - MOCK_SPEED_MIN_FTPS),
          lastTick: now(),
          missedPolls: 0,
          trail: [],
          pos: null,
          heading: 0,
        });
      }
    }
    this.onStatus('mock');
  }

  // ---- live mode ----------------------------------------------------------

  startLive() {
    this.poller = new Poller({
      storageKey: BUS_LEDGER_KEY,
      intervalMs: POLL_MS,
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn: () => this.#pollOnce(),
      onStatus: (status, err) => this.#handlePollStatus(status, err),
    });
    this.poller.start();
  }

  stop() {
    this.poller?.stop();
  }

  // Two (or more) sequential 10-route-max getvehicles calls per attempt,
  // combined into one #ingest() so the seen/stale bookkeeping below runs
  // once per full poll against every route's result together — splitting
  // it per-chunk would incorrectly age out buses on whichever chunk's
  // routes didn't happen to run in that particular call.
  async #pollOnce() {
    const routeIds = Object.keys(this.routePids).length ? Object.keys(this.routePids) : MARQUEE_ROUTES;
    const allVehicles = [];
    for (const chunk of chunkRoutes(routeIds)) {
      const res = await fetch(`/api/bus/getvehicles?rt=${chunk.join(',')}&format=json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (isAuthError(data)) {
        throw new Error(`CTA bus API auth error: ${data['bustime-response'].error[0]?.msg ?? 'invalid key'}`);
      }
      allVehicles.push(...extractVehicles(data));
    }
    this.ingest(allVehicles);
  }

  // Same translation trains.js's #handlePollStatus does: a single failed
  // poll still reads 'live' (transient blips shouldn't flip the HUD), only
  // 3+ consecutive failures — which is what a missing/bad CTA_BUS_KEY
  // produces via isAuthError() above — read as 'lost'.
  #handlePollStatus(status, err) {
    if (status === 'ok') {
      this.failures = 0;
      this.onStatus('live');
    } else if (status === 'error') {
      console.warn('[chi-tron] bus poll failed:', err.message);
      this.failures++;
      this.onStatus(this.failures > 2 ? 'lost' : 'live');
    } else if (status === 'hold') {
      this.onStatus('hold');
    }
  }

  // Public (unlike trains.js's private #ingest) so buses.test.js can drive
  // CTA's no-service/unknown-pid edge cases directly against a plain
  // vehicle array, without needing a real fetch or a raw response envelope.
  ingest(vehicles) {
    const seen = new Set();
    for (const v of vehicles ?? []) {
      const pid = String(v.pid);
      if (!this.patterns.has(pid)) continue; // unknown pattern: skip without throwing
      const pdist = parseFloat(v.pdist);
      if (!Number.isFinite(pdist)) continue;
      const id = `bus-${v.vid}`;
      seen.add(id);
      const existing = this.buses.get(id);
      if (existing) {
        existing.dirSign = pdist >= existing.targetDist ? 1 : -1;
        existing.targetDist = pdist;
        existing.pid = pid;
        existing.rt = v.rt;
        existing.state = 'tracking';
        existing.missedPolls = 0;
      } else {
        this.buses.set(id, {
          id,
          rt: v.rt,
          pid,
          mock: false,
          state: 'tracking',
          dist: pdist,
          targetDist: pdist,
          dirSign: 1,
          speed: 0,
          lastTick: now(),
          missedPolls: 0,
          trail: [],
          pos: null,
          heading: 0,
        });
      }
    }
    // stale/removed lifecycle for runs that vanished — identical shape to
    // trains.js's #ingest tail.
    for (const bus of this.buses.values()) {
      if (bus.mock || seen.has(bus.id)) continue;
      bus.missedPolls++;
      if (bus.missedPolls >= STALE_POLLS * 2) bus.state = 'removed';
      else if (bus.missedPolls >= STALE_POLLS) bus.state = 'stale';
    }
    for (const [id, bus] of this.buses) {
      if (bus.state === 'removed') this.buses.delete(id);
    }
  }
}
