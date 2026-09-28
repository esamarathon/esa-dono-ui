import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';

type EventDb = Pick<Prisma.TransactionClient, 'event' | 'channel'>;

/**
 * An Event can be activated only if its primary Channel is set, belongs to the
 * Event, and is active (PRD-0002 §S8): donations with no Channel route there.
 * Throws 409 otherwise.
 */
export async function assertCanActivateEvent(db: EventDb, eventId: string): Promise<void> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { primary_channel: true },
  });
  if (!event) throw httpError(404, 'Event not found');
  const primary = event.primary_channel;
  if (!primary) {
    throw httpError(409, 'Choose a primary channel before activating the event');
  }
  if (primary.event_id !== event.id) {
    throw httpError(409, 'The primary channel must belong to this event');
  }
  if (!primary.is_active) {
    throw httpError(409, 'The primary channel must be active before the event is activated');
  }
}

/**
 * The active Event a Channel is the primary Channel of, or null. Such a Channel
 * cannot be deactivated or moved to another Event until the Event designates a
 * different primary (PRD-0002 §S8).
 */
export async function activeEventWithPrimary(db: EventDb, channelId: string) {
  return db.event.findFirst({
    where: { primary_channel_id: channelId, is_active: true },
    select: { id: true, name: true },
  });
}
