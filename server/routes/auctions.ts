import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import { minNextBidCents } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { donorAuth } from '../middleware/donorAuth.js';
import { spendLimit } from '../middleware/rateLimit.js';
import { placeBidTx } from '../services/auction.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const { channel_id } = req.query;
  const auctions = await prisma.auction.findMany({
    where: {
      is_active: true,
      ...(typeof channel_id === 'string' ? { channel_id } : {}),
    },
    orderBy: { ends_at: 'asc' },
  });
  res.json(
    auctions.map((a) => ({
      ...a,
      min_next_bid_cents: ['OPEN'].includes(a.status) ? minNextBidCents(a) : null,
    })),
  );
});

router.get('/:id', async (req: Request, res: Response) => {
  const auction = await prisma.auction.findUnique({
    where: { id: req.params.id },
    include: {
      bids: {
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { id: true, amount_cents: true, status: true, created_at: true },
      },
    },
  });
  if (!auction || !auction.is_active) return res.status(404).json({ error: 'Auction not found' });
  res.json({
    ...auction,
    min_next_bid_cents: auction.status === 'OPEN' ? minNextBidCents(auction) : null,
  });
});

router.post('/:id/bid', spendLimit, donorAuth, async (req: Request, res: Response) => {
  try {
    const cents = Number(req.body.amount_cents);
    await prisma.$transaction((tx: Prisma.TransactionClient) =>
      placeBidTx(tx, req.donor!.id, req.params.id!, cents),
    );
    res.json({ success: true });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

export default router;
