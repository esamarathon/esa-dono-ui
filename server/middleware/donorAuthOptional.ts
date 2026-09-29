import type { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';
import { resolveEffectiveRole } from '../lib/roles.js';
import { bearerDonorToken } from '../lib/authHeader.js';
import { readSessionCookie } from '../lib/session.js';

/**
 * Like `donorAuth`, but never rejects: if a valid session/Bearer donor token
 * is present it resolves `req.donor` (with effective role), otherwise it
 * passes through with `req.donor` undefined. Used on public read endpoints
 * that want to personalize a response (e.g. flag "you are the highest bidder")
 * without requiring login.
 */
export async function donorAuthOptional(req: Request, res: Response, next: NextFunction) {
  const token = readSessionCookie(req) ?? bearerDonorToken(req);
  if (!token) return next();

  const donor = await prisma.donor.findUnique({ where: { magic_token: token } });
  if (!donor || (donor.token_expires_at && new Date() > donor.token_expires_at)) return next();
  if (donor.is_frozen) return next();

  req.donor = {
    ...donor,
    role: resolveEffectiveRole(donor.email, donor.role, donor.email_verified),
  };
  next();
}
