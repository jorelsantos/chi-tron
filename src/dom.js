/**
 * Small DOM builders shared by the board and browse surfaces.
 *
 * Every list row in the app is the same shape — an optional leading element
 * (colour swatch, route badge, line orbs), a name, an optional meta label,
 * an optional chevron — and it was previously hand-assembled at six call
 * sites with six chances to drift. These helpers produce exactly that markup
 * so the CSS in index.html keeps matching.
 */

/**
 * Escape for interpolation into innerHTML. Arrival rows use template markup
 * (they carry inline gradient styles), so untrusted CTA strings — station
 * and destination names — must pass through here first.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The single-line placeholder every list shows instead of rows: LOADING…,
 * NO MATCH, BUDGET HOLD, and friends.
 * @param {string} text
 * @returns {HTMLDivElement}
 */
export function emptyState(text) {
  const el = document.createElement('div');
  el.className = 'sheet-empty';
  el.textContent = text;
  return el;
}

/**
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLSpanElement}
 */
export function span(text, className) {
  const el = document.createElement('span');
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

/**
 * A tappable browse row.
 * @param {object} opts
 * @param {HTMLElement|null} [opts.lead] swatch / badge / orb cluster
 * @param {string} opts.name primary label
 * @param {string} [opts.meta] right-aligned status word (LIVE, MAP, 12 STOPS)
 * @param {boolean} [opts.chevron] show the › affordance
 * @param {() => void} opts.onClick
 * @returns {HTMLButtonElement}
 */
export function browseRow({ lead = null, name, meta, chevron = false, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'browse-row';
  if (lead) btn.appendChild(lead);
  btn.appendChild(span(name, 'browse-name'));
  if (meta != null) btn.appendChild(span(meta, 'meta'));
  if (chevron) btn.appendChild(span('›', 'browse-chevron'));
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Solid line-colour square used by the train line list.
 * @param {number[]} color rgb triple
 */
export function colorSwatch(color) {
  const sw = document.createElement('span');
  sw.className = 'browse-swatch';
  const rgb = `rgb(${color.join(',')})`;
  sw.style.background = rgb;
  sw.style.color = rgb;
  return sw;
}

/**
 * CTA-style route number badge.
 * @param {string} rt
 * @param {boolean} [small]
 */
export function routeBadge(rt, small = false) {
  return span(rt, `bus-route-badge${small ? ' bus-route-badge-sm' : ''}`);
}

/**
 * The cluster of coloured dots showing which lines serve a station.
 * @param {string[]} lineKeys
 * @param {(key: string) => number[]} lineColor
 * @param {(key: string) => {name?: string}|null} lineDef
 * @param {number} [max] overflow past this collapses into a +N pill
 */
export function lineOrbs(lineKeys, lineColor, lineDef, max = 5) {
  const wrap = document.createElement('span');
  wrap.className = 'line-orbs';
  const keys = lineKeys || [];
  for (const k of keys.slice(0, max)) {
    const orb = document.createElement('span');
    orb.className = 'line-orb';
    orb.style.background = `rgb(${lineColor(k).join(',')})`;
    orb.title = lineDef(k)?.name || k;
    wrap.appendChild(orb);
  }
  if (keys.length > max) wrap.appendChild(span(`+${keys.length - max}`, 'line-orb-more'));
  return wrap;
}

/**
 * Replace a container's children with a single empty-state line.
 * @param {HTMLElement|null} container
 * @param {string} text
 */
export function showEmpty(container, text) {
  if (!container) return;
  container.replaceChildren(emptyState(text));
}
