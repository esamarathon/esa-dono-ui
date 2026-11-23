import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { countedDonation } from '../lib/donationTotals.js';
import { isFeatureFlagEnabled } from '../services/featureFlags.js';
import { scheduleForSlug, type ScheduleResult } from '../services/schedule.js';

const router = Router();

/** Rolling window of the strip's donation acknowledgements (D6). */
export const ACK_WINDOW_MS = 60_000;

/** The `donation-acknowledgements` feature flag (D11, default off). */
const ACK_FLAG = 'donation-acknowledgements';

/** One acknowledgement candidate as the client receives it (D8). */
export interface ScheduleRecentDonation {
  id: string;
  /** Display name after the D2/D5 mapping: blank or hidden reads "Anonymous". */
  display_name: string;
  amount_cents: number;
  created_at: string;
}

/**
 * GET /api/schedule?channel=<channel-slug>
 *
 * The computed "Live / Up next" result for a Channel's Horaro schedule (#148)
 * plus the donation-acknowledgement data (#250). `channel` is a Channel slug.
 * When absent, the primary Channel of the single active Event is used (D7).
 * Every unclear state returns `{ live: null, next: null }` with 200 — no
 * Channel, ambiguous or missing active Event, no primary Channel, no
 * configured slug, or nothing scheduled (D6). The browser never calls Horaro
 * directly.
 *
 * Acknowledgements (D3/D8/D11): while the `donation-acknowledgements` flag is
 * on and the strip renders (the schedule result is not empty), the response
 * also carries `recent_donations` — the Event's ack-eligible donations
 * (COMPLETED/REFUNDED, D1) of the last minute as
 * `(id, display name, amount, created_at)`. That read is computed FRESH per
 * request and never inherits the ~60 s Horaro timetable cache. With the flag
 * off (or its row absent) the field is omitted and the strip behaves exactly
 * like 0.10.0. Wherever the strip renders nothing, there are no
 * acknowledgements either.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const channelSlug = typeof req.query.channel === 'string' ? req.query.channel : undefined;
    const { horaroSlug, eventId } = await resolveStripContext(channelSlug);
    const schedule = await scheduleForSlug(horaroSlug);
    const body: ScheduleResult & { recent_donations?: ScheduleRecentDonation[] } = {
      ...schedule,
    };
    // Acks ride the schedule's render decision (D3): no schedule, no acks.
    if (schedule.live || schedule.next) {
      const recent = await recentDonationsForEvent(eventId);
      if (recent) body.recent_donations = recent;
    }
    res.json(body);
  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

/** The Horaro slug and the Event of the Channel in context, else of the single
 *  active Event's primary Channel; nulls whenever the state is unclear (D6/D7). */
async function resolveStripContext(
  channelSlug: string | undefined,
): Promise<{ horaroSlug: string | null; eventId: string | null }> {
  if (channelSlug) {
    const channel = await prisma.channel.findUnique({
      where: { slug: channelSlug },
      select: { horaro_schedule_slug: true, event_id: true },
    });
    return {
      horaroSlug: channel?.horaro_schedule_slug || null,
      eventId: channel?.event_id ?? null,
    };
  }
  const activeEvents = await prisma.event.findMany({
    where: { is_active: true },
    select: { id: true, primary_channel: { select: { horaro_schedule_slug: true } } },
  });
  if (activeEvents.length !== 1) return { horaroSlug: null, eventId: null };
  return {
    horaroSlug: activeEvents[0]!.primary_channel?.horaro_schedule_slug || null,
    eventId: activeEvents[0]!.id,
  };
}

/**
 * The Event's ack-eligible donations of the last minute (D1–D3, D8), fresh
 * per request. Returns undefined while the `donation-acknowledgements` flag is
 * off (D11), so the caller omits the field entirely.
 *
 * Eligibility: the money-counted statuses only (`countedDonation`, D1), any
 * source (derived item 5), `moderated` ignored (derived item 1). A donation
 * with no Event is never acknowledged (D3). The display name applies the
 * Tiltify wire's exact mapping (D2/D5, `tiltifyPayload.ts`): hidden or blank
 * reads "Anonymous"; the comment is never read or sent (D4).
 */
export async function recentDonationsForEvent(
  eventId: string | null,
): Promise<ScheduleRecentDonation[] | undefined> {
  if (!(await isFeatureFlagEnabled(ACK_FLAG))) return undefined;
  if (!eventId) return [];
  const since = new Date(Date.now() - ACK_WINDOW_MS);
  const rows = await prisma.donation.findMany({
    where: { event_id: eventId, created_at: { gte: since }, ...countedDonation },
    orderBy: { created_at: 'asc' },
    select: {
      id: true,
      donor_name: true,
      hidden_from_overlay: true,
      amount_cents: true,
      created_at: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    display_name: row.hidden_from_overlay ? 'Anonymous' : row.donor_name?.trim() || 'Anonymous',
    amount_cents: row.amount_cents,
    created_at: row.created_at.toISOString(),
  }));
}

export default router;
