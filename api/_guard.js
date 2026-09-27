// Shared request guard for the public CTA proxies (api/tt.js,
// api/arrivals.js, api/bus/[...path].js).
//
// Why this exists: this repo is public and the deployed proxies inject our
// CTA keys server-side. Without a guard, anyone who reads the source can
// point a script at /api/tt and drain the 25k/day self-imposed ceiling — and
// then CTA's real 100k/day cap — on our key. The ledger in src/poller.js
// governs one browser's own usage via localStorage; it is not, and cannot
// be, a server-side control. This module is that control.
//
// Three layers, cheapest check first:
//   1. same-origin — a browser sends `Origin` on cross-origin fetch and
//      `Referer` on same-origin fetch. One of them must resolve to this
//      deployment's own host, or to an explicit ALLOWED_ORIGINS entry. A
//      bare `curl https://…/api/tt` sends neither and is rejected.
//   2. per-IP rate limit — fixed window per client.
//   3. per-instance daily budget — hard stop well under the CTA ceiling.
//
// Honest limitation: layers 2 and 3 hold state in module memory, so they are
// per warm serverless instance, not global across the deployment. They bound
// what one instance can spend and make casual scraping expensive; they are
// not an exact distributed quota. Primary CTA cost control is edge caching
// on /api/tt, /api/arrivals, and /api/bus (see *_CACHE below) — edge hits
// never invoke this function. This budget is defense-in-depth for cache
// misses. For a true global quota, move the counters to Vercel KV / Upstash
// — the call sites here do not change.

/** Requests per IP per window (layer 2). */
export const RATE_LIMIT = 120;
export const RATE_WINDOW_MS = 60_000;

/**
 * Per-name ceilings for one warm instance (layer 3). Train positions,
 * station arrivals, and bus each keep their own ledger. The three numbers
 * sum to 8k, so ~10 instances stay under CTA's 100k/day hard cap. Edge
 * cache still absorbs most viewer traffic.
 * @type {Record<'tt' | 'arrivals' | 'bus', number>}
 */
export const BUDGET_CEILINGS = {
  tt: 5_000,
  arrivals: 1_000,
  bus: 2_000,
};

/** Sum of the three named ceilings. */
export const DAILY_BUDGET =
  BUDGET_CEILINGS.tt + BUDGET_CEILINGS.arrivals + BUDGET_CEILINGS.bus;

/**
 * Edge cache for train positions. Client poll is 5s; one shared window per
 * identical URL pins upstream cost regardless of concurrent viewers.
 * `public` is required for Vercel's CDN to store; max-age=0 keeps the browser
 * revalidating so the map still feels live.
 */
export const TRAIN_POSITIONS_CACHE = 'public, max-age=0, s-maxage=5, stale-while-revalidate=10';

/** Edge cache for station boards (client poll ~20s). */
export const TRAIN_ARRIVALS_CACHE = 'public, max-age=0, s-maxage=15, stale-while-revalidate=20';

/** Edge cache for Divvy GBFS status (client poll 60s, ttl 60). */
export const DIVVY_STATUS_CACHE = 'public, max-age=0, s-maxage=45, stale-while-revalidate=30';

/** Edge cache for bus vehicles. Client poll is 15s. */
export const BUS_VEHICLES_CACHE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=15';

/** Edge cache for bus boards. Client poll is 20s. */
export const BUS_PREDICTIONS_CACHE = 'public, max-age=0, s-maxage=15, stale-while-revalidate=20';

/**
 * Shared-cache header for a bus proxy response. Errors stay uncached so a
 * brief CTA blip does not freeze every viewer for the TTL.
 * @param {string} method getvehicles | getpredictions
 * @param {number} status upstream HTTP status
 * @returns {string}
 */
export function busCacheControl(method, status) {
  if (!(status >= 200 && status < 300)) return 'no-store';
  return String(method || '').toLowerCase() === 'getpredictions'
    ? BUS_PREDICTIONS_CACHE
    : BUS_VEHICLES_CACHE;
}

/**
 * Host of a URL-ish header value, lowercased, or null when unparseable.
 * Origin arrives as `https://host[:port]`; Referer as a full URL.
 * @param {string|undefined|null} value
 * @returns {string|null}
 */
export function hostOf(value) {
  if (!value) return null;
  try {
    return new URL(String(value)).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Hosts this deployment answers for: its own host plus any ALLOWED_ORIGINS
 * entry. Using the request's own host (rather than a hardcoded domain) is
 * what lets Vercel preview deployments work without configuration.
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {string|undefined} allowedOriginsEnv comma-separated origins/hosts
 * @returns {Set<string>}
 */
export function allowedHosts(headers = {}, allowedOriginsEnv = '') {
  const hosts = new Set();
  const self = headers['x-forwarded-host'] || headers.host;
  if (self) hosts.add(String(self).split(',')[0].trim().toLowerCase());
  for (const entry of String(allowedOriginsEnv || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Accept both `https://example.com` and a bare `example.com`.
    hosts.add(hostOf(trimmed) || trimmed.toLowerCase());
  }
  hosts.delete('');
  return hosts;
}

/**
 * True when the request carries browser provenance pointing at a host we
 * serve. Absent every signal we reject: the only legitimate caller of these
 * proxies is our own page running in a browser.
 *
 * `Sec-Fetch-Site: same-origin` is checked first and on its own. It is a
 * forbidden header name, so page JavaScript cannot set it, and — unlike
 * Referer — it survives a strict referrer policy or a privacy extension
 * that strips referrers. Without it, a user browsing with referrers off
 * would see the whole app fail closed.
 *
 * None of these headers is unforgeable by a non-browser client (curl can
 * send any of them). That is expected: this layer stops casual scraping and
 * cross-origin embedding cheaply, and the rate limit plus daily budget
 * bound what a determined caller can spend.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {string|undefined} allowedOriginsEnv
 * @returns {boolean}
 */
export function isSameOrigin(headers = {}, allowedOriginsEnv = '') {
  if (headers['sec-fetch-site'] === 'same-origin') return true;
  const hosts = allowedHosts(headers, allowedOriginsEnv);
  if (!hosts.size) return false;
  const origin = hostOf(headers.origin);
  if (origin) return hosts.has(origin);
  const referer = hostOf(headers.referer || headers.referrer);
  if (referer) return hosts.has(referer);
  return false;
}

/**
 * Client address, preferring the left-most entry of x-forwarded-for (the
 * original client; entries to its right are proxies).
 * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string}}} req
 * @returns {string}
 */
export function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req?.headers?.['x-real-ip'] || req?.socket?.remoteAddress || 'unknown';
}

/**
 * Fixed-window rate limiter. Exported as a factory so tests drive their own
 * clock and their own isolated state instead of the module-level singleton.
 * @param {{limit?: number, windowMs?: number, now?: () => number}} [opts]
 */
export function createRateLimiter({
  limit = RATE_LIMIT,
  windowMs = RATE_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const buckets = new Map();
  return {
    /**
     * Counts one request against `key`.
     * @param {string} key
     * @returns {{ok: boolean, retryAfterMs: number}}
     */
    check(key) {
      const t = now();
      // Bound memory on a long-lived warm instance: drop expired buckets
      // before adding a new one, so a scan of many distinct IPs cannot grow
      // the map without limit.
      if (buckets.size > 5000) {
        for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return { ok: true, retryAfterMs: 0 };
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        return { ok: false, retryAfterMs: Math.max(0, bucket.resetAt - t) };
      }
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

/**
 * Per-local-day counter that mirrors src/poller.js's ledger shape, so both
 * sides of the budget story read the same way. Resets when the date stamp
 * changes rather than on a rolling 24h window.
 * @param {{ceiling?: number, now?: () => number}} [opts]
 */
export function createDailyBudget({ ceiling = DAILY_BUDGET, now = () => Date.now() } = {}) {
  let stamp = '';
  let count = 0;
  const dateStamp = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    /**
     * Reserves one upstream request.
     * @returns {boolean} false once today's ceiling is met.
     */
    consume() {
      const today = dateStamp(now());
      if (today !== stamp) {
        stamp = today;
        count = 0;
      }
      if (count >= ceiling) return false;
      count += 1;
      return true;
    },
    /** @returns {number} today's count (test/observability helper). */
    used() {
      return dateStamp(now()) === stamp ? count : 0;
    },
  };
}

/**
 * Three lazy ledgers on one warm instance. A name is created on first use.
 * @param {{ now?: () => number }} [opts]
 */
export function createNamedBudgets({ now = () => Date.now() } = {}) {
  /** @type {Partial<Record<'tt' | 'arrivals' | 'bus', ReturnType<typeof createDailyBudget>>>} */
  const slots = {};
  /**
   * @param {'tt' | 'arrivals' | 'bus'} name
   */
  function slot(name) {
    if (!slots[name]) {
      slots[name] = createDailyBudget({ ceiling: BUDGET_CEILINGS[name], now });
    }
    return slots[name];
  }
  return {
    /**
     * @param {'tt' | 'arrivals' | 'bus'} name
     * @returns {boolean}
     */
    consume(name) {
      return slot(name).consume();
    },
    /**
     * @param {'tt' | 'arrivals' | 'bus'} name
     * @returns {number}
     */
    used(name) {
      return slots[name] ? slots[name].used() : 0;
    },
  };
}

// One limiter and one named-budget set per warm instance. The three ceilings
// are independent. Their sum is DAILY_BUDGET.
const limiter = createRateLimiter();
const budgets = createNamedBudgets();

/**
 * True for the query parameter Vercel adds to describe a catch-all route's
 * matched segment.
 *
 * This exists because of a production bug. Vercel rewrites
 * `/api/alerts/routes.aspx` internally and appends the matched segment to the
 * query string — named `...path` for a `[...path].js` file, dots included,
 * not `path`. Both proxies skipped the literal `'path'`, so the real
 * parameter sailed through to the upstream API. CTA's Bus Tracker ignores
 * unknown parameters and hid the bug; CTA's Alerts API validates them and
 * answered `Invalid parameter: '...path'`.
 *
 * Matching on the suffix covers a rename of the file's `[...x]` slug too.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isRouteParam(key) {
  return key === 'path' || /^\.{3}/.test(key);
}

/**
 * Bus Tracker v3 methods the client is allowed to reach. Only these two are
 * called from the browser (src/buses.js, src/bus-arrivals.js); the catalog
 * bake in scripts/build-patterns.mjs talks to CTA directly with its own key
 * and never goes through this proxy, so it needs no entry here.
 *
 * This allowlist is also what closes the path-injection hole: the method is
 * interpolated into the upstream URL, so `../../foo` previously escaped the
 * `/bustime/api/v3/` prefix and reached other paths on ctabustracker.com.
 * An exact-match check makes traversal unrepresentable rather than merely
 * sanitized.
 */
export const BUS_METHODS = new Set(['getvehicles', 'getpredictions']);

/**
 * @param {string} method path segment after /api/bus/
 * @returns {boolean}
 */
export function isAllowedBusMethod(method) {
  return BUS_METHODS.has(String(method || '').toLowerCase());
}

/**
 * Runs all three layers and writes the rejection response itself.
 * @param {any} req
 * @param {any} res
 * @param {{ metered?: boolean, budget?: 'tt' | 'arrivals' | 'bus' }} [opts]
 * @returns {boolean} true when the caller should proceed to fetch upstream.
 */
export function guardRequest(req, res, { metered = true, budget = 'tt' } = {}) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method not allowed' });
    return false;
  }
  if (!isSameOrigin(req.headers || {}, process.env.ALLOWED_ORIGINS)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  const { ok, retryAfterMs } = limiter.check(clientIp(req));
  if (!ok) {
    res.setHeader('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({ error: 'rate limited' });
    return false;
  }
  // Keyless upstreams (CTA's Customer Alerts API) pass metered:false. They
  // still need the origin and rate-limit layers, because this function is
  // ours and should not become a general-purpose relay. They must not draw
  // down a named budget. Those ceilings protect the keyed tt, arrivals, and
  // bus proxies, and a 2-minute alerts poll would eat one for no reason.
  // The bus proxy also passes metered:false, then calls consumeBudget(res, 'bus')
  // only after its method allowlist. A rejected method must not spend a unit.
  if (metered && !consumeBudget(res, budget)) return false;
  return true;
}

/**
 * Reserves one unit of a named daily budget. Writes 503 when that ceiling
 * is met. Defaults to the bus budget. The bus proxy calls this only after
 * its method allowlist.
 * @param {any} res
 * @param {'tt' | 'arrivals' | 'bus'} [name]
 * @returns {boolean} true when the caller should fetch upstream
 */
export function consumeBudget(res, name = 'bus') {
  if (!budgets.consume(name)) {
    res.status(503).json({ error: 'daily budget reached' });
    return false;
  }
  return true;
}

/**
 * @param {'tt' | 'arrivals' | 'bus'} [name]
 * @returns {number} units spent from that named budget today. Defaults to bus.
 */
export function used(name = 'bus') {
  return budgets.used(name);
}
