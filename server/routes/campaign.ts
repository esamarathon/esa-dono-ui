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

/** One scope query value: absent (undefined), exactly one non-empty slug, or
 *  malformed (null) — empty, repeated, or not a plain string. */
function scopeSlug(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value !== '' ? value : null;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const eventSlug = scopeSlug(req.query.event);
    const channelSlug = scopeSlug(req.query.channel);
    if (eventSlug === null || channelSlug === null) {
      return res.status(400).json({
        error: 'event and channel must each be given at most once, as a non-empty slug',
      });
    }
    if (eventSlug !== undefined && channelSlug !== undefined) {
      return res.status(400).json({ error: 'Use either event or channel, not both' });
    }

    // One resolved scope: its lookup, not-found text and total function are
    // chosen once here; the flow below is scope-agnostic.
    const scope =
      eventSlug !== undefined
        ? {
            notFound: 'Event not found',
            find: () => prisma.event.findUnique({ where: { slug: eventSlug } }),
            total: (id: string) => eventTotalCents(prisma, id),
          }
        : channelSlug !== undefined
          ? {
              notFound: 'Channel not found',
              find: () => prisma.channel.findUnique({ where: { slug: channelSlug } }),
              total: (id: string) => channelTotalCents(prisma, id),
            }
          : null;

    // Completed and wallet-refunded donations count; chargebacks do not (lib/donationTotals.ts).
    // Hidden donations still count; hiding is a display decision. An Event total is its
    // assigned donations; an unassigned one counts in the overall total only.
    if (scope) {
      const row = await scope.find();
      if (!row) return res.status(404).json({ error: scope.notFound });
      return res.json({ total_raised_cents: await scope.total(row.id) });
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
