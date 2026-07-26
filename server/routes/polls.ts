import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { donorAuth } from '../middleware/donorAuth.js';
import { spendLimit } from '../middleware/rateLimit.js';
import { votePollTx, proposeCustomEntryTx } from '../services/spend.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const polls = await prisma.poll.findMany({
    where: { is_active: true },
    include: { options: { where: { status: 'ACTIVE' }, orderBy: { votes_cents: 'desc' } } },
    orderBy: { created_at: 'desc' },
  });
  res.json(polls);
});

router.post('/:id/custom-entry', spendLimit, donorAuth, async (req: Request, res: Response) => {
  try {
    const { label, amount_cents } = req.body;
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return proposeCustomEntryTx(tx, req.donor!.id, req.params.id!, label, Number(amount_cents));
    });
    res.json({
      success: true,
      entry: { id: result.entry.id, label: result.entry.label, status: result.status },
      pending_approval: result.status === 'PENDING_APPROVAL',
    });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/:id/vote', spendLimit, donorAuth, async (req: Request, res: Response) => {
  try {
    const { poll_option_id, amount_cents } = req.body;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await votePollTx(tx, req.donor!.id, req.params.id!, poll_option_id, Number(amount_cents));
    });
    res.json({ success: true });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

export default router;
