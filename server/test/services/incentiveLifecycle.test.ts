import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { PathLike } from 'fs';

// Observe the filesystem boundary, while still deleting real fixture files.
const files = vi.hoisted(() => ({ beforeUnlink: vi.fn<(path: PathLike) => Promise<void>>() }));
vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>();
  return {
    ...fs,
    unlink: async (path: PathLike) => {
      await files.beforeUnlink(path);
      return fs.unlink(path);
    },
  };
});

// Real SQLite and outbox; no delivery network calls.
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
import prisma from '../../lib/prisma.js';
import { createTestChannel, DEFAULT_EVENT_ID } from '../helpers/fixtures.js';
const channelIds: string[] = [];
import {
  createReward,
  updateReward,
  createPoll,
  updatePoll,
  createGoal,
  updateGoal,
  createPollOption,
  updatePollOption,
  removeIncentive,
  reverseAndDeactivate,
} from '../../services/incentiveLifecycle.js';
import { access, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { UPLOADS_DIR, ensureUploadsDir } from '../../lib/uploads.js';

const imagePaths: string[] = [];
// A separate WAL reader sees committed state even while the writer has a transaction open.
const committed = new PrismaClient();

const rewardIds: string[] = [];
const pollIds: string[] = [];
const goalIds: string[] = [];
const donorIds: string[] = [];
const destinationIds: string[] = [];

async function destination() {
  const row = await prisma.webhookDestination.create({
    data: {
      url: 'http://127.0.0.1:1/hook',
      secret: 's',
      event_types:
        '["incentive.created","incentive.enabled","incentive.disabled","incentive.value_changed"]',
    },
  });
  destinationIds.push(row.id);
  return row.id;
}

async function messages(destinationId: string) {
  const rows = await prisma.webhookDelivery.findMany({
    where: { destination_id: destinationId },
    orderBy: { seq: 'asc' },
  });
  return rows.map((row) => JSON.parse(row.payload));
}

afterEach(async () => {
  files.beforeUnlink.mockReset();
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_lifecycle_delivery');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_lifecycle_deactivation');
  for (const path of imagePaths.splice(0)) await unlink(path).catch(() => {});
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
  donorIds.length = 0;
  await prisma.reward.deleteMany({ where: { id: { in: rewardIds } } });
  await prisma.poll.deleteMany({ where: { id: { in: pollIds } } });
  await prisma.channelDefaultGoal.deleteMany({ where: { channel_id: { in: channelIds } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goalIds } } });
  pollIds.length = goalIds.length = 0;
  await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
  channelIds.length = 0;
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinationIds } } });
  rewardIds.length = destinationIds.length = 0;
});
afterAll(async () => {
  await committed.$disconnect();
  await prisma.$disconnect();
});

describe('Incentive lifecycle on SQLite', () => {
  it('updates reward activation and price, but ignores unchanged values and title-only changes', async () => {
    const target = await destination();
    const reward = await prisma.reward.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Old', type: 'DIGITAL', cost_cents: 500 },
    });
    rewardIds.push(reward.id);
    await updateReward(reward.id, { title: 'New', is_active: false, cost_cents: 700 });
    await updateReward(reward.id, { title: 'Renamed', is_active: false, cost_cents: 700 });
    await updateReward(reward.id, { is_active: true });
    expect(await messages(target)).toEqual([
      expect.objectContaining({
        type: 'incentive.disabled',
        data: {
          incentive_kind: 'REWARD',
          incentive_id: reward.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'New',
        },
      }),
      expect.objectContaining({
        type: 'incentive.value_changed',
        data: {
          incentive_kind: 'REWARD',
          incentive_id: reward.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'New',
          changed_fields: ['cost_cents'],
          old_cost_cents: 500,
          new_cost_cents: 700,
        },
      }),
      expect.objectContaining({
        type: 'incentive.enabled',
        data: {
          incentive_kind: 'REWARD',
          incentive_id: reward.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'Renamed',
        },
      }),
    ]);
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
      title: 'Renamed',
      is_active: true,
      cost_cents: 700,
    });
  });
  it('keeps the old image and record when an update rolls back, and deletes the image only on success', async () => {
    const target = await destination();
    await ensureUploadsDir();
    const filename = `${crypto.randomUUID()}.webp`;
    const imagePath = join(UPLOADS_DIR, filename);
    imagePaths.push(imagePath);
    await writeFile(imagePath, 'old image');
    const reward = await createReward({
      event_id: DEFAULT_EVENT_ID,
      title: 'Image reward',
      type: 'DIGITAL',
      cost_cents: 500,
      image_url: `/api/uploads/${filename}`,
    });
    rewardIds.push(reward.id);
    const deletedStates: unknown[] = [];
    files.beforeUnlink.mockImplementation(async (path) => {
      if (path === imagePath)
        deletedStates.push(await committed.reward.findUnique({ where: { id: reward.id } }));
    });
    await prisma.webhookDelivery.deleteMany({ where: { destination_id: target } });
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_lifecycle_delivery BEFORE INSERT ON WebhookDelivery
      WHEN NEW.destination_id = '${target}' AND NEW.event_type = 'incentive.value_changed'
      BEGIN SELECT RAISE(ABORT, 'forced delivery failure'); END`);
    await expect(
      updateReward(reward.id, {
        cost_cents: 700,
        is_active: false,
        image_url: '/api/uploads/new.webp',
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(access(imagePath)).resolves.toBeUndefined();
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
      cost_cents: 500,
      is_active: true,
      image_url: `/api/uploads/${filename}`,
    });
    expect(await messages(target)).toEqual([]);
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_lifecycle_delivery');
    await updateReward(reward.id, { cost_cents: 700, image_url: '/api/uploads/new.webp' });
    await expect(access(imagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(deletedStates).toEqual([
      expect.objectContaining({ cost_cents: 700, image_url: '/api/uploads/new.webp' }),
    ]);
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
      cost_cents: 700,
      image_url: '/api/uploads/new.webp',
    });
  });

  it('creates and updates a poll with options, activation and end-time messages in order', async () => {
    const target = await destination();
    const poll = await createPoll({
      event_id: DEFAULT_EVENT_ID,
      title: 'Poll',
      is_active: false,
      options: { create: [{ label: 'A' }, { label: 'B' }] },
    });
    pollIds.push(poll.id);
    expect(poll.options.map((option) => option.label)).toEqual(['A', 'B']);
    const endsAt = new Date('2026-12-01T12:00:00Z');
    const updated = await updatePoll(poll.id, {
      title: 'Open poll',
      is_active: true,
      ends_at: endsAt,
    });
    expect(updated.options).toHaveLength(2);
    await updatePoll(poll.id, {
      description: 'Only text',
      ends_at: new Date('2026-12-01T12:00:00Z'),
    });
    await updatePoll(poll.id, { is_active: false, ends_at: null });
    expect(await messages(target)).toEqual([
      expect.objectContaining({
        type: 'incentive.created',
        data: {
          incentive_kind: 'POLL',
          incentive_id: poll.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'Poll',
          is_active: false,
          ends_at: null,
        },
      }),
      expect.objectContaining({
        type: 'incentive.enabled',
        data: {
          incentive_kind: 'POLL',
          incentive_id: poll.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'Open poll',
        },
      }),
      expect.objectContaining({
        type: 'incentive.value_changed',
        data: {
          incentive_kind: 'POLL',
          incentive_id: poll.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'Open poll',
          changed_fields: ['ends_at'],
          old_ends_at: null,
          new_ends_at: endsAt.toISOString(),
        },
      }),
      expect.objectContaining({ type: 'incentive.disabled' }),
      expect.objectContaining({
        type: 'incentive.value_changed',
        data: expect.objectContaining({ old_ends_at: endsAt.toISOString(), new_ends_at: null }),
      }),
    ]);
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      is_active: false,
      ends_at: null,
      description: 'Only text',
    });
  });

  it('derives goal completion on target edits and rejects a manual completion override', async () => {
    const target = await destination();
    const goal = await createGoal({
      event_id: DEFAULT_EVENT_ID,
      title: 'Goal',
      target_cents: 1000,
    });
    goalIds.push(goal.id);
    await expect(updateGoal(goal.id, { is_complete: true })).rejects.toMatchObject({ status: 400 });
    await updateGoal(goal.id, { target_cents: 2000, is_active: false });
    await updateGoal(goal.id, { description: 'Changed text', target_cents: 2000 });
    await updateGoal(goal.id, { is_active: true });
    expect(await messages(target)).toEqual([
      expect.objectContaining({
        type: 'incentive.created',
        data: {
          incentive_kind: 'GOAL',
          incentive_id: goal.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'Goal',
          is_active: true,
          target_cents: 1000,
        },
      }),
      expect.objectContaining({ type: 'incentive.disabled' }),
      expect.objectContaining({
        type: 'incentive.value_changed',
        data: {
          incentive_kind: 'GOAL',
          incentive_id: goal.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: 'Goal',
          changed_fields: ['target_cents'],
          old_target_cents: 1000,
          new_target_cents: 2000,
        },
      }),
      expect.objectContaining({ type: 'incentive.enabled' }),
    ]);
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      target_cents: 2000,
      current_cents: 0,
      is_active: true,
      is_complete: false,
    });
  });

  it('validates representable positive cents, titles, labels, nullable Channels and stock', async () => {
    const goal = await createGoal({
      event_id: DEFAULT_EVENT_ID,
      title: '  Goal  ',
      target_cents: 1000,
    });
    goalIds.push(goal.id);
    expect(goal.title).toBe('Goal');
    for (const target of [0, -1, 0.5, 2147483648, Number.MAX_SAFE_INTEGER]) {
      await expect(updateGoal(goal.id, { target_cents: target })).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(updateGoal(goal.id, { title: '  ' })).rejects.toMatchObject({ status: 400 });
    await expect(updateGoal(goal.id, { channel_id: 'missing' })).rejects.toMatchObject({
      status: 400,
    });
    const reward = await createReward({
      event_id: DEFAULT_EVENT_ID,
      title: '  Reward  ',
      type: 'DIGITAL',
      cost_cents: 1,
    });
    rewardIds.push(reward.id);
    for (const cost of [0, -1, 0.5, 2147483648]) {
      await expect(updateReward(reward.id, { cost_cents: cost })).rejects.toMatchObject({
        status: 400,
      });
    }
    for (const stock of [-1, 0.5, 2147483648]) {
      await expect(updateReward(reward.id, { quantity_total: stock })).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(await updateReward(reward.id, { quantity_total: 0 })).toMatchObject({
      quantity_total: 0,
    });
    const poll = await createPoll({
      event_id: DEFAULT_EVENT_ID,
      title: ' Poll ',
      options: { create: [{ label: ' A ' }] },
    });
    pollIds.push(poll.id);
    expect(poll).toMatchObject({
      title: 'Poll',
      options: [expect.objectContaining({ label: 'A' })],
    });
    await expect(createPollOption(poll.id, '  ')).rejects.toMatchObject({ status: 400 });
    await expect(updatePollOption(poll.options[0]!.id, '  ')).rejects.toMatchObject({
      status: 400,
    });
  });

  it.each([false, true])(
    'protects Channel and reward type changes with allocation history (reversed: %s)',
    async (reversed) => {
      const donor = await prisma.donor.create({
        data: { email: `${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(donor.id);
      const reward = await createReward({
        event_id: DEFAULT_EVENT_ID,
        title: 'Reward',
        type: 'DIGITAL',
        cost_cents: 500,
      });
      rewardIds.push(reward.id);
      await prisma.rewardClaim.create({
        data: {
          reward_id: reward.id,
          donor_id: donor.id,
          amount_cents: 500,
          status: reversed ? 'REVERSED' : 'PENDING',
          reversed_at: reversed ? new Date() : null,
        },
      });
      await expect(updateReward(reward.id, { type: 'PHYSICAL' })).rejects.toMatchObject({
        status: 409,
      });
      // Stock zero can close future availability even below a live claimed count.
      if (!reversed)
        await prisma.reward.update({ where: { id: reward.id }, data: { quantity_claimed: 1 } });
      expect(await updateReward(reward.id, { quantity_total: 0 })).toMatchObject({
        quantity_total: 0,
        quantity_claimed: reversed ? 0 : 1,
      });
    },
  );

  it.each(['REWARD', 'POLL', 'GOAL'] as const)(
    'blocks %s Channel changes with reversed history but permits text edits',
    async (kind) => {
      const a = await createTestChannel(prisma);
      const b = await createTestChannel(prisma);
      channelIds.push(a.id, b.id);
      const owner = await prisma.donor.create({
        data: { email: `${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(owner.id);
      if (kind === 'REWARD') {
        const reward = await createReward({
          title: 'Original',
          type: 'DIGITAL',
          cost_cents: 100,
          channel_id: a.id,
        });
        rewardIds.push(reward.id);
        await prisma.rewardClaim.create({
          data: {
            donor_id: owner.id,
            reward_id: reward.id,
            amount_cents: 100,
            status: 'REVERSED',
            reversed_at: new Date(),
          },
        });
        await expect(updateReward(reward.id, { channel_id: b.id })).rejects.toMatchObject({
          status: 409,
        });
        expect(await updateReward(reward.id, { title: 'Edited' })).toMatchObject({
          channel_id: a.id,
          title: 'Edited',
        });
      } else if (kind === 'POLL') {
        const poll = await createPoll({
          title: 'Original',
          channel_id: a.id,
          options: { create: { label: 'A' } },
        });
        pollIds.push(poll.id);
        await prisma.pollVote.create({
          data: {
            donor_id: owner.id,
            poll_id: poll.id,
            poll_option_id: poll.options[0]!.id,
            amount_cents: 100,
            reversed_at: new Date(),
          },
        });
        await expect(updatePoll(poll.id, { channel_id: b.id })).rejects.toMatchObject({
          status: 409,
        });
        expect(await updatePoll(poll.id, { title: 'Edited' })).toMatchObject({
          channel_id: a.id,
          title: 'Edited',
        });
      } else {
        const goal = await createGoal({ title: 'Original', channel_id: a.id, target_cents: 100 });
        goalIds.push(goal.id);
        await prisma.fundContribution.create({
          data: {
            donor_id: owner.id,
            goal_id: goal.id,
            amount_cents: 100,
            reversed_at: new Date(),
          },
        });
        await expect(updateGoal(goal.id, { channel_id: b.id })).rejects.toMatchObject({
          status: 409,
        });
        expect(await updateGoal(goal.id, { title: 'Edited' })).toMatchObject({
          channel_id: a.id,
          title: 'Edited',
        });
      }
    },
  );

  it('derives completion only for actual target edits, retaining terminal-shrink exceptions during text edits', async () => {
    const goal = await prisma.fundGoal.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Completed before shrink',
        target_cents: 1000,
        current_cents: 500,
        is_complete: true,
      },
    });
    goalIds.push(goal.id);
    expect(await updateGoal(goal.id, { title: 'Renamed', target_cents: 1000 })).toMatchObject({
      is_complete: true,
    });
    expect(await updateGoal(goal.id, { target_cents: 1200 })).toMatchObject({ is_complete: false });
    expect(await updateGoal(goal.id, { target_cents: 400 })).toMatchObject({ is_complete: true });
  });

  it('protects an unused goal referenced by a Default goal list without blocking a still-valid move to shared', async () => {
    const a = await createTestChannel(prisma);
    const b = await createTestChannel(prisma);
    channelIds.push(a.id, b.id);
    const goal = await createGoal({ title: 'Setup goal', target_cents: 1000, channel_id: a.id });
    goalIds.push(goal.id);
    await prisma.channelDefaultGoal.create({
      data: { channel_id: a.id, goal_id: goal.id, position: 0 },
    });
    await expect(removeIncentive('GOAL', goal.id)).rejects.toMatchObject({
      status: 409,
      message: 'Remove this goal from its Default goal lists before deleting it.',
    });
    expect(await updateGoal(goal.id, { channel_id: null })).toMatchObject({ channel_id: null });
    await expect(updateGoal(goal.id, { channel_id: b.id })).rejects.toMatchObject({ status: 409 });
    await prisma.channelDefaultGoal.deleteMany({ where: { goal_id: goal.id } });
    expect(await updateGoal(goal.id, { channel_id: b.id })).toMatchObject({ channel_id: b.id });
  });

  it('adds and renames poll options without queueing messages', async () => {
    const target = await destination();
    const poll = await prisma.poll.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Options' },
    });
    pollIds.push(poll.id);
    const option = await createPollOption(poll.id, 'A');
    expect(await updatePollOption(option.id, 'B')).toMatchObject({
      id: option.id,
      label: 'B',
      status: 'ACTIVE',
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      poll_id: poll.id,
      label: 'B',
    });
    expect(await messages(target)).toEqual([]);
  });

  it.each(['REWARD', 'POLL', 'POLL_OPTION', 'GOAL'] as const)(
    'removes an unused %s, leaving no messages',
    async (kind) => {
      const target = await destination();
      const reward = await prisma.reward.create({
        data: {
          event_id: DEFAULT_EVENT_ID,
          title: 'Unused reward',
          type: 'DIGITAL',
          cost_cents: 500,
        },
      });
      rewardIds.push(reward.id);
      const poll = await prisma.poll.create({
        data: {
          event_id: DEFAULT_EVENT_ID,
          title: 'Unused poll',
          options: { create: { label: 'Unused option' } },
        },
        include: { options: true },
      });
      pollIds.push(poll.id);
      const goal = await prisma.fundGoal.create({
        data: { event_id: DEFAULT_EVENT_ID, title: 'Unused goal', target_cents: 1000 },
      });
      goalIds.push(goal.id);
      const option = poll.options[0]!;
      const id = { REWARD: reward.id, POLL: poll.id, POLL_OPTION: option.id, GOAL: goal.id }[kind];
      await removeIncentive(kind, id);
      const removed =
        kind === 'REWARD'
          ? await prisma.reward.findUnique({ where: { id } })
          : kind === 'POLL'
            ? await prisma.poll.findUnique({ where: { id } })
            : kind === 'POLL_OPTION'
              ? await prisma.pollOption.findUnique({ where: { id } })
              : await prisma.fundGoal.findUnique({ where: { id } });
      expect(removed).toBeNull();
      if (kind === 'POLL')
        expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toBeNull();
      expect(await messages(target)).toEqual([]);
    },
  );

  it.each([
    ['REWARD', false],
    ['REWARD', true],
    ['POLL', false],
    ['POLL', true],
    ['POLL_OPTION', false],
    ['POLL_OPTION', true],
    ['GOAL', false],
    ['GOAL', true],
  ] as const)('protects %s allocation history (reversed-only: %s)', async (kind, reversed) => {
    const target = await destination();
    const owner = await prisma.donor.create({
      data: { email: `history-${crypto.randomUUID()}@example.com` },
    });
    donorIds.push(owner.id);
    const reward = await prisma.reward.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Reward', type: 'DIGITAL', cost_cents: 500 },
    });
    rewardIds.push(reward.id);
    const poll = await prisma.poll.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Poll', options: { create: { label: 'A' } } },
      include: { options: true },
    });
    pollIds.push(poll.id);
    const option = poll.options[0]!;
    const goal = await prisma.fundGoal.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Goal', target_cents: 1000 },
    });
    goalIds.push(goal.id);
    const reversedAt = reversed ? new Date('2026-01-01') : null;
    const claim = await prisma.rewardClaim.create({
      data: {
        reward_id: reward.id,
        donor_id: owner.id,
        status: reversed ? 'REVERSED' : 'PENDING',
        reversed_at: reversedAt,
      },
    });
    const vote = await prisma.pollVote.create({
      data: {
        poll_id: poll.id,
        poll_option_id: option.id,
        donor_id: owner.id,
        amount_cents: 500,
        reversed_at: reversedAt,
      },
    });
    const contribution = await prisma.fundContribution.create({
      data: { goal_id: goal.id, donor_id: owner.id, amount_cents: 500, reversed_at: reversedAt },
    });
    const id = { REWARD: reward.id, POLL: poll.id, POLL_OPTION: option.id, GOAL: goal.id }[kind];
    await expect(removeIncentive(kind, id)).rejects.toMatchObject({
      status: 409,
      message: 'This has allocation history. Deactivate it instead.',
    });
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toEqual(reward);
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toEqual(
      expect.objectContaining({ id: poll.id, title: 'Poll' }),
    );
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toEqual(option);
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toEqual(goal);
    expect(await prisma.rewardClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
    expect(await prisma.pollVote.findUnique({ where: { id: vote.id } })).toEqual(vote);
    expect(await prisma.fundContribution.findUnique({ where: { id: contribution.id } })).toEqual(
      contribution,
    );
    expect(await messages(target)).toEqual([]);
  });

  it.each(['GOAL', 'POLL_OPTION'] as const)(
    'reverses live %s allocations once, deactivates and preserves history',
    async (kind) => {
      const target = await destination();
      const owner = await prisma.donor.create({
        data: { email: `reverse-${crypto.randomUUID()}@example.com`, balance_remaining: 100 },
      });
      donorIds.push(owner.id);
      const goal = await prisma.fundGoal.create({
        data: {
          event_id: DEFAULT_EVENT_ID,
          title: 'Goal',
          target_cents: 500,
          current_cents: 750,
          is_complete: true,
        },
      });
      goalIds.push(goal.id);
      const poll = await prisma.poll.create({
        data: {
          event_id: DEFAULT_EVENT_ID,
          title: 'Poll',
          total_votes_cents: 750,
          options: { create: { label: 'A', votes_cents: 750 } },
        },
        include: { options: true },
      });
      pollIds.push(poll.id);
      const option = poll.options[0]!;
      for (const amount of [250, 500, 900]) {
        const reversedAt = amount === 900 ? new Date('2026-01-01') : null;
        if (kind === 'GOAL')
          await prisma.fundContribution.create({
            data: {
              goal_id: goal.id,
              donor_id: owner.id,
              amount_cents: amount,
              reversed_at: reversedAt,
            },
          });
        else
          await prisma.pollVote.create({
            data: {
              poll_id: poll.id,
              poll_option_id: option.id,
              donor_id: owner.id,
              amount_cents: amount,
              reversed_at: reversedAt,
            },
          });
      }
      const id = kind === 'GOAL' ? goal.id : option.id;
      const results = await Promise.all([
        reverseAndDeactivate(kind, id, 'admin'),
        reverseAndDeactivate(kind, id, 'admin'),
      ]);
      expect(results).toEqual(
        expect.arrayContaining([
          { refunded_count: 2, refunded_cents: 750 },
          { refunded_count: 0, refunded_cents: 0 },
        ]),
      );
      expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
        balance_remaining: 850,
      });
      expect(
        await prisma.balanceAdjustment.findMany({
          where: { donor_id: owner.id },
          orderBy: { created_at: 'asc' },
        }),
      ).toEqual([
        expect.objectContaining({
          amount_cents: 250,
          balance_after_cents: 350,
          type: 'REFUND',
          created_by: 'admin',
        }),
        expect.objectContaining({
          amount_cents: 500,
          balance_after_cents: 850,
          type: 'REFUND',
          created_by: 'admin',
        }),
      ]);
      if (kind === 'GOAL') {
        expect(await prisma.fundGoal.findUnique({ where: { id } })).toMatchObject({
          is_active: false,
          is_complete: false,
          current_cents: 0,
        });
        expect(await prisma.fundContribution.count({ where: { goal_id: id } })).toBe(3);
        expect(
          await prisma.fundContribution.count({ where: { goal_id: id, reversed_at: null } }),
        ).toBe(0);
        expect(await messages(target)).toEqual([
          expect.objectContaining({
            type: 'incentive.disabled',
            data: {
              incentive_kind: 'GOAL',
              incentive_id: id,
              channel_id: null,
              event_id: DEFAULT_EVENT_ID,
              title: 'Goal',
            },
          }),
        ]);
      } else {
        expect(await prisma.pollOption.findUnique({ where: { id } })).toMatchObject({
          status: 'REJECTED',
          votes_cents: 0,
        });
        expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
          total_votes_cents: 0,
        });
        expect(await prisma.pollVote.count({ where: { poll_option_id: id } })).toBe(3);
        expect(
          await prisma.pollVote.count({ where: { poll_option_id: id, reversed_at: null } }),
        ).toBe(0);
        expect(await messages(target)).toEqual([]);
      }
      await expect(removeIncentive(kind, id)).rejects.toMatchObject({ status: 409 });
    },
  );

  it.each(['GOAL', 'POLL_OPTION'] as const)(
    'rolls back %s reversals if deactivation fails',
    async (kind) => {
      const target = await destination();
      const owner = await prisma.donor.create({
        data: { email: `rollback-${crypto.randomUUID()}@example.com`, balance_remaining: 100 },
      });
      donorIds.push(owner.id);
      const goal = await prisma.fundGoal.create({
        data: { event_id: DEFAULT_EVENT_ID, title: 'Goal', target_cents: 500, current_cents: 500 },
      });
      goalIds.push(goal.id);
      const poll = await prisma.poll.create({
        data: {
          event_id: DEFAULT_EVENT_ID,
          title: 'Poll',
          total_votes_cents: 500,
          options: { create: { label: 'A', votes_cents: 500 } },
        },
        include: { options: true },
      });
      pollIds.push(poll.id);
      const option = poll.options[0]!;
      const contribution = await prisma.fundContribution.create({
        data: { goal_id: goal.id, donor_id: owner.id, amount_cents: 500 },
      });
      const vote = await prisma.pollVote.create({
        data: {
          poll_id: poll.id,
          poll_option_id: option.id,
          donor_id: owner.id,
          amount_cents: 500,
        },
      });
      await prisma.$executeRawUnsafe(
        kind === 'GOAL'
          ? `CREATE TRIGGER fail_lifecycle_deactivation BEFORE INSERT ON WebhookDelivery WHEN NEW.destination_id = '${target}' AND NEW.event_type = 'incentive.disabled' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`
          : `CREATE TRIGGER fail_lifecycle_deactivation BEFORE UPDATE ON PollOption WHEN NEW.id = '${option.id}' AND NEW.status = 'REJECTED' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
      );
      await expect(
        reverseAndDeactivate(kind, kind === 'GOAL' ? goal.id : option.id, 'admin'),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
        balance_remaining: 100,
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: owner.id } })).toBe(0);
      expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toEqual(goal);
      expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toEqual(option);
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: 500,
      });
      expect(await prisma.fundContribution.findUnique({ where: { id: contribution.id } })).toEqual(
        contribution,
      );
      expect(await prisma.pollVote.findUnique({ where: { id: vote.id } })).toEqual(vote);
      expect(await messages(target)).toEqual([]);
    },
  );

  it.each(['REWARD', 'POLL', 'GOAL'] as const)(
    'concurrent %s updates compare the committed prior state and publish each change once',
    async (kind) => {
      const target = await destination();
      const reward = await prisma.reward.create({
        data: { event_id: DEFAULT_EVENT_ID, title: 'Reward', type: 'DIGITAL', cost_cents: 500 },
      });
      rewardIds.push(reward.id);
      const poll = await prisma.poll.create({
        data: { event_id: DEFAULT_EVENT_ID, title: 'Poll' },
      });
      pollIds.push(poll.id);
      const goal = await prisma.fundGoal.create({
        data: { event_id: DEFAULT_EVENT_ID, title: 'Goal', target_cents: 1000 },
      });
      goalIds.push(goal.id);
      const update = () =>
        kind === 'REWARD'
          ? updateReward(reward.id, { is_active: false, cost_cents: 700 })
          : kind === 'POLL'
            ? updatePoll(poll.id, { is_active: false, ends_at: new Date('2026-12-01') })
            : updateGoal(goal.id, { is_active: false, target_cents: 2000 });
      await Promise.all([update(), update()]);
      expect((await messages(target)).map((message) => message.type)).toEqual([
        'incentive.disabled',
        'incentive.value_changed',
      ]);
    },
  );

  it('deactivation alone preserves live votes and contributions without crediting the wallet', async () => {
    const owner = await prisma.donor.create({
      data: { email: `deactivate-${crypto.randomUUID()}@example.com`, balance_remaining: 100 },
    });
    donorIds.push(owner.id);
    const goal = await prisma.fundGoal.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Goal',
        target_cents: 500,
        current_cents: 500,
        is_complete: true,
      },
    });
    goalIds.push(goal.id);
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Poll',
        total_votes_cents: 500,
        options: { create: { label: 'A', votes_cents: 500 } },
      },
      include: { options: true },
    });
    pollIds.push(poll.id);
    const contribution = await prisma.fundContribution.create({
      data: { goal_id: goal.id, donor_id: owner.id, amount_cents: 500 },
    });
    const vote = await prisma.pollVote.create({
      data: {
        poll_id: poll.id,
        poll_option_id: poll.options[0]!.id,
        donor_id: owner.id,
        amount_cents: 500,
      },
    });
    await updateGoal(goal.id, { is_active: false });
    await updatePoll(poll.id, { is_active: false });
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      is_active: false,
      current_cents: 500,
      is_complete: true,
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      is_active: false,
      total_votes_cents: 500,
    });
    expect(await prisma.pollOption.findUnique({ where: { id: poll.options[0]!.id } })).toEqual(
      poll.options[0],
    );
    expect(await prisma.fundContribution.findUnique({ where: { id: contribution.id } })).toEqual(
      contribution,
    );
    expect(await prisma.pollVote.findUnique({ where: { id: vote.id } })).toEqual(vote);
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 100,
    });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: owner.id } })).toBe(0);
  });

  it.each(['REWARD', 'POLL', 'GOAL'] as const)(
    'rolls back %s creation when the outbox write fails',
    async (kind) => {
      const target = await destination();
      const title = `Failed ${crypto.randomUUID()}`;
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_lifecycle_delivery BEFORE INSERT ON WebhookDelivery
      WHEN NEW.destination_id = '${target}' BEGIN SELECT RAISE(ABORT, 'forced delivery failure'); END`);
      const create =
        kind === 'REWARD'
          ? createReward({ event_id: DEFAULT_EVENT_ID, title, type: 'DIGITAL', cost_cents: 500 })
          : kind === 'POLL'
            ? createPoll({
                event_id: DEFAULT_EVENT_ID,
                title,
                options: { create: { label: title } },
              })
            : createGoal({ event_id: DEFAULT_EVENT_ID, title, target_cents: 1000 });
      await expect(create).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.reward.count({ where: { title } })).toBe(0);
      expect(await prisma.poll.count({ where: { title } })).toBe(0);
      expect(await prisma.pollOption.count({ where: { label: title } })).toBe(0);
      expect(await prisma.fundGoal.count({ where: { title } })).toBe(0);
      expect(await messages(target)).toEqual([]);
    },
  );

  it('creates a reward and queues its committed values', async () => {
    const target = await destination();
    const reward = await createReward({
      event_id: DEFAULT_EVENT_ID,
      title: `Reward ${crypto.randomUUID()}`,
      type: 'DIGITAL',
      cost_cents: 500,
      is_active: false,
    });
    rewardIds.push(reward.id);
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
      cost_cents: 500,
      is_active: false,
    });
    expect(await messages(target)).toEqual([
      expect.objectContaining({
        type: 'incentive.created',
        data: {
          incentive_kind: 'REWARD',
          incentive_id: reward.id,
          channel_id: null,
          event_id: DEFAULT_EVENT_ID,
          title: reward.title,
          is_active: false,
          cost_cents: 500,
        },
      }),
    ]);
  });
});
