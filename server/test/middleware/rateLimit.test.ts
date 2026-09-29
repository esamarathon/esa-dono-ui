import { describe, it, expect, vi, beforeEach } from 'vitest';
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
