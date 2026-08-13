import type { Request, Response, NextFunction } from 'express';
import { donorAuth } from './donorAuth.js';
import { hasModeratorAccess } from '../lib/roles.js';

/**
 * Grants moderator-level access via any of:
 *  - `X-Admin-Key` matching `ADMIN_API_KEY` (admin supersedes moderator)
 *  - `X-Moderator-Key` matching `MODERATOR_API_KEY` (operational fallback,
 *    independent of the magic-link/role system)
 *  - an authenticated donor whose role is MODERATOR or ADMIN
 */
export async function moderatorAuth(req: Request, res: Response, next: NextFunction) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey && process.env.ADMIN_API_KEY && adminKey === process.env.ADMIN_API_KEY) {
    return next();
  }

  const moderatorKey = req.headers['x-moderator-key'];
  if (
    moderatorKey &&
    process.env.MODERATOR_API_KEY &&
    moderatorKey === process.env.MODERATOR_API_KEY
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
