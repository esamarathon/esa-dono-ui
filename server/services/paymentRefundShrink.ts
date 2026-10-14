import type { Prisma } from '@prisma/client';
import type { PoolCategory } from '@dono/shared';
import { readDonationAccountingTx } from './poolAccounting.js';

type Tx = Prisma.TransactionClient;
type Component = {
  kind: 'claim' | 'vote' | 'contribution' | 'redemption' | 'credit';
  id: string;
  category: PoolCategory;
  before_cents: number;
  after_cents: number;
  target_id: string | null;
  allocation_id: string | null;
  ended: boolean;
  completed: boolean;
  reduced_before_cents: number;
  reduced_after_cents: number;
};

/** Financial components, not reward entitlements. Original redemptions remain immutable. */
export async function previewPoolShrinkTx(
  tx: Tx,
  donationId: string,
  claimId: string,
  itemCents: number,
) {
  const state = await readDonationAccountingTx(tx, donationId);
  const components: Component[] = [];
  const add = (component: Omit<Component, 'after_cents' | 'reduced_after_cents'>) => {
    components.push({
      ...component,
      after_cents: component.before_cents,
      reduced_after_cents: component.reduced_before_cents,
    });
  };
  const directClaims = await tx.rewardClaim.findMany({
    where: {
      donation_id: donationId,
      id: { not: claimId },
      reversed_at: null,
      status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] },
      credit_redemptions: { none: {} },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  for (const row of directClaims)
    add({
      kind: 'claim',
      id: row.id,
      category: 'reward',
      before_cents: row.amount_cents,
      target_id: row.reward_id,
      allocation_id: row.id,
      ended: false,
      completed: false,
      reduced_before_cents: 0,
    });
  const votes = await tx.pollVote.findMany({
    where: { donation_id: donationId, reversed_at: null },
    include: { poll: true, credit_redemptions: true },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  const contributions = await tx.fundContribution.findMany({
    where: { donation_id: donationId, reversed_at: null },
    include: { goal: true, credit_redemptions: true },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  for (const row of votes)
    if (!row.credit_redemptions.length)
      add({
        kind: 'vote',
        id: row.id,
        category: 'poll',
        before_cents: row.amount_cents,
        target_id: row.poll_option_id,
        allocation_id: row.id,
        ended: !row.poll.is_active || !!(row.poll.ends_at && row.poll.ends_at <= new Date()),
        completed: false,
        reduced_before_cents: 0,
      });
  for (const row of contributions)
    if (!row.credit_redemptions.length)
      add({
        kind: 'contribution',
        id: row.id,
        category: 'goal',
        before_cents: row.amount_cents,
        target_id: row.goal_id,
        allocation_id: row.id,
        ended: !row.goal.is_active,
        completed: row.goal.is_complete,
        reduced_before_cents: 0,
      });
  const redemptions = await tx.poolCreditRedemption.findMany({
    where: {
      credit: { donation_id: donationId },
      OR: [
        { claim: { reversed_at: null, status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] } } },
        { vote: { reversed_at: null } },
        { contribution: { reversed_at: null } },
      ],
    },
    include: {
      credit: true,
      claim: true,
      vote: { include: { poll: true } },
      contribution: { include: { goal: true } },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  for (const row of redemptions)
    add({
      kind: 'redemption',
      id: row.id,
      category: row.credit.category as PoolCategory,
      before_cents: row.amount_cents - row.reduced_cents,
      target_id:
        row.claim?.reward_id ?? row.vote?.poll_option_id ?? row.contribution?.goal_id ?? null,
      allocation_id: row.claim_id ?? row.vote_id ?? row.contribution_id,
      ended: row.vote
        ? !row.vote.poll.is_active ||
          !!(row.vote.poll.ends_at && row.vote.poll.ends_at <= new Date())
        : row.contribution
          ? !row.contribution.goal.is_active
          : false,
      completed: row.contribution?.goal.is_complete ?? false,
      reduced_before_cents: row.reduced_cents,
    });
  const credits = await tx.poolCredit.findMany({
    where: { donation_id: donationId, remaining_cents: { gt: 0 } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  for (const row of credits)
    add({
      kind: 'credit',
      id: row.id,
      category: row.category as PoolCategory,
      before_cents: row.remaining_cents,
      target_id: null,
      allocation_id: null,
      ended: false,
      completed: false,
      reduced_before_cents: 0,
    });
  const budget = state.pledge_amount_cents! - itemCents - state.failed_payment_wallet_credit_cents;
  const categories = {} as Record<
    PoolCategory,
    {
      before_cents: number;
      after_cents: number;
      unused_consumed_cents: number;
      reduced_cents: number;
    }
  >;
  for (const category of ['reward', 'poll', 'goal'] as const) {
    const rows = components.filter((row) => row.category === category);
    const total = rows.reduce((sum, row) => sum + row.before_cents, 0);
    const reduction = Math.max(0, total - Math.max(0, budget));
    // Exact integer largest remainder; stable reader order breaks equal remainders.
    const ranked = rows
      .map((row, index) => {
        const numerator = BigInt(row.before_cents) * BigInt(reduction);
        const floor = total ? Number(numerator / BigInt(total)) : 0;
        row.after_cents -= floor;
        return { row, index, remainder: total ? numerator % BigInt(total) : 0n };
      })
      .sort((a, b) =>
        a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
      );
    const remaining =
      reduction - rows.reduce((sum, row) => sum + row.before_cents - row.after_cents, 0);
    for (let i = 0; i < remaining; i++) ranked[i]!.row.after_cents--;
    for (const row of rows)
      if (row.kind === 'redemption') row.reduced_after_cents += row.before_cents - row.after_cents;
    categories[category] = {
      before_cents: state.pledge_amount_cents!,
      after_cents: state.pledge_amount_cents! - itemCents,
      unused_consumed_cents: itemCents - reduction,
      reduced_cents: reduction,
    };
  }
  return {
    donation_id: donationId,
    claim_id: claimId,
    money_before_cents: state.amount_cents,
    money_after_cents: state.amount_cents - itemCents,
    pledge_before_cents: state.pledge_amount_cents!,
    pledge_after_cents: state.pledge_amount_cents! - itemCents,
    wallet_applied_cents: state.wallet_applied_cents,
    failed_payment_wallet_credit_cents: state.failed_payment_wallet_credit_cents,
    categories,
    components,
  };
}

/** No ordinary reverseSpend: acceptance must never mint category or Wallet credit. */
export async function applyPoolShrinkTx(
  tx: Tx,
  plan: Awaited<ReturnType<typeof previewPoolShrinkTx>>,
  actor: string,
) {
  const now = new Date();
  for (const component of plan.components) {
    const cents = component.before_cents - component.after_cents;
    if (!cents) continue;
    if (component.kind === 'credit') {
      await tx.poolCredit.update({
        where: { id: component.id },
        data: { remaining_cents: component.after_cents },
      });
      continue;
    }
    if (component.kind === 'redemption') {
      await tx.poolCreditRedemption.update({
        where: { id: component.id },
        data: { reduced_cents: component.reduced_after_cents },
      });
      // A reward is one entitlement regardless of how many sources fund it.
      if (component.category === 'reward') continue;
    }
    const id = component.allocation_id!;
    if (component.category === 'reward') {
      await tx.rewardClaim.update({ where: { id }, data: { amount_cents: component.after_cents } });
    } else if (component.category === 'poll') {
      const row = await tx.pollVote.findUniqueOrThrow({
        where: { id },
        include: { poll_option: true },
      });
      const after = row.amount_cents - cents;
      await tx.pollVote.update({
        where: { id },
        data: {
          amount_cents: after,
          ...(after === 0 ? { reversed_at: now, reversed_by: actor } : {}),
        },
      });
      if (row.poll_option.status === 'ACTIVE') {
        await tx.pollOption.update({
          where: { id: row.poll_option_id },
          data: { votes_cents: { decrement: cents } },
        });
        await tx.poll.update({
          where: { id: row.poll_id },
          data: { total_votes_cents: { decrement: cents } },
        });
      }
    } else {
      const row = await tx.fundContribution.findUniqueOrThrow({ where: { id } });
      const after = row.amount_cents - cents;
      await tx.fundContribution.update({
        where: { id },
        data: {
          amount_cents: after,
          ...(after === 0 ? { reversed_at: now, reversed_by: actor } : {}),
        },
      });
      // #167: completed goals STAY complete; do not apply the ordinary reversal policy.
      await tx.fundGoal.update({
        where: { id: row.goal_id },
        data: { current_cents: { decrement: cents } },
      });
    }
  }
}
