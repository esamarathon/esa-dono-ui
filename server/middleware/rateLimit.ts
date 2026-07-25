import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

const keyGenerator = (req: Request): string =>
  (typeof req.query.token === 'string' ? req.query.token : undefined) ??
  ipKeyGenerator(req.ip ?? '');

const spendLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_SPEND) || 20,
  keyGenerator,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

const customEntryLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_CUSTOM_ENTRY) || 5,
  keyGenerator,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests, please slow down.' }),
});

export { spendLimit, customEntryLimit };
