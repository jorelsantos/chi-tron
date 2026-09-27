import { describe, expect, it } from 'vitest';
import { boardRowsLabel, sheetAriaLabel } from './board.js';

describe('boardRowsLabel', () => {
  it('replaces rows that are already on screen when the feed fails', () => {
    expect(boardRowsLabel([{ rn: '1' }], 'HTTP 500', true)).toBe('FEED ERROR');
    expect(boardRowsLabel([{ rn: '1' }], 'BUDGET HOLD', true)).toBe('BUDGET HOLD');
    expect(boardRowsLabel([{ rn: '1' }], null, true)).toBe('ROWS');
  });
});

describe('sheetAriaLabel', () => {
  it('names a train board, a bus board, and a bike board', () => {
    expect(sheetAriaLabel('train')).toBe('Station arrivals');
    expect(sheetAriaLabel('bus')).toBe('Bus arrivals');
    expect(sheetAriaLabel('bike')).toBe('Bike station');
  });
});
