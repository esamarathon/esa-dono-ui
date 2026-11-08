import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { readDonationAccountingTx, type CategoryAmounts } from './poolAccounting.js';
import { confirmedRewardType } from './rewardFunding.js';

type Tx = Prisma.TransactionClient;

/** End is not deactivation. Credit conversion/expiry remains entirely derived. */
export async function previewEventEndTx(tx: Tx, eventId: string, undo = false) {
  const event = await tx.event.findUnique({ where: { id: eventId } });
  if (!event) throw httpError(404, 'Event not found');
  const blockers: string[] = [];
  if (undo ? !event.ended_at : !!event.ended_at)
    blockers.push(undo ? 'Event has not ended' : 'Event has already ended');
  if (event.is_active) blockers.push('Deactivate the Event first');
  const requested = await tx.paymentRefund.count({
    where: { donation: { event_id: eventId }, status: 'REQUESTED' },
  });
  if (!undo && requested) blockers.push('A Payment refund is requested for this Event');
  const donations = await tx.donation.findMany({
    where: { event_id: eventId },
    select: {
      id: true,
      status: true,
      pledge_amount_cents: true,
      reward_claims: {
        // Credit-funded claims are never physical, even when this reward id
        // also appeared as PHYSICAL in the source donation's original pledge.
        where: {
          reversed_at: null,
          status: { in: ['PENDING', 'CANCELLING'] },
          credit_redemptions: { none: {} },
        },
        select: { reward_id: true, reward: { select: { type: true } } },
      },
      pledge: {
        select: {
          items: {
            where: { kind: 'REWARD' },
            select: { kind: true, target_id: true, confirmed_reward_type: true },
          },
        },
      },
    },
  });
  const credits: CategoryAmounts = { reward: 0, poll: 0, goal: 0 };
  const consuming_assignments: {
    donation_id: string;
    category: 'poll' | 'goal';
    assignment_ids: string[];
  }[] = [];
  let physical = 0;
  for (const donation of donations) {
    // Catalog edits must not reopen or close a confirmed physical refund window.
    if (
      donation.status === 'COMPLETED' &&
      donation.pledge_amount_cents !== null &&
      donation.reward_claims.some(
        (claim) => confirmedRewardType(claim, donation.pledge?.items) === 'PHYSICAL',
      )
    )
      physical++;
    const state = await readDonationAccountingTx(tx, donation.id);
    if (donation.pledge_amount_cents === null) continue;
    for (const category of ['reward', 'poll', 'goal'] as const) {
      if (
        donation.status === 'COMPLETED' ||
        (category === 'reward' && donation.status === 'REFUNDED')
      )
        credits[category] += state.pools[category].outstanding_credit_cents;
    }
    if (!undo || !event.ended_at || donation.status !== 'COMPLETED') continue;
    for (const category of ['poll', 'goal'] as const) {
      const budget = state.pools[category];
      // Restoring RAW credit is unsafe only when the real category budget
      // would overflow. A post-end assignment funded by original Unused is fine.
      if (
        budget.live_cents +
          budget.outstanding_credit_cents +
          state.failed_payment_wallet_credit_cents <=
        donation.pledge_amount_cents
      )
        continue;
      const where = {
        donation_id: donation.id,
        source: 'moderator',
        reversed_at: null,
        allocated_at: { gte: event.ended_at },
      };
      const rows =
        category === 'poll'
          ? await tx.pollVote.findMany({ where, select: { id: true } })
          : await tx.fundContribution.findMany({ where, select: { id: true } });
      if (rows.length)
        consuming_assignments.push({
          donation_id: donation.id,
          category,
          assignment_ids: rows.map((row) => row.id),
        });
    }
  }
  if (consuming_assignments.length)
    blockers.push('Reverse the post-end moderator assignments that consume converted credit first');
  const open_pledges = await tx.pendingPledge.count({
    where: { channel: { event_id: eventId }, status: 'OPEN' },
  });
  return {
    event_id: eventId,
    slug: event.slug,
    action: undo ? ('UNDO_END' as const) : ('END' as const),
    can_apply: blockers.length === 0,
    blockers,
    pool_credit_cents: credits,
    unshipped_physical_donations: physical,
    open_pledges,
    requested_payment_refunds: requested,
    consuming_assignments,
  };
}

async function changeEndTx(tx: Tx, eventId: string, slug: unknown, actor: string, undo: boolean) {
  if (!actor) throw httpError(400, 'Event end actor required');
  const preview = await previewEventEndTx(tx, eventId, undo);
  if (slug !== preview.slug) throw httpError(400, 'Type the Event slug to confirm');
  if (!preview.can_apply) throw httpError(409, preview.blockers.join('; '));
  const now = new Date();
  const event = await tx.event.update({
    where: { id: eventId },
    data: undo
      ? {
          ended_at: null,
          ended_by: null,
          is_active: false,
          end_undone_at: now,
          end_undone_by: actor,
        }
      : { ended_at: now, ended_by: actor },
  });
  await tx.eventEndAudit.create({
    data: { event_id: eventId, action: preview.action, created_by: actor, created_at: now },
  });
  return event;
}
export function endEventTx(tx: Tx, eventId: string, slug: unknown, actor: string) {
  return changeEndTx(tx, eventId, slug, actor, false);
}
export function undoEventEndTx(tx: Tx, eventId: string, slug: unknown, actor: string) {
  return changeEndTx(tx, eventId, slug, actor, true);
}
