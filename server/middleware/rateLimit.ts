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

// Feedback submissions are public/unauthenticated (no donor token to key on),
// so throttle purely by IP.
const feedbackLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_FEEDBACK) || 5,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

// Global per-IP limit on the whole API (#140), a load backstop. The stricter
// limits above guard specific abuse (email sending, spending) and apply on top.
// Sized for the busiest legitimate client: kollekt polls /api/tiltify every 5 s
// (~36 requests/min per Channel), and several donors can share a venue NAT.
// Keyed by req.ip, so TRUST_PROXY must match the proxy hops (lib/trustProxy.ts).
const apiLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_API) || 600,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

export { spendLimit, authLimit, metricsLimit, feedbackLimit, apiLimit };
