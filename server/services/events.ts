import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';
import { assertUsableSlug, availableSlugFrom } from '../lib/slugs.js';

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

export interface EventInput {
  name?: unknown;
  slug?: unknown;
  primary_channel_id?: unknown;
  is_active?: unknown;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw httpError(400, `${field} must be true or false`);
  return value;
}

function uniqueConflict(e: unknown): Error | null {
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err.code !== 'P2002') return null;
  return JSON.stringify(err.meta?.target ?? '').includes('slug')
    ? httpError(409, 'slug is already used by another event or channel')
    : null;
}

/** Create an Event. It starts inactive: it has no Channels, so no primary Channel yet. */
export async function createEvent(input: EventInput) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw httpError(400, 'name is required');
  if (optionalBoolean(input.is_active, 'is_active')) {
    throw httpError(
      409,
      'Create the event, add a channel and choose it as primary before activating',
    );
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const slug =
        input.slug === undefined || input.slug === ''
          ? await availableSlugFrom(tx, name, 'event')
          : await assertUsableSlug(tx, input.slug);
      return tx.event.create({ data: { name, slug } });
    });
  } catch (e) {
    throw uniqueConflict(e) ?? e;
  }
}

/**
 * Update an Event (PRD-0002 §S7, §S8): the slug is fixed while active; the primary
 * Channel must be one of the Event's Channels; activating (or staying active with a
 * new primary) requires an active primary Channel.
 */
export async function updateEvent(id: string, input: EventInput) {
  const isActive = optionalBoolean(input.is_active, 'is_active');
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.event.findUnique({ where: { id } });
      if (!current) throw httpError(404, 'Event not found');
      const data: Prisma.EventUncheckedUpdateInput = {};

      if (input.name !== undefined) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) throw httpError(400, 'name must not be empty');
        data.name = name;
      }
      if (input.slug !== undefined && input.slug !== current.slug) {
        if (current.is_active) {
          throw httpError(
            409,
            'Deactivate the event before changing its slug: overlays and links use it',
          );
        }
        data.slug = await assertUsableSlug(tx, input.slug, { eventId: id });
      }
      if (input.primary_channel_id !== undefined) {
        const channelId = input.primary_channel_id;
        if (channelId === null || channelId === '') {
          if (isActive ?? current.is_active) {
            throw httpError(409, 'An active event must keep a primary channel');
          }
          data.primary_channel_id = null;
        } else {
          if (typeof channelId !== 'string')
            throw httpError(400, 'primary_channel_id must be a string');
          const channel = await tx.channel.findUnique({ where: { id: channelId } });
          if (!channel || channel.event_id !== id) {
            throw httpError(400, 'primary_channel_id must be a channel of this event');
          }
          data.primary_channel_id = channelId;
        }
      }
      if (isActive !== undefined) data.is_active = isActive;

      const updated = await tx.event.update({ where: { id }, data });
      if (updated.is_active) await assertCanActivateEvent(tx, id);
      return updated;
    });
  } catch (e) {
    throw uniqueConflict(e) ?? e;
  }
}

/** Soft-delete: donations and channels reference the Event. */
export function deactivateEvent(id: string) {
  return updateEvent(id, { is_active: false });
}
