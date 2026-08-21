import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { metricsAuth } from '../../middleware/metricsAuth.js';
import { register, httpRequestsTotal } from '../../lib/metrics.js';

function createApp() {
  const app = express();
  app.get('/api/metrics', metricsAuth, async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  });
  return app;
}

describe('GET /api/metrics', () => {
  beforeEach(() => {
    process.env.METRICS_API_KEY = 'test-metrics-key';
    register.resetMetrics();
  });

  it('returns 401 without a token', async () => {
    const res = await request(createApp()).get('/api/metrics');
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong token', async () => {
    const res = await request(createApp())
      .get('/api/metrics')
      .set('Authorization', 'Bearer key_metrics_wrong');
    expect(res.status).toBe(401);
  });

  it('returns Prometheus-formatted metrics with a valid token', async () => {
    httpRequestsTotal.inc({ method: 'GET', route: '/api/health', status: '200' });

    const res = await request(createApp())
      .get('/api/metrics')
      .set('Authorization', 'Bearer key_metrics_test-metrics-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# HELP http_requests_total');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain(
      'http_requests_total{method="GET",route="/api/health",status="200"} 1',
    );
  });

  it('returns 404 when metrics are disabled (no METRICS_API_KEY)', async () => {
    delete process.env.METRICS_API_KEY;
    const res = await request(createApp())
      .get('/api/metrics')
      .set('Authorization', 'Bearer key_metrics_anything');
    expect(res.status).toBe(404);
  });
});
