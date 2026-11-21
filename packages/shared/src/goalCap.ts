import type { PledgePlan } from './pledgePlan.js';

/**
 * One goal-Pool ask: the donor-chosen cents and the automatic top-up that came
 * with the selection. `order` is the donor's insertion order.
 */
export interface GoalAsk {
  goal_id: string;
  donor_cents: number;
  auto_cents: number;
  order: number;
}

export interface GoalPlacement {
  goal_id: string;
  donor_cents: number;
  auto_cents: number;
}

export interface GoalContinuationPlan {
  placements: GoalPlacement[];
  /** Cents no selected goal could take; they continue at the Default goal list. */
  unplaced_cents: number;
}

/** Largest-remainder split of `total` by weight; ties follow insertion order. */
function proportionalShares(
  total: number,
  rows: ReadonlyArray<{ weight: number; order: number; index: number }>,
): number[] {
  const weights = rows.map((row) => (row.weight > 0 ? row.weight : 0));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const effective = weightSum > 0 ? weights : weights.map(() => 1);
  const totalWeight = effective.reduce((sum, weight) => sum + weight, 0);
  const shares = rows.map((_, index) => {
    const numerator = BigInt(total) * BigInt(effective[index]!);
    return {
      index,
      cents: Number(numerator / BigInt(totalWeight)),
      remainder: numerator % BigInt(totalWeight),
    };
  });
  let pennies = total - shares.reduce((sum, row) => sum + row.cents, 0);
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    const orderA = rows[a.index]!.order;
    const orderB = rows[b.index]!.order;
    return orderA - orderB || rows[a.index]!.index - rows[b.index]!.index;
  });
  for (const row of byRemainder) {
    if (pennies <= 0) break;
    shares[row.index]!.cents++;
    pennies--;
  }
  return shares.map((row) => row.cents);
}

/**
 * Pure goal continuation (#201). Cap every ask at its goal's live remaining
 * need, then send the excess to the donor's other selections in proportion,
 * repeating until no selected goal has room. Money still left over leaves the
 * selection set for the Default goal list; the caller decides that. Integer
 * cents throughout, largest remainder, insertion-order ties.
 */
export function planGoalContinuation(
  asks: readonly GoalAsk[],
  capacity: Readonly<Record<string, number>>,
): GoalContinuationPlan {
  const rows: Array<{ goal_id: string; donor: number; auto: number; order: number }> = [];
  for (const ask of asks) {
    if (!Number.isSafeInteger(ask.donor_cents) || ask.donor_cents < 0)
      throw new Error('donor_cents must be non-negative integer cents');
    if (!Number.isSafeInteger(ask.auto_cents) || ask.auto_cents < 0)
      throw new Error('auto_cents must be non-negative integer cents');
    const existing = rows.find((row) => row.goal_id === ask.goal_id);
    if (existing) {
      existing.donor += ask.donor_cents;
      existing.auto += ask.auto_cents;
      existing.order = Math.min(existing.order, ask.order);
    } else {
      rows.push({
        goal_id: ask.goal_id,
        donor: ask.donor_cents,
        auto: ask.auto_cents,
        order: ask.order,
      });
    }
  }
  const placed = rows.map(() => 0);
  let excess = 0;
  rows.forEach((row, index) => {
    const intended = row.donor + row.auto;
    const room = Math.max(0, capacity[row.goal_id] ?? 0);
    const take = Math.min(intended, room);
    placed[index] = take;
    excess += intended - take;
  });
  while (excess > 0) {
    const open = rows
      .map((row, index) => ({
        index,
        weight: row.donor,
        order: row.order,
        room: Math.max(0, (capacity[row.goal_id] ?? 0) - placed[index]!),
      }))
      .filter((row) => row.room > 0);
    if (!open.length) break;
    const shares = proportionalShares(excess, open);
    let moved = 0;
    open.forEach((row, position) => {
      const take = Math.min(shares[position]!, row.room);
      placed[row.index] = placed[row.index]! + take;
      moved += take;
    });
    // Every recipient can fill completely; a round that moves nothing would loop.
    if (moved === 0) break;
    excess -= moved;
  }
  return {
    placements: rows.map((row, index) => {
      const total = placed[index]!;
      const donor = Math.min(row.donor, total);
      return { goal_id: row.goal_id, donor_cents: donor, auto_cents: total - donor };
    }),
    unplaced_cents: excess,
  };
}

export interface GoalCapRow extends GoalPlacement {
  /** Cents the donor's selections intended for this goal, before the cap. */
  intended_cents: number;
  /** Insertion order of the earliest selection for this goal. */
  order: number;
  /** The goal cannot take all of the intended cents. */
  capped: boolean;
}

export interface GoalCapView {
  rows: GoalCapRow[];
  /** Cents that continue to the Default goal list, else Unused pool money. */
  continuation_cents: number;
}

/** Build the review's asks from the immutable plan (donor cents plus top-ups). */
export function planAsks(plan: Pick<PledgePlan, 'selections' | 'top_up_rows'>): GoalAsk[] {
  return plan.selections.flatMap((selection, index) => {
    if (selection.kind !== 'GOAL') return [];
    const auto = plan.top_up_rows.find((row) => row.selection_index === index)?.amount_cents ?? 0;
    return [
      {
        goal_id: selection.target_id,
        donor_cents: selection.amount_cents,
        auto_cents: auto,
        order: selection.insertion_order,
      },
    ];
  });
}

/**
 * Review-only cap model (#201). No stock, eligibility or write decisions: the
 * live remaining need per goal comes from the caller, and the Default goal list
 * is summarized by `continuation_cents`.
 */
export function previewGoalCap(
  plan: Pick<PledgePlan, 'selections' | 'top_up_rows'>,
  remaining_cents: Readonly<Record<string, number>>,
): GoalCapView {
  const asks = planAsks(plan);
  const planOutcome = planGoalContinuation(asks, remaining_cents);
  const intended = new Map<string, { cents: number; order: number }>();
  for (const ask of asks) {
    const row = intended.get(ask.goal_id);
    const cents = ask.donor_cents + ask.auto_cents;
    if (row) row.cents += cents;
    else intended.set(ask.goal_id, { cents, order: ask.order });
  }
  const rows = planOutcome.placements.map((placement) => {
    const wanted = intended.get(placement.goal_id)!.cents;
    return {
      ...placement,
      intended_cents: wanted,
      order: intended.get(placement.goal_id)!.order,
      capped: placement.donor_cents + placement.auto_cents < wanted,
    };
  });
  return { rows, continuation_cents: planOutcome.unplaced_cents };
}
