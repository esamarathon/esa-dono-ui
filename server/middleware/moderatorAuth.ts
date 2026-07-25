import type { Request, Response, NextFunction } from 'express';
import { donorAuth } from './donorAuth.js';

export async function moderatorAuth(req: Request, res: Response, next: NextFunction) {
  await donorAuth(req, res, () => {
    if (!req.donor?.is_moderator) {
      return res.status(403).json({ error: 'Moderator access required' });
    }
    next();
  });
}
