import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { channelResponse } from '../services/channels.js';

const router = Router();

/**
 * GET /api/channels
 * Public list of active channels, for the /donate channel picker.
 */
router.get('/', async (_req: Request, res: Response) => {
  const channels = await prisma.channel.findMany({
    where: { is_active: true },
    orderBy: { created_at: 'asc' },
    include: { default_goals: { orderBy: { position: 'asc' } } },
  });
  res.json(channels.map(channelResponse));
});

export default router;
