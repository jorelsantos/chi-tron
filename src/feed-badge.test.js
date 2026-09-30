import { describe, expect, it } from 'vitest';
import { feedBadge } from './feed-badge.js';

describe('feedBadge', () => {
  it('names the worse of the train feed and the bus feed', () => {
    expect([
      feedBadge('live', 'live'),
      feedBadge('live', 'lost'),
      feedBadge('live', 'hold'),
      feedBadge('live', 'disabled'),
      feedBadge('mock', 'live'),
      feedBadge('boot', 'live'),
      feedBadge('lost', 'hold'),
    ]).toEqual(['LIVE', 'OFF', 'HOLD', 'OFF', 'SIM', 'BOOT', 'OFF']);
  });
});
