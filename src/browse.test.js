import { describe, it, expect } from 'vitest';
import { capBikeList } from './browse.js';

function names(count) {
  return Array.from({ length: count }, (_, i) => ({ name: `Station ${i}` }));
}

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
