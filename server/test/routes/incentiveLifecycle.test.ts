import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
import prisma from '../../lib/prisma.js';
import adminRouter from '../../routes/admin.js';
import moderatorRouter from '../../routes/moderator.js';
import { catchAsyncErrors, errorHandler } from '../../lib/httpError.js';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/moderator', moderatorRouter);
catchAsyncErrors(app);
app.use(errorHandler);

const rewardIds: string[] = [];
const pollIds: string[] = [];
const goalIds: string[] = [];
const destinationIds: string[] = [];
const donorIds: string[] = [];
let moderatorToken: string;
let userToken: string;
let ownerId: string;
const auth = (role: string) =>
  `Bearer ${role === 'admin' ? 'key_admin_test-admin-key' : moderatorToken}`;

beforeAll(async () => {
  for (const role of ['MODERATOR', 'USER']) {
    const token = crypto.randomUUID();
    const row = await prisma.donor.create({
      data: {
        email: `${token}@example.com`,
        role,
        magic_token: token,
        token_expires_at: new Date(Date.now() + 600_000),
      },
    });
    donorIds.push(row.id);
    if (role === 'MODERATOR') moderatorToken = token;
    else {
      userToken = token;
      ownerId = row.id;
    }
  }
});
afterEach(async () => {
  await prisma.rewardClaim.deleteMany({ where: { reward_id: { in: rewardIds } } });
  await prisma.pollVote.deleteMany({ where: { poll_id: { in: pollIds } } });
  await prisma.fundContribution.deleteMany({ where: { goal_id: { in: goalIds } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewardIds } } });
  await prisma.poll.deleteMany({ where: { id: { in: pollIds } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goalIds } } });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinationIds } } });
  rewardIds.length = pollIds.length = goalIds.length = destinationIds.length = 0;
});
afterAll(async () => {
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
  await prisma.$disconnect();
});

const inputs = {
  rewards: {
    title: 'Reward',
    description: 'Description',
    type: 'CUSTOM',
    custom_type_label: 'Custom',
    cost_cents: 500,
    quantity_total: 10,
    image_url: '/api/uploads/missing.webp',
    is_active: false,
    channel_id: null,
    quantity_claimed: 99,
  },
  polls: {
    title: 'Poll',
    description: 'Description',
    is_active: false,
    ends_at: '2026-12-01T12:00:00.000Z',
    allow_custom_entries: true,
    max_entry_chars: 40,
    auto_approve: false,
    channel_id: null,
    options: [{ label: 'A', votes_cents: 99 }],
  },
  goals: {
    title: 'Goal',
    description: 'Description',
    target_cents: 1000,
    is_active: false,
    channel_id: null,
    current_cents: 99,
  },
};

for (const role of ['admin', 'moderator']) {
  describe(`${role} incentive lifecycle mappings`, () => {
    it.each(['rewards', 'polls', 'goals'] as const)(
      'maps %s input and queues the same lifecycle messages',
      async (category) => {
        const target = await prisma.webhookDestination.create({
          data: {
            url: 'http://127.0.0.1:1/hook',
            secret: 's',
            event_types: '["incentive.created","incentive.enabled","incentive.value_changed"]',
          },
        });
        destinationIds.push(target.id);
        const created = await request(app)
          .post(`/api/${role}/${category}`)
          .set('Authorization', auth(role))
          .send(inputs[category]);
        expect(created.status).toBe(200);
        ({ rewards: rewardIds, polls: pollIds, goals: goalIds })[category].push(created.body.id);
        expect(created.body).toMatchObject({
          title: inputs[category].title,
          description: 'Description',
          is_active: false,
          channel_id: null,
        });
        if (category === 'rewards')
          expect(created.body).toMatchObject({
            type: 'CUSTOM',
            cost_cents: 500,
            quantity_total: 10,
            quantity_claimed: 0,
            custom_type_label: 'Custom',
            image_url: '/api/uploads/missing.webp',
          });
        if (category === 'polls')
          expect(created.body).toMatchObject({
            ends_at: '2026-12-01T12:00:00.000Z',
            allow_custom_entries: true,
            auto_approve: false,
            max_entry_chars: 40,
            options: [expect.objectContaining({ label: 'A', votes_cents: 0 })],
          });
        if (category === 'goals')
          expect(created.body).toMatchObject({
            target_cents: 1000,
            current_cents: 0,
            is_complete: false,
          });
        const updated = await request(app)
          .put(`/api/${role}/${category}/${created.body.id}`)
          .set('Authorization', auth(role))
          .send({
            title: 'Updated',
            is_active: true,
            cost_cents: 700,
            target_cents: 2000,
            quantity_claimed: 99,
            current_cents: 99,
          });
        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject({
          title: 'Updated',
          description: 'Description',
          is_active: true,
          channel_id: null,
        });
        if (category === 'rewards')
          expect(updated.body).toMatchObject({
            type: 'CUSTOM',
            custom_type_label: 'Custom',
            cost_cents: 700,
            quantity_total: null,
            image_url: null,
            quantity_claimed: 0,
          });
        if (category === 'polls')
          expect(updated.body).toMatchObject({
            ends_at: null,
            allow_custom_entries: false,
            max_entry_chars: null,
            auto_approve: true,
            options: [expect.objectContaining({ label: 'A' })],
          });
        if (category === 'goals')
          expect(updated.body).toMatchObject({
            target_cents: 2000,
            current_cents: 0,
            is_complete: false,
          });
        const rows = await prisma.webhookDelivery.findMany({
          where: { destination_id: target.id },
          orderBy: { seq: 'asc' },
        });
        expect(rows.map((row) => row.message_type)).toEqual([
          'incentive.created',
          'incentive.enabled',
          'incentive.value_changed',
        ]);
      },
    );

    it('rejects manual completion on create and update and invalid prices for either role', async () => {
      for (const is_complete of [true, false, null]) {
        await request(app)
          .post(`/api/${role}/goals`)
          .set('Authorization', auth(role))
          .send({ title: 'Goal', target_cents: 100, is_complete })
          .expect(400);
      }
      const created = await request(app)
        .post(`/api/${role}/goals`)
        .set('Authorization', auth(role))
        .send({ title: ' Trimmed ', target_cents: 100 })
        .expect(200);
      goalIds.push(created.body.id);
      expect(created.body.title).toBe('Trimmed');
      await request(app)
        .put(`/api/${role}/goals/${created.body.id}`)
        .set('Authorization', auth(role))
        .send({ is_complete: false })
        .expect(400);
      for (const target_cents of [0, -1, 1.5, 2147483648]) {
        await request(app)
          .put(`/api/${role}/goals/${created.body.id}`)
          .set('Authorization', auth(role))
          .send({ target_cents })
          .expect(400);
      }
      for (const channel_id of ['', false, 0, 'missing']) {
        await request(app)
          .put(`/api/${role}/goals/${created.body.id}`)
          .set('Authorization', auth(role))
          .send({ channel_id })
          .expect(400);
      }
      await request(app)
        .post(`/api/${role}/polls`)
        .set('Authorization', auth(role))
        .send({ title: 'Valid poll', options: [{ label: '  ' }] })
        .expect(400);
      await request(app)
        .post(`/api/${role}/rewards`)
        .set('Authorization', auth(role))
        .send({ title: '  ', cost_cents: 100, type: 'DIGITAL' })
        .expect(400);
    });

    it('returns the exact history conflict for hard deletes without granting reversal powers', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Reward', type: 'DIGITAL', cost_cents: 500 },
      });
      rewardIds.push(reward.id);
      await prisma.rewardClaim.create({
        data: {
          reward_id: reward.id,
          donor_id: ownerId,
          status: 'REVERSED',
          reversed_at: new Date(),
        },
      });
      const poll = await prisma.poll.create({
        data: { title: 'Poll', options: { create: { label: 'A' } } },
        include: { options: true },
      });
      pollIds.push(poll.id);
      await prisma.pollVote.create({
        data: {
          poll_id: poll.id,
          poll_option_id: poll.options[0]!.id,
          donor_id: ownerId,
          amount_cents: 500,
          reversed_at: new Date(),
        },
      });
      const paths = [`rewards/${reward.id}`, `polls/${poll.id}`];
      if (role === 'moderator') {
        const goal = await prisma.fundGoal.create({ data: { title: 'Goal', target_cents: 1000 } });
        goalIds.push(goal.id);
        await prisma.fundContribution.create({
          data: { goal_id: goal.id, donor_id: ownerId, amount_cents: 500, reversed_at: new Date() },
        });
        paths.push(`goals/${goal.id}`, `polls/options/${poll.options[0]!.id}`);
      }
      for (const path of paths) {
        const response = await request(app)
          .delete(`/api/${role}/${path}`)
          .set('Authorization', auth(role));
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          error: 'This has allocation history. Deactivate it instead.',
        });
      }
    });

    it('does not let an ordinary donor mutate incentives', async () => {
      for (const category of ['rewards', 'polls', 'goals'] as const) {
        const response = await request(app)
          .post(`/api/${role}/${category}`)
          .set('Authorization', `Bearer ${userToken}`)
          .send(inputs[category]);
        expect(response.status).toBe(403);
      }
    });
  });
}

it('keeps goal and poll-option reverse-and-deactivate wire responses admin-only', async () => {
  const goal = await prisma.fundGoal.create({
    data: { title: 'Goal', target_cents: 1000, current_cents: 400 },
  });
  goalIds.push(goal.id);
  const poll = await prisma.poll.create({
    data: {
      title: 'Poll',
      total_votes_cents: 400,
      options: { create: { label: 'A', votes_cents: 400 } },
    },
    include: { options: true },
  });
  pollIds.push(poll.id);
  await prisma.fundContribution.create({
    data: { goal_id: goal.id, donor_id: ownerId, amount_cents: 400 },
  });
  await prisma.pollVote.create({
    data: {
      poll_id: poll.id,
      poll_option_id: poll.options[0]!.id,
      donor_id: ownerId,
      amount_cents: 400,
    },
  });
  for (const path of [`goals/${goal.id}`, `polls/options/${poll.options[0]!.id}`]) {
    expect(
      (await request(app).delete(`/api/admin/${path}`).set('Authorization', auth('moderator')))
        .status,
    ).toBe(403);
    const response = await request(app)
      .delete(`/api/admin/${path}`)
      .set('Authorization', auth('admin'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, refunded_count: 1, refunded_cents: 400 });
  }
  expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
    is_active: false,
  });
  expect(await prisma.pollOption.findUnique({ where: { id: poll.options[0]!.id } })).toMatchObject({
    status: 'REJECTED',
  });
  expect(
    (
      await request(app)
        .post(`/api/moderator/goals/${goal.id}/refund`)
        .set('Authorization', auth('moderator'))
    ).status,
  ).toBe(404);
  expect(
    (
      await request(app)
        .post(`/api/moderator/polls/options/${poll.options[0]!.id}/refund`)
        .set('Authorization', auth('moderator'))
    ).status,
  ).toBe(404);
});
