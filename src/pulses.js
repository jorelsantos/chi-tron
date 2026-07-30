// Aesthetic-mode Tron energy: fast light pulses racing each L line's
// prepared polyline end-to-end. Same trail state shape as trains so
// layers.js can reuse TripsLayer without a second animation system (KTD3).

import { prepareLine, pointAtDist } from './tracks.js';

export function now() {
  return performance.now() / 1000;
}

// Fast data-light, not L mph (KTD4). Tuned so a ~35 km Red run crosses in
// roughly 12–18 s — reads as energy, not rolling stock.
export const PULSE_SPEED_MIN = 2200; // m/s
export const PULSE_SPEED_MAX = 3200;
export const PULSE_TRAIL_SECONDS = 3.5;
export const MAX_PULSE_DT_S = 0.05; // hard clamp: large stalls don't teleport

/**
 * @param {Record<string, {coords: number[][], cumDist: number[]}>} tracksData
 */
export class PulseEngine {
  constructor(tracksData) {
    this.lines = {};
    for (const [key, line] of Object.entries(tracksData)) {
      this.lines[key] = prepareLine(line);
    }
    this.pulses = new Map();
    this.trailVersion = 0;
    this.onStatus = () => {};
  }

  /** @param {number} perLine how many pulses to seed per line key */
  seed(perLine = 2) {
    this.pulses.clear();
    for (const key of Object.keys(this.lines)) {
      const line = this.lines[key];
      if (!line.totalDist || line.totalDist <= 0) continue;
      for (let i = 0; i < perLine; i++) {
        const id = `pulse-${key}-${i}`;
        const speed =
          PULSE_SPEED_MIN + Math.random() * (PULSE_SPEED_MAX - PULSE_SPEED_MIN);
        this.pulses.set(id, {
          id,
          line: key,
          state: 'tracking',
          dist: ((i + 0.35) / perLine) * line.totalDist,
          dirSign: i % 2 === 0 ? 1 : -1,
          speed,
          lastTick: now(),
          trail: [],
          pos: null,
          lastTrailT: -Infinity,
        });
      }
    }
    this.onStatus('mock');
  }

  clear() {
    this.pulses.clear();
  }

  tick() {
    const t = now();
    for (const pulse of this.pulses.values()) {
      this.#tickPulse(pulse, t);
      this.#appendTrail(pulse, t);
    }
    return [...this.pulses.values()];
  }

  #tickPulse(pulse, t) {
    const dt = Math.min(Math.max(0, t - pulse.lastTick), MAX_PULSE_DT_S);
    pulse.lastTick = t;
    const line = this.lines[pulse.line];
    if (!line) return;
    pulse.dist += pulse.speed * pulse.dirSign * dt;
    if (pulse.dist >= line.totalDist || pulse.dist <= 0) {
      pulse.dirSign *= -1;
      pulse.dist = Math.max(0, Math.min(pulse.dist, line.totalDist));
    }
  }

  #appendTrail(pulse, t) {
    const line = this.lines[pulse.line];
    if (!line) return;
    const [lon, lat] = pointAtDist(line, pulse.dist);
    pulse.pos = [lon, lat];
    // Dense sampling so short trails still look continuous at high speed.
    if (t - pulse.lastTrailT < 0.04) return;
    pulse.lastTrailT = t;
    pulse.trail.push({ lon, lat, t });
    const cutoff = t - PULSE_TRAIL_SECONDS;
    while (pulse.trail.length > 2 && pulse.trail[0].t < cutoff) pulse.trail.shift();
    this.trailVersion = (this.trailVersion ?? 0) + 1;
  }
}
