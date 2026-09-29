import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';

const router = Router();

/**
 * GET /api/channels
 * Public list of active channels, for the /donate channel picker.
 */
router.get('/', async (_req: Request, res: Response) => {
  const channels = await prisma.channel.findMany({
    where: { is_active: true },
    orderBy: { created_at: 'asc' },
  });
  res.json(channels);
});

export default router;
