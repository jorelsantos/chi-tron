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
 * Normalize CTA direction text → short board section titles.
 * @param {object} r
 * @returns {{ title: string, key: string, kind: string }}
 */
export function directionLabel(r) {
  const raw = `${r?.stpDe || ''} ${r?.destNm || ''}`.toLowerCase();
  if (raw.includes('midway')) {
    return { title: 'TO MIDWAY', key: 'midway', kind: 'midway' };
  }
  if (raw.includes('95th') || raw.includes('dan ryan')) {
    return { title: 'TO 95TH', key: '95th', kind: '95th' };
  }
  if (raw.includes('howard')) {
    return { title: 'TO HOWARD', key: 'howard', kind: 'howard' };
  }
  if (raw.includes("o'hare") || raw.includes('ohare') || raw.includes('o’hare')) {
    return { title: "TO O'HARE", key: 'ohare', kind: 'ohare' };
  }
  if (raw.includes('forest park')) {
    return { title: 'TO FOREST PARK', key: 'forest-park', kind: 'forest-park' };
  }
  if (raw.includes('kimball')) {
    return { title: 'TO KIMBALL', key: 'kimball', kind: 'kimball' };
  }
  if (raw.includes('linden')) {
    return { title: 'TO LINDEN', key: 'linden', kind: 'linden' };
  }
  if (raw.includes('54th') || raw.includes('cermak')) {
    return { title: 'TO 54TH/CERMAK', key: '54th', kind: '54th' };
  }
  if (raw.includes('skokie') || raw.includes('dempster')) {
    return { title: 'TO SKOKIE', key: 'skokie', kind: 'skokie' };
  }
  if (raw.includes('cottage grove')) {
    return { title: 'TO COTTAGE GROVE', key: 'cottage-grove', kind: 'cottage-grove' };
  }
  if (raw.includes('ashland/63') || raw.includes('ashland-63')) {
    return { title: 'TO ASHLAND/63RD', key: 'ashland-63', kind: 'ashland-63' };
  }
  if (raw.includes('harlem') && raw.includes('lake')) {
    return { title: 'TO HARLEM/LAKE', key: 'harlem-lake', kind: 'harlem-lake' };
  }
  if (raw.includes('loop') || raw.includes('downtown') || raw.includes('clark/lake')) {
    return { title: 'TO LOOP', key: 'loop', kind: 'loop' };
  }
  if (r?.destNm) {
    const dest = String(r.destNm).trim();
    return { title: `TO ${dest.toUpperCase()}`, key: dest.toLowerCase(), kind: 'other' };
  }
  return { title: 'ARRIVALS', key: 'arrivals', kind: 'other' };
}

/** Short destination label for a single row (no arrow, no route fluff). */
export function shortDestName(r) {
  const d = String(r?.destNm || '').trim();
  if (!d) return '—';
  if (/midway/i.test(d)) return 'Midway';
  if (/95th/i.test(d)) return '95th';
  if (/howard/i.test(d)) return 'Howard';
  if (/o['']?hare/i.test(d)) return "O'Hare";
  if (/forest park/i.test(d)) return 'Forest Park';
  if (/kimball/i.test(d)) return 'Kimball';
  if (/linden/i.test(d)) return 'Linden';
  if (/54th|cermak/i.test(d)) return '54th/Cermak';
  if (/skokie|dempster/i.test(d)) return 'Skokie';
  if (/cottage grove/i.test(d)) return 'Cottage Grove';
  if (/ashland\/63/i.test(d)) return 'Ashland/63rd';
  if (/harlem.*lake|lake.*harlem/i.test(d)) return 'Harlem/Lake';
  if (/loop/i.test(d) || /clark\/lake/i.test(d)) return 'Loop';
  return d.replace(/\s*\((Orange|Red|Blue|Brown|Green|Purple|Pink|Yellow)\)\s*/gi, '');
}

/** CTA rt code → line key (Red, Org, …). */
export function lineKeyFromRt(rt) {
  const code = String(rt || '').toLowerCase();
  const map = {
    red: 'Red',
    blue: 'Blue',
    brn: 'Brn',
    g: 'G',
    org: 'Org',
    p: 'P',
    pink: 'Pink',
    y: 'Y',
  };
  return map[code] || String(rt || 'Other');
}

/**
 * Group arrival rows by service direction (single-line boards).
 * @param {object[]} rows
 * @returns {{ title: string, kind: string, rows: object[] }[]}
 */
export function groupArrivalsByDirection(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const { title, key, kind } = directionLabel(r);
    if (!map.has(key)) map.set(key, { title, kind, rows: [] });
    map.get(key).rows.push(r);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    const rank = (k) => {
      const order = [
        'howard', '95th', 'midway', 'loop', 'ohare', 'forest-park',
        'kimball', 'linden', '54th', 'skokie', 'cottage-grove', 'ashland-63', 'harlem-lake',
      ];
      const i = order.indexOf(k);
      return i === -1 ? 50 : i;
    };
    const d = rank(a.kind) - rank(b.kind);
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
 * Full-station board: group by line, then direction within each line.
 * @param {object[]} rows
 * @returns {{ lineKey: string, directions: ReturnType<typeof groupArrivalsByDirection> }[]}
 */
export function groupArrivalsByLineThenDirection(rows) {
  const byLine = new Map();
  for (const r of rows || []) {
    const lk = lineKeyFromRt(r.rt);
    if (!byLine.has(lk)) byLine.set(lk, []);
    byLine.get(lk).push(r);
  }
  const lineOrder = ['Red', 'Blue', 'Brn', 'G', 'Org', 'P', 'Pink', 'Y'];
  const keys = [...byLine.keys()].sort((a, b) => {
    const ia = lineOrder.indexOf(a);
    const ib = lineOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((lineKey) => ({
    lineKey,
    directions: groupArrivalsByDirection(byLine.get(lineKey)),
  }));
}

/**
 * One-shot fetch for a station board.
 * Policy A: omit `rt` → all lines at mapid (full station).
 * @param {{ mapid: string, rt?: string|null }} opts
 */
export async function fetchArrivals({ mapid, rt = null }, signal) {
  const q = new URLSearchParams({ mapid: String(mapid), outputType: 'JSON' });
  if (rt) q.set('rt', rt);
  const res = await fetch(`/api/arrivals?${q}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data?.ctatt?.errCd && String(data.ctatt.errCd) !== '0') {
    throw new Error(data.ctatt.errNm || `CTA err ${data.ctatt.errCd}`);
  }
  return normalizeArrivals(data, { rtFilter: rt || null });
}

/**
 * Panel-scoped arrivals poller: only runs while a station is open.
 * Shares cta-train ledger with positions.
 */
export class ArrivalsSession {
  constructor() {
    this.mapid = null;
    /** @type {string|null} null = full station (all lines) */
    this.rt = null;
    this.rows = [];
    this.updatedAt = null;
    this.error = null;
    /** True after first successful fetch for this open (even if zero rows). */
    this.loaded = false;
    this.onUpdate = () => {};
    this.poller = null;
  }

  /**
   * Start (or switch) board polling for a station.
   * @param {string} mapid
   * @param {string|null} [rt] omit / null = full station (policy A)
   */
  open(mapid, rt = null) {
    this.close();
    this.mapid = String(mapid);
    this.rt = rt || null;
    this.rows = [];
    this.error = null;
    this.loaded = false;
    this.poller = new Poller({
      storageKey: ARRIVALS_LEDGER_KEY,
      intervalMs: ARRIVALS_POLL_MS,
      ceiling: DEFAULT_DAILY_CEILING,
      fetchFn: async (signal) => {
        const rows = await fetchArrivals({ mapid: this.mapid, rt: this.rt }, signal);
        this.rows = rows;
        this.updatedAt = Date.now();
        this.error = null;
        this.loaded = true;
        this.onUpdate({
          rows,
          updatedAt: this.updatedAt,
          error: null,
          mapid: this.mapid,
          loaded: true,
        });
      },
      onStatus: (status, err) => {
        if (status === 'error') {
          this.error = err?.message ?? 'fetch failed';
          this.onUpdate({
            rows: this.rows,
            updatedAt: this.updatedAt,
            error: this.error,
            mapid: this.mapid,
            loaded: this.loaded,
          });
        } else if (status === 'hold') {
          this.error = 'BUDGET HOLD';
          this.onUpdate({
            rows: this.rows,
            updatedAt: this.updatedAt,
            error: this.error,
            mapid: this.mapid,
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
    this.mapid = null;
    this.loaded = false;
  }
}
