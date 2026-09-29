import type { Request, Response, NextFunction } from 'express';
import { donorAuth } from './donorAuth.js';
import { hasAdminAccess } from '../lib/roles.js';
import { parseCredential } from '../lib/authHeader.js';

/**
 * Gates `/api/admin/*` on either:
 *  - the operational admin key, carried as `Authorization: Bearer key_admin_<key>`
 *    (an operator secret for scripting/bootstrapping), or
 *  - an authenticated donor (session cookie or Bearer donor token) whose
 *    effective role is ADMIN (ADR 0003).
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction) {
  const cred = parseCredential(req);
  if (
    cred?.kind === 'admin-key' &&
    process.env.ADMIN_API_KEY &&
    cred.key === process.env.ADMIN_API_KEY
  ) {
    return next();
  }

  await donorAuth(req, res, () => {
    if (!hasAdminAccess(req.donor?.role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}
