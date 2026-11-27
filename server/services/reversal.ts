import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { countsTowardTotals } from '../lib/donationTotals.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';
import {
  assertPaymentRefundFreeze,
  readDonationAccountingTx,
  readRewardFundingTx,
  walletCreditGrantCents,
} from './poolAccounting.js';
import {
  assertSpendSourceTx,
  reverseClaimRowTx,
  reverseContributionRowTx,
  reverseVoteRowTx,
  returnRowFundingTx,
} from './reversalPolicy.js';
import { adjustWalletTx } from './walletAdjust.js';

type Tx = Prisma.TransactionClient;

/** Asserts every funding source of a non-retained claim and collects every donation the reversal touches. */
async function walkReversalSourcesTx(
  tx: Tx,
  state: Awaited<ReturnType<typeof readDonationAccountingTx>>,
): Promise<Set<string>> {
  const affectedIds = new Set([state.id]);
  for (const allocation of state.allocations.reward) {
    const claim = await tx.rewardClaim.findUniqueOrThrow({ where: { id: allocation.id } });
    const funding = await readRewardFundingTx(tx, claim);
    for (const id of funding.donation_ids) {
      // Retaining a fulfilled claim never changes another source's funding.
      if (allocation.status !== 'FULFILLED') await assertSpendSourceTx(tx, id);
      affectedIds.add(id);
    }
  }
  return affectedIds;
}

/** Pure ADR-0011 §5/6 computation shared by preview and commit. */
function planDonationReversal(
  state: Awaited<ReturnType<typeof readDonationAccountingTx>>,
  status: 'REFUNDED' | 'CHARGEBACK',
  walletBalanceCents: number,
) {
  const retained = state.allocations.reward.filter((row) => row.status === 'FULFILLED');
  const claims = state.allocations.reward.filter((row) => row.status !== 'FULFILLED');
  const cents = (rows: { amount_cents: number }[]) =>
    rows.reduce((sum, row) => sum + row.amount_cents, 0);
  const reversedCents =
    cents(claims) + cents(state.allocations.poll) + cents(state.allocations.goal);
  const desired = walletCreditGrantCents(state, status, {
    retained_cents: cents(retained),
    reversed_cents: reversedCents,
  });
  return {
    retained,
    claims,
    preview: {
      donation_id: state.id,
      status,
      accounting: state.pledge_amount_cents === null ? ('LEGACY' as const) : ('POOLED' as const),
      wallet_adjustment_cents: Math.max(desired, -walletBalanceCents),
      money_before_cents: countsTowardTotals(state.status) ? state.amount_cents : 0,
      money_after_cents: countsTowardTotals(status) ? state.amount_cents : 0,
      reversed_rows: {
        reward: claims.length,
        poll: state.allocations.poll.length,
        goal: state.allocations.goal.length,
      },
      retained_claim_ids: retained.map((row) => row.id),
      reversed_allocation_ids: {
        reward: claims.map((row) => row.id),
        poll: state.allocations.poll.map((row) => row.id),
        goal: state.allocations.goal.map((row) => row.id),
      },
      cleared_unused_cents: {
        poll: state.pools.poll.unused_cents,
        goal: state.pools.goal.unused_cents,
      },
      cleared_pool_credit_cents: {
        reward: state.pools.reward.outstanding_credit_cents,
        poll: state.pools.poll.outstanding_credit_cents,
        goal: state.pools.goal.outstanding_credit_cents,
      },
    },
  };
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
  assertPaymentRefundFreeze(donation.payment_refund_requested);
  if (status === 'CHARGEBACK' && donation.amount_cents === 0)
    throw httpError(400, 'Cannot record a chargeback for zero money');
  await walkReversalSourcesTx(tx, donation);
  const donor = await tx.donor.findUniqueOrThrow({
    where: { id: donation.donor_id },
    select: { balance_remaining: true },
  });
  return planDonationReversal(donation, status, donor.balance_remaining).preview;
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
  const donation = await tx.donation.findUnique({ where: { id: donationId } });
  if (!donation) throw httpError(404, 'Donation not found');
  if (donation.refund_id || ['REFUNDED', 'CHARGEBACK'].includes(donation.status))
    throw httpError(400, 'Donation is refunded/charged back and cannot change status');
  if (donation.status === status) throw httpError(400, 'Donation already has this status');
  if (!['REFUNDED', 'CHARGEBACK'].includes(status)) throw httpError(400, 'Invalid status');
  const initial = await readDonationAccountingTx(tx, donationId);
  assertPaymentRefundFreeze(initial.payment_refund_requested);
  const affectedIds = await walkReversalSourcesTx(tx, initial);
  const before = await publisher.snapshot([...affectedIds]);
  let refundId: string | undefined;
  let granted = 0;
  if (status === 'REFUNDED' || status === 'CHARGEBACK') {
    if (status === 'CHARGEBACK' && initial.amount_cents === 0)
      throw httpError(400, 'Cannot record a chargeback for zero money');
    const donor = await tx.donor.findUniqueOrThrow({
      where: { id: initial.donor_id },
      select: { balance_remaining: true },
    });
    const { preview, retained, claims } = planDonationReversal(
      initial,
      status,
      donor.balance_remaining,
    );
    for (const claim of claims) {
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
    }
    if (status === 'CHARGEBACK')
      for (const claim of retained)
        await tx.rewardClaim.update({
          where: { id: claim.id },
          data: { chargeback_flagged_at: new Date() },
        });
    for (const vote of initial.allocations.poll) await reverseVoteRowTx(tx, vote, actor);
    for (const row of initial.allocations.goal)
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
