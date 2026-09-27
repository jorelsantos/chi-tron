import { describe, it, expect } from 'vitest';
import { bikeListPhase, capBikeList } from './browse.js';

function names(count) {
  return Array.from({ length: count }, (_, i) => ({ name: `Station ${i}` }));
}

describe('bikeListPhase', () => {
  it('stays loading while the bake has not landed and has not failed', () => {
    expect(bikeListPhase({ ready: false, failed: false })).toBe('loading');
  });

  it('reports a failed bake', () => {
    expect(bikeListPhase({ ready: false, failed: true })).toBe('error');
  });

  it('reports a ready bake', () => {
    expect(bikeListPhase({ ready: true, failed: false })).toBe('list');
  });
});

describe('capBikeList', () => {
  it('keeps 200 rows and names the hidden rest', () => {
    const capped = capBikeList(names(201));
    expect(capped.shown).toHaveLength(200);
    expect(capped.total).toBe(201);
    expect(capped.caption).toBe('SHOWING 200 OF 201');
  });

  it('counts a short list in full', () => {
    expect(capBikeList(names(3)).caption).toBe('SHOWING 3 OF 3');
  });
});
