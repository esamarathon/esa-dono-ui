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
