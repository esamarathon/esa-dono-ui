import type { Prisma } from '@prisma/client';
import { isAvailableOn } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';
import { assertUsableSlug, availableSlugFrom } from '../lib/slugs.js';
import { activeEventWithPrimary } from './events.js';
import { defaultGoal } from './defaultGoal.js';

/** Live staff editor projection; uses the fulfillment resolver, never private donor data. */
export async function readStaffChannelsTx(tx: Prisma.TransactionClient) {
  const channels = await tx.channel.findMany({
    orderBy: { created_at: 'asc' },
    include: { default_goals: { orderBy: { position: 'asc' }, include: { goal: true } } },
  });
  const goal = async (id: string | null) =>
    id ? tx.fundGoal.findUnique({ where: { id }, select: { id: true, title: true } }) : null;
  return Promise.all(
    channels.map(async (channel) => ({
      ...channelResponse(channel),
      default_goal: await goal(await defaultGoal(tx, channel.id)),
      fallback_goal: await goal(await defaultGoal(tx, channel.id, true)),
      has_eligible_default: channel.default_goals.some(
        ({ goal }) => goal.is_active && !goal.is_complete && isAvailableOn(goal, channel),
      ),
    })),
  );
}

/**
 * Channel create / update / deactivate, shared by the admin and moderator routes.
 * Enforces the identity rules of PRD-0002 §S6-§S8 (ADR-0008).
 */

export interface ChannelInput {
  name?: unknown;
  slug?: unknown;
  event_id?: unknown;
  is_active?: unknown;
  /** Update only: ordered goal ids (own or shared), including ineligible entries. */
  default_goals?: unknown;
}

/** Public identity projection; never traverses donors or allocation actors. */
export function channelResponse<T extends { default_goals: { goal_id: string }[] }>(channel: T) {
  return { ...channel, default_goals: channel.default_goals.map((entry) => entry.goal_id) };
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
 * The Event a new Channel or shared incentive joins: `event_id` if given, else
 * the only Event that exists. There is always at least one (the migration
 * creates a default Event), so this fallback keeps single-Event callers working.
 */
export async function resolveEventId(
  tx: Prisma.TransactionClient,
  eventId: unknown,
): Promise<string> {
  if (eventId !== undefined && eventId !== null && eventId !== '') {
    if (typeof eventId !== 'string') throw httpError(400, 'event_id must be a string');
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw httpError(400, 'event_id does not match an event');
    return event.id;
  }
  const events = await tx.event.findMany({ select: { id: true }, take: 2 });
  if (events.length !== 1)
    throw httpError(400, 'event_id is required unless exactly one event exists');
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
      if (movingEvent) {
        // ADR-0012: an incentive never moves to another Event, so neither may its Channel.
        const where = { channel_id: id };
        const owned =
          (await tx.reward.count({ where })) +
          (await tx.poll.count({ where })) +
          (await tx.fundGoal.count({ where })) +
          (await tx.auction.count({ where }));
        if (owned)
          throw httpError(
            409,
            'This channel has incentives. Incentives cannot move to another event, so the channel cannot either.',
          );
        data.event_id = await resolveEventId(tx, eventId);
      }
      if (isActive !== undefined) data.is_active = isActive;

      if (input.default_goals !== undefined) {
        const ids = input.default_goals;
        if (
          !Array.isArray(ids) ||
          ids.some((goalId) => typeof goalId !== 'string') ||
          new Set(ids).size !== ids.length
        ) {
          throw httpError(400, 'default_goals must be an ordered list of unique goal ids');
        }
        const scope = { id, event_id: (data.event_id as string | undefined) ?? current.event_id };
        for (const goalId of ids) {
          const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
          if (!goal || !isAvailableOn(goal, scope)) {
            throw httpError(
              400,
              'Default goals must belong to this Channel or be shared in its event',
            );
          }
        }
        await tx.channelDefaultGoal.deleteMany({ where: { channel_id: id } });
        await tx.channelDefaultGoal.createMany({
          data: ids.map((goalId, position) => ({ channel_id: id, goal_id: goalId, position })),
        });
      }
      return channelResponse(
        await tx.channel.update({
          where: { id },
          data,
          include: { default_goals: { orderBy: { position: 'asc' } } },
        }),
      );
    });
  } catch (e) {
    throw uniqueConflict(e) ?? e;
  }
}

/** Soft-delete (deactivate): channels are referenced by incentives, donations and pledges. */
export function deactivateChannel(id: string) {
  return updateChannel(id, { is_active: false });
}
