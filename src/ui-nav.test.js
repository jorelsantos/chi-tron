import { describe, it, expect } from 'vitest';
import {
  activeSurface,
  listFabAction,
  searchFabAction,
  dismissTopAction,
  dialogPresence,
  followTarget,
} from './ui-nav.js';

describe('activeSurface', () => {
  it('prefers board over browse', () => {
    expect(activeSurface(true, true)).toBe('board');
  });
  it('returns browse when only browse open', () => {
    expect(activeSurface(true, false)).toBe('browse');
  });
  it('returns map when nothing open', () => {
    expect(activeSurface(false, false)).toBe('map');
  });
});

describe('listFabAction', () => {
  it('opens browse from map', () => {
    expect(listFabAction('map')).toBe('open-browse');
  });
  it('closes browse when browse is open', () => {
    expect(listFabAction('browse')).toBe('close-browse');
  });
  it('moves board to browse root', () => {
    expect(listFabAction('board')).toBe('board-to-browse');
  });
});

describe('searchFabAction', () => {
  it('opens search from map', () => {
    expect(searchFabAction('map', false)).toBe('open-search');
  });
  it('toggles search closed when search browse open', () => {
    expect(searchFabAction('browse', true)).toBe('close-browse');
  });
  it('switches to search from lines browse', () => {
    expect(searchFabAction('browse', false)).toBe('open-search');
  });
});

describe('dismissTopAction', () => {
  it('closes board first', () => {
    expect(dismissTopAction('board')).toBe('close-board');
  });
  it('closes browse on map with browse', () => {
    expect(dismissTopAction('browse')).toBe('close-browse');
  });
  it('no-op on map', () => {
    expect(dismissTopAction('map')).toBe('none');
  });
});

describe('dialogPresence', () => {
  it('keeps a closed dialog out of the tab order', () => {
    expect(dialogPresence(false)).toEqual({ inert: true, modal: false });
  });
  it('makes an open dialog modal', () => {
    expect(dialogPresence(true)).toEqual({ inert: false, modal: true });
  });
});

describe('followTarget', () => {
  it('follows a bus capsule by route and id', () => {
    expect(followTarget({ layerId: 'bus-capsules', id: 'bus-1', rt: '22' })).toEqual({
      kind: 'bus',
      id: 'bus-1',
      label: '22 · bus-1',
    });
  });
  it('returns null for a station hit', () => {
    expect(followTarget({ layerId: 'station-ring', id: 'belmont' })).toBeNull();
  });
});
