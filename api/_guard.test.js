import { describe, it, expect } from 'vitest';
import {
  hostOf,
  allowedHosts,
  isSameOrigin,
  clientIp,
  createRateLimiter,
  createDailyBudget,
  isAllowedBusMethod,
  isRouteParam,
} from './_guard.js';

describe('hostOf', () => {
  it('reads the host from an Origin value', () => {
    expect(hostOf('https://chi-tron.vercel.app')).toBe('chi-tron.vercel.app');
  });

  it('reads the host from a full Referer URL', () => {
    expect(hostOf('https://chi-tron.vercel.app/?x=1#f')).toBe('chi-tron.vercel.app');
  });

  it('keeps the port, since host:port is a distinct origin', () => {
    expect(hostOf('http://localhost:5173/')).toBe('localhost:5173');
  });

  it('returns null for missing or unparseable values', () => {
    expect(hostOf(undefined)).toBeNull();
    expect(hostOf('')).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('allowedHosts', () => {
  it('always includes the deployment host the request arrived on', () => {
    expect(allowedHosts({ host: 'chi-tron.vercel.app' })).toContain('chi-tron.vercel.app');
  });

  it('prefers x-forwarded-host so preview deployments self-authorize', () => {
    const hosts = allowedHosts({ host: 'internal', 'x-forwarded-host': 'preview-abc.vercel.app' });
    expect(hosts).toContain('preview-abc.vercel.app');
    expect(hosts).not.toContain('internal');
  });

  it('accepts extra origins in either full-URL or bare-host form', () => {
    const hosts = allowedHosts({ host: 'a.app' }, 'https://b.app, c.app');
    expect(hosts).toContain('b.app');
    expect(hosts).toContain('c.app');
  });

  it('ignores empty entries in the env list', () => {
    const hosts = allowedHosts({ host: 'a.app' }, ' , ,');
    expect([...hosts]).toEqual(['a.app']);
  });
});

describe('isSameOrigin', () => {
  const host = 'chi-tron.vercel.app';

  it('accepts a same-origin fetch identified by Referer', () => {
    expect(isSameOrigin({ host, referer: `https://${host}/` })).toBe(true);
  });

  it('accepts Sec-Fetch-Site alone, so referrer-stripping users still work', () => {
    expect(isSameOrigin({ host, 'sec-fetch-site': 'same-origin' })).toBe(true);
  });

  it('rejects a bare request carrying no browser provenance at all', () => {
    expect(isSameOrigin({ host })).toBe(false);
  });

  it('rejects another site hotlinking the proxy', () => {
    expect(isSameOrigin({ host, origin: 'https://evil.example' })).toBe(false);
    expect(isSameOrigin({ host, referer: 'https://evil.example/page' })).toBe(false);
  });

  it('does not fall back to Referer when Origin is present and wrong', () => {
    // A cross-origin request may carry both; the stricter Origin decides.
    const headers = { host, origin: 'https://evil.example', referer: `https://${host}/` };
    expect(isSameOrigin(headers)).toBe(false);
  });

  it('accepts an explicitly configured extra origin', () => {
    expect(isSameOrigin({ host, origin: 'https://chi-tron.io' }, 'https://chi-tron.io')).toBe(true);
  });

  it('rejects when the deployment host header is missing entirely', () => {
    expect(isSameOrigin({ referer: 'https://anything/' })).toBe(false);
  });
});

describe('clientIp', () => {
  it('takes the left-most x-forwarded-for entry (the real client)', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } })).toBe('9.9.9.9');
  });

  it('falls back to x-real-ip, then the socket address', () => {
    expect(clientIp({ headers: { 'x-real-ip': '8.8.8.8' } })).toBe('8.8.8.8');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '7.7.7.7' } })).toBe('7.7.7.7');
  });

  it('never throws on a malformed request object', () => {
    expect(clientIp({})).toBe('unknown');
    expect(clientIp(undefined)).toBe('unknown');
  });
});

describe('createRateLimiter', () => {
  it('allows up to the limit, then rejects within the same window', () => {
    const t = 0; // clock held still: all four calls land in one window
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    expect(rl.check('ip').ok).toBe(true);
    expect(rl.check('ip').ok).toBe(true);
    expect(rl.check('ip').ok).toBe(true);
    expect(rl.check('ip').ok).toBe(false);
  });

  it('reports how long the caller must wait', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    rl.check('ip');
    t = 400;
    expect(rl.check('ip').retryAfterMs).toBe(600);
  });

  it('resets once the window elapses', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.check('ip').ok).toBe(true);
    expect(rl.check('ip').ok).toBe(false);
    t = 1000;
    expect(rl.check('ip').ok).toBe(true);
  });

  it('keeps separate budgets per client', () => {
    const t = 0; // clock held still: both clients share one window
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('b').ok).toBe(true);
    expect(rl.check('a').ok).toBe(false);
  });

  it('prunes expired buckets so a wide IP scan cannot grow memory forever', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    for (let i = 0; i < 5001; i++) rl.check(`ip-${i}`);
    t = 5000; // every bucket above is now expired
    rl.check('trigger-prune');
    // The survivor is still rate limited on its own terms.
    expect(rl.check('trigger-prune').ok).toBe(false);
  });
});

describe('createDailyBudget', () => {
  it('allows requests up to the ceiling and refuses past it', () => {
    const b = createDailyBudget({ ceiling: 2, now: () => 0 });
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(false);
  });

  it('resets when the calendar date rolls over', () => {
    let t = Date.parse('2026-08-11T23:59:00Z');
    const b = createDailyBudget({ ceiling: 1, now: () => t });
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(false);
    t = Date.parse('2026-08-12T00:01:00Z');
    expect(b.consume()).toBe(true);
  });

  it('reports today count, and zero after the date changes', () => {
    let t = Date.parse('2026-08-11T10:00:00Z');
    const b = createDailyBudget({ ceiling: 5, now: () => t });
    b.consume();
    b.consume();
    expect(b.used()).toBe(2);
    t = Date.parse('2026-08-12T10:00:00Z');
    expect(b.used()).toBe(0);
  });
});

describe('isRouteParam', () => {
  it('matches the ...path key Vercel appends for [...path].js', () => {
    expect(isRouteParam('...path')).toBe(true);
  });

  it('matches a renamed catch-all slug', () => {
    expect(isRouteParam('...slug')).toBe(true);
  });

  it('still matches the plain path key', () => {
    expect(isRouteParam('path')).toBe(true);
  });

  it('leaves real upstream parameters alone', () => {
    for (const k of ['rt', 'type', 'outputType', 'activeonly', 'stpid', 'pathfinder']) {
      expect(isRouteParam(k)).toBe(false);
    }
  });
});

describe('isAllowedBusMethod', () => {
  it('allows exactly the two methods the client calls', () => {
    expect(isAllowedBusMethod('getvehicles')).toBe(true);
    expect(isAllowedBusMethod('getpredictions')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowedBusMethod('GetVehicles')).toBe(true);
  });

  it('rejects path traversal out of the v3 prefix', () => {
    expect(isAllowedBusMethod('../../../etc')).toBe(false);
    expect(isAllowedBusMethod('..%2f..%2fadmin')).toBe(false);
    expect(isAllowedBusMethod('getvehicles/../getroutes')).toBe(false);
  });

  it('rejects other real v3 methods that the browser never needs', () => {
    expect(isAllowedBusMethod('getpatterns')).toBe(false);
    expect(isAllowedBusMethod('getstops')).toBe(false);
  });

  it('rejects empty and missing values', () => {
    expect(isAllowedBusMethod('')).toBe(false);
    expect(isAllowedBusMethod(undefined)).toBe(false);
  });
});
