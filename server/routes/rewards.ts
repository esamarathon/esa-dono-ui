import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { donorAuth } from '../middleware/donorAuth.js';
import { spendLimit } from '../middleware/rateLimit.js';
import { claimRewardTx } from '../services/spend.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const rewards = await prisma.reward.findMany({
    where: { is_active: true },
    orderBy: { cost_cents: 'asc' },
  });
  res.json(rewards);
});

router.post('/:id/claim', spendLimit, donorAuth, async (req: Request, res: Response) => {
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await claimRewardTx(tx, req.donor!.id, req.params.id!, req.body.claim_data);
    });
    res.json({ success: true });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

export default router;
