import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { countsTowardTotals } from '../lib/donationTotals.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';
import { readDonationAccountingTx } from './poolAccounting.js';
import { readRewardFundingTx } from './rewardFunding.js';

type Tx = Prisma.TransactionClient;

/** Serialize eligibility reads before any mutation, also across SQLite clients. */
async function lockReversalTx(tx: Tx) {
  await tx.$executeRaw`UPDATE Donor SET id = id WHERE 0`;
}
export type AdjustmentType = 'REFUND' | 'FREEZE_ZERO' | 'MANUAL' | 'CHARGEBACK' | 'WALLET_REFUND';

async function returnRowFundingTx(
  tx: Tx,
  row: {
    id: string;
    donor_id: string;
    donation_id: string | null;
    amount_cents: number;
    source?: string;
  },
  category: 'reward' | 'poll' | 'goal',
  actor: string,
  reason: string,
  terminalDonationId?: string,
) {
  // Check canonical redemption funding BEFORE the legacy-null Wallet fallback.
  const redemptions = await tx.poolCreditRedemption.findMany({
    where:
      category === 'reward'
        ? { claim_id: row.id }
        : category === 'poll'
          ? { vote_id: row.id }
          : { contribution_id: row.id },
    select: {
      amount_cents: true,
      reduced_cents: true,
      credit_id: true,
      credit: { select: { donation_id: true, donation: { select: { status: true } } } },
    },
  });
  if (redemptions.length) {
    for (const redemption of redemptions) {
      await assertNoRequestedRefundTx(tx, redemption.credit.donation_id);
      if (
        redemption.credit.donation_id === terminalDonationId ||
        redemption.credit.donation.status === 'CHARGEBACK'
      )
        continue;
      await tx.poolCredit.update({
        where: { id: redemption.credit_id },
        data: {
          remaining_cents: { increment: redemption.amount_cents - redemption.reduced_cents },
          cleared_at: null,
          cleared_by: null,
        },
      });
    }
    return;
  }
  await assertNoRequestedRefundTx(tx, row.donation_id);
  const donation = row.donation_id
    ? await tx.donation.findUniqueOrThrow({ where: { id: row.donation_id } })
    : null;
  // Old terminal rows are not repaired, and cannot mint credit for lost money.
  if (donation?.status === 'CHARGEBACK') return;
  if (donation?.pledge_amount_cents != null) {
    if (row.source === 'moderator' || row.amount_cents === 0) return;
    await tx.poolCredit.create({
      data: {
        donation_id: donation.id,
        category,
        amount_cents: row.amount_cents,
        remaining_cents: row.amount_cents,
        created_by: actor,
        ...(category === 'reward'
          ? { source_claim_id: row.id }
          : category === 'poll'
            ? { source_vote_id: row.id }
            : { source_contribution_id: row.id }),
      },
    });
  } else {
    await adjustWalletTx(
      tx,
      row.donor_id,
      row.amount_cents,
      'REFUND',
      reason,
      actor,
      row.id,
      row.donation_id,
    );
  }
}

/** Balance and audit row must use the same transaction, including the balance-after snapshot. */
async function adjustWalletTx(
  tx: Tx,
  donorId: string,
  amountCents: number,
  type: AdjustmentType,
  reason: string | null,
  actor: string,
  referenceId: string | null = null,
  donationId: string | null = null,
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
      donation_id: donationId,
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
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  const entry = await tx.pollCustomEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw httpError(404, 'Entry not found');
  if (entry.status !== 'PENDING') throw httpError(400, 'Only pending entries can be moderated');
  const option = await tx.pollOption.findUnique({ where: { custom_entry_id: entry.id } });
  if (!option) throw httpError(404, 'Associated poll option not found');
  const votes = await tx.pollVote.findMany({
    where: { poll_option_id: option.id, reversed_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (!votes.length) throw httpError(404, 'Associated funding vote not found');
  if (option.status !== 'PENDING_APPROVAL') {
    throw httpError(400, 'Only pending entries can be moderated');
  }

  const donationIds = [
    ...new Set(votes.flatMap((vote) => (vote.donation_id ? [vote.donation_id] : []))),
  ];
  for (const id of donationIds) await assertNoRequestedRefundTx(tx, id);
  const before = await publisher.snapshot(donationIds);
  if (status === 'APPROVED') {
    const cents = votes.reduce((sum, vote) => sum + vote.amount_cents, 0);
    await tx.pollOption.update({
      where: { id: option.id },
      data: { status: 'ACTIVE', votes_cents: { increment: cents } },
    });
    await tx.poll.update({
      where: { id: entry.poll_id },
      data: { total_votes_cents: { increment: cents } },
    });
  } else {
    for (const vote of votes) {
      await returnRowFundingTx(tx, vote, 'poll', actor, 'Rejected custom poll entry');
      await tx.pollVote.update({
        where: { id: vote.id },
        data: { reversed_at: new Date(), reversed_by: actor },
      });
    }
    await tx.pollOption.update({ where: { id: option.id }, data: { status: 'REJECTED' } });
  }
  const updated = await tx.pollCustomEntry.update({ where: { id: entry.id }, data: { status } });
  await publisher.publish(donationIds, before);
  return updated;
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
    balance_before: donor.balance_remaining,
    balance_after: adjustment.balance_after_cents,
    adjustment: cents,
  };
}

export async function refundGoalContributions(
  tx: Tx,
  goalId: string,
  actor: string,
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
  if (!goal) throw httpError(404, 'Goal not found');
  const contributions = await tx.fundContribution.findMany({
    where: { goal_id: goalId, reversed_at: null },
    orderBy: { created_at: 'asc' },
  });
  const ids = [
    ...new Set(contributions.flatMap((row) => (row.donation_id ? [row.donation_id] : []))),
  ];
  const before = await publisher.snapshot(ids);
  let refundedCents = 0;
  for (const contribution of contributions) {
    await returnRowFundingTx(tx, contribution, 'goal', actor, 'Refunded removed fundraising goal');
    await tx.fundContribution.update({
      where: { id: contribution.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    refundedCents += contribution.amount_cents;
  }
  await tx.fundGoal.update({
    where: { id: goal.id },
    data: {
      current_cents: { decrement: refundedCents },
      is_complete: goal.current_cents - refundedCents >= goal.target_cents,
    },
  });
  await publisher.publish(ids, before);
  return { refunded_count: contributions.length, refunded_cents: refundedCents };
}

export async function refundPollOptionVotes(
  tx: Tx,
  optionId: string,
  actor: string,
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  const option = await tx.pollOption.findUnique({ where: { id: optionId } });
  if (!option) throw httpError(404, 'Poll option not found');
  const votes = await tx.pollVote.findMany({
    where: { poll_option_id: optionId, reversed_at: null },
    orderBy: { created_at: 'asc' },
  });
  const ids = [...new Set(votes.flatMap((row) => (row.donation_id ? [row.donation_id] : [])))];
  const before = await publisher.snapshot(ids);
  let refundedCents = 0;
  for (const vote of votes) {
    await returnRowFundingTx(tx, vote, 'poll', actor, 'Refunded removed poll option');
    await tx.pollVote.update({
      where: { id: vote.id },
      data: { reversed_at: new Date(), reversed_by: actor },
    });
    refundedCents += vote.amount_cents;
  }
  if (option.status === 'ACTIVE' && refundedCents > 0) {
    await decrementPollTalliesTx(tx, option.id, option.poll_id, refundedCents);
  }
  await publisher.publish(ids, before);
  return { refunded_count: votes.length, refunded_cents: refundedCents };
}

async function assertNoRequestedRefundTx(tx: Tx, donationId: string | null) {
  if (
    donationId &&
    (await tx.paymentRefund.count({ where: { donation_id: donationId, status: 'REQUESTED' } }))
  )
    throw httpError(409, 'A Payment refund is requested for this donation');
}

async function reverseClaimRowTx(tx: Tx, claim: { id: string; reward_id: string }, actor: string) {
  await tx.rewardClaim.update({
    where: { id: claim.id },
    data: { status: 'REVERSED', reversed_at: new Date(), reversed_by: actor },
  });
  await tx.reward.update({
    where: { id: claim.reward_id },
    data: { quantity_claimed: { decrement: 1 } },
  });
}

async function reverseVoteRowTx(
  tx: Tx,
  vote: { id: string; poll_id: string; poll_option_id: string; amount_cents: number },
  actor: string,
) {
  const option = await tx.pollOption.findUniqueOrThrow({ where: { id: vote.poll_option_id } });
  await tx.pollVote.update({
    where: { id: vote.id },
    data: { reversed_at: new Date(), reversed_by: actor },
  });
  if (option.status === 'ACTIVE')
    await decrementPollTalliesTx(tx, option.id, vote.poll_id, vote.amount_cents);
  else if (
    option.status === 'PENDING_APPROVAL' &&
    !(await tx.pollVote.count({ where: { poll_option_id: option.id, reversed_at: null } }))
  )
    await tx.pollOption.update({ where: { id: option.id }, data: { status: 'REJECTED' } });
}

async function reverseContributionRowTx(
  tx: Tx,
  row: { id: string; goal_id: string; amount_cents: number },
  actor: string,
  chargeback = false,
) {
  const goal = await tx.fundGoal.findUniqueOrThrow({ where: { id: row.goal_id } });
  await tx.fundContribution.update({
    where: { id: row.id },
    data: { reversed_at: new Date(), reversed_by: actor },
  });
  const remaining = goal.current_cents - row.amount_cents;
  await tx.fundGoal.update({
    where: { id: goal.id },
    data: {
      current_cents: remaining,
      // Approved #188 policy: recompute ordinarily, but chargebacks keep completed goals complete.
      is_complete: (chargeback && goal.is_complete) || remaining >= goal.target_cents,
    },
  });
}

/** Same computation is used for preview and commit, always inside the caller's tx. */
export async function previewDonationReversalTx(
  tx: Tx,
  donationId: string,
  status: 'REFUNDED' | 'CHARGEBACK',
) {
  const donation = await readDonationAccountingTx(tx, donationId);
  if (donation.status === 'REFUNDED' || donation.status === 'CHARGEBACK')
    throw httpError(400, 'Donation is refunded/charged back and cannot change status');
  await assertNoRequestedRefundTx(tx, donationId);
  if (status === 'CHARGEBACK' && donation.amount_cents === 0)
    throw httpError(400, 'Cannot record a chargeback for zero money');
  const retained = donation.allocations.reward.filter((row) => row.status === 'FULFILLED');
  const claims = donation.allocations.reward.filter((row) => row.status !== 'FULFILLED');
  for (const allocation of claims) {
    const claim = await tx.rewardClaim.findUniqueOrThrow({ where: { id: allocation.id } });
    for (const id of (await readRewardFundingTx(tx, claim)).donation_ids)
      await assertSpendSourceTx(tx, id);
  }
  const cents = (rows: { amount_cents: number }[]) =>
    rows.reduce((sum, row) => sum + row.amount_cents, 0);
  const reversedCents =
    cents(claims) + cents(donation.allocations.poll) + cents(donation.allocations.goal);
  const desired =
    donation.pledge_amount_cents === null
      ? reversedCents - (status === 'CHARGEBACK' ? donation.amount_cents : 0)
      : (status === 'CHARGEBACK'
          ? donation.wallet_applied_cents
          : donation.pledge_amount_cents - cents(retained)) - donation.wallet_credit_granted_cents;
  const donor = await tx.donor.findUniqueOrThrow({
    where: { id: donation.donor_id },
    select: { balance_remaining: true },
  });
  return {
    donation_id: donationId,
    status,
    accounting: donation.pledge_amount_cents === null ? ('LEGACY' as const) : ('POOLED' as const),
    wallet_adjustment_cents: Math.max(desired, -donor.balance_remaining),
    money_before_cents: countsTowardTotals(donation.status) ? donation.amount_cents : 0,
    money_after_cents: countsTowardTotals(status) ? donation.amount_cents : 0,
    reversed_rows: {
      reward: claims.length,
      poll: donation.allocations.poll.length,
      goal: donation.allocations.goal.length,
    },
    retained_claim_ids: retained.map((row) => row.id),
    reversed_allocation_ids: {
      reward: claims.map((row) => row.id),
      poll: donation.allocations.poll.map((row) => row.id),
      goal: donation.allocations.goal.map((row) => row.id),
    },
    cleared_unused_cents: {
      poll: donation.pools.poll.unused_cents,
      goal: donation.pools.goal.unused_cents,
    },
    cleared_pool_credit_cents: {
      reward: donation.pools.reward.outstanding_credit_cents,
      poll: donation.pools.poll.outstanding_credit_cents,
      goal: donation.pools.goal.outstanding_credit_cents,
    },
  };
}

/** ADR-0011 §5/6. NULL-D selects the legacy rule, including PAYMENT_REVIEW receipts. */
export async function setDonationStatusTx(
  tx: Tx,
  donationId: string,
  status: string,
  reason: string | undefined,
  actor: string,
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  const donation = await tx.donation.findUnique({ where: { id: donationId } });
  if (!donation) throw httpError(404, 'Donation not found');
  if (donation.refund_id || ['REFUNDED', 'CHARGEBACK'].includes(donation.status))
    throw httpError(400, 'Donation is refunded/charged back and cannot change status');
  if (donation.status === status) throw httpError(400, 'Donation already has this status');
  if (!['REFUNDED', 'CHARGEBACK'].includes(status)) throw httpError(400, 'Invalid status');
  await assertNoRequestedRefundTx(tx, donationId);
  const initial = await readDonationAccountingTx(tx, donationId);
  const affectedIds = new Set([donationId]);
  for (const allocation of initial.allocations.reward) {
    const claim = await tx.rewardClaim.findUniqueOrThrow({ where: { id: allocation.id } });
    const funding = await readRewardFundingTx(tx, claim);
    for (const id of funding.donation_ids) {
      // Retaining a fulfilled claim never changes another source's funding.
      if (allocation.status !== 'FULFILLED' || !['REFUNDED', 'CHARGEBACK'].includes(status))
        await assertSpendSourceTx(tx, id);
      affectedIds.add(id);
    }
  }
  const before = await publisher.snapshot([...affectedIds]);
  let refundId: string | undefined;
  let granted = 0;
  if (status === 'REFUNDED' || status === 'CHARGEBACK') {
    const preview = await previewDonationReversalTx(tx, donationId, status);
    const state = await readDonationAccountingTx(tx, donationId);
    for (const claim of state.allocations.reward) {
      if (claim.status !== 'FULFILLED') {
        const wholeClaim = await tx.rewardClaim.findUniqueOrThrow({ where: { id: claim.id } });
        const funding = await readRewardFundingTx(tx, wholeClaim);
        if (funding.redemption_backed)
          await returnRowFundingTx(
            tx,
            wholeClaim,
            'reward',
            actor,
            'Terminal source reversal',
            donationId,
          );
        await reverseClaimRowTx(tx, claim, actor);
      } else if (status === 'CHARGEBACK')
        await tx.rewardClaim.update({
          where: { id: claim.id },
          data: { chargeback_flagged_at: new Date() },
        });
    }
    for (const vote of state.allocations.poll) await reverseVoteRowTx(tx, vote, actor);
    for (const row of state.allocations.goal)
      await reverseContributionRowTx(tx, row, actor, status === 'CHARGEBACK');
    await tx.poolCredit.updateMany({
      where: { donation_id: donationId, remaining_cents: { gt: 0 } },
      data: { remaining_cents: 0, cleared_at: new Date(), cleared_by: actor },
    });
    const adjustment = await adjustWalletTx(
      tx,
      donation.donor_id,
      preview.wallet_adjustment_cents,
      status === 'REFUNDED' ? 'WALLET_REFUND' : 'CHARGEBACK',
      reason || `Donation ${status.toLowerCase()}`,
      actor,
      donation.id,
      donation.id,
    );
    refundId = adjustment.id;
    granted = Math.max(0, preview.wallet_adjustment_cents);
  }
  const row = await tx.donation.update({
    where: { id: donationId },
    data: {
      status,
      wallet_credit_granted_cents: { increment: granted },
      ...(refundId ? { refund_id: refundId } : {}),
    },
    include: { channel: { select: { id: true, name: true, slug: true, event_id: true } } },
  });
  await publisher.publish([...affectedIds], before);
  return row;
}

/** Verified old async failure; terminal history and duplicate receipts are deliberately untouched. */
export async function recordLegacyAsyncFailureTx(
  tx: Tx,
  receipt: { donation_id: string; checkout_session_id: string; pledge_token: string | null },
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  const donation = await tx.donation.findUniqueOrThrow({ where: { id: receipt.donation_id } });
  if (donation.pledge_amount_cents !== null || donation.external_id !== receipt.checkout_session_id)
    throw httpError(409, 'Legacy payment receipt does not match donation');
  if (donation.refund_id || ['REFUNDED', 'CHARGEBACK'].includes(donation.status))
    return { duplicate: true };
  return setDonationStatusTx(
    tx,
    donation.id,
    'CHARGEBACK',
    'Legacy async payment failed',
    'stripe',
    publisher,
  );
}

export interface ReversalDestination {
  destination: 'Wallet credit' | 'Pool credit' | 'Unused pool money' | 'Expired reward Pool credit';
  category: 'reward' | 'poll' | 'goal';
  donation_id: string | null;
  credit_id: string | null;
  amount_cents: number;
}
async function rowReturnPreviewTx(
  tx: Tx,
  row: { id: string; donation_id: string | null; amount_cents: number; source?: string },
  category: 'reward' | 'poll' | 'goal',
): Promise<ReversalDestination[]> {
  const redemptions = await tx.poolCreditRedemption.findMany({
    where:
      category === 'reward'
        ? { claim_id: row.id }
        : category === 'poll'
          ? { vote_id: row.id }
          : { contribution_id: row.id },
    select: {
      amount_cents: true,
      reduced_cents: true,
      credit_id: true,
      credit: {
        select: {
          donation_id: true,
          donation: { select: { status: true, event: { select: { ended_at: true } } } },
        },
      },
    },
  });
  if (redemptions.length)
    return redemptions
      .filter((r) => r.credit.donation.status !== 'CHARGEBACK')
      .map((r) => ({
        destination: r.credit.donation.event?.ended_at
          ? category === 'reward'
            ? 'Expired reward Pool credit'
            : 'Unused pool money'
          : 'Pool credit',
        category,
        donation_id: r.credit.donation_id,
        credit_id: r.credit_id,
        amount_cents: r.amount_cents - r.reduced_cents,
      }));
  const donation = row.donation_id
    ? await tx.donation.findUniqueOrThrow({
        where: { id: row.donation_id },
        select: { status: true, pledge_amount_cents: true, event: { select: { ended_at: true } } },
      })
    : null;
  if (donation?.status === 'CHARGEBACK') return [];
  return [
    {
      category,
      donation_id: row.donation_id,
      credit_id: null,
      amount_cents: row.amount_cents,
      destination:
        donation?.pledge_amount_cents == null
          ? 'Wallet credit'
          : row.source === 'moderator' || (donation.event?.ended_at && category !== 'reward')
            ? 'Unused pool money'
            : donation.event?.ended_at
              ? 'Expired reward Pool credit'
              : 'Pool credit',
    },
  ];
}
/** Read-only destination projection of the existing reversal policy. Mutation rechecks all locks. */
export async function previewSpendReversalTx(tx: Tx, donorId: string, kind: string, id: string) {
  const row =
    kind === 'claim'
      ? await tx.rewardClaim.findUnique({ where: { id } })
      : kind === 'vote'
        ? await tx.pollVote.findUnique({ where: { id } })
        : kind === 'contribution'
          ? await tx.fundContribution.findUnique({ where: { id } })
          : null;
  if (!row || row.donor_id !== donorId) throw httpError(404, 'Spend record not found');
  const category = kind === 'claim' ? 'reward' : kind === 'vote' ? 'poll' : 'goal';
  if (row.reversed_at) throw httpError(409, 'Already reversed');
  if ('status' in row && row.status !== 'PENDING')
    throw httpError(
      409,
      'Only pending claims can be reversed; mark fulfilled claims pending first',
    );
  if (kind === 'claim')
    for (const source of (await readRewardFundingTx(tx, row)).donation_ids)
      await assertSpendSourceTx(tx, source);
  else await assertSpendSourceTx(tx, row.donation_id);
  return { destinations: await rowReturnPreviewTx(tx, row, category) };
}
export async function previewIncentiveReversalTx(tx: Tx, kind: 'goal' | 'option', id: string) {
  const target =
    kind === 'goal'
      ? await tx.fundGoal.findUnique({ where: { id }, select: { id: true } })
      : await tx.pollOption.findUnique({ where: { id }, select: { id: true } });
  if (!target) throw httpError(404, 'Incentive not found');
  const rows =
    kind === 'goal'
      ? await tx.fundContribution.findMany({ where: { goal_id: id, reversed_at: null } })
      : await tx.pollVote.findMany({ where: { poll_option_id: id, reversed_at: null } });
  const destinations: ReversalDestination[] = [];
  for (const row of rows) {
    await assertNoRequestedRefundTx(tx, row.donation_id);
    destinations.push(...(await rowReturnPreviewTx(tx, row, kind === 'goal' ? 'goal' : 'poll')));
  }
  return { destinations };
}

async function assertSpendSourceTx(tx: Tx, donationId: string | null) {
  await assertNoRequestedRefundTx(tx, donationId);
  if (
    donationId &&
    (await tx.donation.findUniqueOrThrow({ where: { id: donationId } })).status === 'CHARGEBACK'
  )
    throw httpError(409, 'Cannot reverse spending from a charged-back donation');
}

/** Shared read/mutation guard checks EVERY funding source, including credit-backed claims. */
export async function claimStatusReasonTx(tx: Tx, claimId: string): Promise<string | null> {
  const claim = await tx.rewardClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw httpError(404, 'Claim not found');
  try {
    for (const id of (await readRewardFundingTx(tx, claim)).donation_ids)
      await assertSpendSourceTx(tx, id);
    if (claim.reversed_at || !['PENDING', 'FULFILLED'].includes(claim.status))
      return 'Only pending or fulfilled claims can change status';
    return null;
  } catch (error) {
    if (error instanceof Error && 'status' in error) return error.message;
    throw error;
  }
}

/** Only live PENDING <-> FULFILLED transitions, never resurrection of a reversed claim. */
export async function setClaimStatusTx(
  tx: Tx,
  claimId: string,
  status: string,
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  if (!['PENDING', 'FULFILLED'].includes(status)) throw httpError(400, 'Invalid status');
  const claim = await tx.rewardClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw httpError(404, 'Claim not found');
  const funding = await readRewardFundingTx(tx, claim);
  const disabled = await claimStatusReasonTx(tx, claimId);
  if (disabled) throw httpError(409, disabled);
  const ids = funding.donation_ids;
  const before = await publisher.snapshot(ids);
  const result = await tx.rewardClaim.update({
    where: { id: claimId },
    data: { status },
    include: { reward: true },
  });
  await publisher.publish(ids, before);
  return result;
}

export async function acknowledgeChargebackClaimTx(
  tx: Tx,
  claimId: string,
  actor: string,
  note?: string,
) {
  await lockReversalTx(tx);
  if (note !== undefined && typeof note !== 'string')
    throw httpError(400, 'Invalid acknowledgement note');
  const claim = await tx.rewardClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw httpError(404, 'Claim not found');
  if (!claim.chargeback_flagged_at || claim.status !== 'FULFILLED')
    throw httpError(409, 'Claim has no shipped chargeback flag');
  return tx.rewardClaim.update({
    where: { id: claimId },
    data: {
      chargeback_flagged_at: null,
      chargeback_acknowledged_at: new Date(),
      chargeback_acknowledged_by: actor,
      chargeback_acknowledgement_note: note?.trim() || null,
    },
  });
}

/** Call inside the caller's transaction; eligibility is never read before it starts. */
export async function reverseSpendTx(
  tx: Tx,
  donorId: string,
  spendType: string,
  spendId: string,
  actor: string,
  publisher: DonationPublisher,
) {
  await lockReversalTx(tx);
  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor) throw httpError(404, 'Donor not found');
  const reverse = async (
    row: {
      id: string;
      donor_id: string;
      donation_id: string | null;
      amount_cents: number;
      source?: string;
    },
    category: 'reward' | 'poll' | 'goal',
    reason: string,
    mutate: () => Promise<void>,
  ) => {
    const ids =
      category === 'reward'
        ? (await readRewardFundingTx(tx, row)).donation_ids
        : row.donation_id
          ? [row.donation_id]
          : [];
    const before = await publisher.snapshot(ids);
    await returnRowFundingTx(tx, row, category, actor, reason);
    await mutate();
    await publisher.publish(ids, before);
  };

  if (spendType === 'claim') {
    const claim = await tx.rewardClaim.findUnique({ where: { id: spendId } });
    if (!claim || claim.donor_id !== donorId) throw httpError(404, 'Claim not found');
    for (const id of (await readRewardFundingTx(tx, claim)).donation_ids)
      await assertSpendSourceTx(tx, id);
    if (claim.reversed_at || claim.status === 'REVERSED')
      throw httpError(400, 'Claim already reversed');
    if (claim.status === 'CANCELLING')
      throw httpError(409, 'Claim has a Payment refund in progress');
    if (claim.status === 'FULFILLED') {
      throw httpError(400, 'Cannot reverse fulfilled claim; mark it as PENDING first');
    }

    await reverse(claim, 'reward', 'Reversed reward claim', () =>
      reverseClaimRowTx(tx, claim, actor),
    );
  } else if (spendType === 'vote') {
    const vote = await tx.pollVote.findUnique({ where: { id: spendId } });
    if (!vote || vote.donor_id !== donorId) throw httpError(404, 'Vote not found');
    await assertSpendSourceTx(tx, vote.donation_id);
    if (vote.reversed_at) throw httpError(400, 'Vote already reversed');
    await reverse(vote, 'poll', 'Reversed poll vote', () => reverseVoteRowTx(tx, vote, actor));
  } else if (spendType === 'contribution') {
    const contribution = await tx.fundContribution.findUnique({ where: { id: spendId } });
    if (!contribution || contribution.donor_id !== donorId) {
      throw httpError(404, 'Contribution not found');
    }
    await assertSpendSourceTx(tx, contribution.donation_id);
    if (contribution.reversed_at) throw httpError(400, 'Contribution already reversed');
    await reverse(contribution, 'goal', 'Reversed fund contribution', () =>
      reverseContributionRowTx(tx, contribution, actor),
    );
  } else {
    throw httpError(400, 'Invalid spend_type. Must be claim, vote, or contribution');
  }
}
