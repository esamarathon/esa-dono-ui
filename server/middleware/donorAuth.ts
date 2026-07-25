import type { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';

export async function donorAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.query.token;
  if (!token || typeof token !== 'string') return res.status(401).json({ error: 'Token required' });
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
  req.donor = donor;
  next();
}
