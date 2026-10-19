import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

describe('spendLimit middleware', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RATE_LIMIT_SPEND = '2';
  });

  it('allows requests within the rate limit', async () => {
    const { spendLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.get('/test', spendLimit, (req, res) => res.json({ ok: true }));

    const res1 = await request(app).get('/test?token=aaa');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/test?token=aaa');
    expect(res2.status).toBe(200);
  });

  it('blocks requests that exceed the rate limit', async () => {
    process.env.RATE_LIMIT_SPEND = '1';
    const { spendLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.get('/test', spendLimit, (req, res) => res.json({ ok: true }));

    const res1 = await request(app).get('/test?token=bbb');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/test?token=bbb');
    expect(res2.status).toBe(429);
    expect(res2.body.error).toBe('Too many requests, please slow down.');
  });
});

describe('authLimit middleware', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RATE_LIMIT_AUTH = '2';
  });

  it('uses IP-based keying for auth endpoints', async () => {
    const { authLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.post('/auth', authLimit, (_req, res) => res.json({ ok: true }));

    const res = await request(app).post('/auth');
    expect(res.status).toBe(200);
  });
});

describe('metricsLimit middleware', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RATE_LIMIT_METRICS = '2';
  });

  it('uses IP-based keying for metrics endpoints', async () => {
    const { metricsLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.get('/metrics', metricsLimit, (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });
});

describe('apiLimit middleware (#140)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RATE_LIMIT_API = '1';
  });

  /** An app behind `hops` proxies, like Caddy -> nginx -> Express on staging. */
  async function appBehind(hops: number) {
    const { apiLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.set('trust proxy', hops);
    app.use('/api', apiLimit);
    app.get('/api/x', (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  // Caddy appends the client; nginx appends Caddy. Express sees nginx as the peer.
  const viaCaddy = (client: string) => `${client}, 172.18.0.5`;

  it('gives each client behind two proxies its own bucket when TRUST_PROXY=2', async () => {
    const app = await appBehind(2);
    const a1 = await request(app).get('/api/x').set('X-Forwarded-For', viaCaddy('203.0.113.1'));
    expect(a1.status).toBe(200);
    expect(a1.body.ip).toBe('203.0.113.1');
    const b1 = await request(app).get('/api/x').set('X-Forwarded-For', viaCaddy('203.0.113.2'));
    expect(b1.status).toBe(200);
    const a2 = await request(app).get('/api/x').set('X-Forwarded-For', viaCaddy('203.0.113.1'));
    expect(a2.status).toBe(429);
  });

  it('shares one bucket between clients when TRUST_PROXY is one hop too low (the bug)', async () => {
    const app = await appBehind(1);
    const a = await request(app).get('/api/x').set('X-Forwarded-For', viaCaddy('203.0.113.1'));
    expect(a.body.ip).toBe('172.18.0.5'); // the proxy, not the client
    const b = await request(app).get('/api/x').set('X-Forwarded-For', viaCaddy('203.0.113.2'));
    expect(b.status).toBe(429);
  });
});

describe('RATE_LIMIT_EXEMPT_IPS on apiLimit', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RATE_LIMIT_API = '1';
  });
  afterEach(() => {
    delete process.env.RATE_LIMIT_EXEMPT_IPS;
  });

  /** An app with the real limiter behind one proxy (the frontend nginx). */
  async function appWithExempt(exempt: string) {
    process.env.RATE_LIMIT_EXEMPT_IPS = exempt;
    const { apiLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api', apiLimit);
    app.get('/api/x', (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  async function statuses(app: express.Express, xff: string | null, n = 3) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const req = request(app).get('/api/x');
      out.push((xff ? await req.set('X-Forwarded-For', xff) : await req).status);
    }
    return out;
  }

  it('lets an exempt IP past the limit and still limits other IPs', async () => {
    const app = await appWithExempt('172.18.0.5');
    expect(await statuses(app, '172.18.0.5')).toEqual([200, 200, 200]);
    expect(await statuses(app, '172.18.0.6')).toEqual([200, 429, 429]);
  });

  it('matches IPv4 and IPv6 CIDRs', async () => {
    const app = await appWithExempt(' 172.18.0.0/16 , fd00::/8 ');
    expect(await statuses(app, '172.18.44.7')).toEqual([200, 200, 200]);
    expect(await statuses(app, 'fd12:3456::9')).toEqual([200, 200, 200]);
    expect(await statuses(app, '172.19.0.1')).toEqual([200, 429, 429]);
  });

  it('matches IPv4-mapped IPv6 against IPv4 entries and the reverse', async () => {
    // A dual-stack listener reports the direct supertest peer as ::ffff:127.0.0.1.
    const direct = await appWithExempt('127.0.0.1');
    expect(await statuses(direct, null)).toEqual([200, 200, 200]);

    vi.resetModules();
    const mapped = await appWithExempt('::ffff:172.18.0.0/112');
    expect(await statuses(mapped, '172.18.3.4')).toEqual([200, 200, 200]);
    expect(await statuses(mapped, '::ffff:172.18.3.5')).toEqual([200, 200, 200]);
  });

  it('does not exempt a client that forges X-Forwarded-For past a trusted hop', async () => {
    // The client sends "172.18.0.5"; nginx appends the real address. With
    // TRUST_PROXY=1, req.ip is the address nginx appended.
    const app = await appWithExempt('172.18.0.5');
    expect(await statuses(app, '172.18.0.5, 203.0.113.9')).toEqual([200, 429, 429]);
  });

  it('does not exempt an IP from the stricter limits', async () => {
    process.env.RATE_LIMIT_EXEMPT_IPS = '127.0.0.1';
    process.env.RATE_LIMIT_AUTH = '1';
    const { authLimit } = await import('../../middleware/rateLimit.js');
    const app = express();
    app.post('/auth', authLimit, (_req, res) => res.json({ ok: true }));
    expect((await request(app).post('/auth')).status).toBe(200);
    expect((await request(app).post('/auth')).status).toBe(429);
  });

  it('exempts nobody when the list is empty', async () => {
    const app = await appWithExempt(' , ');
    expect(await statuses(app, null)).toEqual([200, 429, 429]);
  });

  it.each([
    '172.18.0.256',
    '172.18.0.0/33',
    'fd00::/129',
    '10.0.0.0/8/1',
    'kollekt',
    '::ffff:10.0.0.0/64',
    '10.0.0.0/x',
  ])('rejects the invalid entry %s at import', async (entry) => {
    process.env.RATE_LIMIT_EXEMPT_IPS = `172.18.0.5,${entry}`;
    await expect(import('../../middleware/rateLimit.js')).rejects.toThrow(
      `RATE_LIMIT_EXEMPT_IPS: invalid entry "${entry}"`,
    );
  });
});

describe('trustProxySetting (#140)', () => {
  it('defaults to one hop and parses numbers, booleans and lists', async () => {
    const { trustProxySetting } = await import('../../lib/trustProxy.js');
    expect(trustProxySetting(undefined)).toBe(1);
    expect(trustProxySetting('')).toBe(1);
    expect(trustProxySetting(' 2 ')).toBe(2);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
