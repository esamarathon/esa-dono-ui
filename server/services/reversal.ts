import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { countsTowardTotals } from '../lib/donationTotals.js';
import type { EmitTiltify } from './webhooks/outbox.js';

type Tx = Prisma.TransactionClient;
export type AdjustmentType = 'REFUND' | 'FREEZE_ZERO' | 'MANUAL' | 'CHARGEBACK';

/** Balance and audit row must use the same transaction, including the balance-after snapshot. */
async function adjustWalletTx(
  tx: Tx,
  donorId: string,
  amountCents: number,
  type: AdjustmentType,
  reason: string | null,
  actor: string,
  referenceId: string | null = null,
) {
  const donor = await tx.donor.update({
    where: { id: donorId },
    data: { balance_remaining: { increment: amountCents } },
  });
  return tx.balanceAdjustment.create({
    data: {
      donor_id: donorId,
      amount_cents: amountCents,
      balance_after_cents: donor.balance_remaining,
      type,
      reason,
      reference_id: referenceId,
      created_by: actor,
    },
  });
}

async function decrementPollTalliesTx(tx: Tx, optionId: string, pollId: string, cents: number) {
  await tx.pollOption.update({
    where: { id: optionId },
    data: { votes_cents: { decrement: cents } },
  });
  await tx.poll.update({
    where: { id: pollId },
    data: { total_votes_cents: { decrement: cents } },
  });
}

/** Approval shares the rejection transaction boundary so neither can act on stale funding. */
export async function moderateCustomEntryTx(
  tx: Tx,
  entryId: string,
  status: 'APPROVED' | 'REJECTED',
  actor: string,
) {
  const entry = await tx.pollCustomEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw httpError(404, 'Entry not found');
  if (entry.status !== 'PENDING') throw httpError(400, 'Only pending entries can be moderated');
  const option = await tx.pollOption.findUnique({ where: { custom_entry_id: entry.id } });
  if (!option) throw httpError(404, 'Associated poll option not found');
  const vote = await tx.pollVote.findFirst({
    where: { poll_option_id: option.id, reversed_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (!vote) throw httpError(404, 'Associated funding vote not found');
  if (option.status !== 'PENDING_APPROVAL') {
    throw httpError(400, 'Only pending entries can be moderated');
  }

  if (status === 'APPROVED') {
    await tx.pollOption.update({
      where: { id: option.id },
      data: { status: 'ACTIVE', votes_cents: { increment: vote.amount_cents } },
    });
    await tx.poll.update({
      where: { id: entry.poll_id },
      data: { total_votes_cents: { increment: vote.amount_cents } },
    });
  } else {
    await adjustWalletTx(
      tx,
      vote.donor_id,
      vote.amount_cents,
      'REFUND',
      'Rejected custom poll entry',
      actor,
      vote.id,
    );
    await tx.pollVote.update({
      where: { id: vote.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    await tx.pollOption.update({ where: { id: option.id }, data: { status: 'REJECTED' } });
  }
  return tx.pollCustomEntry.update({ where: { id: entry.id }, data: { status } });
}

export async function sweepWalletCreditsTx(
  tx: Tx,
  where: Prisma.DonorWhereInput,
  confirm: boolean,
  actor: string,
) {
  const donors = await tx.donor.findMany({
    where,
    select: {
      id: true,
      balance_remaining: true,
      donations: { orderBy: { created_at: 'desc' }, take: 1, select: { donor_name: true } },
    },
  });
  const totalCents = donors.reduce((sum, donor) => sum + donor.balance_remaining, 0);
  if (!confirm) {
    return {
      preview: true,
      donor_count: donors.length,
      total_cents: totalCents,
      sample: donors.slice(0, 10).map((donor) => ({
        id: donor.id,
        balance_remaining: donor.balance_remaining,
        donor_name: donor.donations[0]?.donor_name ?? null,
      })),
    };
  }
  for (const donor of donors) {
    const displayName = donor.donations[0]?.donor_name || 'Anonymous';
    await adjustWalletTx(
      tx,
      donor.id,
      -donor.balance_remaining,
      'FREEZE_ZERO',
      `Bulk credit sweep (${displayName})`,
      actor,
    );
  }
  return { success: true, donor_count: donors.length, total_cents: totalCents };
}

export async function adjustWalletCreditTx(
  tx: Tx,
  donorId: string,
  cents: number,
  type: AdjustmentType,
  reason: string | undefined,
  actor: string,
) {
  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor) throw httpError(404, 'Donor not found');
  if (donor.balance_remaining + cents < 0) {
    throw httpError(400, 'Adjustment would result in negative balance');
  }
  const adjustment = await adjustWalletTx(tx, donorId, cents, type, reason || null, actor);
  return {
    success: true,
    email: donor.email,
    balance_before: donor.balance_remaining,
    balance_after: adjustment.balance_after_cents,
    adjustment: cents,
  };
}

export async function refundGoalContributions(tx: Tx, goalId: string, actor: string) {
  const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
  if (!goal) throw httpError(404, 'Goal not found');
  const contributions = await tx.fundContribution.findMany({
    where: { goal_id: goalId, reversed_at: null },
    orderBy: { created_at: 'asc' },
  });
  let refundedCents = 0;
  for (const contribution of contributions) {
    await adjustWalletTx(
      tx,
      contribution.donor_id,
      contribution.amount_cents,
      'REFUND',
      'Refunded removed fundraising goal',
      actor,
      contribution.id,
    );
    await tx.fundContribution.update({
      where: { id: contribution.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    refundedCents += contribution.amount_cents;
  }
  if (refundedCents > 0) {
    await tx.fundGoal.update({
      where: { id: goal.id },
      data: {
        current_cents: { decrement: refundedCents },
        is_complete: goal.current_cents - refundedCents >= goal.target_cents,
      },
    });
  }
  return { refunded_count: contributions.length, refunded_cents: refundedCents };
}

export async function refundPollOptionVotes(tx: Tx, optionId: string, actor: string) {
  const option = await tx.pollOption.findUnique({ where: { id: optionId } });
  if (!option) throw httpError(404, 'Poll option not found');
  const votes = await tx.pollVote.findMany({
    where: { poll_option_id: optionId, reversed_at: null },
    orderBy: { created_at: 'asc' },
  });
  let refundedCents = 0;
  for (const vote of votes) {
    await adjustWalletTx(
      tx,
      vote.donor_id,
      vote.amount_cents,
      'REFUND',
      'Refunded removed poll option',
      actor,
      vote.id,
    );
    await tx.pollVote.update({
      where: { id: vote.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    refundedCents += vote.amount_cents;
  }
  if (option.status === 'ACTIVE' && refundedCents > 0) {
    await decrementPollTalliesTx(tx, option.id, option.poll_id, refundedCents);
  }
  return { refunded_count: votes.length, refunded_cents: refundedCents };
}

/** Keep today's clawback rule, not ADR-0011's future Wallet refund rule. */
export async function setDonationStatusTx(
  tx: Tx,
  donationId: string,
  status: string,
  reason: string | undefined,
  actor: string,
  tiltify: EmitTiltify,
) {
  const donation = await tx.donation.findUnique({
    where: { id: donationId },
    include: { donor: true },
  });
  if (!donation) throw httpError(404, 'Donation not found');
  if (donation.refund_id) {
    throw httpError(400, 'Donation is refunded/charged back and cannot change status');
  }
  if (donation.status === status) throw httpError(400, 'Donation already has this status');

  let refundId: string | undefined;
  if (status === 'REFUNDED' || status === 'CHARGEBACK') {
    const clawback = Math.min(donation.amount_cents, donation.donor.balance_remaining);
    const adjustment = await adjustWalletTx(
      tx,
      donation.donor_id,
      -clawback,
      status === 'REFUNDED' ? 'REFUND' : 'CHARGEBACK',
      reason || `Donation ${status.toLowerCase()}`,
      actor,
      donation.id,
    );
    refundId = adjustment.id;
  }
  const row = await tx.donation.update({
    where: { id: donationId },
    data: { status, ...(refundId ? { refund_id: refundId } : {}) },
    include: {
      donor: { select: { email: true } },
      channel: { select: { id: true, name: true, slug: true, event_id: true } },
    },
  });
  // Preserve existing publication: only counted-set transitions publish totals.
  if (countsTowardTotals(donation.status) !== countsTowardTotals(status)) {
    await tiltify.totals(row.channel_id);
  }
  return row;
}

/** Call inside the caller's transaction; eligibility is never read before it starts. */
export async function reverseSpendTx(
  tx: Tx,
  donorId: string,
  spendType: string,
  spendId: string,
  actor: string,
) {
  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor) throw httpError(404, 'Donor not found');

  if (spendType === 'claim') {
    const claim = await tx.rewardClaim.findUnique({
      where: { id: spendId },
      include: { reward: true },
    });
    if (!claim || claim.donor_id !== donorId) throw httpError(404, 'Claim not found');
    if (claim.status === 'REVERSED') throw httpError(400, 'Claim already reversed');
    if (claim.status === 'FULFILLED') {
      throw httpError(400, 'Cannot reverse fulfilled claim; mark it as PENDING first');
    }

    // Deliberately keep the live-price rule until PRD-0003 slice 5.
    await adjustWalletTx(
      tx,
      donorId,
      claim.reward.cost_cents,
      'REFUND',
      'Reversed reward claim',
      actor,
      claim.id,
    );
    await tx.rewardClaim.update({
      where: { id: claim.id },
      data: { status: 'REVERSED', reversed_at: new Date(), reversed_by: actor },
    });
    await tx.reward.update({
      where: { id: claim.reward_id },
      data: { quantity_claimed: { decrement: 1 } },
    });
  } else if (spendType === 'vote') {
    const vote = await tx.pollVote.findUnique({ where: { id: spendId } });
    if (!vote || vote.donor_id !== donorId) throw httpError(404, 'Vote not found');
    if (vote.reversed_at) throw httpError(400, 'Vote already reversed');
    const option = await tx.pollOption.findUnique({ where: { id: vote.poll_option_id } });

    await adjustWalletTx(
      tx,
      donorId,
      vote.amount_cents,
      'REFUND',
      'Reversed poll vote',
      actor,
      vote.id,
    );
    await tx.pollVote.update({
      where: { id: vote.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    // Pending write-ins have not entered the public tally yet.
    if (option?.status === 'ACTIVE') {
      await decrementPollTalliesTx(tx, option.id, vote.poll_id, vote.amount_cents);
    } else if (option) {
      await tx.pollOption.update({ where: { id: option.id }, data: { status: 'REJECTED' } });
    }
  } else if (spendType === 'contribution') {
    const contribution = await tx.fundContribution.findUnique({ where: { id: spendId } });
    if (!contribution || contribution.donor_id !== donorId) {
      throw httpError(404, 'Contribution not found');
    }
    if (contribution.reversed_at) throw httpError(400, 'Contribution already reversed');
    const goal = await tx.fundGoal.findUnique({ where: { id: contribution.goal_id } });

    await adjustWalletTx(
      tx,
      donorId,
      contribution.amount_cents,
      'REFUND',
      'Reversed fund contribution',
      actor,
      contribution.id,
    );
    await tx.fundContribution.update({
      where: { id: contribution.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    if (goal) {
      await tx.fundGoal.update({
        where: { id: goal.id },
        data: {
          current_cents: { decrement: contribution.amount_cents },
          // Keep this path's historical rule, distinct from a per-goal reversal.
          is_complete: goal.current_cents - contribution.amount_cents <= 0 ? false : undefined,
        },
      });
    }
  } else {
    throw httpError(400, 'Invalid spend_type. Must be claim, vote, or contribution');
  }
}
