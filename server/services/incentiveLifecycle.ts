import type { Prisma } from '@prisma/client';
import { httpError } from '../lib/httpError.js';
import { deleteUploadByUrl } from '../lib/uploads.js';
import { refundGoalContributions, refundPollOptionVotes } from './reversal.js';
import { withWebhooks, type EmitWebhook } from './webhooks/outbox.js';
import {
  buildIncentiveCreatedPayload,
  buildIncentiveEnabledPayload,
  buildIncentiveDisabledPayload,
  buildIncentiveValueChangedPayload,
} from './webhooks/delivery.js';

type IncentiveKind = 'REWARD' | 'POLL' | 'GOAL';

function protectHistory(count: number) {
  if (count > 0) throw httpError(409, 'This has allocation history. Deactivate it instead.');
}

/** Remove setup mistakes only: reversed rows are still allocation history. */
export async function removeIncentive(kind: IncentiveKind | 'POLL_OPTION', id: string) {
  const image = await withWebhooks(async (tx) => {
    switch (kind) {
      case 'REWARD': {
        const prior = await tx.reward.findUnique({ where: { id } });
        if (!prior) throw httpError(404, 'Reward not found');
        protectHistory(await tx.rewardClaim.count({ where: { reward_id: id } }));
        await tx.reward.delete({ where: { id } });
        return prior.image_url;
      }
      case 'POLL': {
        if (!(await tx.poll.findUnique({ where: { id } }))) throw httpError(404, 'Poll not found');
        protectHistory(
          await tx.pollVote.count({
            where: {
              OR: [{ poll_id: id }, { poll_option: { poll_id: id } }],
            },
          }),
        );
        await tx.poll.delete({ where: { id } });
        return null;
      }
      case 'POLL_OPTION': {
        if (!(await tx.pollOption.findUnique({ where: { id } })))
          throw httpError(404, 'Poll option not found');
        protectHistory(await tx.pollVote.count({ where: { poll_option_id: id } }));
        await tx.pollOption.delete({ where: { id } });
        return null;
      }
      case 'GOAL': {
        if (!(await tx.fundGoal.findUnique({ where: { id } })))
          throw httpError(404, 'Goal not found');
        protectHistory(await tx.fundContribution.count({ where: { goal_id: id } }));
        await tx.fundGoal.delete({ where: { id } });
        return null;
      }
    }
  });
  await deleteUploadByUrl(image);
}
/** Admin-only at the router: preserve the existing soft-delete and refund response. */
export async function reverseAndDeactivate(
  kind: 'GOAL' | 'POLL_OPTION',
  id: string,
  actor: string,
) {
  return withWebhooks(async (tx, emit, publisher) => {
    // Match the common Reversal lock before reading activation state.
    await tx.$executeRaw`UPDATE Donor SET id = id WHERE 0`;
    if (kind === 'POLL_OPTION') {
      const refund = await refundPollOptionVotes(tx, id, actor, publisher);
      await tx.pollOption.update({ where: { id }, data: { status: 'REJECTED' } });
      return refund;
    }
    const prior = await tx.fundGoal.findUnique({ where: { id } });
    if (!prior) throw httpError(404, 'Goal not found');
    const refund = await refundGoalContributions(tx, id, actor, publisher);
    const updated = await tx.fundGoal.update({ where: { id }, data: { is_active: false } });
    await publishActivation(emit, 'GOAL', prior, updated);
    return refund;
  });
}

type IncentiveRow = { id: string; title: string; channel_id: string | null; is_active: boolean };

function identity(kind: IncentiveKind, row: IncentiveRow) {
  return { incentiveKind: kind, incentiveId: row.id, channelId: row.channel_id, title: row.title };
}

async function publishActivation(
  emit: EmitWebhook,
  kind: IncentiveKind,
  prior: IncentiveRow,
  updated: IncentiveRow,
) {
  if (prior.is_active === updated.is_active) return;
  if (updated.is_active) {
    await emit('incentive.enabled', () => buildIncentiveEnabledPayload(identity(kind, updated)));
  } else {
    await emit('incentive.disabled', () => buildIncentiveDisabledPayload(identity(kind, updated)));
  }
}

type PollData = Pick<
  Prisma.PollUncheckedCreateInput,
  | 'title'
  | 'description'
  | 'is_active'
  | 'ends_at'
  | 'allow_custom_entries'
  | 'max_entry_chars'
  | 'auto_approve'
  | 'channel_id'
>;

export async function createPoll(
  data: PollData & Pick<Prisma.PollUncheckedCreateInput, 'options'>,
) {
  return withWebhooks(async (tx, emit) => {
    const created = await tx.poll.create({ data, include: { options: true } });
    await emit('incentive.created', () =>
      buildIncentiveCreatedPayload({
        ...identity('POLL', created),
        isActive: created.is_active,
        endsAt: created.ends_at,
      }),
    );
    return created;
  });
}

export async function updatePoll(id: string, data: Partial<PollData>) {
  return withWebhooks(async (tx, emit) => {
    const prior = await tx.poll.findUnique({ where: { id } });
    if (!prior) throw httpError(404, 'Poll not found');
    const updated = await tx.poll.update({ where: { id }, data, include: { options: true } });
    await publishActivation(emit, 'POLL', prior, updated);
    const oldEndsAt = prior.ends_at;
    const newEndsAt = updated.ends_at;
    if (oldEndsAt?.getTime() !== newEndsAt?.getTime()) {
      await emit('incentive.value_changed', () =>
        buildIncentiveValueChangedPayload({
          ...identity('POLL', updated),
          changedFields: ['ends_at'],
          oldEndsAt,
          newEndsAt,
        }),
      );
    }
    return updated;
  });
}

// Option labels have no incentive message type.
export async function createPollOption(pollId: string, label: string) {
  return withWebhooks((tx) => tx.pollOption.create({ data: { poll_id: pollId, label } }));
}

export async function updatePollOption(id: string, label: string) {
  return withWebhooks((tx) => tx.pollOption.update({ where: { id }, data: { label } }));
}

type GoalData = Pick<
  Prisma.FundGoalUncheckedCreateInput,
  'title' | 'description' | 'target_cents' | 'is_active' | 'channel_id'
>;

export async function createGoal(data: GoalData) {
  return withWebhooks(async (tx, emit) => {
    const created = await tx.fundGoal.create({ data });
    await emit('incentive.created', () =>
      buildIncentiveCreatedPayload({
        ...identity('GOAL', created),
        isActive: created.is_active,
        targetCents: created.target_cents,
      }),
    );
    return created;
  });
}

export async function updateGoal(id: string, data: Partial<GoalData> & { is_complete?: boolean }) {
  return withWebhooks(async (tx, emit) => {
    const prior = await tx.fundGoal.findUnique({ where: { id } });
    if (!prior) throw httpError(404, 'Goal not found');
    const updated = await tx.fundGoal.update({ where: { id }, data });
    await publishActivation(emit, 'GOAL', prior, updated);
    if (prior.target_cents !== updated.target_cents) {
      await emit('incentive.value_changed', () =>
        buildIncentiveValueChangedPayload({
          ...identity('GOAL', updated),
          changedFields: ['target_cents'],
          oldTargetCents: prior.target_cents,
          newTargetCents: updated.target_cents,
        }),
      );
    }
    return updated;
  });
}

type RewardData = Pick<
  Prisma.RewardUncheckedCreateInput,
  | 'title'
  | 'description'
  | 'type'
  | 'cost_cents'
  | 'quantity_total'
  | 'is_active'
  | 'custom_type_label'
  | 'image_url'
  | 'channel_id'
>;

export async function updateReward(id: string, data: Partial<RewardData>) {
  const { reward, replacedImage } = await withWebhooks(async (tx, emit) => {
    const prior = await tx.reward.findUnique({ where: { id } });
    if (!prior) throw httpError(404, 'Reward not found');
    const updated = await tx.reward.update({ where: { id }, data });
    await publishActivation(emit, 'REWARD', prior, updated);
    if (prior.cost_cents !== updated.cost_cents) {
      await emit('incentive.value_changed', () =>
        buildIncentiveValueChangedPayload({
          ...identity('REWARD', updated),
          changedFields: ['cost_cents'],
          oldCostCents: prior.cost_cents,
          newCostCents: updated.cost_cents,
        }),
      );
    }
    return {
      reward: updated,
      replacedImage: prior.image_url !== updated.image_url ? prior.image_url : null,
    };
  });
  // Filesystem changes cannot roll back with SQLite. Clean up only after commit.
  await deleteUploadByUrl(replacedImage);
  return reward;
}

export async function createReward(data: RewardData) {
  return withWebhooks(async (tx, emit) => {
    const created = await tx.reward.create({ data });
    await emit('incentive.created', () =>
      buildIncentiveCreatedPayload({
        incentiveKind: 'REWARD',
        incentiveId: created.id,
        channelId: created.channel_id,
        title: created.title,
        isActive: created.is_active,
        costCents: created.cost_cents,
      }),
    );
    return created;
  });
}
