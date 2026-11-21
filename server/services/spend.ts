import type { Prisma } from '@prisma/client';
import {
  MIN_SPEND_CENTS,
  claimAnswerError,
  isAvailableOn,
  type ClaimData,
  type PoolCategory,
} from '@dono/shared';
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
  incentive: { channel_id: string | null; event_id: string },
  pool?: SpendFunding,
) {
  if (pool?.mode === 'credit') {
    const batch = await tx.poolCreditBatch.findUnique({ where: { id: pool.batch_id } });
    const event = await tx.event.findUnique({ where: { id: pool.event_id } });
    if (
      !batch ||
      batch.donor_id !== donorId ||
      batch.event_id !== pool.event_id ||
      !event ||
      event.ended_at ||
      incentive.event_id !== pool.event_id
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
  // ADR-0012: the donation's Channel, or a shared incentive of its Event.
  if (
    incentive.event_id !== donation.event_id ||
    (incentive.channel_id !== null && incentive.channel_id !== donation.channel_id)
  )
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

const WALLET_SPEND_TARGET = { reward: 'Reward', poll: 'Poll', goal: 'Goal' } as const;

/**
 * A direct Wallet spend targets one active Channel and may fund only an
 * incentive available on it, like a pledge (ADR-0012). Call it in the spend's
 * transaction before any write. A missing incentive is left to the spend's 404.
 */
export async function assertWalletSpendScopeTx(
  tx: Tx,
  channelId: unknown,
  kind: keyof typeof WALLET_SPEND_TARGET,
  incentiveId: string,
) {
  if (!channelId || typeof channelId !== 'string') throw httpError(400, 'channel_id is required');
  const channel = await tx.channel.findUnique({ where: { id: channelId } });
  if (!channel || !channel.is_active) throw httpError(404, 'Channel not found or inactive');
  const where = { where: { id: incentiveId } };
  const incentive =
    kind === 'reward'
      ? await tx.reward.findUnique(where)
      : kind === 'poll'
        ? await tx.poll.findUnique(where)
        : await tx.fundGoal.findUnique(where);
  if (incentive && !isAvailableOn(incentive, channel))
    throw httpError(400, `${WALLET_SPEND_TARGET[kind]} is not available on this Channel`);
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
  // A labeled CUSTOM reward requires its claim answer (#78). Creation only:
  // historical claims with blank answers are never rewritten.
  const answerError = claimAnswerError(claimData, reward);
  if (answerError) throw httpError(400, answerError);
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
  await fundSpend(tx, donorId, donationId, 'reward', totalCost, reward, pool);
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
  await fundSpend(tx, donorId, donationId, 'poll', cents, poll, pool);
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
  await fundSpend(tx, donorId, donationId, 'poll', cents, poll, pool);
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

/** Live money a goal can still take. Never negative, never from a stale flag (#201). */
export function goalRemainingCents(goal: { target_cents: number; current_cents: number }) {
  return Math.max(0, goal.target_cents - goal.current_cents);
}

export interface GoalSplit {
  donor: number;
  auto: number;
}

/**
 * Write one goal contribution with an exact donor/auto split. The amount is
 * capped at the goal's live remaining need inside this write, so no caller can
 * overfill a goal (#201). Returns the cents actually placed; money that did not
 * fit stays with the caller (Unused pool money, Pool credit, or the chain).
 */
export async function contributeGoalSplitTx(
  tx: Tx,
  donorId: string,
  goalId: string,
  split: GoalSplit,
  donationId: string | null = null,
  pool?: SpendFunding,
) {
  const cents = split.donor + split.auto;
  if (
    !Number.isSafeInteger(split.donor) ||
    !Number.isSafeInteger(split.auto) ||
    split.donor < 0 ||
    split.auto < 0
  )
    throw httpError(400, 'Invalid goal allocation');
  if (cents === 0) return { cost: 0, contribution_ids: [] };
  validateCents(cents, pool);
  const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
  // Credit batches validate the WHOLE selection against open goals before
  // mutation. An earlier source component may complete this same selection.
  if (!goal || !goal.is_active || (goal.is_complete && pool?.mode !== 'credit'))
    throw httpError(404, 'Goal not found, inactive, or complete');
  const placed = Math.min(cents, goalRemainingCents(goal));
  if (placed === 0) return { cost: 0, contribution_ids: [] };
  // Donor-chosen money is placed before automatic money; the dropped auto money
  // is returned to the pool, where the chain decides where it continues.
  const auto = Math.max(0, placed - Math.min(split.donor, placed));
  const funding: SpendFunding | undefined =
    pool?.mode === 'credit'
      ? { ...pool, funding: truncateFunding(pool.funding, placed) }
      : pool && { ...pool, auto_cents: auto };
  await fundSpend(tx, donorId, donationId, 'goal', placed, goal, funding);
  const contributionIds: string[] = [];
  for (const row of allocationRows(placed, funding)) {
    const contribution = await tx.fundContribution.create({
      data: { ...row, goal_id: goal.id, donor_id: donorId, donation_id: donationId },
    });
    contributionIds.push(contribution.id);
    await linkCreditTx(tx, funding, { contribution_id: contribution.id });
  }
  await tx.fundGoal.update({
    where: { id: goal.id },
    data: {
      current_cents: { increment: placed },
      is_complete: goal.current_cents + placed >= goal.target_cents,
    },
  });
  return { cost: placed, contribution_ids: contributionIds };
}

/** Oldest-first credit is drawn by the caller; drop the tail that this write cannot take. */
function truncateFunding(funding: CreditSpend['funding'], cents: number) {
  const rows: CreditSpend['funding'] = [];
  let left = cents;
  for (const component of funding) {
    if (left <= 0) break;
    const amount = Math.min(left, component.amount_cents);
    rows.push({ ...component, amount_cents: amount });
    left -= amount;
  }
  return rows;
}

/** A pool or Wallet goal spend, split by its optional automatic part. */
export async function contributeGoalTx(
  tx: Tx,
  donorId: string,
  goalId: string,
  cents: number,
  donationId: string | null = null,
  pool?: SpendFunding,
) {
  const auto = pool?.auto_cents ?? 0;
  return contributeGoalSplitTx(
    tx,
    donorId,
    goalId,
    { donor: cents - auto, auto },
    donationId,
    pool,
  );
}
