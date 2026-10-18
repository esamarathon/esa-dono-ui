import type { Prisma } from '@prisma/client';
import { isAvailableOn } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';

/** One live policy shared by fulfillment and the read-only donate preview. */
export async function defaultGoal(
  tx: Prisma.TransactionClient,
  channelId: string,
  skipOwnList = false,
): Promise<string | null> {
  const channel = await tx.channel.findUniqueOrThrow({
    where: { id: channelId },
    include: { event: true },
  });
  for (const listChannel of new Set(
    [channelId, channel.event.primary_channel_id].filter((id): id is string => id !== null),
  )) {
    if (skipOwnList && listChannel === channelId) continue;
    const entries = await tx.channelDefaultGoal.findMany({
      where: { channel_id: listChannel },
      orderBy: { position: 'asc' },
      include: { goal: true },
    });
    const entry = entries.find(
      ({ goal }) => goal.is_active && !goal.is_complete && isAvailableOn(goal, channel),
    );
    if (entry) return entry.goal_id;
  }
  for (const scope of [channelId, null]) {
    const goals = await tx.fundGoal.findMany({
      where: { channel_id: scope, event_id: channel.event_id, is_active: true, is_complete: false },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    goals.sort((a, b) => a.target_cents - a.current_cents - (b.target_cents - b.current_cents));
    if (goals[0]) return goals[0].id;
  }
  return null;
}

/** No reservation or mutation. Payment completion re-runs the same resolver. */
export async function defaultGoalPreview(channelId: string) {
  return prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({ where: { id: channelId } });
    if (!channel?.is_active) throw httpError(404, 'Channel not found or inactive');
    const id = await defaultGoal(tx, channelId);
    const goal = id
      ? await tx.fundGoal.findUnique({ where: { id }, select: { id: true, title: true } })
      : null;
    return { goal };
  });
}
