// One reused point so a dock's lat/lon does not allocate on every frame.
const scratch = [0, 0];

function inView(item, inBounds) {
  if (!item || item.state === 'removed') return false;
  const pos = item.pos;
  if (Array.isArray(pos) && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
    return inBounds(pos);
  }
  if (!Number.isFinite(item.lon) || !Number.isFinite(item.lat)) return false;
  scratch[0] = item.lon;
  scratch[1] = item.lat;
  return inBounds(scratch);
}

/**
 * Trains count when their line is visible and the point is inside `inBounds`.
 * Buses and Divvy docks count when the point is inside `inBounds`.
 * A bike bake that is not ready returns a null dock count.
 *
 * @param {object} input
 * @param {Array<{pos?: number[], line?: string, state?: string}>} [input.trains]
 * @param {Array<{pos?: number[], state?: string}>} [input.buses]
 * @param {Array<{pos?: number[], lon?: number, lat?: number}>} [input.docks]
 * @param {(pos: number[]) => boolean} input.inBounds
 * @param {Set<string>} input.visibleLines
 * @param {boolean} input.bikeReady
 * @returns {{trains: number, buses: number, bikes: number|null}}
 */
export function ridesInView({
  trains = [],
  buses = [],
  docks = [],
  inBounds,
  visibleLines,
  bikeReady,
}) {
  let trainCount = 0;
  for (const train of trains) {
    if (!visibleLines || !visibleLines.has(train?.line)) continue;
    if (!inView(train, inBounds)) continue;
    trainCount += 1;
  }

  let busCount = 0;
  for (const bus of buses) {
    if (!inView(bus, inBounds)) continue;
    busCount += 1;
  }

  if (!bikeReady) return { trains: trainCount, buses: busCount, bikes: null };

  let dockCount = 0;
  for (const dock of docks) {
    if (!inView(dock, inBounds)) continue;
    dockCount += 1;
  }
  return { trains: trainCount, buses: busCount, bikes: dockCount };
}
