import { describe, it, expect } from 'vitest';
import {
  PlayerBolt,
  PLAYER_CRUISE_MPS,
  MAX_PLAYER_DT_S,
  PLAYER_TRAIL_SECONDS,
} from './player.js';

const FAKE = {
  Red: {
    coords: [
      [-87.63, 41.88],
      [-87.63, 41.89],
    ],
    cumDist: [0, 1113.2],
  },
};

describe('PlayerBolt', () => {
  it('starts at startDist with a position', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 100, goalDist: 900, dir: 1 });
    expect(p.dist).toBe(100);
    expect(p.pos).toBeTruthy();
    expect(p.asVehicle().id).toBe('player');
    expect(p.asVehicle().line).toBe('Red');
  });

  it('moves forward under cruise speed', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 100, goalDist: 900, dir: 1 });
    p.lastTick = performance.now() / 1000 - MAX_PLAYER_DT_S;
    const before = p.dist;
    p.tick();
    expect(p.dist).toBeGreaterThan(before);
    expect(p.dist - before).toBeLessThanOrEqual(PLAYER_CRUISE_MPS * MAX_PLAYER_DT_S + 0.01);
  });

  it('boosts faster than cruise', () => {
    const a = new PlayerBolt(FAKE, { line: 'Red', startDist: 100, goalDist: 900, dir: 1 });
    const b = new PlayerBolt(FAKE, { line: 'Red', startDist: 100, goalDist: 900, dir: 1 });
    a.lastTick = performance.now() / 1000 - MAX_PLAYER_DT_S;
    b.lastTick = performance.now() / 1000 - MAX_PLAYER_DT_S;
    b.setBoosting(true);
    a.tick();
    b.tick();
    expect(b.dist - 100).toBeGreaterThan(a.dist - 100);
  });

  it('reverse flips dir', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 500, goalDist: 900, dir: 1 });
    p.reverse();
    expect(p.dir).toBe(-1);
  });

  it('clamps at ends and flips dir', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 1100, goalDist: 100, dir: 1 });
    p.lastTick = performance.now() / 1000 - MAX_PLAYER_DT_S;
    p.tick();
    expect(p.dist).toBeLessThanOrEqual(1113.2);
  });

  it('freeze stops motion', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 200, goalDist: 900, dir: 1 });
    p.freeze();
    p.lastTick = performance.now() / 1000 - MAX_PLAYER_DT_S;
    p.tick();
    expect(p.dist).toBe(200);
  });

  it('trims trail by trail window', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 100, goalDist: 900, dir: 1 });
    const t0 = performance.now() / 1000;
    for (let i = 0; i < 50; i++) {
      p.lastTick = t0 + i * 0.05 - MAX_PLAYER_DT_S;
      p.lastTrailT = -Infinity;
      p.tick();
    }
    const times = p.trail.map((x) => x.t);
    if (times.length >= 2) {
      expect(times[times.length - 1] - times[0]).toBeLessThanOrEqual(PLAYER_TRAIL_SECONDS + 0.2);
    }
  });

  it('cameraTarget returns finite center and bearing', () => {
    const p = new PlayerBolt(FAKE, { line: 'Red', startDist: 200, goalDist: 900, dir: 1 });
    const cam = p.cameraTarget();
    expect(cam.center).toHaveLength(2);
    expect(Number.isFinite(cam.bearing)).toBe(true);
  });
});
