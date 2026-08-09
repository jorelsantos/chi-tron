// CTA Bus Tracker getpredictions → board rows (mirrors arrivals.js shape).

import { Poller, DEFAULT_DAILY_CEILING } from './poller.js';

const BUS_ARRIVALS_LEDGER = 'cta-bus';
export const BUS_ARRIVALS_POLL_MS = 20000;

function asList(maybe) {
  if (Array.isArray(maybe)) return maybe;
  return maybe ? [maybe] : [];
}

/**
 * @param {object} data bustime-response from getpredictions
 * @param {{ rtFilter?: string|null, nowMs?: number }} [opts]
 */
export function normalizeBusPredictions(data, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const rtFilter = opts.rtFilter != null ? String(opts.rtFilter) : null;
  const preds = asList(data?.['bustime-response']?.prd);
  const rows = [];
  for (const p of preds) {
    const rt = String(p.rt ?? '');
    if (rtFilter && rt !== rtFilter) continue;
    const prdtm = String(p.prdtm || ''); // yyyyMMdd HH:mm
    const arrMs = parseBusPrdtm(prdtm);
    const countdown = String(p.prdctdn ?? '').trim();
    let minutes;
    if (/^DUE$/i.test(countdown) || countdown === '0') minutes = 'DUE';
    else if (/^\d+$/.test(countdown)) minutes = Number(countdown);
    else if (Number.isFinite(arrMs)) {
      const m = Math.round((arrMs - nowMs) / 60000);
      minutes = m <= 0 ? 'DUE' : m;
    } else continue;

    rows.push({
      stpid: String(p.stpid ?? ''),
      stpnm: p.stpnm ?? '',
      rt,
      rtdir: p.rtdir ?? '',
      des: p.des ?? p.destNm ?? '',
      prdtm,
      arrMs,
      minutes,
      clock: formatBusClock(arrMs),
      delayed: String(p.dly) === 'true' || p.dly === true,
      vid: String(p.vid ?? ''),
    });
  }
  rows.sort((a, b) => {
    const am = a.minutes === 'DUE' ? -1 : a.minutes;
    const bm = b.minutes === 'DUE' ? -1 : b.minutes;
    return am - bm;
  });
  return rows;
}

/** CTA prdtm "yyyyMMdd HH:mm" as Chicago wall → epoch ms (best effort). */
export function parseBusPrdtm(prdtm) {
  const m = String(prdtm).match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // Interpret as local machine time if already in Chicago; OK for display deltas.
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00`);
  return Number.isFinite(ms) ? ms : null;
}

export function formatBusClock(arrMs) {
  if (!Number.isFinite(arrMs)) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(arrMs));
}

export function groupBusByDirection(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const title = (r.rtdir && String(r.rtdir).trim()) || 'Arrivals';
    const key = title.toLowerCase();
    if (!map.has(key)) map.set(key, { title: title.toUpperCase(), rows: [] });
    map.get(key).rows.push(r);
  }
  return [...map.values()];
}

/**
 * @param {{ stpid: string, rt?: string|null }} opts
 */
export async function fetchBusPredictions({ stpid, rt = null }, signal) {
  const q = new URLSearchParams({ format: 'json', stpid: String(stpid) });
  if (rt) q.set('rt', String(rt));
  const res = await fetch(`/api/bus/getpredictions?${q}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const err = data?.['bustime-response']?.error;
  if (Array.isArray(err) && err.length && !data?.['bustime-response']?.prd) {
    const msg = err[0]?.msg || 'prediction error';
    if (/key/i.test(msg)) throw new Error(msg);
    // "No arrival times" style → empty list
    return [];
  }
  return normalizeBusPredictions(data, { rtFilter: rt });
}

export class BusArrivalsSession {
  constructor() {
    this.stpid = null;
    this.rt = null;
    this.rows = [];
    this.updatedAt = null;
    this.error = null;
    this.loaded = false;
    this.onUpdate = () => {};
    this.poller = null;
  }

  open(stpid, rt = null) {
    this.close();
    this.stpid = String(stpid);
    this.rt = rt ? String(rt) : null;
    this.rows = [];
    this.error = null;
    this.loaded = false;
    this.poller = new Poller({
      storageKey: BUS_ARRIVALS_LEDGER,
      intervalMs: BUS_ARRIVALS_POLL_MS,
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn: async (signal) => {
        const rows = await fetchBusPredictions({ stpid: this.stpid, rt: this.rt }, signal);
        this.rows = rows;
        this.updatedAt = Date.now();
        this.error = null;
        this.loaded = true;
        this.onUpdate({ rows, updatedAt: this.updatedAt, error: null, loaded: true });
      },
      onStatus: (status, err) => {
        if (status === 'error') {
          this.error = err?.message ?? 'fetch failed';
          this.onUpdate({
            rows: this.rows,
            updatedAt: this.updatedAt,
            error: this.error,
            loaded: this.loaded,
          });
        } else if (status === 'hold') {
          this.error = 'BUDGET HOLD';
          this.onUpdate({
            rows: this.rows,
            updatedAt: this.updatedAt,
            error: this.error,
            loaded: this.loaded,
          });
        }
      },
    });
    this.poller.start();
  }

  close() {
    this.poller?.stop();
    this.poller = null;
    this.stpid = null;
    this.loaded = false;
  }
}
