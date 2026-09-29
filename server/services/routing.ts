import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { buildDonationCreatedPayload } from './webhooks/delivery.js';
import { withWebhooks } from './webhooks/outbox.js';

/** Where a donation is routed. Both null = unassigned (PRD-0002 §E5, §E6). */
export interface DonationRoute {
  channelId: string | null;
  eventId: string | null;
}

type RoutingDb = Pick<Prisma.TransactionClient, 'channel' | 'event'>;

/**
 * Route a donation when it is created (PRD-0002 §E5):
 * 1. an explicit Channel (a fulfilled pledge's, or the caller's) → that Channel;
 * 2. else a known Event → its primary Channel;
 * 3. else exactly one active Event → its primary Channel;
 * 4. else unassigned: both null, and nothing is published until an admin assigns it.
 *
 * An explicit Channel or Event that does not exist is a 400; an inactive one is
 * accepted (an admin may record a late donation against a closed stream).
 */
export async function resolveDonationRoute(
  db: RoutingDb,
  { channelId, eventId }: { channelId?: string | null; eventId?: string | null },
): Promise<DonationRoute> {
  if (channelId) {
    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { id: true, event_id: true },
    });
    if (!channel) throw httpError(400, 'channel_id does not match a channel');
    return { channelId: channel.id, eventId: channel.event_id };
  }
  if (eventId) {
    const event = await db.event.findUnique({
      where: { id: eventId },
      select: { id: true, primary_channel_id: true },
    });
    if (!event) throw httpError(400, 'event_id does not match an event');
    return { channelId: event.primary_channel_id, eventId: event.id };
  }
  const active = await db.event.findMany({
    where: { is_active: true },
    select: { id: true, primary_channel_id: true },
    take: 2,
  });
  if (active.length === 1)
    return { channelId: active[0]!.primary_channel_id, eventId: active[0]!.id };
  return { channelId: null, eventId: null };
}

/**
 * Assign an unassigned donation to a Channel (PRD-0002 §E6) and publish it, in one
 * transaction. A donation that already has a Channel or Event is not reassigned:
 * it was already published.
 */
export async function assignDonationChannel(donationId: string, channelId: unknown) {
  if (typeof channelId !== 'string' || !channelId) throw httpError(400, 'channel_id is required');
  return withWebhooks(async (tx, emit) => {
    const donation = await tx.donation.findUnique({ where: { id: donationId } });
    if (!donation) throw httpError(404, 'Donation not found');
    if (donation.channel_id || donation.event_id) {
      throw httpError(409, 'Donation is already assigned');
    }
    const route = await resolveDonationRoute(tx, { channelId });
    const updated = await tx.donation.update({
      where: { id: donationId },
      data: { channel_id: route.channelId, event_id: route.eventId },
    });
    await emit('donation.created', () =>
      buildDonationCreatedPayload({
        donationId: updated.id,
        externalId: updated.external_id,
        amountCents: updated.amount_cents,
        channelId: route.channelId,
        donorRef: updated.donor_id,
      }),
    );
    return updated;
  });
}
