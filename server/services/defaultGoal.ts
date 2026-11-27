import type { Prisma } from '@prisma/client';
import { isAvailableOn } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { httpError } from '../lib/httpError.js';
import { goalRemainingCents } from './spend.js';

export interface DefaultGoalOptions {
  /** Skip the Channel's own list, for the primary Channel's fallback lookup. */
  skipOwnList?: boolean;
  /** Goals a resolution run has already filled or declined. */
  exclude?: Iterable<string>;
}

/** A goal takes money only while it is live, open and below its target (#201). */
function canReceive(goal: {
  is_active: boolean;
  is_complete: boolean;
  current_cents: number;
  target_cents: number;
}) {
  return goal.is_active && !goal.is_complete && goal.target_cents > goal.current_cents;
}

/**
 * One live policy shared by fulfillment, Pool credit and the read-only donate
 * preview. Order: the Channel's Default goal list, the primary Channel's list,
 * then the eligible goal closest to completion. A full goal is never returned,
 * even when its complete flag is stale (#201).
 */
export async function defaultGoal(
  tx: Prisma.TransactionClient,
  channelId: string,
  options: DefaultGoalOptions = {},
): Promise<string | null> {
  const skip = new Set(options.exclude ?? []);
  const channel = await tx.channel.findUniqueOrThrow({
    where: { id: channelId },
    include: { event: true },
  });
  for (const listChannel of new Set(
    [channelId, channel.event.primary_channel_id].filter((id): id is string => id !== null),
  )) {
    if (options.skipOwnList && listChannel === channelId) continue;
    const entries = await tx.channelDefaultGoal.findMany({
      where: { channel_id: listChannel },
      orderBy: { position: 'asc' },
      include: { goal: true },
    });
    const entry = entries.find(
      ({ goal }) => canReceive(goal) && !skip.has(goal.id) && isAvailableOn(goal, channel),
    );
    if (entry) return entry.goal_id;
  }
  for (const scope of [channelId, null]) {
    const goals = await tx.fundGoal.findMany({
      where: { channel_id: scope, event_id: channel.event_id, is_active: true, is_complete: false },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    goals.sort((a, b) => a.target_cents - a.current_cents - (b.target_cents - b.current_cents));
    const goal = goals.find((row) => canReceive(row) && !skip.has(row.id));
    if (goal) return goal.id;
  }
  return null;
}

export interface DefaultGoalChainEntry {
  id: string;
  title: string;
  remaining_cents: number;
}

/**
 * The next goals that would receive goal-Pool money, in the resolver's order.
 * Fulfillment walks this same order until the money or the eligible goals run
 * out, so the preview and the write cannot disagree (#201).
 */
export async function defaultGoalChain(
  tx: Prisma.TransactionClient,
  channelId: string,
  max = 5,
): Promise<DefaultGoalChainEntry[]> {
  const chain: DefaultGoalChainEntry[] = [];
  const exclude = new Set<string>();
  while (chain.length < max) {
    const id = await defaultGoal(tx, channelId, { exclude });
    if (!id) break;
    const goal = await tx.fundGoal.findUniqueOrThrow({ where: { id } });
    chain.push({ id: goal.id, title: goal.title, remaining_cents: goalRemainingCents(goal) });
    exclude.add(id);
  }
  return chain;
}

/** No reservation or mutation. Payment completion re-runs the same resolver. */
export async function defaultGoalPreview(channelId: string) {
  return prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({ where: { id: channelId } });
    if (!channel?.is_active) throw httpError(404, 'Channel not found or inactive');
    const chain = await defaultGoalChain(tx, channelId);
    const goal = chain[0] ? { id: chain[0].id, title: chain[0].title } : null;
    return { goal, chain };
  });
}
