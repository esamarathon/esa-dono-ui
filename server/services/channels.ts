import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';
import { assertUsableSlug, availableSlugFrom } from '../lib/slugs.js';
import { activeEventWithPrimary } from './events.js';

/**
 * Channel create / update / deactivate, shared by the admin and moderator routes.
 * Enforces the identity rules of PRD-0002 §S6-§S8 (ADR-0008).
 */

export interface ChannelInput {
  name?: unknown;
  slug?: unknown;
  event_id?: unknown;
  is_active?: unknown;
}

/** Map a Prisma unique-constraint error to a 409 (the slug check can race with another writer). */
function uniqueConflict(e: unknown): Error | null {
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err.code !== 'P2002') return null;
  const target = JSON.stringify(err.meta?.target ?? '');
  if (target.includes('slug'))
    return httpError(409, 'slug is already used by another event or channel');
  if (target.includes('name')) return httpError(409, 'Channel name already exists');
  return null;
}

/** `is_active` must be a boolean when given: a truthy string must not bypass the primary-channel rule. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw httpError(400, `${field} must be true or false`);
  return value;
}

/**
 * The Event a new Channel joins: `event_id` if given, else the only Event that
 * exists. There is always at least one (the migration creates a default Event),
 * so this fallback keeps channel creation working until the Event admin UI
 * (#115) lets admins pick one.
 */
async function resolveEventId(tx: Prisma.TransactionClient, eventId: unknown): Promise<string> {
  if (eventId !== undefined && eventId !== null && eventId !== '') {
    if (typeof eventId !== 'string') throw httpError(400, 'event_id must be a string');
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw httpError(400, 'event_id does not match an event');
    return event.id;
  }
  const events = await tx.event.findMany({ select: { id: true }, take: 2 });
  if (events.length !== 1)
    throw httpError(400, 'event_id is required when more than one event exists');
  return events[0]!.id;
}

/** Create a Channel. `slug` defaults to one derived from `name`. */
export async function createChannel(input: ChannelInput) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw httpError(400, 'name is required');
  const isActive = optionalBoolean(input.is_active, 'is_active');
  try {
    return await prisma.$transaction(async (tx) => {
      const event_id = await resolveEventId(tx, input.event_id);
      const slug =
        input.slug === undefined || input.slug === ''
          ? await availableSlugFrom(tx, name, 'channel')
          : await assertUsableSlug(tx, input.slug);
      return tx.channel.create({
        data: { name, slug, event_id, is_active: isActive ?? true },
      });
    });
  } catch (e) {
    throw uniqueConflict(e) ?? e;
  }
}

/**
 * Update a Channel. A slug cannot change while the Channel is active, and the
 * primary Channel of an active Event cannot be deactivated or moved to another
 * Event.
 */
export async function updateChannel(id: string, input: ChannelInput) {
  const isActive = optionalBoolean(input.is_active, 'is_active');
  const eventId = input.event_id === '' || input.event_id === null ? undefined : input.event_id;
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.channel.findUnique({ where: { id } });
      if (!current) throw httpError(404, 'Channel not found');
      const data: Prisma.ChannelUncheckedUpdateInput = {};

      if (input.name !== undefined) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) throw httpError(400, 'name must not be empty');
        data.name = name;
      }
      if (input.slug !== undefined && input.slug !== current.slug) {
        if (current.is_active) {
          throw httpError(
            409,
            'Deactivate the channel before changing its slug: overlays and links use it',
          );
        }
        data.slug = await assertUsableSlug(tx, input.slug, { channelId: id });
      }
      const movingEvent = eventId !== undefined && eventId !== current.event_id;
      const deactivating = isActive === false && current.is_active;
      if (movingEvent || deactivating) {
        const primaryOf = await activeEventWithPrimary(tx, id);
        if (primaryOf) {
          throw httpError(
            409,
            `This is the primary channel of the active event "${primaryOf.name}". Choose another primary channel first.`,
          );
        }
      }
      if (movingEvent) data.event_id = await resolveEventId(tx, eventId);
      if (isActive !== undefined) data.is_active = isActive;

      return tx.channel.update({ where: { id }, data });
    });
  } catch (e) {
    throw uniqueConflict(e) ?? e;
  }
}

/** Soft-delete (deactivate): channels are referenced by incentives, donations and pledges. */
export function deactivateChannel(id: string) {
  return updateChannel(id, { is_active: false });
}
