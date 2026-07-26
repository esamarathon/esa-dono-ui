import type { Prisma } from '@prisma/client';
import { MIN_SPEND_CENTS, type ClaimData } from '@dono/shared';

type Tx = Prisma.TransactionClient;

export async function claimRewardTx(
  tx: Tx,
  donorId: string,
  rewardId: string,
  claimData?: ClaimData | null,
) {
  const reward = await tx.reward.findUnique({ where: { id: rewardId } });
  if (!reward || !reward.is_active)
    throw Object.assign(new Error('Reward not found'), { status: 404 });
  if (reward.quantity_total !== null && reward.quantity_claimed >= reward.quantity_total) {
    throw Object.assign(new Error('Reward sold out'), { status: 400 });
  }

  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor || donor.balance_remaining < reward.cost_cents) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }

  const data = claimData || {};
  if (reward.type === 'PHYSICAL') {
    const { name, address, city, country } = data as Record<string, unknown>;
    if (!name || !address || !city || !country) {
      throw Object.assign(new Error('Physical rewards require name, address, city, country'), {
        status: 400,
      });
    }
  }

  await tx.donor.update({
    where: { id: donorId },
    data: { balance_remaining: { decrement: reward.cost_cents } },
  });
  await tx.rewardClaim.create({
    data: {
      reward_id: reward.id,
      donor_id: donorId,
      claim_data: JSON.stringify(data),
      status: 'PENDING',
    },
  });
  await tx.reward.update({
    where: { id: reward.id },
    data: { quantity_claimed: { increment: 1 } },
  });

  return { cost: reward.cost_cents };
}

export async function votePollTx(
  tx: Tx,
  donorId: string,
  pollId: string,
  pollOptionId: string,
  cents: number,
) {
  if (!Number.isInteger(cents) || cents < MIN_SPEND_CENTS) {
    throw Object.assign(new Error(`amount_cents (min ${MIN_SPEND_CENTS}) required`), {
      status: 400,
    });
  }

  const poll = await tx.poll.findUnique({ where: { id: pollId } });
  if (!poll || !poll.is_active)
    throw Object.assign(new Error('Poll not found or inactive'), { status: 404 });
  if (poll.ends_at && new Date() > poll.ends_at) {
    throw Object.assign(new Error('Poll has ended'), { status: 400 });
  }

  const option = await tx.pollOption.findUnique({ where: { id: pollOptionId } });
  if (!option || option.poll_id !== poll.id)
    throw Object.assign(new Error('Option not found'), { status: 404 });

  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor || donor.balance_remaining < cents) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }

  await tx.donor.update({
    where: { id: donorId },
    data: { balance_remaining: { decrement: cents } },
  });
  await tx.pollVote.create({
    data: {
      poll_id: poll.id,
      poll_option_id: pollOptionId,
      donor_id: donorId,
      amount_cents: cents,
    },
  });
  await tx.pollOption.update({
    where: { id: pollOptionId },
    data: { votes_cents: { increment: cents } },
  });
  await tx.poll.update({
    where: { id: poll.id },
    data: { total_votes_cents: { increment: cents } },
  });

  return { cost: cents };
}

/**
 * Check text against the global blocked-words dictionary, scoped to the
 * given transaction client (so it reads a consistent snapshot alongside
 * the rest of a proposeCustomEntryTx call).
 */
async function checkBlockedWordsTx(tx: Tx, text: string): Promise<string | null> {
  const blockedWords = await tx.blockedWord.findMany();
  if (blockedWords.length === 0) return null;
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const lowerBlocked = new Set(blockedWords.map((w) => w.word.toLowerCase()));
  for (const word of words) {
    if (lowerBlocked.has(word)) {
      return `Entry contains blocked word: "${word}"`;
    }
  }
  return null;
}

/**
 * Propose a funded custom poll write-in (Model B: spend-immediately-and-reverse).
 *
 * Commits the donor's funds at proposal time by creating a PollOption +
 * PollCustomEntry + PollVote atomically, and decrementing balance_remaining.
 * If the poll's auto_approve is true, the option goes live immediately
 * (votes_cents credited, poll total updated). Otherwise the option is
 * created with status PENDING_APPROVAL and excluded from public tallies
 * until a moderator approves it (server/routes/moderator.ts) or rejects it
 * (funds reversed via BalanceAdjustment, same machinery as vote reversal).
 */
export async function proposeCustomEntryTx(
  tx: Tx,
  donorId: string,
  pollId: string,
  label: string,
  cents: number,
) {
  if (!Number.isInteger(cents) || cents < MIN_SPEND_CENTS) {
    throw Object.assign(new Error(`amount_cents (min ${MIN_SPEND_CENTS}) required`), {
      status: 400,
    });
  }

  const trimmed = (label || '').trim();
  if (!trimmed) {
    throw Object.assign(new Error('label is required'), { status: 400 });
  }

  const poll = await tx.poll.findUnique({ where: { id: pollId } });
  if (!poll || !poll.is_active)
    throw Object.assign(new Error('Poll not found or inactive'), { status: 404 });
  if (!poll.allow_custom_entries)
    throw Object.assign(new Error('This poll does not allow custom entries'), { status: 400 });
  if (poll.ends_at && new Date() > poll.ends_at) {
    throw Object.assign(new Error('Poll has ended'), { status: 400 });
  }
  if (poll.max_entry_chars && trimmed.length > poll.max_entry_chars) {
    throw Object.assign(new Error(`Entry exceeds maximum of ${poll.max_entry_chars} characters`), {
      status: 400,
    });
  }

  const blockedError = await checkBlockedWordsTx(tx, trimmed);
  if (blockedError) {
    throw Object.assign(new Error(blockedError), { status: 400 });
  }

  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor || donor.balance_remaining < cents) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }

  const autoApprove = poll.auto_approve;
  const optionStatus = autoApprove ? 'ACTIVE' : 'PENDING_APPROVAL';

  await tx.donor.update({
    where: { id: donorId },
    data: { balance_remaining: { decrement: cents } },
  });

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

  await tx.pollVote.create({
    data: {
      poll_id: poll.id,
      poll_option_id: option.id,
      donor_id: donorId,
      amount_cents: cents,
    },
  });

  if (autoApprove) {
    await tx.poll.update({
      where: { id: poll.id },
      data: { total_votes_cents: { increment: cents } },
    });
  }

  return { cost: cents, option, entry, status: optionStatus };
}

export async function contributeGoalTx(tx: Tx, donorId: string, goalId: string, cents: number) {
  if (!Number.isInteger(cents) || cents < MIN_SPEND_CENTS) {
    throw Object.assign(new Error(`amount_cents (min ${MIN_SPEND_CENTS}) required`), {
      status: 400,
    });
  }

  const goal = await tx.fundGoal.findUnique({ where: { id: goalId } });
  if (!goal || !goal.is_active || goal.is_complete) {
    throw Object.assign(new Error('Goal not found, inactive, or complete'), { status: 404 });
  }

  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor || donor.balance_remaining < cents) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }

  const newTotal = goal.current_cents + cents;
  const isComplete = newTotal >= goal.target_cents;

  await tx.donor.update({
    where: { id: donorId },
    data: { balance_remaining: { decrement: cents } },
  });
  await tx.fundContribution.create({
    data: { goal_id: goal.id, donor_id: donorId, amount_cents: cents },
  });
  await tx.fundGoal.update({
    where: { id: goal.id },
    data: { current_cents: { increment: cents }, is_complete: isComplete },
  });

  return { cost: cents };
}
