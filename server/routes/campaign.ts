import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';

const router = Router();

const STUB_CAMPAIGN = {
  name: 'ESA Charity Marathon',
  description:
    'A charity speedrunning channel raising money for a great cause. Watch runners tackle games at incredible speeds while supporting charity!',
  goal: { value: '5000.00' },
};

router.get('/', async (_req: Request, res: Response) => {
  try {
    const goalCents = Number(process.env.CAMPAIGN_GOAL_CENTS || '500000');

    const { _sum } = await prisma.donation.aggregate({
      _sum: { amount_cents: true },
    });

    res.json({
      ...STUB_CAMPAIGN,
      amount_raised: { value: ((_sum.amount_cents ?? 0) / 100).toFixed(2) },
      goal: { value: (goalCents / 100).toFixed(2) },
    });
  } catch (err) {
    console.error('Campaign error:', err);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

export default router;
