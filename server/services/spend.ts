import type { Prisma } from '@prisma/client';
import type { ClaimData } from '@dono/shared';

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
  if (!Number.isInteger(cents) || cents < 100) {
    throw Object.assign(new Error('amount_cents (min 100) required'), { status: 400 });
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

export async function contributeGoalTx(tx: Tx, donorId: string, goalId: string, cents: number) {
  if (!Number.isInteger(cents) || cents < 100) {
    throw Object.assign(new Error('amount_cents (min 100) required'), { status: 400 });
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
