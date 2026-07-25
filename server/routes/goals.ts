import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { donorAuth } from '../middleware/donorAuth.js';
import { spendLimit } from '../middleware/rateLimit.js';
import { contributeGoalTx } from '../services/spend.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const goals = await prisma.fundGoal.findMany({
    where: { is_active: true },
    orderBy: { created_at: 'desc' },
  });
  res.json(goals);
});

router.post('/:id/contribute', spendLimit, donorAuth, async (req: Request, res: Response) => {
  try {
    const { amount_cents } = req.body;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await contributeGoalTx(tx, req.donor!.id, req.params.id!, Number(amount_cents));
    });
    res.json({ success: true });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

export default router;
