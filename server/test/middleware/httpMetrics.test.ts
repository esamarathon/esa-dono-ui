import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { httpMetrics } from '../../middleware/httpMetrics.js';
import { httpRequestsTotal } from '../../lib/metrics.js';

describe('httpMetrics middleware', () => {
  it('records request metrics and calls next', async () => {
    const app = express();
    app.use(httpMetrics);
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const { values } = await httpRequestsTotal.get();
    const recorded = values.find(
      (v) => v.labels.method === 'GET' && v.labels.route === '/ping' && v.labels.status === '200',
    );
    expect(recorded).toBeTruthy();
    expect(recorded!.value).toBeGreaterThan(0);
  });
});
