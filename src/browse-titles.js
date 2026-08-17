/** HUD kind names. The bar draws icons; these are the spoken labels. */
export const KIND_LABELS = {
  train: 'TRAIN',
  bus: 'BUS',
  bike: 'BIKE',
};

export const KINDS = /** @type {const} */ (['train', 'bus', 'bike']);

/** Root sheet titles. Station and line names stay mixed case. */
export const ROOT_TITLES = {
  train: 'Train Rides',
  bus: 'Bus Routes',
  bike: 'Bike Stations',
  search: 'SEARCH STATIONS',
};

/**
 * Map a 0–1 pointer position across the kind track to a mode.
 * @param {number} t
 * @returns {'train'|'bus'|'bike'}
 */
export function kindFromRatio(t) {
  const x = Number.isFinite(t) ? Math.max(0, Math.min(0.999, t)) : 0;
  if (x < 1 / 3) return 'train';
  if (x < 2 / 3) return 'bus';
  return 'bike';
}

/**
 * Continuous thumb index (0–2) so the pill can follow a drag.
 * @param {number} t
 */
export function thumbIndexFromRatio(t) {
  const x = Number.isFinite(t) ? t : 0;
  return Math.max(0, Math.min(2, x * 3 - 0.5));
}
