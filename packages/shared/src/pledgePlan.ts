import { MIN_SPEND_CENTS } from './money.js';

export type PoolCategory = 'reward' | 'poll' | 'goal';
export type PledgeItemKind = 'REWARD' | 'POLL_VOTE' | 'POLL_CUSTOM' | 'GOAL';

/** Prices and physical status come from the caller's validated reward catalog. */
export interface PledgeSelection {
  kind: PledgeItemKind;
  target_id: string;
  poll_id?: string | null;
  amount_cents: number;
  insertion_order: number;
  quantity?: number;
  unit_price_cents?: number | null;
  reward_type?: string | null;
  /** Opaque selection data is carried through unchanged; text validation is live. */
  data?: unknown;
}

export interface PlannedSelection extends PledgeSelection {
  poll_id: string | null;
  quantity: number;
  unit_price_cents: number | null;
  reward_type: string | null;
  data: unknown;
}

export interface PledgePlan {
  pledge_amount_cents: number;
  selections: PlannedSelection[];
  /** Donor-directed usage, before proportional auto-allocation. */
  usage_cents: Record<PoolCategory, number>;
  overage_cents: Record<PoolCategory, number>;
  top_up_rows: Array<{ selection_index: number; amount_cents: number }>;
  wallet_applied_cents: number;
  new_money_cents: number;
  requires_shipping: boolean;
}

function integer(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum} cents`);
  }
}

/**
 * Pure review plan. No stock, eligibility, Channel, text or fallback decisions.
 * Each category gets D independently. Largest remainders use exact integer
 * arithmetic, with insertion-order ties (array order is only the final tie).
 * Overages are returned for the pool bar; they are never silently clipped.
 */
export function planPledge(input: {
  pledge_amount_cents: number;
  selections: readonly PledgeSelection[];
  available_wallet_cents: number | null;
}): PledgePlan {
  const d = input.pledge_amount_cents;
  integer(d, MIN_SPEND_CENTS, 'pledge_amount_cents');
  if (input.available_wallet_cents !== null) {
    integer(input.available_wallet_cents, 0, 'available_wallet_cents');
  }
  const usage: Record<PoolCategory, number> = { reward: 0, poll: 0, goal: 0 };
  let physical = 0;
  const selections = input.selections.map((selection): PlannedSelection => {
    if (!['REWARD', 'POLL_VOTE', 'POLL_CUSTOM', 'GOAL'].includes(selection.kind)) {
      throw new Error('Invalid selection kind');
    }
    integer(selection.insertion_order, 0, 'insertion_order');
    const reward = selection.kind === 'REWARD';
    const quantity = reward ? (selection.quantity ?? 1) : 1;
    integer(quantity, 1, 'quantity');
    const price = reward ? selection.unit_price_cents : null;
    if (reward) {
      integer(price!, 1, 'unit_price_cents');
      if (!['DIGITAL', 'PHYSICAL', 'SHOUTOUT', 'CUSTOM'].includes(selection.reward_type ?? '')) {
        throw new Error('Validated reward_type required');
      }
    }
    const amount = reward ? price! * quantity : selection.amount_cents;
    integer(amount, MIN_SPEND_CENTS, 'Selection amount');
    const category = reward ? 'reward' : selection.kind === 'GOAL' ? 'goal' : 'poll';
    usage[category] += amount;
    integer(usage[category], 0, 'Pool usage');
    if (reward && selection.reward_type === 'PHYSICAL') physical += amount;
    return {
      kind: selection.kind,
      target_id: selection.target_id,
      poll_id: selection.poll_id ?? null,
      amount_cents: amount,
      insertion_order: selection.insertion_order,
      quantity,
      unit_price_cents: price ?? null,
      reward_type: reward ? (selection.reward_type ?? null) : null,
      data: selection.data ?? null,
    };
  });
  const overage = {
    reward: Math.max(0, usage.reward - d),
    poll: Math.max(0, usage.poll - d),
    goal: Math.max(0, usage.goal - d),
  };
  const topUps: PledgePlan['top_up_rows'] = [];
  for (const category of ['poll', 'goal'] as const) {
    const used = usage[category];
    if (used === 0 || used >= d) continue;
    const weighted = selections.flatMap((selection, index) => {
      const matches =
        category === 'goal'
          ? selection.kind === 'GOAL'
          : selection.kind === 'POLL_VOTE' || selection.kind === 'POLL_CUSTOM';
      if (!matches) return [];
      const numerator = BigInt(d - used) * BigInt(selection.amount_cents);
      return [
        {
          index,
          order: selection.insertion_order,
          cents: Number(numerator / BigInt(used)),
          remainder: numerator % BigInt(used),
        },
      ];
    });
    let pennies = d - used - weighted.reduce((sum, row) => sum + row.cents, 0);
    weighted.sort((a, b) =>
      a.remainder === b.remainder
        ? a.order - b.order || a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
    for (const row of weighted) {
      if (pennies > 0) {
        row.cents++;
        pennies--;
      }
      if (row.cents > 0) topUps.push({ selection_index: row.index, amount_cents: row.cents });
    }
  }
  topUps.sort((a, b) => a.selection_index - b.selection_index);
  let wallet = Math.min(input.available_wallet_cents ?? 0, Math.max(0, d - physical));
  if (d - wallet > 0 && d - wallet < 50) wallet = d - 50;
  return {
    pledge_amount_cents: d,
    selections,
    usage_cents: usage,
    overage_cents: overage,
    top_up_rows: topUps,
    wallet_applied_cents: wallet,
    new_money_cents: d - wallet,
    requires_shipping: physical > 0,
  };
}
