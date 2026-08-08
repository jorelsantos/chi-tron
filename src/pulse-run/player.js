// Player bolt for Pulse Run — tip-only energy on one prepared L polyline.

import { prepareLine, pointAtDist, bearingDeg } from '../tracks.js';

export const PLAYER_CRUISE_MPS = 45;
export const PLAYER_BOOST_MPS = 75;
export const PLAYER_TRAIL_SECONDS = 11;
export const MAX_PLAYER_DT_S = 0.05;
export const LOOKAHEAD_M = 100;

function nowS() {
  return performance.now() / 1000;
}

/**
 * Controllable tip-only bolt on a single line.
 * Trail shape matches PulseEngine so deck.gl TripsLayer can render it.
 */
export class PlayerBolt {
  /**
   * @param {Record<string, {coords: number[][], cumDist: number[]}>} tracksData
   * @param {{ line: string, startDist: number, goalDist: number, dir?: number }} opts
   */
  constructor(tracksData, opts) {
    const lineData = tracksData[opts.line];
    if (!lineData) throw new Error(`PlayerBolt: unknown line ${opts.line}`);
    this.prepared = prepareLine(lineData);
    this.line = opts.line;
    this.startDist = opts.startDist;
    this.goalDist = opts.goalDist;
    this.dir = opts.dir ?? (opts.goalDist >= opts.startDist ? 1 : -1);
    this.dist = opts.startDist;
    this.boosting = false;
    this.frozen = false;
    this.trail = [];
    this.pos = null;
    this.lastTick = nowS();
    this.lastTrailT = -Infinity;
    this.trailVersion = 0;
    this.#updatePos();
  }

  reset() {
    this.dist = this.startDist;
    this.dir = this.goalDist >= this.startDist ? 1 : -1;
    this.boosting = false;
    this.frozen = false;
    this.trail = [];
    this.lastTick = nowS();
    this.lastTrailT = -Infinity;
    this.trailVersion = 0;
    this.#updatePos();
  }

  setBoosting(on) {
    this.boosting = !!on;
  }

  reverse() {
    if (this.frozen) return;
    this.dir *= -1;
  }

  freeze() {
    this.frozen = true;
    this.boosting = false;
  }

  /** @returns {{ id: string, line: string, pos: number[], trail: object[], state: string }} */
  asVehicle() {
    return {
      id: 'player',
      line: this.line,
      pos: this.pos,
      trail: this.trail,
      state: 'tracking',
    };
  }

  /**
   * Look-ahead camera target + bearing (degrees clockwise from north).
   * @returns {{ center: [number, number], bearing: number }}
   */
  cameraTarget() {
    const clampD = (d) => Math.max(0, Math.min(this.prepared.totalDist, d));
    const center = pointAtDist(this.prepared, clampD(this.dist + this.dir * LOOKAHEAD_M));
    const here = this.pos ?? pointAtDist(this.prepared, this.dist);
    const forward = pointAtDist(this.prepared, clampD(this.dist + this.dir * 40));
    const bearing = bearingDeg(here, forward);
    return { center, bearing };
  }

  tick() {
    const t = nowS();
    if (!this.frozen) {
      const dt = Math.min(Math.max(0, t - this.lastTick), MAX_PLAYER_DT_S);
      this.lastTick = t;
      const speed = this.boosting ? PLAYER_BOOST_MPS : PLAYER_CRUISE_MPS;
      this.dist += speed * this.dir * dt;
      if (this.dist >= this.prepared.totalDist) {
        this.dist = this.prepared.totalDist;
        this.dir = -1;
      } else if (this.dist <= 0) {
        this.dist = 0;
        this.dir = 1;
      }
    } else {
      this.lastTick = t;
    }
    this.#updatePos();
    this.#appendTrail(t);
    return this.asVehicle();
  }

  #updatePos() {
    this.pos = pointAtDist(this.prepared, this.dist);
  }

  #appendTrail(t) {
    if (!this.pos) return;
    if (t - this.lastTrailT < 0.04) return;
    this.lastTrailT = t;
    this.trail.push({ lon: this.pos[0], lat: this.pos[1], t });
    const cutoff = t - PLAYER_TRAIL_SECONDS;
    while (this.trail.length > 2 && this.trail[0].t < cutoff) this.trail.shift();
    this.trailVersion += 1;
  }
}
