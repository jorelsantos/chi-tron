// Train engine: live poller + per-run tween state machine, and the mock
// generator. Both feed the exact same state shape, so the render layers
// cannot tell live from mock.

import { prepareLine, snapToLine, pointAtDist } from './tracks.js';

const POLL_MS = 5000;
const STALE_POLLS = 2; // absent this many polls → stale → removed
const TRAIL_SECONDS = 60; // history kept per train
const ROUTES = ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y'];
// API route codes → tracks.json line keys
const ROUTE_TO_LINE = {
  red: 'Red', blue: 'Blue', brn: 'Brn', g: 'G',
  org: 'Org', p: 'P', pink: 'Pink', y: 'Y',
};

export function now() {
  return performance.now() / 1000; // seconds since page load — TripsLayer time base
}

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
    const dt = t - train.lastTick;
    train.dist += train.speed * train.dirSign * dt;
    const line = this.lines[train.line];
    if (train.dist >= line.totalDist || train.dist <= 0) {
      train.dirSign *= -1; // bounce at terminals
      train.dist = Math.max(0, Math.min(train.dist, line.totalDist));
    }
    train.lastTick = t;
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
        });
      }
    }
    this.onStatus('mock');
  }

  // ---- live mode ----------------------------------------------------------

  startLive() {
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/tt?rt=${ROUTES.join(',')}&outputType=JSON`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.#ingest(data);
        this.failures = 0;
        this.onStatus('live');
      } catch (err) {
        console.warn('[chi-tron] poll failed:', err.message);
        this.failures = (this.failures || 0) + 1;
        this.onStatus(this.failures > 2 ? 'lost' : 'live');
      }
      // exponential backoff on repeated failure, capped at 60s
      const delay = POLL_MS * Math.min(12, 2 ** (this.failures || 0));
      this.timer = setTimeout(poll, delay);
    };
    poll();
  }

  stop() {
    clearTimeout(this.timer);
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
        if (existing) {
          existing.dirSign = snap.dist >= existing.targetDist ? 1 : -1;
          existing.targetDist = snap.dist;
          existing.state = 'tracking';
          existing.missedPolls = 0;
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
