import type { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';
import { resolveEffectiveRole } from '../lib/roles.js';
import { bearerDonorToken } from '../lib/authHeader.js';
import { readSessionCookie } from '../lib/session.js';
import { setDonorOnActiveSpan } from '../lib/tracing.js';

/**
 * Resolve the donor magic token from the browser session cookie (primary) or,
 * for non-browser/API clients, an `Authorization: Bearer <token>` header.
 * The legacy `?token=` query param is no longer accepted (ADR 0004).
 */
export function resolveDonorToken(req: Request): string | undefined {
  return readSessionCookie(req) ?? bearerDonorToken(req);
}

export async function donorAuth(req: Request, res: Response, next: NextFunction) {
  const token = resolveDonorToken(req);
  if (!token) return res.status(401).json({ error: 'Token required' });
  const donor = await prisma.donor.findUnique({
    where: { magic_token: token },
  });
  if (!donor) return res.status(401).json({ error: 'Invalid token' });
  if (donor.token_expires_at && new Date() > donor.token_expires_at) {
    return res.status(401).json({ error: 'Token expired' });
  }
  if (donor.is_frozen) {
    return res.status(403).json({ error: 'Account frozen' });
  }
  // Effective role is resolved per-request from ADMIN_EMAILS/MODERATOR_EMAILS
  // allowlists (never downgrading below the persisted role), gated on the
  // donor's verified email. Roles are never granted as a side effect of
  // donating — see resolveEffectiveRole() docs.
  req.donor = {
    ...donor,
    role: resolveEffectiveRole(donor.email, donor.role, donor.email_verified),
  };
  setDonorOnActiveSpan(donor.id, donor.email);
  next();
}
