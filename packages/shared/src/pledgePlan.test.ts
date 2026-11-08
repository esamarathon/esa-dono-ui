import { describe, expect, it } from 'vitest';
import { planPledge } from './pledgePlan.js';

describe('shared pledge plan', () => {
  it('requires validated reward types, rather than treating an unknown type as digital', () => {
    expect(() =>
      planPledge({
        pledge_amount_cents: 1000,
        available_wallet_cents: 1000,
        selections: [
          {
            kind: 'REWARD',
            target_id: 'physical?',
            amount_cents: 500,
            unit_price_cents: 500,
            insertion_order: 0,
          },
        ],
      }),
    ).toThrow('reward_type');
  });
  it.each([
    { available: null, wallet: 0, cash: 1000 },
    { available: 975, wallet: 950, cash: 50 },
    { available: 1000, wallet: 1000, cash: 0 },
    { available: 400, wallet: 400, cash: 600 },
  ])('plans wallet $available as $wallet credit and $cash cash', ({ available, wallet, cash }) => {
    expect(
      planPledge({ pledge_amount_cents: 1000, selections: [], available_wallet_cents: available }),
    ).toMatchObject({
      wallet_applied_cents: wallet,
      new_money_cents: cash,
      requires_shipping: false,
      top_up_rows: [],
    });
  });

  it('locks validated physical prices and keeps their whole cost in new money', () => {
    const plan = planPledge({
      pledge_amount_cents: 1000,
      available_wallet_cents: 1000,
      selections: [
        {
          kind: 'REWARD',
          target_id: 'shirt',
          amount_cents: 1,
          quantity: 2,
          unit_price_cents: 300,
          reward_type: 'PHYSICAL',
          insertion_order: 0,
        },
      ],
    });
    expect(plan).toMatchObject({
      usage_cents: { reward: 600, poll: 0, goal: 0 },
      wallet_applied_cents: 400,
      new_money_cents: 600,
      requires_shipping: true,
    });
    expect(plan.selections[0]).toMatchObject({
      amount_cents: 600,
      unit_price_cents: 300,
      reward_type: 'PHYSICAL',
      quantity: 2,
    });
  });

  it('breaks equal remainder ties by insertion order, not target id or array position', () => {
    expect(
      planPledge({
        pledge_amount_cents: 301,
        available_wallet_cents: null,
        selections: [
          { kind: 'GOAL', target_id: 'a', amount_cents: 100, insertion_order: 2 },
          { kind: 'GOAL', target_id: 'z', amount_cents: 100, insertion_order: 1 },
          { kind: 'GOAL', target_id: 'b', amount_cents: 100, insertion_order: 3 },
        ],
      }).top_up_rows,
    ).toEqual([{ selection_index: 1, amount_cents: 1 }]);
  });

  it('returns three separate overages without topping up an overdrawn Pool', () => {
    const plan = planPledge({
      pledge_amount_cents: 100,
      available_wallet_cents: 10000,
      selections: [
        {
          kind: 'REWARD',
          target_id: 'r',
          unit_price_cents: 200,
          reward_type: 'PHYSICAL',
          amount_cents: 200,
          insertion_order: 0,
        },
        { kind: 'POLL_VOTE', target_id: 'p', amount_cents: 300, insertion_order: 1 },
        { kind: 'GOAL', target_id: 'g', amount_cents: 400, insertion_order: 2 },
      ],
    });
    expect(plan.overage_cents).toEqual({ reward: 100, poll: 200, goal: 300 });
    expect(plan.top_up_rows).toEqual([]);
    expect(plan.wallet_applied_cents).toBe(0);
  });

  it.each([0, 99, 100.5, NaN])('rejects donor selections of %s cents', (amount) => {
    expect(() =>
      planPledge({
        pledge_amount_cents: 1000,
        available_wallet_cents: null,
        selections: [{ kind: 'GOAL', target_id: 'g', amount_cents: amount, insertion_order: 0 }],
      }),
    ).toThrow('Selection amount');
  });

  it('uses exact products even when proportional multiplication exceeds Number precision', () => {
    expect(
      planPledge({
        pledge_amount_cents: 2147483647,
        available_wallet_cents: null,
        selections: [
          { kind: 'GOAL', target_id: 'g1', amount_cents: 100000000, insertion_order: 0 },
          { kind: 'GOAL', target_id: 'g2', amount_cents: 200000000, insertion_order: 1 },
        ],
      }).top_up_rows,
    ).toEqual([
      { selection_index: 0, amount_cents: 615827882 },
      { selection_index: 1, amount_cents: 1231655765 },
    ]);
  });

  it('backs three independent $10 Pools and allocates polls as one flat weighted set', () => {
    const plan = planPledge({
      pledge_amount_cents: 1000,
      available_wallet_cents: null,
      selections: [
        {
          kind: 'REWARD',
          target_id: 'reward',
          amount_cents: 1000,
          unit_price_cents: 1000,
          reward_type: 'DIGITAL',
          insertion_order: 0,
        },
        {
          kind: 'POLL_VOTE',
          target_id: 'a',
          poll_id: 'first',
          amount_cents: 100,
          insertion_order: 1,
        },
        {
          kind: 'POLL_VOTE',
          target_id: 'b',
          poll_id: 'first',
          amount_cents: 200,
          insertion_order: 2,
        },
        {
          kind: 'POLL_VOTE',
          target_id: 'c',
          poll_id: 'second',
          amount_cents: 300,
          insertion_order: 3,
        },
        { kind: 'GOAL', target_id: 'goal', amount_cents: 100, insertion_order: 4 },
      ],
    });
    expect(plan.usage_cents).toEqual({ reward: 1000, poll: 600, goal: 100 });
    expect(plan.overage_cents).toEqual({ reward: 0, poll: 0, goal: 0 });
    // $4 remainder weighted 1:2:3 gives 67, 133, 200 cents, not a split by poll.
    expect(plan.top_up_rows).toEqual([
      { selection_index: 1, amount_cents: 67 },
      { selection_index: 2, amount_cents: 133 },
      { selection_index: 3, amount_cents: 200 },
      { selection_index: 4, amount_cents: 900 },
    ]);
    expect(plan.wallet_applied_cents).toBe(0);
    expect(plan.new_money_cents).toBe(1000);
    expect(plan.requires_shipping).toBe(false);
  });
});
