/**
 * The browse surface: TRAIN | BUS | BIKE icons on the tracker → lists → board,
 * plus station search. Mode tabs live on the tracker titlebar.
 *
 * Three things worth knowing before editing:
 *
 * 1. Bus stop order comes from the baked pattern sequence, never from CTA's
 *    `getstops`, which returns stops sorted by name and is therefore useless
 *    as a route sequence. See scripts/build-patterns.mjs.
 * 2. Bus data is lazy (src/bus-data.js). Any bus view may render before the
 *    bake has landed, so each one asks for it and paints a loading state
 *    until `onChange` re-renders it. Train views never wait on anything.
 * 3. Bike is shallower: a flat searchable station list. No direction step.
 */

import {
  stationsOrdered,
  searchStations,
  browseLinesLive,
  liveStationsUnion,
  lineDefByKey,
  lineColor,
  cleanStationName,
} from './catalog.js';
import {
  directionsForRoute,
  stopsForRoute,
  busRouteDef,
  searchBusRoutes,
} from './bus-catalog.js';
import { browseRow, colorSwatch, routeBadge, lineOrbs, showEmpty } from './dom.js';
import {
  KIND_LABELS,
  KINDS,
  ROOT_TITLES,
  kindFromRatio,
  thumbIndexFromRatio,
} from './browse-titles.js';
import { bikeStatusMeta } from './bike-status.js';

/**
 * @param {object} deps
 * @param {() => Record<string, object>} deps.getStations snapped station index
 * @param {import('./bus-data.js').BusData} deps.busData
 * @param {() => import('./divvy.js').DivvyLive[]} [deps.getBikeStations]
 * @param {() => boolean} [deps.bikeReady]
 * @param {() => void} [deps.ensureBikeData]
 * @param {(station: object, opts: object) => void} deps.onOpenStation
 * @param {(stop: object, opts: object) => void} deps.onOpenBusStop
 * @param {(station: object, opts?: object) => void} [deps.onOpenBikeStation]
 * @param {() => boolean} deps.isBoardOpen
 * @param {() => void} deps.closeBoard
 */
export function createBrowse({
  getStations,
  busData,
  getBikeStations = () => [],
  bikeReady = () => false,
  ensureBikeData = () => {},
  onOpenStation,
  onOpenBusStop,
  onOpenBikeStation = () => {},
  isBoardOpen,
  closeBoard,
}) {
  const browseEl = document.getElementById('browse-sheet');
  const browseList = document.getElementById('browse-list');
  const browseTitle = document.getElementById('browse-title');
  const browseBack = document.getElementById('browse-back');
  const searchInput = document.getElementById('browse-search-input');

  /** @type {'train'|'bus'|'bike'} */
  let kind = 'train';
  /** @type {'lines'|'directions'|'stations'|'search'} */
  let mode = 'lines';
  let lineKey = browseLinesLive()[0]?.key || 'Org';
  let busRt = '8';
  /** @type {string} CTA rtdir, e.g. Northbound */
  let busRtdir = '';
  let busQuery = '';
  let bikeQuery = '';

  const isOpen = () => Boolean(browseEl?.classList.contains('open'));

  function setTitle(text) {
    if (!browseTitle) return;
    browseTitle.textContent = text || '';
    browseTitle.hidden = !isOpen() || !text;
  }

  function setBack(visible) {
    if (browseBack) browseBack.hidden = !visible;
  }

  function syncKindUi() {
    for (const k of KINDS) {
      const el = document.getElementById(`browse-kind-${k}`);
      const active = kind === k;
      el?.classList.toggle('active', active);
      el?.setAttribute('aria-pressed', String(active));
      el?.setAttribute('aria-selected', String(active));
      el?.setAttribute('aria-label', KIND_LABELS[k]);
    }
    const i = String(Math.max(0, KINDS.indexOf(kind)));
    browseEl?.style.setProperty('--kind-i', i);
    document.getElementById('browse-kind')?.style.setProperty('--kind-i', i);
  }

  /**
   * Ask for the bus bake and paint a placeholder until it lands. Returns
   * false when the caller should stop rendering and wait.
   * @param {string} title heading to show while waiting
   * @returns {boolean} true when data is available now
   */
  function requireBusData(title) {
    if (busData.status === 'ready') return true;
    if (busData.status === 'failed') {
      setTitle(title);
      showEmpty(browseList, 'BUS DATA OFF');
      return false;
    }
    setTitle(title);
    showEmpty(browseList, 'LOADING…');
    busData.ensureLoaded();
    return false;
  }

  // ---- renderers --------------------------------------------------------

  function renderBusRoutes() {
    browseEl?.classList.add('mode-bus-list');
    browseEl?.classList.remove('mode-search');
    if (searchInput) {
      searchInput.placeholder = 'Route # or name…';
      searchInput.value = busQuery;
    }
    if (!requireBusData(ROOT_TITLES.bus)) return;
    setTitle(ROOT_TITLES.bus);
    const routes = searchBusRoutes(busData.boardRoutes, busQuery);
    if (!routes.length) {
      showEmpty(browseList, busQuery.trim() ? 'NO MATCH' : 'NO LIVE ROUTES');
      return;
    }
    browseList.replaceChildren(
      ...routes.map((route) =>
        browseRow({
          lead: routeBadge(route.rt),
          name: route.name,
          meta: route.mapLive ? 'MAP' : 'LIVE',
          chevron: true,
          onClick: () => {
            busRt = route.rt;
            busRtdir = '';
            renderBusDirections(route.rt);
          },
        }),
      ),
    );
  }

  function renderTrainLines() {
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    setTitle(ROOT_TITLES.train);
    const lines = browseLinesLive();
    if (!lines.length) {
      showEmpty(browseList, 'NO LIVE LINES');
      return;
    }
    browseList.replaceChildren(
      ...lines.map((line) =>
        browseRow({
          lead: colorSwatch(line.color),
          name: line.name,
          // No meta label here. Every line in this list is live, so a 'LIVE'
          // badge on all 8 rows carried no information — it was decoration
          // that read as status. The bus list keeps its badge because there
          // it varies: MAP means the route also draws vehicles on the map.
          chevron: true,
          onClick: () => {
            lineKey = line.key;
            renderStations(line.key);
          },
        }),
      ),
    );
  }

  function renderBikeStations() {
    browseEl?.classList.add('mode-bike-list');
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    if (searchInput) {
      searchInput.placeholder = 'Station name…';
      searchInput.value = bikeQuery;
    }
    setTitle(ROOT_TITLES.bike);
    if (!bikeReady()) {
      showEmpty(browseList, 'LOADING…');
      ensureBikeData();
      return;
    }
    const q = bikeQuery.trim().toLowerCase();
    let list = getBikeStations();
    if (q) {
      list = list.filter((s) => String(s.name || '').toLowerCase().includes(q));
    }
    // Stable A–Z when no live order matters.
    list = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!list.length) {
      showEmpty(browseList, q ? 'NO MATCH' : 'NO STATIONS');
      return;
    }
    // Cap list length for DOM budget; search narrows.
    const shown = list.slice(0, 200);
    browseList.replaceChildren(
      ...shown.map((st) => {
        return browseRow({
          name: st.name || st.id,
          meta: bikeStatusMeta(st),
          chevron: true,
          onClick: () => onOpenBikeStation(st, { source: 'stations' }),
        });
      }),
    );
  }

  function renderLines() {
    if (!browseList) return;
    mode = 'lines';
    setBack(false);
    browseList.replaceChildren();
    if (kind === 'bus') renderBusRoutes();
    else if (kind === 'bike') renderBikeStations();
    else renderTrainLines();
  }

  function renderStations(key) {
    if (!browseList) return;
    mode = 'stations';
    kind = 'train';
    syncKindUi();
    const line = lineDefByKey(key) || browseLinesLive()[0];
    setTitle(line?.name || key);
    setBack(true);
    browseEl?.classList.remove('mode-search');
    const list = stationsOrdered(getStations(), key);
    if (!list.length) {
      showEmpty(browseList, 'NO STATIONS');
      return;
    }
    browseList.replaceChildren(
      ...list.map((s) =>
        browseRow({
          lead: lineOrbs(s.lines || [key], lineColor, lineDefByKey),
          name: cleanStationName(s.name || s.id),
          chevron: true,
          onClick: () => onOpenStation(s, { fly: true, source: 'stations', lineKey }),
        }),
      ),
    );
  }

  /** CTA-style: pick Northbound / Southbound before the stop list. */
  function renderBusDirections(rt) {
    if (!browseList) return;
    mode = 'directions';
    kind = 'bus';
    busRt = String(rt);
    busRtdir = '';
    syncKindUi();
    setBack(true);
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    browseList.replaceChildren();
    const def = busRouteDef(busData.catalog, rt) || busRouteDef(rt);
    const title = `${rt} · ${def?.name || 'Bus'}`;
    if (!requireBusData(title)) return;
    setTitle(title);
    const dirs = directionsForRoute(busData.patterns, rt);
    if (!dirs.length) {
      // Legacy bake without directions — fall through to a flat stop list.
      renderBusStops(rt, '');
      return;
    }
    browseList.replaceChildren(
      ...dirs.map((d) =>
        browseRow({
          name: d.rtdir,
          meta: `${d.stops?.length || 0} STOPS`,
          chevron: true,
          onClick: () => {
            busRtdir = d.rtdir;
            renderBusStops(rt, d.rtdir);
          },
        }),
      ),
    );
  }

  function renderBusStops(rt, rtdir = busRtdir) {
    if (!browseList) return;
    mode = 'stations';
    kind = 'bus';
    busRt = String(rt);
    busRtdir = String(rtdir || '');
    syncKindUi();
    setBack(true);
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    browseList.replaceChildren();
    const def = busRouteDef(busData.catalog, rt) || busRouteDef(rt);
    const title = `${rt} · ${def?.name || 'Bus'}${busRtdir ? ` · ${busRtdir}` : ''}`;
    if (!requireBusData(title)) return;
    setTitle(title);
    const list = stopsForRoute(busData.patterns, rt, busRtdir || undefined);
    if (!list.length) {
      showEmpty(browseList, 'NO STOPS');
      return;
    }
    browseList.replaceChildren(
      ...list.map((stop) =>
        browseRow({
          lead: routeBadge(rt, true),
          name: stop.name || stop.stpid,
          chevron: true,
          onClick: () => onOpenBusStop(stop, { rt, rtdir: busRtdir, source: 'stations' }),
        }),
      ),
    );
  }

  function renderSearch(q) {
    if (!browseList) return;
    mode = 'search';
    kind = 'train';
    syncKindUi();
    setTitle(ROOT_TITLES.search);
    setBack(false);
    browseEl?.classList.add('mode-search');
    browseList.replaceChildren();
    if (!String(q || '').trim()) {
      showEmpty(browseList, 'TYPE A STATION');
      return;
    }
    const hits = searchStations(liveStationsUnion(getStations()), q);
    if (!hits.length) {
      showEmpty(browseList, 'NO MATCH');
      return;
    }
    browseList.replaceChildren(
      ...hits.map((s) =>
        browseRow({
          lead: lineOrbs(s.lines || [], lineColor, lineDefByKey),
          name: cleanStationName(s.name || s.id),
          onClick: () =>
            onOpenStation(s, { fly: true, source: 'search', query: searchInput?.value || '' }),
        }),
      ),
    );
  }

  // ---- surface control --------------------------------------------------

  function close() {
    browseEl?.classList.remove('open');
    browseEl?.classList.remove('mode-search');
    browseEl?.classList.remove('mode-bus-list');
    browseEl?.classList.remove('mode-bike-list');
    document.getElementById('fab-search')?.setAttribute('aria-pressed', 'false');
    if (searchInput) searchInput.value = '';
    busQuery = '';
    bikeQuery = '';
    if (browseTitle) {
      browseTitle.textContent = '';
      browseTitle.hidden = true;
    }
  }

  /** @param {'lines'|'directions'|'stations'|'search'} [nextMode] */
  function open(nextMode = 'lines') {
    // Exclusive surface: never stack board + browse.
    if (isBoardOpen()) closeBoard();
    mode = nextMode;
    browseEl?.classList.add('open');
    const showBusSearch = kind === 'bus' && nextMode === 'lines';
    const showBikeSearch = kind === 'bike' && nextMode === 'lines';
    browseEl?.classList.toggle('mode-search', nextMode === 'search' && kind === 'train');
    browseEl?.classList.toggle('mode-bus-list', showBusSearch);
    browseEl?.classList.toggle('mode-bike-list', showBikeSearch);
    document.getElementById('fab-search')?.setAttribute('aria-pressed', String(nextMode === 'search'));
    syncKindUi();
    if (nextMode === 'lines') {
      renderLines();
    } else if (nextMode === 'directions' && kind === 'bus') {
      renderBusDirections(busRt);
    } else if (nextMode === 'stations') {
      if (kind === 'bus') renderBusStops(busRt, busRtdir);
      else if (kind === 'bike') renderBikeStations();
      else renderStations(lineKey);
    } else {
      kind = 'train';
      syncKindUi();
      if (searchInput) searchInput.placeholder = 'Station name…';
      renderSearch('');
    }
    if (nextMode === 'search' || showBusSearch || showBikeSearch) searchInput?.focus();
  }

  /**
   * Put the user back where the board was opened from.
   * @param {import('./board.js').BoardNav} nav
   */
  function restore(nav) {
    if (nav.kind === 'bus') {
      kind = 'bus';
      busRt = nav.busRt || busRt;
      busRtdir = nav.busRtdir || busRtdir;
      open('stations');
      return;
    }
    if (nav.kind === 'bike') {
      kind = 'bike';
      open('lines');
      return;
    }
    kind = 'train';
    if (nav.source === 'search') {
      open('search');
      if (searchInput && nav.query) {
        searchInput.value = nav.query;
        renderSearch(nav.query);
      }
      return;
    }
    lineKey = nav.lineKey || 'Org';
    open('stations');
  }

  /** Re-render whatever bus view is on screen once the bake lands. */
  function onBusDataChange() {
    if (!isOpen() || kind !== 'bus') return;
    if (mode === 'lines') renderLines();
    else if (mode === 'directions') renderBusDirections(busRt);
    else if (mode === 'stations') renderBusStops(busRt, busRtdir);
  }

  /** Re-render bike list once stations + status are ready. */
  function onBikeDataChange() {
    if (!isOpen() || kind !== 'bike') return;
    renderBikeStations();
  }

  // ---- event wiring -----------------------------------------------------

  document.getElementById('browse-close')?.addEventListener('click', close);
  document.getElementById('browse-back')?.addEventListener('click', () => {
    if (kind === 'bus' && mode === 'stations') {
      renderBusDirections(busRt);
      return;
    }
    if (mode === 'stations' || mode === 'directions') renderLines();
  });
  function setKind(next) {
    if (!KINDS.includes(next)) {
      syncKindUi();
      return;
    }
    const sameRoot = next === kind && isOpen() && mode === 'lines';
    kind = next;
    if (kind === 'bus') busData.ensureLoaded();
    if (kind === 'bike') ensureBikeData();
    if (sameRoot) {
      close();
      syncKindUi();
      return;
    }
    open('lines');
  }

  document.getElementById('browse-kind-train')?.addEventListener('click', () => setKind('train'));
  document.getElementById('browse-kind-bus')?.addEventListener('click', () => setKind('bus'));
  document.getElementById('browse-kind-bike')?.addEventListener('click', () => setKind('bike'));

  const kindEl = document.getElementById('browse-kind');
  let slideOn = false;
  let slideMoved = false;
  let slideY = 0;
  let suppressKindClick = false;
  const ratioFromY = (y) => {
    const box = kindEl?.getBoundingClientRect();
    if (!box || box.height <= 0) return KINDS.indexOf(kind) / 3 + 1 / 6;
    return (y - box.top) / box.height;
  };
  kindEl?.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    slideOn = true;
    slideMoved = false;
    slideY = e.clientY;
    kindEl.setPointerCapture?.(e.pointerId);
    kindEl.classList.add('is-sliding');
  });
  kindEl?.addEventListener('pointermove', (e) => {
    if (!slideOn) return;
    if (Math.abs(e.clientY - slideY) >= 8) slideMoved = true;
    if (!slideMoved) return;
    kindEl.style.setProperty('--kind-i', String(thumbIndexFromRatio(ratioFromY(e.clientY))));
  });
  const endKindSlide = (e) => {
    if (!slideOn) return;
    slideOn = false;
    kindEl?.classList.remove('is-sliding');
    suppressKindClick = true;
    setKind(kindFromRatio(ratioFromY(e.clientY)));
  };
  kindEl?.addEventListener('pointerup', endKindSlide);
  kindEl?.addEventListener('pointercancel', () => {
    slideOn = false;
    kindEl?.classList.remove('is-sliding');
    syncKindUi();
  });
  kindEl?.addEventListener('click', (e) => {
    if (!suppressKindClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressKindClick = false;
  }, true);
  kindEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = KINDS.indexOf(kind);
    const n = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? i + 1 : i - 1;
    if (n < 0 || n >= KINDS.length) return;
    setKind(KINDS[n]);
    document.getElementById(`browse-kind-${KINDS[n]}`)?.focus();
  });

  let swipeX = 0;
  let swipeY = 0;
  let swipeOn = false;
  browseEl?.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeOn = true;
    swipeX = e.clientX;
    swipeY = e.clientY;
  });
  browseEl?.addEventListener('pointerup', (e) => {
    if (!swipeOn) return;
    swipeOn = false;
    const dx = e.clientX - swipeX;
    const dy = e.clientY - swipeY;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return;
    const i = KINDS.indexOf(kind);
    if (dx < 0 && i < KINDS.length - 1) setKind(KINDS[i + 1]);
    else if (dx > 0 && i > 0) setKind(KINDS[i - 1]);
  });
  browseEl?.addEventListener('pointercancel', () => {
    swipeOn = false;
  });
  searchInput?.addEventListener('input', () => {
    if (kind === 'bus' && mode === 'lines') {
      busQuery = searchInput.value;
      renderLines();
      return;
    }
    if (kind === 'bike' && mode === 'lines') {
      bikeQuery = searchInput.value;
      renderLines();
      return;
    }
    renderSearch(searchInput.value);
  });

  return {
    open,
    close,
    isOpen,
    restore,
    onBusDataChange,
    onBikeDataChange,
    /** @returns {boolean} true when the search view is the one on screen */
    isSearch: () => mode === 'search' && isOpen(),
    /** The line being browsed — the board uses it to resolve transfer stops. */
    get lineKey() {
      return lineKey;
    },
    get kind() {
      return kind;
    },
    setKind(next) {
      if (next === 'bus') kind = 'bus';
      else if (next === 'bike') kind = 'bike';
      else kind = 'train';
    },
  };
}
