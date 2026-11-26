import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { countedDonation } from '../lib/donationTotals.js';

const router = Router();

// The donor site shows no public aggregate total or goal (#148): the stream
// overlay owns the public fundraising display and the homepage's static
// name/description live in the client. The total itself stays in the API for
// external tools (#148 amendment) as a minimal integer-cents shape; there is
// no goal (the deployment-wide goal was retired with the display, D1).

router.get('/', async (_req: Request, res: Response) => {
  try {
    // Completed and wallet-refunded donations count; chargebacks do not (lib/donationTotals.ts).
    // Hidden donations still count; hiding is a display decision.
    const { _sum } = await prisma.donation.aggregate({
      where: countedDonation,
      _sum: { amount_cents: true },
    });
    res.json({ total_raised_cents: _sum.amount_cents ?? 0 });
  } catch (err) {
    console.error('Campaign error:', err);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

router.get('/broadcast', async (_req: Request, res: Response) => {
  try {
    const broadcast = await prisma.broadcast.findFirst();
    res.json(
      broadcast && broadcast.is_active
        ? { message: broadcast.message, level: broadcast.level }
        : { message: null, level: null },
    );
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(500).json({ error: 'Failed to fetch broadcast' });
  }
});

export default router;
