import type { Prisma } from '@prisma/client';
import { planGoalContinuation, type GoalAsk, type GoalPlacement } from '@dono/shared';
import { contributeGoalSplitTx, goalRemainingCents } from './spend.js';
import { defaultGoal } from './defaultGoal.js';

export type { GoalAsk, GoalPlacement };

export interface GoalFulfillment {
  placements: GoalPlacement[];
  placedCents: number;
  /** Goal-Pool money no eligible goal accepted; it stays Unused pool money. */
  unplacedCents: number;
}

/**
 * Write goal-Pool money: the donor's selections first (capped at each live
 * remaining need and continued in proportion), then the Default goal chain for
 * whatever they could not take. Every chain write is `auto`; a selected goal
 * keeps its donor mark on the cents the donor chose (#201, #236 D1).
 */
export async function fulfillGoalMoneyTx(
  tx: Prisma.TransactionClient,
  input: {
    donorId: string;
    donationId: string;
    channelId: string;
    asks: readonly GoalAsk[];
    /** Money with no goal selection; it starts at the Default goal list. */
    fallbackCents?: number;
  },
): Promise<GoalFulfillment> {
  const goals = input.asks.length
    ? await tx.fundGoal.findMany({ where: { id: { in: input.asks.map((ask) => ask.goal_id) } } })
    : [];
  const capacity: Record<string, number> = {};
  for (const goal of goals)
    capacity[goal.id] = goal.is_active && !goal.is_complete ? goalRemainingCents(goal) : 0;
  const plan = planGoalContinuation(input.asks, capacity);
  const placements: GoalPlacement[] = [];
  for (const placement of plan.placements) {
    if (placement.donor_cents + placement.auto_cents <= 0) continue;
    await contributeGoalSplitTx(
      tx,
      input.donorId,
      placement.goal_id,
      { donor: placement.donor_cents, auto: placement.auto_cents },
      input.donationId,
      { mode: 'pool', source: 'donor' },
    );
    placements.push(placement);
  }
  let remaining = (input.fallbackCents ?? 0) + plan.unplaced_cents;
  // The resolver reads live state, so each write advances the chain past the
  // goal it just filled. Money that no eligible goal takes stays Unused.
  const filled = new Set(
    plan.placements
      .filter((placement) => placement.donor_cents + placement.auto_cents > 0)
      .map((placement) => placement.goal_id),
  );
  while (remaining > 0) {
    const goalId = await defaultGoal(tx, input.channelId, { exclude: filled });
    if (!goalId) break;
    const goal = await tx.fundGoal.findUniqueOrThrow({ where: { id: goalId } });
    const take = Math.min(remaining, goalRemainingCents(goal));
    if (take <= 0) {
      filled.add(goalId);
      continue;
    }
    await contributeGoalSplitTx(
      tx,
      input.donorId,
      goalId,
      { donor: 0, auto: take },
      input.donationId,
      { mode: 'pool', source: 'auto' },
    );
    placements.push({ goal_id: goalId, donor_cents: 0, auto_cents: take });
    remaining -= take;
    filled.add(goalId);
  }
  return {
    placements,
    placedCents: placements.reduce((sum, row) => sum + row.donor_cents + row.auto_cents, 0),
    unplacedCents: remaining,
  };
}
