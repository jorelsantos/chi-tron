import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { guardRequest } from './_guard.js';
import busHandler from './bus/[...path].js';
import ttHandler from './tt.js';

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
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '{"ok":true}',
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

  it('blocks an unauthorized caller before it ever touches CTA', async () => {
    const req = browserReq();
    delete req.headers.referer;
    const res = mockRes();
    await ttHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
