import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { guardRequest } from './_guard.js';
import busHandler from './bus/[...path].js';
import ttHandler from './tt.js';
import alertsHandler, { isAllowedAlertEndpoint } from './alerts/[...path].js';
import divvyHandler, {
  isAllowedDivvyEndpoint,
  resolveFeedUrl,
  DISCOVERY_URL,
  FALLBACK_BASE,
} from './divvy/[...path].js';

const DISCOVERY_DOC = {
  data: {
    en: {
      feeds: [
        {
          name: 'station_status',
          url: 'https://gbfs.lyft.com/gbfs/1.1/chi/en/station_status.json',
        },
        {
          name: 'station_information',
          url: 'https://gbfs.lyft.com/gbfs/1.1/chi/en/station_information.json',
        },
      ],
    },
  },
};

/** Minimal Vercel-style res double that records what the handler wrote. */
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    send(payload) {
      res.body = payload;
      return res;
    },
    setHeader(k, v) {
      res.headers[k.toLowerCase()] = v;
      return res;
    },
  };
  return res;
}

const HOST = 'chi-tron.vercel.app';

/**
 * A request that looks like our own page. Each test gets a unique IP so the
 * module-level rate limiter cannot leak state between tests.
 */
let ipCounter = 0;
function browserReq(overrides = {}) {
  ipCounter += 1;
  return {
    method: 'GET',
    url: '/api/tt?rt=Org',
    headers: {
      host: HOST,
      referer: `https://${HOST}/`,
      'x-forwarded-for': `203.0.113.${ipCounter}`,
      ...overrides.headers,
    },
    ...overrides,
  };
}

let fetchSpy;
beforeEach(() => {
  process.env.CTA_KEY = 'test-train-key';
  process.env.CTA_BUS_KEY = 'test-bus-key';
  delete process.env.ALLOWED_ORIGINS;
  resolveFeedUrl._cache = { urls: {}, until: 0 };
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const href = String(url);
    if (href === DISCOVERY_URL || href.includes('gbfs.json')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(DISCOVERY_DOC),
        json: async () => DISCOVERY_DOC,
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"ok":true}',
      json: async () => ({ ok: true }),
    };
  });
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe('guardRequest', () => {
  it('lets our own page through', () => {
    const res = mockRes();
    expect(guardRequest(browserReq(), res)).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('rejects a bare curl with 403 — this is the quota-drain case', () => {
    const res = mockRes();
    const req = browserReq();
    delete req.headers.referer;
    expect(guardRequest(req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('rejects another origin hotlinking the proxy', () => {
    const res = mockRes();
    expect(guardRequest(browserReq({ headers: { origin: 'https://evil.example' } }), res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('rejects non-GET methods', () => {
    const res = mockRes();
    expect(guardRequest(browserReq({ method: 'POST' }), res)).toBe(false);
    expect(res.statusCode).toBe(405);
  });

  it('rate limits a single IP and sets retry-after', () => {
    const req = browserReq();
    let res;
    // The shared limiter allows 120/min; the 121st from one IP must fail.
    for (let i = 0; i < 120; i++) {
      res = mockRes();
      expect(guardRequest({ ...req }, res)).toBe(true);
    }
    res = mockRes();
    expect(guardRequest({ ...req }, res)).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('does not penalize a different IP for a noisy neighbour', () => {
    const noisy = browserReq();
    for (let i = 0; i < 130; i++) guardRequest({ ...noisy }, mockRes());
    const res = mockRes();
    expect(guardRequest(browserReq(), res)).toBe(true);
  });
});

describe('bus proxy handler', () => {
  it('forwards an allowed method and injects the key server-side', async () => {
    const res = mockRes();
    await busHandler(
      browserReq({ url: '/api/bus/getvehicles?rt=8', query: { path: 'getvehicles', rt: '8' } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const target = fetchSpy.mock.calls[0][0];
    expect(target).toContain('/bustime/api/v3/getvehicles');
    expect(target).toContain('key=test-bus-key');
  });

  it('never lets the key reach the response body or headers', async () => {
    const res = mockRes();
    await busHandler(browserReq({ url: '/api/bus/getvehicles', query: { path: 'getvehicles' } }), res);
    expect(JSON.stringify(res.body)).not.toContain('test-bus-key');
    expect(JSON.stringify(res.headers)).not.toContain('test-bus-key');
  });

  it('rejects path traversal instead of reaching another upstream path', async () => {
    const res = mockRes();
    await busHandler(
      browserReq({ url: '/api/bus/../../admin', query: { path: ['..', '..', 'admin'] } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects v3 methods the browser never needs', async () => {
    const res = mockRes();
    await busHandler(browserReq({ url: '/api/bus/getpatterns', query: { path: 'getpatterns' } }), res);
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks an unauthorized caller before it ever touches CTA', async () => {
    const req = browserReq({ url: '/api/bus/getvehicles', query: { path: 'getvehicles' } });
    delete req.headers.referer;
    const res = mockRes();
    await busHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('alerts proxy handler', () => {
  it('allows exactly the two endpoints src/alerts.js calls', () => {
    expect(isAllowedAlertEndpoint('routes.aspx')).toBe(true);
    expect(isAllowedAlertEndpoint('alerts.aspx')).toBe(true);
    expect(isAllowedAlertEndpoint('../../etc')).toBe(false);
    expect(isAllowedAlertEndpoint('')).toBe(false);
  });

  it('forwards a nested path — the flat-file routing trap this replaces', async () => {
    const res = mockRes();
    await alertsHandler(
      browserReq({
        url: '/api/alerts/routes.aspx?type=rail&outputType=JSON',
        query: { path: 'routes.aspx', type: 'rail' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const target = fetchSpy.mock.calls[0][0];
    expect(target).toContain('/api/1.0/routes.aspx');
    expect(target).toContain('type=rail');
  });

  // Regression: this shipped broken. Vercel rewrites a catch-all request and
  // appends the matched segment to the query string as `...path` — with the
  // dots. The handler skipped the literal 'path', so `...path` reached CTA,
  // which answered `Invalid parameter: '...path'`. The original test used a
  // hand-written URL with no such param, so it passed while production failed.
  // These two use the URL shape Vercel actually produces.
  it('strips the ...path param Vercel appends for a catch-all route', async () => {
    const res = mockRes();
    await alertsHandler(
      browserReq({
        url: '/api/alerts/routes.aspx?type=rail&...path=routes.aspx',
        query: { '...path': 'routes.aspx', type: 'rail' },
      }),
      res,
    );
    const target = fetchSpy.mock.calls[0][0];
    expect(target).not.toContain('path');
    expect(target).toContain('type=rail');
  });

  it('resolves the endpoint from the ...path query key', async () => {
    const res = mockRes();
    await alertsHandler(
      browserReq({
        url: '/api/alerts/alerts.aspx?...path=alerts.aspx',
        query: { '...path': 'alerts.aspx' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/1.0/alerts.aspx');
  });

  it('rejects an endpoint outside the allowlist', async () => {
    const res = mockRes();
    await alertsHandler(browserReq({ url: '/api/alerts/x', query: { path: 'x' } }), res);
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still refuses a caller that is not our page', async () => {
    const req = browserReq({ url: '/api/alerts/routes.aspx', query: { path: 'routes.aspx' } });
    delete req.headers.referer;
    const res = mockRes();
    await alertsHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sets a shared cache header so one poll serves every viewer', async () => {
    const res = mockRes();
    await alertsHandler(
      browserReq({ url: '/api/alerts/routes.aspx', query: { path: 'routes.aspx' } }),
      res,
    );
    expect(res.headers['cache-control']).toContain('s-maxage=60');
  });
});

describe('divvy proxy handler', () => {
  it('allows exactly station_status and station_information', () => {
    expect(isAllowedDivvyEndpoint('station_status.json')).toBe(true);
    expect(isAllowedDivvyEndpoint('station_information.json')).toBe(true);
    expect(isAllowedDivvyEndpoint('free_bike_status.json')).toBe(false);
    expect(isAllowedDivvyEndpoint('../../etc')).toBe(false);
    expect(isAllowedDivvyEndpoint('')).toBe(false);
  });

  it('forwards a nested path to Lyft GBFS', async () => {
    const res = mockRes();
    await divvyHandler(
      browserReq({
        url: '/api/divvy/station_status.json',
        query: { path: 'station_status.json' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u === DISCOVERY_URL)).toBe(true);
    expect(urls.some((u) => u.includes('gbfs/1.1/chi/en/station_status.json'))).toBe(true);
  });

  it('strips the ...path param Vercel appends for a catch-all route', async () => {
    const res = mockRes();
    await divvyHandler(
      browserReq({
        url: '/api/divvy/station_status.json?...path=station_status.json',
        query: { '...path': 'station_status.json' },
      }),
      res,
    );
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => !u.includes('...path') && !u.includes('path='))).toBe(true);
    expect(urls.some((u) => u.endsWith('station_status.json'))).toBe(true);
  });

  it('rejects an endpoint outside the allowlist', async () => {
    const res = mockRes();
    await divvyHandler(
      browserReq({ url: '/api/divvy/x', query: { path: 'x' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still refuses a caller that is not our page', async () => {
    const req = browserReq({
      url: '/api/divvy/station_status.json',
      query: { path: 'station_status.json' },
    });
    delete req.headers.referer;
    const res = mockRes();
    await divvyHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sets s-maxage=45 shared cache on 200', async () => {
    const res = mockRes();
    await divvyHandler(
      browserReq({
        url: '/api/divvy/station_status.json',
        query: { path: 'station_status.json' },
      }),
      res,
    );
    expect(res.headers['cache-control']).toContain('s-maxage=45');
  });

  it('does not cache upstream errors', async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url) === DISCOVERY_URL) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify(DISCOVERY_DOC),
          json: async () => DISCOVERY_DOC,
        };
      }
      return {
        ok: false,
        status: 502,
        headers: { get: () => 'application/json' },
        text: async () => '{"error":"up"}',
        json: async () => ({ error: 'up' }),
      };
    });
    const res = mockRes();
    await divvyHandler(
      browserReq({
        url: '/api/divvy/station_status.json',
        query: { path: 'station_status.json' },
      }),
      res,
    );
    expect(res.statusCode).toBe(502);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('resolveFeedUrl caches discovery within TTL', async () => {
    const cache = { urls: {}, until: 0 };
    const a = await resolveFeedUrl('station_status.json', { fetchImpl: fetch, cache, now: () => 1_000 });
    const b = await resolveFeedUrl('station_status.json', { fetchImpl: fetch, cache, now: () => 2_000 });
    expect(a).toBe('https://gbfs.lyft.com/gbfs/1.1/chi/en/station_status.json');
    expect(b).toBe(a);
    const discCalls = fetchSpy.mock.calls.filter((c) => String(c[0]) === DISCOVERY_URL);
    expect(discCalls).toHaveLength(1);
  });

  it('rejects a discovered host outside the allowlist', async () => {
    const cache = { urls: {}, until: 0 };
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        data: {
          en: {
            feeds: [{ name: 'station_status', url: 'https://evil.example.com/status.json' }],
          },
        },
      }),
      text: async () => '{}',
    }));
    const url = await resolveFeedUrl('station_status.json', { fetchImpl: fetch, cache, now: () => 1 });
    expect(url).toBe(`${FALLBACK_BASE}/station_status.json`);
    expect(url).not.toContain('evil');
  });
});

describe('train positions handler', () => {
  it('forwards to ttpositions with the key appended', async () => {
    const res = mockRes();
    await ttHandler(browserReq({ url: '/api/tt?rt=Org,Red' }), res);
    expect(res.statusCode).toBe(200);
    const target = fetchSpy.mock.calls[0][0];
    expect(target).toContain('ttpositions.aspx');
    expect(target).toContain('rt=Org%2CRed');
    expect(target).toContain('key=test-train-key');
  });

  it('ignores a client-supplied key parameter', async () => {
    const res = mockRes();
    await ttHandler(browserReq({ url: '/api/tt?rt=Org&key=attacker' }), res);
    const target = fetchSpy.mock.calls[0][0];
    expect(target).toContain('key=test-train-key');
    expect(target).not.toContain('attacker');
  });

  it('sets a short shared cache so concurrent viewers collapse to one upstream', async () => {
    const res = mockRes();
    await ttHandler(browserReq({ url: '/api/tt?rt=Org' }), res);
    expect(res.headers['cache-control']).toContain('s-maxage=5');
    expect(res.headers['cache-control']).toContain('stale-while-revalidate');
  });

  it('does not cache upstream errors', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: { get: () => 'application/json' },
      text: async () => '{"error":"up"}',
    });
    const res = mockRes();
    await ttHandler(browserReq({ url: '/api/tt?rt=Org' }), res);
    expect(res.statusCode).toBe(502);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('blocks an unauthorized caller before it ever touches CTA', async () => {
    const req = browserReq();
    delete req.headers.referer;
    const res = mockRes();
    await ttHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('train arrivals handler', () => {
  it('sets a shared board cache on success', async () => {
    const { default: arrivalsHandler } = await import('./arrivals.js');
    const res = mockRes();
    await arrivalsHandler(browserReq({ url: '/api/arrivals?mapid=41400&outputType=JSON' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('s-maxage=15');
  });
});
