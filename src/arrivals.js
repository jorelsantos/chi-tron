// CTA Train Tracker arrivals (ttarrivals) — station board predictions.
// Minutes computed in America/Chicago against CTA's local arrT timestamps.

import { toBool } from './trains.js';
import { Poller, DEFAULT_DAILY_CEILING } from './poller.js';

// Share ledger with TrainEngine positions — same CTA_KEY.
const ARRIVALS_LEDGER_KEY = 'cta-train';
export const ARRIVALS_POLL_MS = 20000;

const CHICAGO_TZ = 'America/Chicago';

function asList(maybe) {
  if (Array.isArray(maybe)) return maybe;
  return maybe ? [maybe] : [];
}

/**
 * Parse CTA arrT like "2026-08-08T12:29:01" as Chicago wall time → epoch ms.
 * @param {string} arrT
 * @returns {number|null}
 */
export function parseChicagoArrT(arrT) {
  if (!arrT || typeof arrT !== 'string') return null;
  // CTA delivers local Chicago time without offset; append CST/CDT via formatter trick:
  // construct as local components interpreted in Chicago.
  const m = arrT.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  // Use temporal-ish approach: format a UTC guess and adjust — simpler:
  // Intl: build ISO with forced offset by comparing Chicago parts.
  const utcGuess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Figure Chicago offset at that instant
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  // Binary-search offset: evaluate what Chicago shows for utcGuess, diff from desired
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(utcGuess)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  const offset = asUtc - utcGuess;
  return utcGuess - offset;
}

/**
 * @param {number} arrMs
 * @param {number} nowMs
 * @param {boolean} isApp
 * @returns {number|'DUE'}
 */
export function minutesUntil(arrMs, nowMs, isApp) {
  if (isApp) return 'DUE';
  if (!Number.isFinite(arrMs)) return 'DUE';
  const mins = Math.round((arrMs - nowMs) / 60000);
  if (mins <= 0) return 'DUE';
  return mins;
}

/**
 * Format clock time in Chicago for display.
 * @param {number} arrMs
 */
export function formatClock(arrMs) {
  if (!Number.isFinite(arrMs)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(arrMs));
}

/**
 * Normalize raw ttarrivals JSON → sorted arrival rows.
 * @param {object} data
 * @param {{ nowMs?: number, rtFilter?: string|null }} [opts]
 */
export function normalizeArrivals(data, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const rtFilter = opts.rtFilter ? String(opts.rtFilter).toLowerCase() : null;
  const eta = data?.ctatt?.eta;
  const rows = [];
  for (const e of asList(eta)) {
    const rt = String(e.rt ?? '').toLowerCase();
    if (rtFilter && rt !== rtFilter) continue;
    const isApp = toBool(e.isApp);
    const isDly = toBool(e.isDly);
    const isSch = toBool(e.isSch);
    const arrMs = parseChicagoArrT(e.arrT);
    const minutes = minutesUntil(arrMs, nowMs, isApp);
    rows.push({
      staId: String(e.staId ?? e.mapid ?? ''),
      stpId: String(e.stpId ?? ''),
      staNm: e.staNm ?? '',
      stpDe: e.stpDe ?? '',
      rt: e.rt ?? '',
      destNm: e.destNm ?? '',
      rn: String(e.rn ?? ''),
      arrT: e.arrT ?? '',
      prdt: e.prdt ?? '',
      arrMs,
      minutes,
      clock: formatClock(arrMs),
      isApp,
      isDly,
      isSch,
    });
  }
  rows.sort((a, b) => {
    const am = a.minutes === 'DUE' ? -1 : a.minutes;
    const bm = b.minutes === 'DUE' ? -1 : b.minutes;
    return am - bm;
  });
  return rows;
}

/**
 * Group arrival rows by service direction for Transit-style board sections.
 * Prefers stpDe ("Service toward Midway"); falls back to destNm.
 * @param {object[]} rows
 * @returns {{ title: string, rows: object[] }[]}
 */
export function groupArrivalsByDirection(rows) {
  const map = new Map();
  for (const r of rows || []) {
    let title = (r.stpDe && String(r.stpDe).trim()) || '';
    if (!title && r.destNm) title = `Toward ${r.destNm}`;
    if (!title) title = 'Arrivals';
    // Normalize casing for merge
    const key = title.toLowerCase();
    if (!map.has(key)) map.set(key, { title, rows: [] });
    map.get(key).rows.push(r);
  }
  // Prefer Midway section before Loop when both present
  const groups = [...map.values()];
  groups.sort((a, b) => {
    const rank = (t) => {
      const s = t.toLowerCase();
      if (s.includes('midway')) return 0;
      if (s.includes('loop')) return 1;
      return 2;
    };
    const d = rank(a.title) - rank(b.title);
    return d !== 0 ? d : a.title.localeCompare(b.title);
  });
  for (const g of groups) {
    g.rows.sort((a, b) => {
      const am = a.minutes === 'DUE' ? -1 : a.minutes;
      const bm = b.minutes === 'DUE' ? -1 : b.minutes;
      return am - bm;
    });
  }
  return groups;
}

/**
 * One-shot fetch for a station board.
 * @param {{ mapid: string, rt?: string }} opts
 */
export async function fetchArrivals({ mapid, rt = 'org' }, signal) {
  const q = new URLSearchParams({ mapid: String(mapid), outputType: 'JSON' });
  if (rt) q.set('rt', rt);
  const res = await fetch(`/api/arrivals?${q}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data?.ctatt?.errCd && String(data.ctatt.errCd) !== '0') {
    throw new Error(data.ctatt.errNm || `CTA err ${data.ctatt.errCd}`);
  }
  return normalizeArrivals(data, { rtFilter: rt });
}

/**
 * Panel-scoped arrivals poller: only runs while a station is open.
 * Shares cta-train ledger with positions.
 */
export class ArrivalsSession {
  constructor() {
    this.mapid = null;
    this.rt = 'org';
    this.rows = [];
    this.updatedAt = null;
    this.error = null;
    this.onUpdate = () => {};
    this.poller = null;
  }

  /**
   * Start (or switch) board polling for a station.
   * @param {string} mapid
   * @param {string} [rt]
   */
  open(mapid, rt = 'org') {
    this.close();
    this.mapid = String(mapid);
    this.rt = rt;
    this.rows = [];
    this.error = null;
    this.poller = new Poller({
      storageKey: ARRIVALS_LEDGER_KEY,
      intervalMs: ARRIVALS_POLL_MS,
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn: async (signal) => {
        const rows = await fetchArrivals({ mapid: this.mapid, rt: this.rt }, signal);
        this.rows = rows;
        this.updatedAt = Date.now();
        this.error = null;
        this.onUpdate({ rows, updatedAt: this.updatedAt, error: null, mapid: this.mapid });
      },
      onStatus: (status, err) => {
        if (status === 'error') {
          this.error = err?.message ?? 'fetch failed';
          this.onUpdate({
            rows: this.rows,
            updatedAt: this.updatedAt,
            error: this.error,
            mapid: this.mapid,
          });
        } else if (status === 'hold') {
          this.error = 'BUDGET HOLD';
          this.onUpdate({
            rows: this.rows,
            updatedAt: this.updatedAt,
            error: this.error,
            mapid: this.mapid,
          });
        }
      },
    });
    this.poller.start();
  }

  close() {
    this.poller?.stop();
    this.poller = null;
    this.mapid = null;
  }
}
