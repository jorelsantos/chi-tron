import { describe, it, expect } from 'vitest';
import { TRACK_GLOW, TRACK_GLOW_LAYER_IDS } from './map-stage.js';
import { AERIAL_2D } from './style.js';

describe('AERIAL_2D cold open', () => {
  it('opens at zoom 13.8, pitch 48, and bearing -12', () => {
    expect(AERIAL_2D.zoom).toBe(13.8);
    expect(AERIAL_2D.pitch).toBe(48);
    expect(AERIAL_2D.bearing).toBe(-12);
  });
});

describe('TRACK_GLOW B1 recipe', () => {
  it('keeps the three-layer stack thin and dim on the wide pass', () => {
    expect(TRACK_GLOW.map((g) => g.id)).toEqual(TRACK_GLOW_LAYER_IDS);
    const wide = TRACK_GLOW[0];
    const mid = TRACK_GLOW[1];
    const core = TRACK_GLOW[2];
    expect(wide.opacity).toBeLessThanOrEqual(0.14);
    expect(wide.blur).toBeLessThanOrEqual(2);
    expect(wide.width[3]).toBeLessThanOrEqual(12);
    expect(mid.opacity).toBeGreaterThan(0.6);
    expect(mid.blur).toBeLessThanOrEqual(0.7);
    expect(core.opacity).toBeGreaterThanOrEqual(0.9);
    expect(core.blur).toBe(0);
    expect(core.width[3]).toBeLessThanOrEqual(3.4);
  });
});
