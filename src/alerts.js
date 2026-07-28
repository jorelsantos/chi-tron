// Service status as light (U15, R12): CTA's two keyless Customer Alerts
// endpoints, polled through the U14 governor every 120s. No key means no
// ledger cost (KTD10 only protects keyed feeds) -- but the same visibility
// gate and single-flight guard still apply, per U15 step 1.
//
// Route Status (`routes.aspx?type=rail`) gives each line's current
// RouteStatus. Per CTA's own developer PDF, this is undocumented free text
// ("described in text (Normal service, Planned work, Minor delays, etc.)")
// -- there is no fixed enum -- so classifyRouteStatus() below buckets it by
// keyword rather than exact match, with an unrecognized value falling
// through to 'normal' rather than throwing.
//
// Detailed Alerts (`alerts.aspx?activeonly=true&accessibility=true`) gives
// per-alert detail: which lines it affects (for the sidebar headline) and
// which stations (for the accessibility glyph). The PDF's own Response
// Fields table names "Accessibility Status" as an example `Impact` string,
// which is the signal isAccessibilityAlert() keys off.

import { Poller } from './poller.js';

const POLL_MS = 120000;

const STATUS_RULES = [
  { tag: 'added', test: (s) => /added/i.test(s) },
  { tag: 'planned', test: (s) => /planned|scheduled/i.test(s) },
  { tag: 'normal', test: (s) => /normal/i.test(s) },
  // Everything else CTA might set (delay, detour, suspended, not in
  // service, slow zone, residual delay, service change, reroute, ...)
  // reads as an active incident -- intentionally no regex here, since
  // "not normal, not planned, not added" already means exactly that.
  { tag: 'incident', test: () => true },
];

/** Classifies a RouteStatus string into one of U15 step 2's four treatment
 * tags. Never throws; an empty/missing/unrecognized status reads as
 * 'normal'. Pure and exported for direct testing. */
export function classifyRouteStatus(status) {
  const s = String(status ?? '').trim();
  if (!s) return 'normal';
  for (const rule of STATUS_RULES) {
    if (rule.test(s)) return rule.tag;
  }
  return 'normal'; // unreachable (the last rule always matches) -- kept as the documented fallback
}

/** True if a Detailed Alert's `Impact` text marks it as an accessibility/
 * elevator alert. Pure and exported for direct testing. */
export function isAccessibilityAlert(impact) {
  return /accessib|elevator/i.test(String(impact ?? ''));
}

// Coerces CTA's documented "may be a single object or an array" JSON shape
// (seen throughout both APIs whenever exactly one item is returned) into an
// array, mirroring trains.js's `[].concat(routes)` idiom for the same
// documented ambiguity.
function asList(maybeOneOrMany) {
  if (Array.isArray(maybeOneOrMany)) return maybeOneOrMany;
  return maybeOneOrMany ? [maybeOneOrMany] : [];
}

export class AlertsEngine {
  constructor() {
    this.lineStatus = {}; // ServiceId (line key, e.g. 'Red') -> classification tag
    this.lineHeadline = {}; // ServiceId -> headline of its highest-severity active alert
    this.stationFlags = new Set(); // station ids (GTFS 4xxxx, matches stations.json's keys) with an active accessibility alert
    this.onStatus = () => {};
  }

  startLive() {
    this.poller = new Poller({
      intervalMs: POLL_MS,
      fetchFn: () => this.#pollOnce(),
      onStatus: (status, err) => this.#handlePollStatus(status, err),
    });
    this.poller.start();
  }

  stop() {
    this.poller?.stop();
  }

  async #pollOnce() {
    const [routesRes, alertsRes] = await Promise.all([
      fetch('/api/alerts/routes.aspx?type=rail&outputType=JSON'),
      fetch('/api/alerts/alerts.aspx?activeonly=true&accessibility=true&outputType=JSON'),
    ]);
    if (!routesRes.ok) throw new Error(`HTTP ${routesRes.status} (routes)`);
    if (!alertsRes.ok) throw new Error(`HTTP ${alertsRes.status} (alerts)`);
    const [routesData, alertsData] = await Promise.all([routesRes.json(), alertsRes.json()]);
    this.ingestRoutes(routesData);
    this.ingestAlerts(alertsData);
  }

  #handlePollStatus(status, err) {
    if (status === 'error') console.warn('[chi-tron] alerts poll failed:', err.message);
    this.onStatus(status);
  }

  /** Applies a Route Status API payload. Every rail line is present in
   * every well-formed response (this always polls `type=rail` with no
   * `routeid` filter), so a line simply isn't re-written on a bad poll --
   * there's no separate "clear stale entries" step needed. A malformed
   * payload (no RouteInfo at all) leaves the previous lineStatus intact.
   * Public (unlike trains.js's private #ingest) so alerts.test.js can drive
   * it directly. */
  ingestRoutes(data) {
    const list = asList(data?.CTARoutes?.RouteInfo);
    if (list.length === 0) return;
    for (const r of list) {
      if (!r?.ServiceId) continue;
      this.lineStatus[r.ServiceId] = classifyRouteStatus(r.RouteStatus);
    }
  }

  /** Applies a Detailed Alerts API payload: rebuilds stationFlags and
   * lineHeadline from scratch each poll (both can legitimately clear, e.g.
   * an elevator alert resolving) -- but only once the payload's root
   * container is confirmed present. A response with a genuinely empty
   * `Alert` list (CTA's documented "no active alerts" case) is a valid
   * signal that everything has cleared; a response missing `CTAAlerts`
   * entirely is what a malformed/broken body looks like, and leaves the
   * previous stationFlags/lineHeadline untouched instead. */
  ingestAlerts(data) {
    if (!data?.CTAAlerts) return;
    const flags = new Set();
    const bestByLine = {}; // ServiceId -> { severity, headline }
    for (const alert of asList(data.CTAAlerts.Alert)) {
      const services = asList(alert?.ImpactedService?.Service);
      const isAccessibility = isAccessibilityAlert(alert?.Impact);
      const severity = Number(alert?.SeverityScore) || 0;
      for (const svc of services) {
        if (svc?.ServiceType === 'T' && svc?.ServiceId && isAccessibility) {
          flags.add(String(svc.ServiceId));
        }
        if (svc?.ServiceType === 'R' && svc?.ServiceId) {
          const prev = bestByLine[svc.ServiceId];
          if (!prev || severity > prev.severity) {
            bestByLine[svc.ServiceId] = { severity, headline: alert?.Headline ?? '' };
          }
        }
      }
    }
    this.stationFlags = flags;
    this.lineHeadline = Object.fromEntries(
      Object.entries(bestByLine).map(([lineKey, v]) => [lineKey, v.headline])
    );
  }
}
