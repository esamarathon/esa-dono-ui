import type { Prisma } from '@prisma/client';
import type { PoolCategory } from '@dono/shared';
import { httpError } from '../lib/httpError.js';

export type CategoryAmounts = Record<PoolCategory, number>;
export interface PoolAccountingInput {
  pledge_amount_cents: number | null;
  status: string;
  event_ended: boolean;
  failed_payment_wallet_credit_cents: number;
  live_cents: CategoryAmounts;
  outstanding_credit_cents: CategoryAmounts;
}

/** One reservation rule for reversals, credit spending, assignment and reporting. */
export function computePoolAccounting(input: PoolAccountingInput) {
  const category = (key: PoolCategory) => {
    const live = input.live_cents[key];
    const outstanding = input.outstanding_credit_cents[key];
    const pooled = input.pledge_amount_cents !== null;
    const active = pooled && input.status === 'COMPLETED';
    // A retained shipped claim can later be reversed after a Wallet refund.
    // Only a chargeback blocks that ordinary category-credit rule (ADR-0011 §5.3).
    const creditAvailable = pooled && ['COMPLETED', 'REFUNDED'].includes(input.status);
    // Poll/goal raw grants survive end for Undo end, but stop reserving the
    // assignment budget. Subtract live assignments BEFORE clamping at zero.
    const reserved = active && input.event_ended && key !== 'reward' ? 0 : outstanding;
    const unused =
      active && key !== 'reward'
        ? Math.max(
            0,
            input.pledge_amount_cents! - live - reserved - input.failed_payment_wallet_credit_cents,
          )
        : 0;
    return {
      live_cents: live,
      outstanding_credit_cents: outstanding,
      pool_credit_cents: creditAvailable && !input.event_ended ? outstanding : 0,
      unused_cents: unused,
      // Expired reward credit remains reserved; ending an Event never mints Wallet credit.
      used_cents: live + reserved + unused,
    };
  };
  return { reward: category('reward'), poll: category('poll'), goal: category('goal') };
}

/** Safe, tx-aware current accounting. No email, claim answers or staff identities are read. */
export async function readDonationAccountingTx(tx: Prisma.TransactionClient, donationId: string) {
  const donation = await tx.donation.findUnique({
    where: { id: donationId },
    select: {
      id: true,
      donor_id: true,
      channel_id: true,
      event_id: true,
      status: true,
      amount_cents: true,
      pledge_amount_cents: true,
      wallet_applied_cents: true,
      wallet_credit_granted_cents: true,
      failed_payment_wallet_credit_cents: true,
      event: { select: { ended_at: true } },
      reward_claims: {
        where: { reversed_at: null, status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] } },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, reward_id: true, amount_cents: true, status: true },
      },
      poll_votes: {
        where: { reversed_at: null },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          poll_id: true,
          poll_option_id: true,
          amount_cents: true,
          source: true,
          poll_option: { select: { status: true } },
        },
      },
      contributions: {
        where: { reversed_at: null },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, goal_id: true, amount_cents: true, source: true },
      },
      pool_credits: { select: { category: true, remaining_cents: true } },
    },
  });
  if (!donation) throw httpError(404, 'Donation not found');
  const { event, pool_credits, reward_claims, poll_votes, contributions, ...fields } = donation;
  const allocations = {
    reward: reward_claims.map((row) => ({ ...row, source: 'donor' as const })),
    poll: poll_votes.map(({ poll_option, ...row }) => ({ ...row, status: poll_option.status })),
    goal: contributions,
  };
  const sum = (rows: { amount_cents: number }[]) =>
    rows.reduce((total, row) => total + row.amount_cents, 0);
  const outstanding = (category: PoolCategory) =>
    pool_credits
      .filter((row) => row.category === category)
      .reduce((total, row) => total + row.remaining_cents, 0);
  return {
    ...fields,
    event_ended_at: event?.ended_at ?? null,
    allocations,
    pools: computePoolAccounting({
      ...fields,
      event_ended: !!event?.ended_at,
      live_cents: {
        reward: sum(allocations.reward),
        poll: sum(allocations.poll),
        goal: sum(allocations.goal),
      },
      outstanding_credit_cents: {
        reward: outstanding('reward'),
        poll: outstanding('poll'),
        goal: outstanding('goal'),
      },
    }),
  };
}
