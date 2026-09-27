import { describe, it, expect } from 'vitest';
import { armLocationWatch, distM, walkMinutes, nearestStation } from './geolocation.js';

describe('geolocation helpers', () => {
  it('distM is ~0 at same point', () => {
    expect(distM([-87.65, 41.85], [-87.65, 41.85])).toBeLessThan(1);
  });

  it('distM Halsted to Ashland is a few km', () => {
    // rough coords from stations.json
    const d = distM([-87.648088, 41.84678], [-87.665317, 41.839234]);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(5000);
  });

  it('walkMinutes floors to at least 1', () => {
    expect(walkMinutes(10)).toBe(1);
    expect(walkMinutes(240)).toBe(3);
  });

  it('nearestStation picks closest', () => {
    const list = [
      { id: 'a', name: 'A', coords: [-87.65, 41.85] },
      { id: 'b', name: 'B', coords: [-87.66, 41.86] },
    ];
    const n = nearestStation([-87.6501, 41.8501], list);
    expect(n.station.id).toBe('a');
  });
});

describe('armLocationWatch', () => {
  it('stops a failed watch and starts again', () => {
    const first = { stopped: false, stop() { this.stopped = true; } };
    const second = { id: 'second', stopped: false, stop() { this.stopped = true; } };
    let starts = 0;
    const arm = armLocationWatch({
      start(hooks) {
        starts += 1;
        if (starts === 1) {
          hooks.onError(new Error('denied'));
          return first;
        }
        return second;
      },
      onOff() {},
      onFix() {},
    });

    arm.enable();
    expect(arm.handle).toBeNull();
    expect(first.stopped).toBe(true);
    expect(arm.enable()).toBe(second);
    expect(second.stopped).toBe(false);
  });

  it('returns the same watch while it is active', () => {
    const watch = { stopped: false, stop() { this.stopped = true; } };
    let starts = 0;
    const arm = armLocationWatch({
      start() {
        starts += 1;
        return watch;
      },
      onOff() {},
      onFix() {},
    });

    expect(arm.enable()).toBe(watch);
    expect(arm.enable()).toBe(watch);
    expect(starts).toBe(1);
    expect(arm.handle).toBe(watch);
  });

  it('calls onFix and does not call onOff for a fix', () => {
    let hooks = null;
    let offCount = 0;
    /** @type {unknown} */
    let fixValue = null;
    const watch = { stopped: false, stop() { this.stopped = true; } };
    const arm = armLocationWatch({
      start(next) {
        hooks = next;
        return watch;
      },
      onOff() { offCount += 1; },
      onFix(fix) { fixValue = fix; },
    });

    arm.enable();
    hooks.onFix({ lon: -87.63, lat: 41.88 });
    expect(fixValue).toEqual({ lon: -87.63, lat: 41.88 });
    expect(offCount).toBe(0);
    expect(watch.stopped).toBe(false);
    expect(arm.handle).toBe(watch);
  });

  it('clears the handle when the error arrives after enable', () => {
    const first = { stopped: false, stop() { this.stopped = true; } };
    const second = { id: 'second', stopped: false, stop() { this.stopped = true; } };
    let starts = 0;
    /** @type {{ onError: (err: unknown) => void, onFix: (fix: unknown) => void }|null} */
    let hooks = null;
    const arm = armLocationWatch({
      start(next) {
        starts += 1;
        hooks = next;
        return starts === 1 ? first : second;
      },
      onOff() {},
      onFix() {},
    });

    expect(arm.enable()).toBe(first);
    hooks.onError(new Error('denied'));
    expect(arm.handle).toBeNull();
    expect(first.stopped).toBe(true);
    expect(arm.enable()).toBe(second);
  });
});
