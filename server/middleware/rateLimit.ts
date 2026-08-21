import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { resolveDonorToken } from './donorAuth.js';

const keyGenerator = (req: Request): string =>
  resolveDonorToken(req) ?? ipKeyGenerator(req.ip ?? '');

const spendLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_SPEND) || 20,
  keyGenerator,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

// Auth endpoints (magic-link requests, SSO initiation) are keyed purely by IP
// to throttle email/upstream abuse regardless of any token on the request.
const authLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_AUTH) || 5,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

// /api/metrics is reachable through the public proxy (no network-level
// restriction) and protected only by the metrics bearer token, so throttle
// unauthenticated/scanning traffic by IP to bound the added load.
const metricsLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_METRICS) || 30,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

export { spendLimit, authLimit, metricsLimit };
