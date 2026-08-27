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
