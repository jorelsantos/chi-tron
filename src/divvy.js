// Divvy bike-share engine: bake static stations, poll live status.
//
// Stations are fixed points — no polylines, no pdist, no trails, no
// direction. One status request returns every station. Poller is keyless
// (storageKey null, ceiling Infinity) so it never draws the CTA budget.

import { Poller } from './poller.js';

const POLL_MS = 60000;
const STATUS_URL = '/api/divvy/station_status.json';

/**
 * @typedef {{id: string, name: string, lat: number, lon: number, capacity: number}} DivvyStation
 * @typedef {{
 *   id: string, name: string, lat: number, lon: number, capacity: number,
 *   classic: number, ebikes: number, docks: number,
 *   renting: boolean, returning: boolean, reportedAt: number
 * }} DivvyLive
 */

/**
 * Normalize a station_information payload (or the baked file shape) into
 * DivvyStation[]. station_id stays a string — the values are 19-digit ids
 * that lose precision as JavaScript numbers.
 *
 * @param {unknown} raw
 * @returns {DivvyStation[]}
 */
export function normalizeStations(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.stations)
      ? raw.stations
      : Array.isArray(raw?.data?.stations)
        ? raw.data.stations
        : [];
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const name = s.name != null ? String(s.name).trim() : '';
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id =
      s.id != null
        ? String(s.id)
        : s.station_id != null
          ? String(s.station_id)
          : '';
    if (!id) continue;
    const capacity = Number.isFinite(Number(s.capacity)) ? Number(s.capacity) : 0;
    out.push({
      id,
      name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      capacity,
    });
  }
  return out;
}

/**
 * Join baked stations with a station_status payload.
 *
 * num_bikes_available includes e-bikes. Classic bikes =
 * num_bikes_available - num_ebikes_available. Skip is_installed === 0.
 *
 * @param {DivvyStation[]} stations
 * @param {unknown} statusRaw
 * @returns {DivvyLive[]}
 */
export function joinStatus(stations, statusRaw) {
  const list = Array.isArray(statusRaw)
    ? statusRaw
    : Array.isArray(statusRaw?.data?.stations)
      ? statusRaw.data.stations
      : Array.isArray(statusRaw?.stations)
        ? statusRaw.stations
        : [];
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const row of list) {
    if (!row) continue;
    const id = row.station_id != null ? String(row.station_id) : '';
    if (!id) continue;
    byId.set(id, row);
  }

  /** @type {DivvyLive[]} */
  const out = [];
  for (const st of stations) {
    const row = byId.get(st.id);
    if (!row) continue;
    // GBFS uses 0/1 ints; treat missing as installed.
    if (row.is_installed === 0 || row.is_installed === false) continue;

    const available = Math.max(0, Number(row.num_bikes_available) || 0);
    const ebikes = Math.max(0, Number(row.num_ebikes_available) || 0);
    // Classic cannot go negative if a feed reports more e-bikes than total.
    const classic = Math.max(0, available - ebikes);
    const docks = Math.max(0, Number(row.num_docks_available) || 0);
    const renting = !(row.is_renting === 0 || row.is_renting === false);
    const returning = !(row.is_returning === 0 || row.is_returning === false);
    const reportedAt = Number(row.last_reported) || 0;

    out.push({
      id: st.id,
      name: st.name,
      lat: st.lat,
      lon: st.lon,
      capacity: st.capacity,
      classic,
      ebikes,
      docks,
      renting,
      returning,
      reportedAt,
    });
  }
  return out;
}

export class DivvyEngine {
  /**
   * @param {DivvyStation[]} [stations]
   */
  constructor(stations = []) {
    /** @type {DivvyStation[]} */
    this.stations = stations;
    /** @type {DivvyLive[]} */
    this.live = [];
    /** @type {(state: 'live'|'lost'|'hold'|'mock') => void} */
    this.onStatus = () => {};
    this.failures = 0;
    this.poller = null;
  }

  /**
   * Late hydrate after empty construct (cold open must not await the bake).
   * @param {DivvyStation[]} stations
   */
  loadStations(stations) {
    this.stations = Array.isArray(stations) ? stations : [];
  }

  startLive() {
    this.poller = new Poller({
      intervalMs: POLL_MS,
      storageKey: null,
      ceiling: Infinity,
      fetchFn: (signal) => this.#pollOnce(signal),
      onStatus: (status, err) => this.#handlePollStatus(status, err),
    });
    this.poller.start();
  }

  stop() {
    this.poller?.stop();
    this.poller = null;
  }

  /**
   * Current live list. Getter, not a simulation step — stations do not
   * advance between frames.
   * @returns {DivvyLive[]}
   */
  tick() {
    return this.live;
  }

  /**
   * Public for tests — apply a status payload without network.
   * @param {unknown} statusRaw
   */
  ingest(statusRaw) {
    this.live = joinStatus(this.stations, statusRaw);
  }

  async #pollOnce(signal) {
    const res = await fetch(STATUS_URL, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.ingest(data);
  }

  #handlePollStatus(status, err) {
    if (status === 'error') {
      this.failures += 1;
      console.warn('[chi-tron] divvy poll failed:', err?.message || err);
      // Match bus/train: three consecutive errors → lost.
      this.onStatus(this.failures >= 3 ? 'lost' : 'live');
      return;
    }
    if (status === 'hold') {
      this.onStatus('hold');
      return;
    }
    // ok
    this.failures = 0;
    this.onStatus('live');
  }
}
