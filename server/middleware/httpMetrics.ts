import type { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '../lib/metrics.js';

/**
 * Records request duration/count for every request. Uses the matched Express
 * route pattern (e.g. `/api/admin/donors/:id`) rather than the raw URL as the
 * `route` label, to keep cardinality bounded — raw URLs with IDs would create
 * an unbounded number of time series.
 */
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : req.baseUrl || req.path || 'unknown';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);
  });

  next();
}
