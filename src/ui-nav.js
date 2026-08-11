/**
 * Pure helpers for exclusive tracker UI surfaces.
 * Surfaces: map (none) | browse | board
 */

/** @typedef {'map'|'browse'|'board'} UiSurface */

/**
 * @param {boolean} browseOpen
 * @param {boolean} boardOpen
 * @returns {UiSurface}
 */
export function activeSurface(browseOpen, boardOpen) {
  if (boardOpen) return 'board';
  if (browseOpen) return 'browse';
  return 'map';
}

/**
 * List FAB: toggle browse from map; close browse if open; if board open,
 * close board and open browse root next (caller applies side effects).
 * @param {UiSurface} surface
 * @returns {'open-browse'|'close-browse'|'board-to-browse'}
 */
export function listFabAction(surface) {
  if (surface === 'browse') return 'close-browse';
  if (surface === 'board') return 'board-to-browse';
  return 'open-browse';
}

/**
 * Search FAB: exclusive search browse; toggle off if already search.
 * @param {UiSurface} surface
 * @param {boolean} browseIsSearch
 * @returns {'open-search'|'close-browse'}
 */
export function searchFabAction(surface, browseIsSearch) {
  if (surface === 'browse' && browseIsSearch) return 'close-browse';
  return 'open-search';
}

/**
 * Map empty-tap / Escape: close top surface only.
 * @param {UiSurface} surface
 * @returns {'close-board'|'close-browse'|'none'}
 */
export function dismissTopAction(surface) {
  if (surface === 'board') return 'close-board';
  if (surface === 'browse') return 'close-browse';
  return 'none';
}
