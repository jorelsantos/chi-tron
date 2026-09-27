/**
 * Pure helpers for exclusive tracker UI surfaces.
 * Surfaces: map (none) | browse | board
 */

/** @typedef {'map'|'browse'|'board'} UiSurface */

/**
 * @param {boolean} browseOpen
 * @param {boolean} boardOpen
 * @returns {UiSurface}
 */
export function activeSurface(browseOpen, boardOpen) {
  if (boardOpen) return 'board';
  if (browseOpen) return 'browse';
  return 'map';
}

/**
 * List FAB: toggle browse from map; close browse if open; if board open,
 * close board and open browse root next (caller applies side effects).
 * @param {UiSurface} surface
 * @returns {'open-browse'|'close-browse'|'board-to-browse'}
 */
export function listFabAction(surface) {
  if (surface === 'browse') return 'close-browse';
  if (surface === 'board') return 'board-to-browse';
  return 'open-browse';
}

/**
 * Search FAB: exclusive search browse; toggle off if already search.
 * @param {UiSurface} surface
 * @param {boolean} browseIsSearch
 * @returns {'open-search'|'close-browse'}
 */
export function searchFabAction(surface, browseIsSearch) {
  if (surface === 'browse' && browseIsSearch) return 'close-browse';
  return 'open-search';
}

/**
 * Map empty-tap / Escape: close top surface only.
 * @param {UiSurface} surface
 * @returns {'close-board'|'close-browse'|'none'}
 */
export function dismissTopAction(surface) {
  if (surface === 'board') return 'close-board';
  if (surface === 'browse') return 'close-browse';
  return 'none';
}

/**
 * Closed dialogs stay out of the tab order. Open dialogs are modal.
 * @param {boolean} isOpen
 * @returns {{ inert: boolean, modal: boolean }}
 */
export function dialogPresence(isOpen) {
  return {
    inert: !isOpen,
    modal: isOpen,
  };
}

/**
 * A bus capsule tap follows that bus. Other hits are not a follow target.
 * @param {{ layerId?: string, id?: string, rt?: string }|null|undefined} hit
 * @returns {{ kind: 'bus', id: string, label: string }|null}
 */
export function followTarget(hit) {
  if (hit?.layerId !== 'bus-capsules' || !hit.id) return null;
  return {
    kind: 'bus',
    id: hit.id,
    label: `${hit.rt} · ${hit.id}`,
  };
}

/**
 * Write `dialogPresence` onto a dialog element.
 * @param {HTMLElement|null|undefined} el
 * @param {boolean} isOpen
 */
export function applyDialogPresence(el, isOpen) {
  if (!el) return;
  const presence = dialogPresence(isOpen);
  if (presence.inert) el.setAttribute('inert', '');
  else el.removeAttribute('inert');
  if (presence.modal) el.setAttribute('aria-modal', 'true');
  else el.removeAttribute('aria-modal');
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Controls inside an open dialog, in tab order.
 * @param {HTMLElement} root
 * @returns {HTMLElement[]}
 */
export function dialogTabbables(root) {
  return [...root.querySelectorAll(TABBABLE)].filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

/**
 * Next control inside a dialog. Tab wraps at either end.
 * @param {HTMLElement} root
 * @param {Element|null} current
 * @param {boolean} backward
 * @returns {HTMLElement|null}
 */
export function dialogTabTarget(root, current, backward) {
  const items = dialogTabbables(root);
  if (!items.length) return null;
  const index = current instanceof HTMLElement ? items.indexOf(current) : -1;
  if (index < 0) return backward ? items[items.length - 1] : items[0];
  const next = index + (backward ? -1 : 1);
  if (next < 0) return items[items.length - 1];
  if (next >= items.length) return items[0];
  return items[next];
}

/**
 * Move focus into a dialog when it is still outside.
 * @param {HTMLElement|null|undefined} el
 */
export function focusOpenDialog(el) {
  if (!el) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && el.contains(active) && active !== el) return;
  dialogTabTarget(el, null, false)?.focus();
}

/**
 * Keep Tab inside an open dialog.
 * @param {KeyboardEvent} event
 * @param {HTMLElement|null|undefined} root
 * @param {boolean} isOpen
 */
export function trapDialogTab(event, root, isOpen) {
  if (event.key !== 'Tab' || !isOpen || !root) return;
  const target = dialogTabTarget(root, document.activeElement, event.shiftKey);
  if (!target) return;
  event.preventDefault();
  target.focus();
}
