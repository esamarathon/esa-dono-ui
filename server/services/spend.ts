import type { Prisma } from '@prisma/client';
import { MIN_SPEND_CENTS, type ClaimData, type PoolCategory } from '@dono/shared';
import { httpError } from '../lib/httpError.js';
import { readDonationAccountingTx } from './poolAccounting.js';
import { textWordTokens } from './blockedWords.js';

type Tx = Prisma.TransactionClient;

/** Pool fulfillment draws from this donation, never from the available Wallet. */
export interface PoolSpend {
  mode: 'pool';
  source: 'donor' | 'auto';
  /** Portion of a donor-directed line that came from automatic redistribution. */
  auto_cents?: number;
  unit_price_cents?: number;
  confirmed_reward_type?: string;
}

/** Trusted credit funding is separate from initial fulfillment and available Wallet. */
export interface CreditSpend {
  mode: 'credit';
  source: 'donor';
  event_id: string;
  batch_id: string;
  funding: { credit_id: string; amount_cents: number }[];
  auto_cents?: never;
  unit_price_cents?: number;
  confirmed_reward_type?: string;
}
type SpendFunding = PoolSpend | CreditSpend;
async function linkCreditTx(
  tx: Tx,
  pool: SpendFunding | undefined,
  target: { claim_id?: string; vote_id?: string; contribution_id?: string },
) {
  if (pool?.mode === 'credit')
    await tx.poolCreditRedemption.createMany({
      data: pool.funding.map((row) => ({ ...row, batch_id: pool.batch_id, ...target })),
    });
}

function allocationRows(cents: number, pool?: SpendFunding) {
  const auto = pool?.auto_cents ?? 0;
  if (!Number.isInteger(auto) || auto < 0 || auto > cents)
    throw httpError(400, 'Invalid auto allocation');
  return [
    ...(cents > auto ? [{ amount_cents: cents - auto, source: pool?.source ?? 'donor' }] : []),
    ...(auto > 0 ? [{ amount_cents: auto, source: 'auto' }] : []),
  ];
}

async function fundSpend(
  tx: Tx,
  donorId: string,
  donationId: string | null,
  category: PoolCategory,
  cents: number,
  incentiveChannel: string | null,
  pool?: SpendFunding,
) {
  if (pool?.mode === 'credit') {
    const batch = await tx.poolCreditBatch.findUnique({ where: { id: pool.batch_id } });
    const event = await tx.event.findUnique({ where: { id: pool.event_id } });
    const channel = incentiveChannel
      ? await tx.channel.findUnique({ where: { id: incentiveChannel } })
      : null;
    if (
      !batch ||
      batch.donor_id !== donorId ||
      batch.event_id !== pool.event_id ||
      !event ||
      event.ended_at ||
      (incentiveChannel && channel?.event_id !== pool.event_id)
    )
      throw httpError(409, 'Invalid credit Event or target');
    if (
      !pool.funding.length ||
      new Set(pool.funding.map((row) => row.credit_id)).size !== pool.funding.length ||
      pool.funding.reduce((sum, row) => sum + row.amount_cents, 0) !== cents
    )
      throw httpError(400, 'Invalid credit funding');
    for (const component of pool.funding) {
      const credit = await tx.poolCredit.findUnique({
        where: { id: component.credit_id },
        include: {
          donation: {
            select: {
              donor_id: true,
              event_id: true,
              pledge_amount_cents: true,
              status: true,
              payment_refunds: { where: { status: 'REQUESTED' }, select: { id: true } },
            },
          },
        },
      });
      if (
        !credit ||
        credit.category !== category ||
        credit.donation.donor_id !== donorId ||
        credit.donation.event_id !== pool.event_id ||
        credit.donation.pledge_amount_cents === null ||
        !['COMPLETED', 'REFUNDED'].includes(credit.donation.status) ||
        credit.donation.payment_refunds.length ||
        !Number.isSafeInteger(component.amount_cents) ||
        component.amount_cents <= 0 ||
        credit.remaining_cents < component.amount_cents ||
        (donationId && donationId !== credit.donation_id)
      )
        throw httpError(409, 'Pool credit changed or source unavailable; refresh and review');
      const accounting = await readDonationAccountingTx(tx, credit.donation_id);
      if (
        accounting.pools[category].live_cents +
          accounting.pools[category].outstanding_credit_cents +
          accounting.failed_payment_wallet_credit_cents >
        accounting.pledge_amount_cents!
      )
        throw httpError(409, 'Source category budget is inconsistent');
      await tx.poolCredit.update({
        where: { id: credit.id },
        data: { remaining_cents: { decrement: component.amount_cents } },
      });
    }
    return;
  }
  if (!pool) {
    const donor = await tx.donor.findUnique({ where: { id: donorId } });
    if (!donor || donor.balance_remaining < cents) throw httpError(400, 'Insufficient balance');
    await tx.donor.update({
      where: { id: donorId },
      data: { balance_remaining: { decrement: cents } },
    });
    return;
  }
  if (!donationId) throw httpError(400, 'Pool spend requires a source donation');
  const donation = await tx.donation.findUnique({ where: { id: donationId } });
  if (
    !donation ||
    donation.pledge_amount_cents === null ||
    donation.donor_id !== donorId ||
    donation.status !== 'COMPLETED'
  ) {
    throw httpError(400, 'Invalid Pool source donation');
  }
  if (incentiveChannel && incentiveChannel !== donation.channel_id)
    throw httpError(400, 'Incentive belongs to another Channel');
  const accounting = await readDonationAccountingTx(tx, donationId);
  const budget = accounting.pools[category];
  if (
    budget.live_cents +
      budget.outstanding_credit_cents +
      donation.failed_payment_wallet_credit_cents +
      cents >
    donation.pledge_amount_cents
  ) {
    throw httpError(400, 'Pool budget exceeded or reserved');
  }
}

function validateCents(cents: number, pool?: SpendFunding) {
  const minimum = pool ? 1 : MIN_SPEND_CENTS;
  if (!Number.isSafeInteger(cents) || cents < minimum)
    throw httpError(400, `amount_cents (min ${minimum}) required`);
  allocationRows(cents, pool);
}

export async function claimRewardTx(
  tx: Tx,
  donorId: string,
  rewardId: string,
  claimData?: ClaimData | null,
  quantity = 1,
  donationId: string | null = null,
  pool?: SpendFunding,
) {
  if (!Number.isInteger(quantity) || quantity < 1)
    throw httpError(400, 'quantity must be a positive integer');
  const reward = await tx.reward.findUnique({ where: { id: rewardId } });
  if (!reward || !reward.is_active) throw httpError(404, 'Reward not found');
  if (reward.type === 'PHYSICAL' && !pool)
    throw httpError(400, 'Physical rewards require a cash-funded pledge through Stripe checkout');
  if (reward.quantity_total !== null && reward.quantity_claimed + quantity > reward.quantity_total)
    throw httpError(400, 'Reward sold out');
  const unitPrice = pool ? pool.unit_price_cents : reward.cost_cents;
  if (!Number.isSafeInteger(unitPrice) || unitPrice! < (pool ? 1 : 0))
    throw httpError(400, 'Confirmed reward price required');
  if (pool && (pool.source !== 'donor' || pool.confirmed_reward_type !== reward.type))
    throw httpError(400, 'Reward type changed after confirmation');
  const totalCost = unitPrice! * quantity;
  if (
    pool?.mode === 'credit' &&
    (reward.type === 'PHYSICAL' ||
      reward.cost_cents !== unitPrice ||
      donationId !== null ||
      quantity !== 1)
  )
    throw httpError(409, 'Credit reward price/type changed or invalid whole entitlement');
  if (pool) validateCents(totalCost, pool);
  if (pool && pool.confirmed_reward_type === 'PHYSICAL') {
    const donation = donationId
      ? await tx.donation.findUnique({ where: { id: donationId } })
      : null;
    const confirmed = donationId
      ? await tx.pendingPledge.findUnique({
          where: { fulfilled_by_donation_id: donationId },
          select: {
            new_money_cents: true,
            items: { where: { confirmed_reward_type: 'PHYSICAL' }, select: { target_id: true } },
          },
        })
      : null;
    // Classify prior claims by CONFIRMED types, not a catalog type that may have
    // changed since payment. An unlinked Pool source conservatively counts all claims.
    const physical = await tx.rewardClaim.aggregate({
      where: {
        donation_id: donationId,
        reversed_at: null,
        status: { in: ['PENDING', 'FULFILLED', 'CANCELLING'] },
        ...(confirmed ? { reward_id: { in: confirmed.items.map((item) => item.target_id) } } : {}),
      },
      _sum: { amount_cents: true },
    });
    if (
      !donation ||
      totalCost + (physical._sum.amount_cents ?? 0) >
        Math.min(donation.amount_cents, confirmed?.new_money_cents ?? donation.amount_cents)
    )
      throw httpError(400, 'Physical rewards exceed confirmed new money');
  }
  await fundSpend(tx, donorId, donationId, 'reward', totalCost, reward.channel_id, pool);
  // One row per unit; price is the confirmed allocation, never the live price.
  const claimIds: string[] = [];
  for (let index = 0; index < quantity; index++) {
    const claim = await tx.rewardClaim.create({
      data: {
        reward_id: reward.id,
        donor_id: donorId,
        claim_data: JSON.stringify(claimData || {}),
        status: 'PENDING',
        amount_cents: unitPrice!,
        donation_id: donationId,
      },
    });
    claimIds.push(claim.id);
    await linkCreditTx(tx, pool, { claim_id: claim.id });
  }
  await tx.reward.update({
    where: { id: reward.id },
    data: { quantity_claimed: { increment: quantity } },
  });
  return { cost: totalCost, claim_ids: claimIds };
}

export async function votePollTx(
  tx: Tx,
  donorId: string,
  pollId: string,
  pollOptionId: string,
  cents: number,
  donationId: string | null = null,
  pool?: SpendFunding,
) {
  validateCents(cents, pool);
  const poll = await tx.poll.findUnique({ where: { id: pollId } });
  if (!poll || !poll.is_active) throw httpError(404, 'Poll not found or inactive');
  if (poll.ends_at && new Date() >= poll.ends_at) throw httpError(400, 'Poll has ended');
  const option = await tx.pollOption.findUnique({ where: { id: pollOptionId } });
  if (!option || option.poll_id !== poll.id) throw httpError(404, 'Option not found');
  if (option.status === 'REJECTED') throw httpError(400, 'Option was rejected');
  await fundSpend(tx, donorId, donationId, 'poll', cents, poll.channel_id, pool);
  const voteIds: string[] = [];
  for (const row of allocationRows(cents, pool)) {
    const vote = await tx.pollVote.create({
      data: {
        ...row,
        poll_id: poll.id,
        poll_option_id: pollOptionId,
        donor_id: donorId,
        donation_id: donationId,
      },
    });
    voteIds.push(vote.id);
    await linkCreditTx(tx, pool, { vote_id: vote.id });
  }
  // Pending write-ins reserve their intended share but do not enter public tallies.
  if (option.status === 'PENDING_APPROVAL') return { cost: cents, vote_ids: voteIds };
  await tx.pollOption.update({
    where: { id: pollOptionId },
    data: { votes_cents: { increment: cents } },
  });
  await tx.poll.update({
    where: { id: poll.id },
    data: { total_votes_cents: { increment: cents } },
  });
  return { cost: cents, vote_ids: voteIds };
}

/** Shared live text policy for eligibility classification and funded write-ins. */
export async function customEntryTextErrorTx(
  tx: Tx,
  text: string,
  maxEntryChars: number | null,
): Promise<string | null> {
  if (maxEntryChars && text.length > maxEntryChars)
    return `Entry exceeds maximum of ${maxEntryChars} characters`;
  const blockedWords = await tx.blockedWord.findMany();
  const words = textWordTokens(text);
  for (const blocked of blockedWords) {
    if (words.has(blocked.word.toLowerCase()))
      return `Entry contains blocked word: "${blocked.word}"`;
  }
  return null;
}

/** A funded write-in reserves funds now; approval alone moves them into tallies. */
export async function proposeCustomEntryTx(
  tx: Tx,
  donorId: string,
  pollId: string,
  label: string,
  cents: number,
  donationId: string | null = null,
  pool?: PoolSpend,
) {
  validateCents(cents, pool);
  const trimmed = (label || '').trim();
  if (!trimmed) throw httpError(400, 'label is required');
  const poll = await tx.poll.findUnique({ where: { id: pollId } });
  if (!poll || !poll.is_active) throw httpError(404, 'Poll not found or inactive');
  if (!poll.allow_custom_entries) throw httpError(400, 'This poll does not allow custom entries');
  if (poll.ends_at && new Date() >= poll.ends_at) throw httpError(400, 'Poll has ended');
  const textError = await customEntryTextErrorTx(tx, trimmed, poll.max_entry_chars);
  if (textError) throw httpError(400, textError);
  await fundSpend(tx, donorId, donationId, 'poll', cents, poll.channel_id, pool);
  const autoApprove = poll.auto_approve;
  const optionStatus = autoApprove ? 'ACTIVE' : 'PENDING_APPROVAL';
  const entry = await tx.pollCustomEntry.create({
    data: {
      poll_id: poll.id,
      donor_id: donorId,
      label: trimmed,
      status: autoApprove ? 'APPROVED' : 'PENDING',
    },
  });
  const option = await tx.pollOption.create({
    data: {
      poll_id: poll.id,
      label: trimmed,
      status: optionStatus,
      votes_cents: autoApprove ? cents : 0,
      custom_entry_id: entry.id,
    },
  });
  await tx.pollVote.createMany({
    data: allocationRows(cents, pool).map((row) => ({
      ...row,
      poll_id: poll.id,
      poll_option_id: option.id,
      donor_id: donorId,
      donation_id: donationId,
    })),
  });
  if (autoApprove)
    await tx.poll.update({
      where: { id: poll.id },
      data: { total_votes_cents: { increment: cents } },
    });
  return { cost: cents, option, entry, status: optionStatus };
}

export async function contributeGoalTx(
  tx: Tx,
  donorId: string,
  goalId: string,
  cents: number,
  donationId: string | null = null,
  pool?: SpendFunding,
) {
  validateCents(cents, pool);
  const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
  // Credit batches validate the WHOLE selection against open goals before
  // mutation. An earlier source component may complete this same selection.
  if (!goal || !goal.is_active || (goal.is_complete && pool?.mode !== 'credit'))
    throw httpError(404, 'Goal not found, inactive, or complete');
  await fundSpend(tx, donorId, donationId, 'goal', cents, goal.channel_id, pool);
  const contributionIds: string[] = [];
  for (const row of allocationRows(cents, pool)) {
    const contribution = await tx.fundContribution.create({
      data: { ...row, goal_id: goal.id, donor_id: donorId, donation_id: donationId },
    });
    contributionIds.push(contribution.id);
    await linkCreditTx(tx, pool, { contribution_id: contribution.id });
  }
  await tx.fundGoal.update({
    where: { id: goal.id },
    data: {
      current_cents: { increment: cents },
      is_complete: goal.current_cents + cents >= goal.target_cents,
    },
  });
  return { cost: cents, contribution_ids: contributionIds };
}
