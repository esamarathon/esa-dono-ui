import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { parseCredential } from '../lib/authHeader.js';

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Gates `GET /api/metrics`. The endpoint is reachable through the public
 * nginx proxy like any other route (no network-level restriction) — access
 * control is entirely this bearer-token check, carried as
 * `Authorization: Bearer key_metrics_<key>` (ADR 0004 credential scheme).
 *
 * If `METRICS_API_KEY` is unset, the endpoint is treated as disabled and
 * always returns 404 so metrics aren't accidentally exposed unauthenticated.
 */
export function metricsAuth(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.METRICS_API_KEY;
  if (!configuredKey) return res.status(404).json({ error: 'Not found' });

  const cred = parseCredential(req);
  if (cred?.kind === 'metrics-key' && timingSafeEqual(cred.key, configuredKey)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}
