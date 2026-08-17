import { describe, it, expect } from 'vitest';
import {
  KIND_LABELS,
  KINDS,
  ROOT_TITLES,
  kindFromRatio,
  thumbIndexFromRatio,
} from './browse-titles.js';

describe('KIND_LABELS', () => {
  it('names the three HUD modes', () => {
    expect(KIND_LABELS.train).toBe('TRAIN');
    expect(KIND_LABELS.bus).toBe('BUS');
    expect(KIND_LABELS.bike).toBe('BIKE');
    expect(KINDS).toEqual(['train', 'bus', 'bike']);
  });
});

describe('ROOT_TITLES', () => {
  it('names each root list', () => {
    expect(ROOT_TITLES.train).toBe('Train Rides');
    expect(ROOT_TITLES.bus).toBe('Bus Routes');
    expect(ROOT_TITLES.bike).toBe('Bike Stations');
    expect(ROOT_TITLES.search).toBe('SEARCH STATIONS');
  });
});

describe('kindFromRatio', () => {
  it('splits the track into three equal slots', () => {
    expect(kindFromRatio(0)).toBe('train');
    expect(kindFromRatio(0.32)).toBe('train');
    expect(kindFromRatio(0.34)).toBe('bus');
    expect(kindFromRatio(2 / 3)).toBe('bike');
    expect(kindFromRatio(1)).toBe('bike');
  });

  it('clamps off-track values', () => {
    expect(kindFromRatio(-1)).toBe('train');
    expect(kindFromRatio(4)).toBe('bike');
    expect(kindFromRatio(Number.NaN)).toBe('train');
  });
});

describe('thumbIndexFromRatio', () => {
  it('centers the pill on each slot', () => {
    expect(thumbIndexFromRatio(1 / 6)).toBeCloseTo(0);
    expect(thumbIndexFromRatio(0.5)).toBeCloseTo(1);
    expect(thumbIndexFromRatio(5 / 6)).toBeCloseTo(2);
  });

  it('clamps while dragging past the ends', () => {
    expect(thumbIndexFromRatio(-0.2)).toBe(0);
    expect(thumbIndexFromRatio(1.2)).toBe(2);
  });
});
