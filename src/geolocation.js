// Client-only geolocation for Live Nav (Maps / Pokémon Go style).
// Never uploaded. Follow breaks on user pan (wired by caller).

/**
 * @typedef {{ lon: number, lat: number, accuracyM: number, heading: number|null, updatedAt: number }} UserFix
 */

/**
 * @param {object} opts
 * @param {(fix: UserFix) => void} opts.onFix
 * @param {(err: GeolocationPositionError|Error) => void} [opts.onError]
 * @param {boolean} [opts.highAccuracy]
 */
export function startWatch({ onFix, onError = () => {}, highAccuracy = true }) {
  if (!navigator.geolocation) {
    onError(new Error('Geolocation not available'));
    return { stop() {}, setHighAccuracy() {} };
  }

  let watchId = null;
  let useHigh = highAccuracy;

  const start = () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        onFix({
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracyM: pos.coords.accuracy ?? 50,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          updatedAt: pos.timestamp || Date.now(),
        });
      },
      (err) => onError(err),
      {
        enableHighAccuracy: useHigh,
        maximumAge: useHigh ? 2000 : 15000,
        timeout: 15000,
      },
    );
  };

  start();

  return {
    stop() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    },
    setHighAccuracy(on) {
      useHigh = !!on;
      start();
    },
  };
}

/**
 * One locate watch. An error stops it so the next enable can start again.
 * A second enable while that watch is active returns the same watch.
 * @param {object} opts
 * @param {(hooks: { onError: (err: unknown) => void, onFix: (fix: unknown) => void }) => { stop?: () => void, stopped?: boolean }|null} opts.start
 * @param {() => void} opts.onOff
 * @param {(fix: unknown) => void} opts.onFix
 */
export function armLocationWatch({ start, onOff, onFix }) {
  /** @type {{ stop?: () => void, stopped?: boolean }|null} */
  let handle = null;

  function stopWatch(watch) {
    if (!watch) return;
    if (typeof watch.stop === 'function') watch.stop();
    watch.stopped = true;
  }

  function enable() {
    if (handle) return handle;
    /** @type {{ stop?: () => void, stopped?: boolean }|null} */
    let started = null;
    let ended = false;
    started = start({
      onError() {
        if (ended || (handle && handle !== started)) return;
        ended = true;
        stopWatch(started);
        if (!handle || handle === started) handle = null;
        onOff();
      },
      onFix(fix) {
        if (ended || (handle && started && handle !== started)) return;
        onFix(fix);
      },
    });
    if (ended) {
      stopWatch(started);
      handle = null;
      return null;
    }
    handle = started;
    return handle;
  }

  return {
    enable,
    get handle() {
      return handle;
    },
  };
}

/**
 * Haversine distance meters.
 * @param {[number, number]} a [lon, lat]
 * @param {[number, number]} b [lon, lat]
 */
export function distM(a, b) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b[1] - a[1]);
  const dLon = toR(b[0] - a[0]);
  const lat1 = toR(a[1]);
  const lat2 = toR(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Walk minutes estimate (~80 m/min urban walk).
 */
export function walkMinutes(meters) {
  return Math.max(1, Math.round(meters / 80));
}

/**
 * Nearest station from a lon/lat among a list of {id, coords, name, ...}.
 */
export function nearestStation(lonLat, stationList) {
  let best = null;
  let bestD = Infinity;
  for (const s of stationList) {
    if (!s.coords) continue;
    const d = distM(lonLat, s.coords);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best ? { station: best, distM: bestD } : null;
}
