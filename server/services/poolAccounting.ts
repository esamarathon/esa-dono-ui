import type { PledgeItem, Prisma } from '@prisma/client';
import type { PoolCategory } from '@dono/shared';
import { httpError } from '../lib/httpError.js';

// Row liveness, the category budget and the Payment-refund freeze are the
// pooled accounting rules (ADR-0011). This module is their only home: every
// allocation query builds its filter from the functions below.

/** Live allocation row: not reversed. */
export function liveRowWhere(): { reversed_at: null } {
  return { reversed_at: null };
}

/** Live claim rows: not reversed and still counting (ADR-0011 §5). */
export function liveClaimWhere(): Prisma.RewardClaimWhereInput {
  return { ...liveRowWhere(), status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] } };
}

/** Live claims funded directly by their donation, not by Pool credit. */
export function liveDirectClaimWhere(): Prisma.RewardClaimWhereInput {
  return { ...liveClaimWhere(), credit_redemptions: { none: {} } };
}

/** Live claims this donation funded through Pool credit. */
export function liveCreditBackedClaimWhere(donationId: string): Prisma.RewardClaimWhereInput {
  return {
    ...liveClaimWhere(),
    credit_redemptions: { some: { credit: { donation_id: donationId } } },
  };
}

/**
 * What a category can still take: the pledge amount minus failed-payment
 * Wallet credit, live rows and reservations (ADR-0011 §1.7).
 */
export function categoryBudgetRemainingCents(
  used: { live_cents: number; outstanding_credit_cents: number },
  pledge_amount_cents: number,
  failed_payment_wallet_credit_cents: number,
): number {
  return (
    pledge_amount_cents -
    failed_payment_wallet_credit_cents -
    used.live_cents -
    used.outstanding_credit_cents
  );
}

// A REQUESTED Payment refund freezes the donation's money until it resolves.
export const requestedPaymentRefundWhere = { status: 'REQUESTED' } as const;

export async function hasRequestedPaymentRefundTx(
  tx: Prisma.TransactionClient,
  donationId: string,
): Promise<boolean> {
  return (
    (await tx.paymentRefund.count({
      where: { donation_id: donationId, ...requestedPaymentRefundWhere },
    })) > 0
  );
}

export async function assertNoRequestedPaymentRefundTx(
  tx: Prisma.TransactionClient,
  donationId: string | null,
): Promise<void> {
  if (donationId && (await hasRequestedPaymentRefundTx(tx, donationId)))
    throw httpError(409, 'A Payment refund is requested for this donation');
}

/** Confirmed initial reward type wins; historical rows fall back to the catalog. */
export function confirmedRewardType(
  claim: { reward_id: string; reward: { type: string } },
  items: readonly Pick<PledgeItem, 'kind' | 'target_id' | 'confirmed_reward_type'>[] | undefined,
): string {
  return (
    items?.find((item) => item.kind === 'REWARD' && item.target_id === claim.reward_id)
      ?.confirmed_reward_type ?? claim.reward.type
  );
}

/** Redemptions are canonical funding, even when a whole entitlement has donation_id=null. */
export async function readRewardFundingTx(
  tx: Prisma.TransactionClient,
  claim: { id: string; donation_id: string | null; amount_cents: number },
) {
  const rows = await tx.poolCreditRedemption.findMany({
    where: { claim_id: claim.id },
    select: {
      id: true,
      credit_id: true,
      amount_cents: true,
      reduced_cents: true,
      credit: { select: { donation_id: true, donation: { select: { created_at: true } } } },
    },
  });
  const amounts = new Map<string, number>();
  for (const row of rows)
    amounts.set(
      row.credit.donation_id,
      (amounts.get(row.credit.donation_id) ?? 0) + row.amount_cents - row.reduced_cents,
    );
  const ordered = [...rows].sort(
    (a, b) =>
      a.credit.donation.created_at.getTime() - b.credit.donation.created_at.getTime() ||
      a.credit.donation_id.localeCompare(b.credit.donation_id),
  );
  return {
    redemption_backed: rows.length > 0,
    components: rows.map(({ credit, ...row }) => ({
      ...row,
      effective_cents: row.amount_cents - row.reduced_cents,
      donation_id: credit.donation_id,
    })),
    donation_ids: rows.length
      ? [...new Set(ordered.map((row) => row.credit.donation_id))]
      : claim.donation_id
        ? [claim.donation_id]
        : [],
    carrier_donation_id: ordered[0]?.credit.donation_id ?? claim.donation_id,
    source_cents: rows.length
      ? amounts
      : new Map(claim.donation_id ? [[claim.donation_id, claim.amount_cents]] : []),
  };
}

/** Source-local financial projection; entitlement/stock/status still belong to ONE claim. */
export async function readCreditRewardAllocationsTx(
  tx: Prisma.TransactionClient,
  donationId: string,
) {
  const claims = await tx.rewardClaim.findMany({
    where: liveCreditBackedClaimWhere(donationId),
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true, donation_id: true, reward_id: true, amount_cents: true, status: true },
  });
  const result = [];
  for (const claim of claims) {
    const funding = await readRewardFundingTx(tx, claim);
    result.push({
      id: claim.id,
      reward_id: claim.reward_id,
      status: claim.status,
      source: 'donor' as const,
      amount_cents: funding.source_cents.get(donationId)!,
      entitlement_amount_cents: claim.amount_cents,
      carrier_donation_id: funding.carrier_donation_id!,
    });
  }
  return result;
}

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
            categoryBudgetRemainingCents(
              { live_cents: live, outstanding_credit_cents: reserved },
              input.pledge_amount_cents!,
              input.failed_payment_wallet_credit_cents,
            ),
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
        where: liveDirectClaimWhere(),
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, reward_id: true, amount_cents: true, status: true },
      },
      poll_votes: {
        where: liveRowWhere(),
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
        where: liveRowWhere(),
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, goal_id: true, amount_cents: true, source: true },
      },
      pool_credits: { select: { category: true, remaining_cents: true } },
    },
  });
  if (!donation) throw httpError(404, 'Donation not found');
  const { event, pool_credits, reward_claims, poll_votes, contributions, ...fields } = donation;
  const allocations = {
    reward: [
      ...reward_claims.map((row) => ({ ...row, source: 'donor' as const })),
      ...(await readCreditRewardAllocationsTx(tx, donationId)),
    ],
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
