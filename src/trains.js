// Train engine: live poller + per-run tween state machine, and the mock
// generator. Both feed the exact same state shape, so the render layers
// cannot tell live from mock.

import { prepareLine, snapToLine, pointAtDist } from './tracks.js';
import { Poller, DEFAULT_DAILY_CEILING } from './poller.js';

const POLL_MS = 5000;
// U14: this feed's ledger namespace (keyed off CTA_KEY, the real Train
// Tracker key) — distinct from whatever storageKey the bus feed uses later
// in this Phase B pass, so their daily ceilings never share one counter.
const TRAIN_LEDGER_KEY = 'cta-train';
const STALE_POLLS = 2; // absent this many polls → stale → removed
const TRAIL_SECONDS = 45; // live train trail length (seconds of history)
// Live Nav MVP: Orange Line only (budget + product focus). Phase 2 re-expands.
export const LIVE_ROUTES = ['org'];
const ROUTES = LIVE_ROUTES;
// API route codes → tracks.json line keys
const ROUTE_TO_LINE = {
  red: 'Red', blue: 'Blue', brn: 'Brn', g: 'G',
  org: 'Org', p: 'P', pink: 'Pink', y: 'Y',
};

export function now() {
  return performance.now() / 1000; // seconds since page load — TripsLayer time base
}

// CTA's Train Tracker payload encodes booleans as the strings "1"/"0" (per
// the developer guide), not JSON booleans — this normalizes either shape.
export function toBool(v) {
  return v === '1' || v === true || v === 1;
}

// U8: how often a mock train's synthetic isDly/isApp flags get re-rolled.
// Randomized within this window so trains don't all flip in lockstep.
const MOCK_FLAG_REROLL_MIN_S = 10;
const MOCK_FLAG_REROLL_MAX_S = 30;
const MOCK_DELAY_CHANCE = 0.1;
const MOCK_APPROACH_CHANCE = 0.1;

// U11's car simulation needed this same clamp for its own frozen/thawed
// off-viewport cars and flagged that #tickMock has the identical unclamped
// shape: a tab backgrounded (or just a long stall between frames) leaves
// `now()` still advancing via performance.now(), so the next frame's dt
// would cover the whole gap and jump a mock train's `dist` by
// speed*dt — far enough to blow past a terminal bounce or land off-track
// before the next poll/tick corrects it. Live mode doesn't need this: its
// ease-toward-target rate is already clamped to 1 regardless of dt.
const MAX_MOCK_DT_S = 1;

export class TrainEngine {
  constructor(tracksData) {
    this.lines = {};
    for (const [key, line] of Object.entries(tracksData)) {
      this.lines[key] = prepareLine(line);
    }
    this.trains = new Map(); // runId → train state
    this.pollCount = 0;
    this.onStatus = () => {};
  }

  // ---- shared per-frame advance ----------------------------------------

  tick() {
    const t = now();
    for (const train of this.trains.values()) {
      if (train.mock) this.#tickMock(train, t);
      else this.#tickLive(train, t);
      this.#appendTrail(train, t);
    }
    return [...this.trains.values()].filter((tr) => tr.state !== 'removed');
  }

  #tickLive(train, t) {
    // Ease displayed distance toward the last snapped target — sized so a
    // train covers the gap in roughly one poll interval, arriving smoothly.
    const dt = Math.max(0.001, t - train.lastTick);
    const rate = Math.min(1, (dt / (POLL_MS / 1000)) * 1.5);
    train.dist += (train.targetDist - train.dist) * rate;
    train.lastTick = t;
  }

  #tickMock(train, t) {
    const dt = Math.min(t - train.lastTick, MAX_MOCK_DT_S);
    train.dist += train.speed * train.dirSign * dt;
    const line = this.lines[train.line];
    if (train.dist >= line.totalDist || train.dist <= 0) {
      train.dirSign *= -1; // bounce at terminals
      train.dist = Math.max(0, Math.min(train.dist, line.totalDist));
    }
    train.lastTick = t;

    // U8 step 6: mock trains never receive real isDly/isApp from a feed, so
    // synthesize occasional flips here — this is what makes the delayed/
    // approaching render treatments (src/layers.js trainStyle) visible and
    // testable under ?mock=1 with no live feed at all.
    if (t >= train.nextFlagRoll) {
      train.isDly = Math.random() < MOCK_DELAY_CHANCE;
      train.isApp = Math.random() < MOCK_APPROACH_CHANCE;
      train.nextFlagRoll =
        t + MOCK_FLAG_REROLL_MIN_S + Math.random() * (MOCK_FLAG_REROLL_MAX_S - MOCK_FLAG_REROLL_MIN_S);
    }
  }

  #appendTrail(train, t) {
    const line = this.lines[train.line];
    const [lon, lat] = pointAtDist(line, train.dist);
    train.pos = [lon, lat];
    // Sample the trail at ~2.5 Hz, not per-frame — caps each path at ~150
    // points and lets the render layer skip geometry re-uploads in between.
    if (t - (train.lastTrailT ?? -Infinity) < 0.4) return;
    train.lastTrailT = t;
    train.trail.push({ lon, lat, t });
    const cutoff = t - TRAIL_SECONDS;
    while (train.trail.length > 2 && train.trail[0].t < cutoff) train.trail.shift();
    this.trailVersion = (this.trailVersion ?? 0) + 1;
  }

  // ---- mock mode --------------------------------------------------------

  seedMock(perLine = 4) {
    for (const key of Object.keys(this.lines)) {
      const line = this.lines[key];
      for (let i = 0; i < perLine; i++) {
        const id = `mock-${key}-${i}`;
        this.trains.set(id, {
          id,
          line: key,
          mock: true,
          state: 'tracking',
          dist: ((i + 0.5) / perLine) * line.totalDist,
          targetDist: 0,
          dirSign: i % 2 === 0 ? 1 : -1,
          speed: 10 + Math.random() * 4, // ~22–31 mph, realistic L pace
          lastTick: now(),
          missedPolls: 0,
          trail: [],
          pos: null,
          isDly: false,
          isApp: false,
          // Stagger initial re-roll so all seeded trains don't flip together.
          nextFlagRoll: now() + Math.random() * MOCK_FLAG_REROLL_MAX_S,
        });
      }
    }
    this.onStatus('mock');
  }

  // ---- live mode ----------------------------------------------------------

  // U14: polling mechanics (visibility gate, single-flight, backoff, daily
  // ledger/ceiling) now live entirely in src/poller.js's Poller — this
  // engine only supplies what to fetch and how to ingest it. Built lazily
  // here rather than in the constructor so mock mode (seedMock(), which
  // never calls startLive()) never instantiates a Poller at all: no timer,
  // no visibilitychange listener, no localStorage touch.
  startLive() {
    // A fresh live session starts with a clean slate -- see buses.js's
    // startLive() for why (code review finding).
    this.failures = 0;
    this.poller = new Poller({
      storageKey: TRAIN_LEDGER_KEY,
      intervalMs: POLL_MS,
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn: (signal) => this.#pollOnce(signal),
      onStatus: (status, err) => this.#handlePollStatus(status, err),
    });
    this.poller.start();
  }

  stop() {
    this.poller?.stop();
  }

  // U16: a clean mode switch needs to drop whichever vehicle set the
  // *previous* mode populated before the new one starts — seedMock() alone
  // only ever adds/overwrites its own `mock-*` ids, so switching LIVE ->
  // EXPLORE without this would leave stale live runs sitting in the Map
  // forever (their last poll simply never gets another update once
  // stop()'d, so they'd never even age into 'stale'/'removed' on their own).
  clear() {
    this.trains.clear();
  }

  async #pollOnce(signal) {
    const res = await fetch(`/api/tt?rt=${ROUTES.join(',')}&outputType=JSON`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.#ingest(data);
  }

  // Translates the governor's low-level 'ok'/'error'/'hold' outcomes into
  // this engine's existing 'live'/'lost'/'hold' HUD states, preserving the
  // pre-U14 hysteresis exactly: a single failed poll still reads as 'live'
  // (transient blips shouldn't flip the HUD), only 3+ consecutive failures
  // read as 'lost'.
  #handlePollStatus(status, err) {
    if (status === 'ok') {
      this.failures = 0;
      this.onStatus('live');
    } else if (status === 'error') {
      console.warn('[chi-tron] poll failed:', err.message);
      this.failures = (this.failures || 0) + 1;
      this.onStatus(this.failures > 2 ? 'lost' : 'live');
    } else if (status === 'hold') {
      this.onStatus('hold');
    }
  }

  #ingest(data) {
    this.pollCount++;
    const routes = data?.ctatt?.route;
    if (!routes) return; // malformed payload → keep prior state (no crash)
    const seen = new Set();
    for (const route of [].concat(routes)) {
      const lineKey = ROUTE_TO_LINE[String(route['@name']).toLowerCase()];
      const line = this.lines[lineKey];
      if (!line || !route.train) continue;
      for (const t of [].concat(route.train)) {
        const id = `${lineKey}-${t.rn}`;
        const lon = parseFloat(t.lon);
        const lat = parseFloat(t.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        seen.add(id);
        const snap = snapToLine(line, [lon, lat]);
        const existing = this.trains.get(id);
        const meta = {
          rn: String(t.rn ?? ''),
          destNm: t.destNm ?? '',
          nextStaNm: t.nextStaNm ?? '',
          nextStaId: t.nextStaId ?? '',
          heading: Number.isFinite(parseFloat(t.heading)) ? parseFloat(t.heading) : null,
          arrT: t.arrT ?? '',
          isDly: toBool(t.isDly),
          isApp: toBool(t.isApp),
        };
        if (existing) {
          existing.dirSign = snap.dist >= existing.targetDist ? 1 : -1;
          existing.targetDist = snap.dist;
          existing.state = 'tracking';
          existing.missedPolls = 0;
          Object.assign(existing, meta);
        } else {
          this.trains.set(id, {
            id,
            line: lineKey,
            mock: false,
            state: 'tracking',
            dist: snap.dist,
            targetDist: snap.dist,
            dirSign: 1,
            speed: 0,
            lastTick: now(),
            missedPolls: 0,
            trail: [],
            pos: null,
            ...meta,
          });
        }
      }
    }
    // stale/removed lifecycle for runs that vanished
    for (const train of this.trains.values()) {
      if (train.mock || seen.has(train.id)) continue;
      train.missedPolls++;
      if (train.missedPolls >= STALE_POLLS * 2) train.state = 'removed';
      else if (train.missedPolls >= STALE_POLLS) train.state = 'stale';
    }
    for (const [id, train] of this.trains) {
      if (train.state === 'removed') this.trains.delete(id);
    }
  }
}
