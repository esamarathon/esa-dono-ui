import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { channelTotalCents, countedDonation, eventTotalCents } from '../lib/donationTotals.js';

const router = Router();

// The donor site shows no public aggregate total or goal (#148): the stream
// overlay owns the public fundraising display and the homepage's static
// name/description live in the client. The total itself stays in the API for
// external tools (#148 amendment) as a minimal integer-cents shape; there is
// no goal (the deployment-wide goal was retired with the display, D1).
// An `event` or `channel` slug scopes the same money rule to that Event or
// Channel (the overlay's own numbers, ADR-0010); the slugs resolve whether
// active or not, like GET /api/tiltify/campaigns/{id}.

router.get('/', async (req: Request, res: Response) => {
  try {
    const eventSlug = typeof req.query.event === 'string' ? req.query.event : undefined;
    const channelSlug = typeof req.query.channel === 'string' ? req.query.channel : undefined;
    if (eventSlug && channelSlug) {
      return res.status(400).json({ error: 'Use either event or channel, not both' });
    }

    if (eventSlug || channelSlug) {
      const row = eventSlug
        ? await prisma.event.findUnique({ where: { slug: eventSlug } })
        : await prisma.channel.findUnique({ where: { slug: channelSlug as string } });
      if (!row) {
        return res.status(404).json({ error: eventSlug ? 'Event not found' : 'Channel not found' });
      }
      // Completed and wallet-refunded donations count; chargebacks do not (lib/donationTotals.ts).
      // Hidden donations still count; hiding is a display decision. An Event total is its
      // assigned donations; an unassigned one counts in the overall total only.
      const cents = eventSlug
        ? await eventTotalCents(prisma, row.id)
        : await channelTotalCents(prisma, row.id);
      return res.json({ total_raised_cents: cents });
    }

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
