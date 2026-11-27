import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { assertNoRequestedPaymentRefundTx, liveRowWhere } from './poolAccounting.js';
import { adjustWalletTx } from './walletAdjust.js';

type Tx = Prisma.TransactionClient;

export async function returnRowFundingTx(
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
  for (const source of await planRowReturnTx(tx, row, category, terminalDonationId)) {
    await assertNoRequestedPaymentRefundTx(tx, source.assert_donation_id);
    if (source.action === 'restore-credit')
      await tx.poolCredit.update({
        where: { id: source.credit_id! },
        data: {
          remaining_cents: { increment: source.amount_cents },
          cleared_at: null,
          cleared_by: null,
        },
      });
    else if (source.action === 'create-credit')
      await tx.poolCredit.create({
        data: {
          donation_id: source.donation_id!,
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
    else if (source.action === 'wallet-credit')
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

export async function decrementPollTalliesTx(
  tx: Tx,
  optionId: string,
  pollId: string,
  cents: number,
) {
  await tx.pollOption.update({
    where: { id: optionId },
    data: { votes_cents: { decrement: cents } },
  });
  await tx.poll.update({
    where: { id: pollId },
    data: { total_votes_cents: { decrement: cents } },
  });
}

export async function reverseClaimRowTx(
  tx: Tx,
  claim: { id: string; reward_id: string },
  actor: string,
) {
  await tx.rewardClaim.update({
    where: { id: claim.id },
    data: { status: 'REVERSED', reversed_at: new Date(), reversed_by: actor },
  });
  await tx.reward.update({
    where: { id: claim.reward_id },
    data: { quantity_claimed: { decrement: 1 } },
  });
}

export async function reverseVoteRowTx(
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
    !(await tx.pollVote.count({ where: { poll_option_id: option.id, ...liveRowWhere() } }))
  )
    await tx.pollOption.update({ where: { id: option.id }, data: { status: 'REJECTED' } });
}

export async function reverseContributionRowTx(
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

export interface ReversalDestination {
  destination: 'Wallet credit' | 'Pool credit' | 'Unused pool money' | 'Expired reward Pool credit';
  category: 'reward' | 'poll' | 'goal';
  donation_id: string | null;
  credit_id: string | null;
  amount_cents: number;
}
/** One funding source behind a reversed row, and the write (if any) that returns it. */
interface RowReturnSource {
  destination: ReversalDestination['destination'];
  donation_id: string | null;
  credit_id: string | null;
  amount_cents: number;
  /** Freeze-checked before any write, including for sources that end up skipped. */
  assert_donation_id: string | null;
  /** Charged-back sources return nothing and stay out of the preview. */
  hidden: boolean;
  action: 'restore-credit' | 'create-credit' | 'wallet-credit' | 'none';
}

/**
 * ADR-0011 §5/6 destination table for one reversed row, computed once for both
 * the preview projection and the mutation. `terminalDonationId` marks sources
 * cleared by their own donation's terminal reversal; they must not be restored
 * twice, because that reversal already zeroes their credits.
 */
async function planRowReturnTx(
  tx: Tx,
  row: { id: string; donation_id: string | null; amount_cents: number; source?: string },
  category: 'reward' | 'poll' | 'goal',
  terminalDonationId?: string,
): Promise<RowReturnSource[]> {
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
      credit: {
        select: {
          donation_id: true,
          donation: { select: { status: true, event: { select: { ended_at: true } } } },
        },
      },
    },
  });
  if (redemptions.length)
    return redemptions.map((redemption) => ({
      destination: redemption.credit.donation.event?.ended_at
        ? category === 'reward'
          ? ('Expired reward Pool credit' as const)
          : ('Unused pool money' as const)
        : ('Pool credit' as const),
      donation_id: redemption.credit.donation_id,
      credit_id: redemption.credit_id,
      amount_cents: redemption.amount_cents - redemption.reduced_cents,
      assert_donation_id: redemption.credit.donation_id,
      hidden: redemption.credit.donation.status === 'CHARGEBACK',
      action:
        redemption.credit.donation_id === terminalDonationId ||
        redemption.credit.donation.status === 'CHARGEBACK'
          ? ('none' as const)
          : ('restore-credit' as const),
    }));
  const donation = row.donation_id
    ? await tx.donation.findUniqueOrThrow({
        where: { id: row.donation_id },
        select: {
          status: true,
          pledge_amount_cents: true,
          event: { select: { ended_at: true } },
        },
      })
    : null;
  return [
    {
      // Old terminal rows are not repaired, and cannot mint credit for lost money.
      destination:
        donation?.pledge_amount_cents == null
          ? 'Wallet credit'
          : row.source === 'moderator' || (donation.event?.ended_at && category !== 'reward')
            ? 'Unused pool money'
            : donation.event?.ended_at
              ? 'Expired reward Pool credit'
              : 'Pool credit',
      donation_id: row.donation_id,
      credit_id: null,
      amount_cents: row.amount_cents,
      assert_donation_id: row.donation_id,
      hidden: donation?.status === 'CHARGEBACK',
      action:
        donation?.status === 'CHARGEBACK'
          ? 'none'
          : donation?.pledge_amount_cents == null
            ? 'wallet-credit'
            : row.source === 'moderator' || row.amount_cents === 0
              ? 'none'
              : 'create-credit',
    },
  ];
}

export async function rowReturnPreviewTx(
  tx: Tx,
  row: { id: string; donation_id: string | null; amount_cents: number; source?: string },
  category: 'reward' | 'poll' | 'goal',
): Promise<ReversalDestination[]> {
  const sources = await planRowReturnTx(tx, row, category);
  return sources
    .filter((source) => !source.hidden)
    .map(({ destination, donation_id, credit_id, amount_cents }) => ({
      destination,
      category,
      donation_id,
      credit_id,
      amount_cents,
    }));
}
export async function assertSpendSourceTx(tx: Tx, donationId: string | null) {
  await assertNoRequestedPaymentRefundTx(tx, donationId);
  if (
    donationId &&
    (await tx.donation.findUniqueOrThrow({ where: { id: donationId } })).status === 'CHARGEBACK'
  )
    throw httpError(409, 'Cannot reverse spending from a charged-back donation');
}
