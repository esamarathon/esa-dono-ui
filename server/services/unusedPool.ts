import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { readDonationAccountingTx } from './poolAccounting.js';
import { reverseSpendTx } from './reversal.js';
import type { DonationPublisher } from './webhooks/donationPublisher.js';

type Tx = Prisma.TransactionClient;
export type UnusedCategory = 'poll' | 'goal';
export function unusedCategory(value: unknown): UnusedCategory {
  if (value !== 'poll' && value !== 'goal') throw httpError(400, 'Category must be poll or goal');
  return value;
}
async function sourceTx(tx: Tx, id: string) {
  const donation = await readDonationAccountingTx(tx, id);
  if (donation.pledge_amount_cents === null || donation.status !== 'COMPLETED')
    throw httpError(409, 'Only COMPLETED pooled donations have Unused pool money');
  if (!donation.channel_id) throw httpError(409, 'An admin must route this donation first');
  if (await tx.paymentRefund.count({ where: { donation_id: id, status: 'REQUESTED' } }))
    throw httpError(409, 'A Payment refund is requested for this donation');
  return donation;
}

/** Safe read model: no donor join, private claim data or staff email. */
export async function listUnusedTx(
  tx: Tx,
  filters: { comments_only?: boolean; show_ended?: boolean; channel_id?: string },
) {
  const donations = await tx.donation.findMany({
    where: {
      status: 'COMPLETED',
      pledge_amount_cents: { not: null },
      ...(filters.comments_only !== false ? { comment: { not: null } } : {}),
      ...(!filters.show_ended ? { OR: [{ event: { ended_at: null } }, { event_id: null }] } : {}),
      ...(filters.channel_id ? { channel_id: filters.channel_id } : {}),
    },
    orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      donor_name: true,
      comment: true,
      created_at: true,
      channel_id: true,
      event: { select: { id: true, name: true, ended_at: true } },
    },
  });
  const result = [];
  for (const donation of donations) {
    if (filters.comments_only !== false && !donation.comment?.trim()) continue;
    const state = await readDonationAccountingTx(tx, donation.id);
    const poll = await tx.pollVote.findMany({
      where: { donation_id: donation.id, source: 'moderator', reversed_at: null },
      select: {
        id: true,
        amount_cents: true,
        allocated_at: true,
        poll_option: {
          select: {
            label: true,
            status: true,
            poll: { select: { is_active: true, ends_at: true } },
          },
        },
      },
    });
    const goal = await tx.fundContribution.findMany({
      where: { donation_id: donation.id, source: 'moderator', reversed_at: null },
      select: {
        id: true,
        amount_cents: true,
        allocated_at: true,
        goal: { select: { title: true, is_active: true, is_complete: true } },
      },
    });
    const assignments = [
      ...poll.map((row) => ({
        id: row.id,
        category: 'poll' as const,
        label: row.poll_option.label,
        amount_cents: row.amount_cents,
        allocated_at: row.allocated_at,
        can_undo:
          row.poll_option.status === 'ACTIVE' &&
          row.poll_option.poll.is_active &&
          (!row.poll_option.poll.ends_at || row.poll_option.poll.ends_at > new Date()),
      })),
      ...goal.map((row) => ({
        id: row.id,
        category: 'goal' as const,
        label: row.goal.title,
        amount_cents: row.amount_cents,
        allocated_at: row.allocated_at,
        can_undo: row.goal.is_active && !row.goal.is_complete,
      })),
    ];
    const unused_cents = {
      poll: state.pools.poll.unused_cents,
      goal: state.pools.goal.unused_cents,
    };
    if (unused_cents.poll || unused_cents.goal || assignments.length)
      result.push({ ...donation, unused_cents, assignments });
  }
  return result;
}

/** Picker and mutation share eligibility and server-computed impact. */
export async function unusedTargetsTx(tx: Tx, donationId: string, category: UnusedCategory) {
  const donation = await sourceTx(tx, donationId);
  const amount = donation.pools[category].unused_cents;
  const scope = { OR: [{ channel_id: donation.channel_id }, { channel_id: null }] };
  const targets =
    category === 'poll'
      ? (
          await tx.pollOption.findMany({
            where: {
              status: 'ACTIVE',
              poll: {
                is_active: true,
                AND: [scope, { OR: [{ ends_at: null }, { ends_at: { gt: new Date() } }] }],
              },
            },
            orderBy: { id: 'asc' },
            select: {
              id: true,
              label: true,
              votes_cents: true,
              poll: { select: { title: true, channel_id: true } },
            },
          })
        ).map((row) => ({
          id: row.id,
          label: `${row.poll.title}: ${row.label}`,
          channel_id: row.poll.channel_id,
          before_cents: row.votes_cents,
          after_cents: row.votes_cents + amount,
          target_cents: null as number | null,
        }))
      : (
          await tx.fundGoal.findMany({
            where: { ...scope, is_active: true, is_complete: false },
            orderBy: { id: 'asc' },
            select: {
              id: true,
              title: true,
              channel_id: true,
              current_cents: true,
              target_cents: true,
            },
          })
        ).map((row) => ({
          id: row.id,
          label: row.title,
          channel_id: row.channel_id,
          before_cents: row.current_cents,
          after_cents: row.current_cents + amount,
          target_cents: row.target_cents,
        }));
  return { amount_cents: amount, targets };
}

/** Own transaction lock, reads, row, tallies and outbox form one atomic operation.
 * This is NOT initial fulfillment or a donor credit spend: ended poll/goal credit
 * is effectively unreserved here, while raw grants remain untouched for Undo end.
 */
export async function assignUnusedTx(
  tx: Tx,
  donationId: string,
  category: UnusedCategory,
  targetId: string,
  expected: number,
  actor: string,
  publisher: DonationPublisher,
) {
  if (!actor) throw httpError(400, 'Assignment actor required');
  if (!Number.isSafeInteger(expected) || expected <= 0)
    throw httpError(400, 'Expected amount must be positive integer cents');
  await tx.$executeRaw`UPDATE Donor SET id = id WHERE 0`;
  const donation = await sourceTx(tx, donationId);
  const picker = await unusedTargetsTx(tx, donationId, category);
  if (picker.amount_cents !== expected)
    throw httpError(409, 'Unused amount changed; reload before assigning');
  if (!picker.targets.some((target) => target.id === targetId))
    throw httpError(409, 'Target is no longer eligible');
  const before = await publisher.snapshot(donationId);
  const data = {
    donation_id: donationId,
    donor_id: donation.donor_id,
    amount_cents: expected,
    source: 'moderator',
    allocated_by: actor,
    allocated_at: new Date(),
  };
  let row;
  if (category === 'poll') {
    const option = await tx.pollOption.findUniqueOrThrow({ where: { id: targetId } });
    row = await tx.pollVote.create({
      data: { ...data, poll_id: option.poll_id, poll_option_id: option.id },
    });
    await tx.pollOption.update({
      where: { id: option.id },
      data: { votes_cents: { increment: expected } },
    });
    await tx.poll.update({
      where: { id: option.poll_id },
      data: { total_votes_cents: { increment: expected } },
    });
  } else {
    const goal = await tx.fundGoal.findUniqueOrThrow({ where: { id: targetId } });
    row = await tx.fundContribution.create({ data: { ...data, goal_id: goal.id } });
    await tx.fundGoal.update({
      where: { id: goal.id },
      data: {
        current_cents: { increment: expected },
        is_complete: goal.current_cents + expected >= goal.target_cents,
      },
    });
  }
  await publisher.publish(donationId, before);
  return row;
}

export async function undoUnusedTx(
  tx: Tx,
  category: UnusedCategory,
  rowId: string,
  actor: string,
  publisher: DonationPublisher,
) {
  await tx.$executeRaw`UPDATE Donor SET id = id WHERE 0`;
  const row =
    category === 'poll'
      ? await tx.pollVote.findUnique({
          where: { id: rowId },
          include: { poll_option: { include: { poll: true } } },
        })
      : await tx.fundContribution.findUnique({ where: { id: rowId }, include: { goal: true } });
  if (!row || row.source !== 'moderator' || !row.donation_id)
    throw httpError(404, 'Moderator assignment not found');
  if ('poll_option' in row) {
    const { poll } = row.poll_option;
    if (
      row.poll_option.status !== 'ACTIVE' ||
      !poll.is_active ||
      (poll.ends_at && poll.ends_at <= new Date())
    )
      throw httpError(409, 'Assignment target is closed');
  } else if (!row.goal.is_active || row.goal.is_complete)
    throw httpError(409, 'Assignment target is closed');
  await reverseSpendTx(
    tx,
    row.donor_id,
    category === 'poll' ? 'vote' : 'contribution',
    row.id,
    actor,
    publisher,
  );
  return { success: true };
}
