import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';
import { readRewardFundingTx } from './poolAccounting.js';
import {
  assertSpendSourceTx,
  reverseClaimRowTx,
  reverseContributionRowTx,
  reverseVoteRowTx,
  returnRowFundingTx,
  rowReturnPreviewTx,
} from './reversalPolicy.js';

type Tx = Prisma.TransactionClient;

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
