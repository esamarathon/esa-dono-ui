import type { Prisma } from '@prisma/client';
import { readDonationAccountingTx } from './poolAccounting.js';
import { readRewardFundingTx } from './rewardFunding.js';
import { claimStatusReasonTx, previewDonationReversalTx } from './reversal.js';
import type { previewPoolShrinkTx } from './paymentRefundShrink.js';

type Tx = Prisma.TransactionClient;
/** Financial allocation totals, never catalog price × count or cross-category money. */
export async function incentiveAllocationTx(tx: Tx, kind: 'reward' | 'poll' | 'goal', id: string) {
  const sources = { donor: 0, auto: 0, moderator: 0 };
  let count = 0;
  if (kind === 'reward') {
    const claims = await tx.rewardClaim.findMany({
      where: {
        reward_id: id,
        reversed_at: null,
        status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] },
      },
    });
    count = claims.length;
    for (const claim of claims) {
      const funding = await readRewardFundingTx(tx, claim);
      sources.donor += funding.redemption_backed
        ? funding.components.reduce((sum, component) => sum + component.effective_cents, 0)
        : claim.amount_cents;
    }
  } else {
    const rows =
      kind === 'poll'
        ? await tx.pollVote.findMany({
            where: { poll_id: id, reversed_at: null },
            select: { source: true, amount_cents: true },
          })
        : await tx.fundContribution.findMany({
            where: { goal_id: id, reversed_at: null },
            select: { source: true, amount_cents: true },
          });
    count = rows.length;
    for (const row of rows)
      if (row.source === 'donor' || row.source === 'auto' || row.source === 'moderator')
        sources[row.source] += row.amount_cents;
  }
  return {
    allocated_cents: sources.donor + sources.auto + sources.moderator,
    allocated_source_cents: sources,
    live_count: count,
  };
}
/** Staff-only projection. Private donor identity is joined ONLY in routes/admin.ts. */
export async function readStaffDonationTx(tx: Tx, id: string) {
  const state = await readDonationAccountingTx(tx, id);
  const donation = await tx.donation.findUniqueOrThrow({
    where: { id },
    include: {
      channel: { select: { id: true, name: true, slug: true, event_id: true } },
      event: { select: { id: true, name: true, ended_at: true } },
    },
  });
  const allocations = {
    reward: await Promise.all(
      state.allocations.reward.map(async (row) => {
        const claim = await tx.rewardClaim.findUniqueOrThrow({
          where: { id: row.id },
          include: { reward: { include: { channel: true } } },
        });
        return {
          ...row,
          label: claim.reward.title,
          channel: claim.reward.channel?.name ?? 'shared',
          recorded_amount_cents: claim.amount_cents,
          current_price_cents: claim.reward.cost_cents,
          chargeback_flagged_at: claim.chargeback_flagged_at,
        };
      }),
    ),
    poll: await Promise.all(
      state.allocations.poll.map(async (row) => {
        const vote = await tx.pollVote.findUniqueOrThrow({
          where: { id: row.id },
          include: { poll: { include: { channel: true } }, poll_option: true },
        });
        return {
          ...row,
          label: `${vote.poll.title}: ${vote.poll_option.label}`,
          channel: vote.poll.channel?.name ?? 'shared',
          allocated_by: vote.allocated_by,
          allocated_at: vote.allocated_at,
        };
      }),
    ),
    goal: await Promise.all(
      state.allocations.goal.map(async (row) => {
        const contribution = await tx.fundContribution.findUniqueOrThrow({
          where: { id: row.id },
          include: { goal: { include: { channel: true } } },
        });
        return {
          ...row,
          label: contribution.goal.title,
          channel: contribution.goal.channel?.name ?? 'shared',
          allocated_by: contribution.allocated_by,
          allocated_at: contribution.allocated_at,
        };
      }),
    ),
  };
  const refunds = await tx.paymentRefund.findMany({
    where: { donation_id: id },
    orderBy: { created_at: 'desc' },
  });
  const flags: string[] = [];
  if (refunds.some((r) => r.status === 'REQUESTED')) flags.push('Payment refund requested');
  if (
    refunds.some(
      (r) =>
        r.status === 'FAILED' ||
        (r.status === 'RESOLVED' &&
          r.accepted_at &&
          r.shipping_cents > 0 &&
          !r.shipping_resolution &&
          r.resolution !== 'REJECTED'),
    )
  )
    flags.push('Payment refund recovery');
  if (allocations.reward.some((r) => r.chargeback_flagged_at))
    flags.push('Shipped claim after chargeback');
  const needs_attention = flags.length > 0;
  if (state.pools.poll.unused_cents > 0 || state.pools.goal.unused_cents > 0)
    flags.push('Unused pool money');
  const ended_target_changes = refunds.flatMap((record) => {
    if (!record.pool_shrink_data) return [];
    const snapshot = JSON.parse(record.pool_shrink_data) as Awaited<
      ReturnType<typeof previewPoolShrinkTx>
    >;
    return snapshot.affected_targets
      .filter((target) => target.ended || target.completed)
      .map((target) => ({ ...target, payment_refund_id: record.id }));
  });
  return {
    ...donation,
    allocations,
    flags,
    ended_target_changes,
    needs_attention,
    unused_cents: { poll: state.pools.poll.unused_cents, goal: state.pools.goal.unused_cents },
    pools: state.pools,
  };
}
export async function donationActionReasonsTx(tx: Tx, id: string) {
  const reason = async (status: 'REFUNDED' | 'CHARGEBACK') => {
    try {
      await previewDonationReversalTx(tx, id, status);
      return null;
    } catch (error) {
      if (error instanceof Error && 'status' in error) return error.message;
      throw error;
    }
  };
  return { REFUNDED: await reason('REFUNDED'), CHARGEBACK: await reason('CHARGEBACK') };
}
/** All admin records, live-only moderator records; own donation null names never fall back. */
export async function readStaffClaimsTx(tx: Tx, liveOnly = false) {
  const claims = await tx.rewardClaim.findMany({
    where: liveOnly
      ? { reversed_at: null, status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] } }
      : {},
    include: {
      reward: true,
      donation: { select: { donor_name: true } },
      donor: {
        select: {
          donations: {
            orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
            take: 1,
            select: { donor_name: true },
          },
        },
      },
    },
    orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
  });
  return Promise.all(
    claims.map(async ({ donor, donation, ...claim }) => {
      let data: unknown = null;
      try {
        data = claim.claim_data ? JSON.parse(claim.claim_data) : null;
      } catch {
        /* historical malformed answer */
      }
      return {
        ...claim,
        claim_data: data,
        donor_name: donation ? donation.donor_name : (donor.donations[0]?.donor_name ?? null),
        funding_donation_ids: (await readRewardFundingTx(tx, claim)).donation_ids,
        toggle_disabled_reason: await claimStatusReasonTx(tx, claim.id),
      };
    }),
  );
}
