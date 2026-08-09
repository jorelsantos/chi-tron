import { describe, it, expect } from 'vitest';
import { PulseEngine, MAX_PULSE_DT_S, PULSE_SPEED_MIN } from './pulses.js';

// Minimal two-point line ~1113 m north of a Chicago origin.
const FAKE_TRACKS = {
  Red: {
    coords: [
      [-87.63, 41.88],
      [-87.63, 41.89],
    ],
    cumDist: [0, 1113.2],
  },
  Blue: {
    coords: [
      [-87.65, 41.88],
      [-87.64, 41.88],
    ],
    cumDist: [0, 830],
  },
};

describe('PulseEngine', () => {
  it('seeds at least one pulse on every line', () => {
    const eng = new PulseEngine(FAKE_TRACKS);
    eng.seed(2);
    const byLine = {};
    for (const p of eng.tick()) {
      byLine[p.line] = (byLine[p.line] ?? 0) + 1;
    }
    expect(byLine.Red).toBeGreaterThanOrEqual(1);
    expect(byLine.Blue).toBeGreaterThanOrEqual(1);
  });

  it('advances distance in one direction until an end, then reverses', () => {
    const eng = new PulseEngine(FAKE_TRACKS);
    eng.seed(1);
    const pulse = [...eng.pulses.values()][0];
    pulse.dist = 10;
    pulse.dirSign = 1;
    pulse.speed = 500;
    pulse.lastTick = 0;
    // Simulate ticks with controlled time via lastTick + now() is hard;
    // call #tickPulse indirectly by faking lastTick far in the past is
    // clamped — instead advance by repeatedly setting lastTick just under now.
    const start = pulse.dist;
    for (let i = 0; i < 20; i++) {
      pulse.lastTick = performance.now() / 1000 - MAX_PULSE_DT_S;
      eng.tick();
    }
    // Either moved forward or hit the end and reversed — distance changed
    // or dir flipped after contact with bound.
    const moved = Math.abs(pulse.dist - start) > 1 || pulse.dirSign === -1;
    expect(moved).toBe(true);
    expect(Number.isFinite(pulse.dist)).toBe(true);
    expect(pulse.pos).toBeTruthy();
    expect(Number.isFinite(pulse.pos[0])).toBe(true);
    expect(Number.isFinite(pulse.pos[1])).toBe(true);
  });

  it('clamps large dt so a stall does not teleport past the line', () => {
    const eng = new PulseEngine(FAKE_TRACKS);
    eng.seed(1);
    const pulse = [...eng.pulses.values()][0];
    pulse.dist = 100;
    pulse.dirSign = 1;
    pulse.speed = PULSE_SPEED_MIN;
    pulse.lastTick = performance.now() / 1000 - 30; // 30s stall
    eng.tick();
    const maxStep = PULSE_SPEED_MIN * MAX_PULSE_DT_S + 1;
    // After one tick from a long stall, only one clamped step applies.
    expect(pulse.dist).toBeLessThan(100 + maxStep + 50);
    expect(pulse.dist).toBeGreaterThanOrEqual(0);
  });

  it('clear empties all pulses', () => {
    const eng = new PulseEngine(FAKE_TRACKS);
    eng.seed(2);
    expect(eng.pulses.size).toBeGreaterThan(0);
    eng.clear();
    expect(eng.tick()).toHaveLength(0);
  });
});
