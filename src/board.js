/**
 * The arrival board — the bottom sheet that shows predictions for one stop.
 *
 * Product rule this module enforces: a board is always about exactly one
 * line or one route. Opening Roosevelt from the Orange list shows Orange,
 * not a transfer dump of every line that touches the platform. `boardNav`
 * remembers where the user came from so the back affordance can put them
 * back in the same list.
 */

import { groupArrivalsByDirection, shortDestName } from './arrivals.js';
import { groupBusByDirection } from './bus-arrivals.js';
import { lineDefByKey, lineColor, liveLineKeys, cleanStationName } from './catalog.js';
import { busRouteDef } from './bus-catalog.js';
import { escapeHtml, emptyState } from './dom.js';

/**
 * @typedef {{
 *   source: 'map'|'stations'|'search',
 *   kind: 'train'|'bus',
 *   lineKey?: string|null,
 *   query?: string,
 *   busRt?: string,
 *   busRtdir?: string,
 * }} BoardNav
 */

/**
 * @param {object} deps
 * @param {ReturnType<import('./map-stage.js').createMapStage>} deps.stage
 * @param {import('./arrivals.js').ArrivalsSession} deps.arrivals
 * @param {import('./bus-arrivals.js').BusArrivalsSession} deps.busArrivals
 * @param {() => any[]} deps.getBusCatalog
 * @param {() => Record<string, string>} deps.getLineStatus alerts, read late —
 *   the alerts engine is constructed after this module.
 * @param {() => string} deps.getBrowseLineKey the line the user is browsing,
 *   used to disambiguate a transfer station.
 * @param {() => void} deps.onOpen called before a board opens, so the caller
 *   can close the browse surface (one surface at a time).
 * @param {(nav: BoardNav) => void} deps.onRestoreBrowse back-affordance target.
 */
export function createBoard({
  stage,
  arrivals,
  busArrivals,
  getBusCatalog,
  getLineStatus,
  getBrowseLineKey,
  onOpen,
  onRestoreBrowse,
}) {
  const sheetEl = document.getElementById('station-sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetMeta = document.getElementById('sheet-meta');
  const sheetRows = document.getElementById('sheet-rows');
  const sheetUpdated = document.getElementById('sheet-updated');

  /** @type {BoardNav|null} */
  let boardNav = null;
  /** @type {string|null} */
  let selectedStationId = null;

  function isOpen() {
    return Boolean(sheetEl?.classList.contains('open'));
  }

  function syncBackUi() {
    sheetEl?.classList.toggle('has-back', Boolean(boardNav && boardNav.source !== 'map'));
  }

  function setUpdated(updatedAt) {
    if (!sheetUpdated || !updatedAt) return;
    const t = new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    sheetUpdated.textContent = `AS OF ${t}`;
  }

  /**
   * Which single line this board is about. Preference order: an explicit
   * request, then the line being browsed, then the station's only line, then
   * Orange as the historical default.
   * @param {object} station
   * @param {string} [preferredKey]
   */
  function resolveBoardLineKey(station, preferredKey) {
    const live = liveLineKeys();
    const onStation = (station?.lines || []).filter((k) => live.includes(k));
    if (preferredKey && onStation.includes(preferredKey)) return preferredKey;
    if (preferredKey && live.includes(preferredKey) && !station?.lines?.length) return preferredKey;
    const browseKey = getBrowseLineKey();
    if (browseKey && onStation.includes(browseKey)) return browseKey;
    if (onStation.length === 1) return onStation[0];
    if (onStation.includes('Org')) return 'Org';
    return onStation[0] || live[0] || 'Org';
  }

  /**
   * Shared shell for both board kinds: the error / loading / empty ladder is
   * identical for trains and buses, only the row markup differs.
   * @param {object[]} rows
   * @param {string|null} error
   * @param {boolean} loaded
   * @param {(rows: object[]) => DocumentFragment} renderGroups
   */
  function renderRows(rows, error, loaded, renderGroups) {
    if (!sheetRows) return;
    if (error && !rows?.length) {
      const label = error === 'BUDGET HOLD'
        ? 'BUDGET HOLD'
        : /key|HTTP|failed|network/i.test(String(error))
          ? 'FEED ERROR'
          : 'NO PREDICTIONS';
      sheetRows.replaceChildren(emptyState(label));
      return;
    }
    if (!rows?.length) {
      sheetRows.replaceChildren(emptyState(loaded ? 'NO PREDICTIONS' : 'LOADING…'));
      return;
    }
    sheetRows.replaceChildren(renderGroups(rows));
  }

  /**
   * @param {string} title
   * @param {string} countLabel
   * @param {string} [kindClass]
   */
  function directionHeader(title, countLabel, kindClass) {
    const h = document.createElement('div');
    h.className = kindClass ? `dir-header dir-${kindClass}` : 'dir-header';
    h.innerHTML = `
        <span class="dir-title">${escapeHtml(title)}</span>
        <span class="dir-count">${escapeHtml(countLabel)}</span>
      `;
    return h;
  }

  function renderTrainGroups(rows, boardLineKey) {
    const frag = document.createDocumentFragment();
    const orbColor = lineColor(boardLineKey);
    for (const g of groupArrivalsByDirection(rows)) {
      const section = document.createElement('section');
      section.className = 'dir-section';
      section.setAttribute('aria-label', g.title);
      const count = g.rows.length;
      section.appendChild(
        directionHeader(g.title, `${count} ${count === 1 ? 'train' : 'trains'}`, g.kind || 'other'),
      );
      for (const r of g.rows) {
        const row = document.createElement('div');
        row.className = 'arrival-row';
        if (r.isDly) row.classList.add('delayed');
        if (r.isApp) row.classList.add('approaching');
        const minsLabel = r.minutes === 'DUE' || r.isApp ? 'DUE' : String(r.minutes);
        row.innerHTML = `
          <span class="arr-orb" style="--orb-rgb: ${orbColor.join(',')}" aria-hidden="true"></span>
          <span class="arr-dest">${escapeHtml(shortDestName(r))}</span>
          <span class="arr-clock">${escapeHtml(r.clock || '')}</span>
          <span class="${minsLabel === 'DUE' ? 'arr-mins due' : 'arr-mins'}">${escapeHtml(minsLabel)}</span>
        `;
        section.appendChild(row);
      }
      frag.appendChild(section);
    }
    return frag;
  }

  function renderBusGroups(rows) {
    const frag = document.createDocumentFragment();
    for (const g of groupBusByDirection(rows)) {
      const section = document.createElement('section');
      section.className = 'dir-section';
      section.appendChild(directionHeader(g.title, String(g.rows.length)));
      for (const r of g.rows) {
        const row = document.createElement('div');
        row.className = 'arrival-row';
        if (r.delayed) row.classList.add('delayed');
        const minsLabel = r.minutes === 'DUE' ? 'DUE' : String(r.minutes);
        row.innerHTML = `
          <span class="arr-orb arr-orb-bus" aria-hidden="true"></span>
          <span class="arr-dest">${escapeHtml(r.des || r.rtdir || '—')}</span>
          <span class="arr-clock">${escapeHtml(r.clock || '')}</span>
          <span class="${minsLabel === 'DUE' ? 'arr-mins due' : 'arr-mins'}">${escapeHtml(minsLabel)}</span>
        `;
        section.appendChild(row);
      }
      frag.appendChild(section);
    }
    return frag;
  }

  /** Shared open sequence: exclusive surface, header text, empty board. */
  function beginOpen(title, meta) {
    onOpen();
    sheetEl?.classList.add('open');
    syncBackUi();
    if (sheetTitle) sheetTitle.textContent = title;
    if (sheetMeta) sheetMeta.textContent = meta;
    if (sheetUpdated) sheetUpdated.textContent = 'AS OF —';
  }

  /**
   * @param {object} station
   * @param {{fly?: boolean, source?: 'map'|'stations'|'search', lineKey?: string, query?: string}} [opts]
   */
  function openStation(station, { fly = true, source = 'map', lineKey, query } = {}) {
    if (!station?.id) return;
    const boardLineKey = resolveBoardLineKey(station, lineKey);
    const def = lineDefByKey(boardLineKey);
    boardNav = { source, kind: 'train', lineKey: boardLineKey, query: query || '' };
    busArrivals.close();
    selectedStationId = station.id;

    const status = getLineStatus()?.[boardLineKey] ?? 'normal';
    const label = (def?.name || boardLineKey).replace(/ Line$/i, '').toUpperCase();
    beginOpen(cleanStationName(station.name || station.id), `${label} · ${String(status).toUpperCase()}`);

    renderRows([], null, false, (rows) => renderTrainGroups(rows, boardLineKey));
    arrivals.onUpdate = ({ rows, updatedAt, error, loaded }) => {
      renderRows(rows, error, Boolean(loaded), (r) => renderTrainGroups(r, boardLineKey));
      setUpdated(updatedAt);
    };
    // Single-line board: only the line the user entered from.
    arrivals.open(station.id, def?.rt || null);
    if (fly && station.coords) stage.easeToPoint(station.coords);
  }

  /**
   * Bus stop board — single route only, same rule as trains.
   * @param {{stpid: string, name?: string, lat?: number, lon?: number}} stop
   * @param {{rt: string, rtdir?: string, source?: 'map'|'stations'|'search'}} opts
   */
  function openBusStop(stop, { rt, rtdir = '', source = 'stations' } = {}) {
    if (!stop?.stpid) return;
    const routeRt = String(rt);
    const def = busRouteDef(getBusCatalog(), routeRt) || busRouteDef(routeRt);
    boardNav = { source, kind: 'bus', busRt: routeRt, busRtdir: rtdir, lineKey: null, query: '' };
    selectedStationId = null;
    arrivals.close();

    const dirBit = rtdir ? ` · ${rtdir.toUpperCase()}` : '';
    beginOpen(stop.name || `Stop ${stop.stpid}`, `${routeRt} · ${(def?.name || 'BUS').toUpperCase()}${dirBit}`);

    renderRows([], null, false, renderBusGroups);
    busArrivals.onUpdate = ({ rows, updatedAt, error, loaded }) => {
      renderRows(rows, error, Boolean(loaded), renderBusGroups);
      setUpdated(updatedAt);
    };
    busArrivals.open(stop.stpid, routeRt);
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
      stage.easeToPoint([stop.lon, stop.lat]);
    }
  }

  /** @param {{restoreBrowse?: boolean}} [opts] */
  function close({ restoreBrowse = false } = {}) {
    const nav = boardNav;
    selectedStationId = null;
    arrivals.close();
    busArrivals.close();
    sheetEl?.classList.remove('open');
    sheetEl?.classList.remove('has-back');
    boardNav = null;
    if (restoreBrowse && nav && nav.source !== 'map') onRestoreBrowse(nav);
  }

  document.getElementById('sheet-close')?.addEventListener('click', () => close());
  document.getElementById('sheet-back')?.addEventListener('click', () => close({ restoreBrowse: true }));

  return {
    openStation,
    openBusStop,
    close,
    isOpen,
    resolveBoardLineKey,
    get selectedStationId() {
      return selectedStationId;
    },
  };
}
