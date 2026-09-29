import type { Request, Response, NextFunction } from 'express';
import { donorAuth } from './donorAuth.js';
import { hasModeratorAccess } from '../lib/roles.js';
import { parseCredential } from '../lib/authHeader.js';

/**
 * Grants moderator-level access via any of (ADR 0004):
 *  - `Authorization: Bearer key_admin_<key>` matching `ADMIN_API_KEY`
 *    (admin supersedes moderator)
 *  - `Authorization: Bearer key_mod_<key>` matching `MODERATOR_API_KEY`
 *    (operational fallback, independent of the magic-link/role system)
 *  - an authenticated donor (session cookie or Bearer donor token) whose role
 *    is MODERATOR or ADMIN
 */
export async function moderatorAuth(req: Request, res: Response, next: NextFunction) {
  const cred = parseCredential(req);

  if (
    cred?.kind === 'admin-key' &&
    process.env.ADMIN_API_KEY &&
    cred.key === process.env.ADMIN_API_KEY
  ) {
    return next();
  }

  if (
    cred?.kind === 'moderator-key' &&
    process.env.MODERATOR_API_KEY &&
    cred.key === process.env.MODERATOR_API_KEY
  ) {
    return next();
  }

  await donorAuth(req, res, () => {
    if (!hasModeratorAccess(req.donor?.role)) {
      return res.status(403).json({ error: 'Moderator access required' });
    }
    next();
  });
}
