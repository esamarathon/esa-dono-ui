import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';
import { assertNoRequestedPaymentRefundTx, liveRowWhere } from './poolAccounting.js';
import {
  decrementPollTalliesTx,
  returnRowFundingTx,
  rowReturnPreviewTx,
} from './reversalPolicy.js';
import type { ReversalDestination } from './reversalPolicy.js';

type Tx = Prisma.TransactionClient;

/** Approval shares the rejection transaction boundary so neither can act on stale funding. */
export async function moderateCustomEntryTx(
  tx: Tx,
  entryId: string,
  status: 'APPROVED' | 'REJECTED',
  actor: string,
  publisher: DonationPublisher,
) {
  const entry = await tx.pollCustomEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw httpError(404, 'Entry not found');
  if (entry.status !== 'PENDING') throw httpError(400, 'Only pending entries can be moderated');
  const option = await tx.pollOption.findUnique({ where: { custom_entry_id: entry.id } });
  if (!option) throw httpError(404, 'Associated poll option not found');
  const votes = await tx.pollVote.findMany({
    where: { poll_option_id: option.id, ...liveRowWhere() },
    orderBy: { created_at: 'desc' },
  });
  if (!votes.length) throw httpError(404, 'Associated funding vote not found');
  if (option.status !== 'PENDING_APPROVAL') {
    throw httpError(400, 'Only pending entries can be moderated');
  }

  const donationIds = [
    ...new Set(votes.flatMap((vote) => (vote.donation_id ? [vote.donation_id] : []))),
  ];
  for (const id of donationIds) await assertNoRequestedPaymentRefundTx(tx, id);
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

export async function refundGoalContributions(
  tx: Tx,
  goalId: string,
  actor: string,
  publisher: DonationPublisher,
) {
  const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
  if (!goal) throw httpError(404, 'Goal not found');
  const contributions = await tx.fundContribution.findMany({
    where: { goal_id: goalId, ...liveRowWhere() },
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
  const option = await tx.pollOption.findUnique({ where: { id: optionId } });
  if (!option) throw httpError(404, 'Poll option not found');
  const votes = await tx.pollVote.findMany({
    where: { poll_option_id: optionId, ...liveRowWhere() },
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

export async function previewIncentiveReversalTx(tx: Tx, kind: 'goal' | 'option', id: string) {
  const target =
    kind === 'goal'
      ? await tx.fundGoal.findUnique({ where: { id }, select: { id: true } })
      : await tx.pollOption.findUnique({ where: { id }, select: { id: true } });
  if (!target) throw httpError(404, 'Incentive not found');
  const rows =
    kind === 'goal'
      ? await tx.fundContribution.findMany({ where: { goal_id: id, ...liveRowWhere() } })
      : await tx.pollVote.findMany({ where: { poll_option_id: id, ...liveRowWhere() } });
  const destinations: ReversalDestination[] = [];
  for (const row of rows) {
    await assertNoRequestedPaymentRefundTx(tx, row.donation_id);
    destinations.push(...(await rowReturnPreviewTx(tx, row, kind === 'goal' ? 'goal' : 'poll')));
  }
  return { destinations };
}
