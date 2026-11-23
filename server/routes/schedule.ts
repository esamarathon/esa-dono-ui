import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { scheduleForSlug } from '../services/schedule.js';

const router = Router();

/**
 * GET /api/schedule?channel=<channel-slug>
 *
 * The computed "Live / Up next" result for a Channel's Horaro schedule (#148).
 * `channel` is a Channel slug. When absent, the primary Channel of the single
 * active Event is used (D7). Every unclear state returns
 * `{ live: null, next: null }` with 200 — no Channel, ambiguous or missing
 * active Event, no primary Channel, no configured slug, or nothing scheduled
 * (D6). The browser never calls Horaro directly.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const channelSlug = typeof req.query.channel === 'string' ? req.query.channel : undefined;
    const horaroSlug = await resolveHoraroSlug(channelSlug);
    res.json(await scheduleForSlug(horaroSlug));
  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

/** The Horaro slug of the named Channel, else of the single active Event's
 *  primary Channel; null whenever the state is unclear (D6/D7). */
async function resolveHoraroSlug(channelSlug: string | undefined): Promise<string | null> {
  if (channelSlug) {
    const channel = await prisma.channel.findUnique({
      where: { slug: channelSlug },
      select: { horaro_schedule_slug: true },
    });
    return channel?.horaro_schedule_slug || null;
  }
  const activeEvents = await prisma.event.findMany({
    where: { is_active: true },
    select: { primary_channel: { select: { horaro_schedule_slug: true } } },
  });
  if (activeEvents.length !== 1) return null;
  return activeEvents[0]!.primary_channel?.horaro_schedule_slug || null;
}

export default router;
