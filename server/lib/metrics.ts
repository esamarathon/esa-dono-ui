import client from 'prom-client';

/**
 * Single Prometheus registry for the process.
 *
 * Two families of metrics live here:
 *  - Runtime/HTTP metrics (this file + middleware/httpMetrics.ts): collected
 *    in-process, inherently per-instance, reset on restart. That's expected —
 *    Prometheus counters are designed to be read with rate()/increase(),
 *    which handle resets correctly.
 *  - Business/custom metrics (services/metrics.ts): derived from the shared
 *    database on a background interval, so they're identical across
 *    load-balanced replicas and survive restarts (the DB is the source of
 *    truth, not process memory).
 */
export const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});
