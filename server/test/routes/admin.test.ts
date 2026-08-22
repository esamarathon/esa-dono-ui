import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    donor: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    rewardClaim: {
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    reward: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    pollVote: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    pollOption: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    poll: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    fundContribution: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    fundGoal: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    balanceAdjustment: {
      create: vi.fn(),
    },
    eventDestination: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    eventDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn((ops: any[]) =>
      Promise.all(ops.map((o) => (typeof o === 'function' ? o() : o))),
    ),
  },
}));

vi.mock('../../services/donation.js', () => ({
  processDonation: vi.fn(),
}));

vi.mock('../../services/webhooks.js', () => ({
  emitWebhookEvent: vi.fn(),
  buildIncentiveCreatedPayload: vi.fn(() => ({
    id: 'x',
    type: 'incentive.created',
    created_at: '',
    data: {},
  })),
  buildIncentiveEnabledPayload: vi.fn(() => ({
    id: 'x',
    type: 'incentive.enabled',
    created_at: '',
    data: {},
  })),
  buildIncentiveDisabledPayload: vi.fn(() => ({
    id: 'x',
    type: 'incentive.disabled',
    created_at: '',
    data: {},
  })),
  buildIncentiveValueChangedPayload: vi.fn(() => ({
    id: 'x',
    type: 'incentive.value_changed',
    created_at: '',
    data: {},
  })),
}));

import prisma from '../../lib/prisma.js';
import adminRouter from '../../routes/admin.js';

// Loose alias for configuring the mocked Prisma client with partial fixtures.
const px = prisma as unknown as Record<string, any>;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

describe('Admin donor management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = 'test-key';
    px.poll.findUnique?.mockResolvedValue({ id: 'p1', is_active: true, title: 'Test Poll' });
    px.fundGoal.findUnique?.mockResolvedValue({ id: 'g1', is_active: true, title: 'Test Goal' });
  });

  const auth = { Authorization: 'Bearer key_admin_test-key' };

  it('GET /donors lists donors', async () => {
    px.donor.findMany.mockResolvedValue([
      { id: 'd1', email: 'a@b.com', total_donated: 1000, balance_remaining: 500 },
    ]);
    px.donor.count.mockResolvedValue(1);

    const res = await request(createApp()).get('/api/admin/donors').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.donors).toHaveLength(1);
    expect(res.body.donors[0].email).toBe('a@b.com');
    expect(res.body.total).toBe(1);
  });

  it('POST /donors creates a donor without a prior donation', async () => {
    px.donor.create.mockResolvedValue({
      id: 'd2',
      email: 'mod@b.com',
      role: 'MODERATOR',
    });

    const res = await request(createApp())
      .post('/api/admin/donors')
      .send({ email: 'mod@b.com', role: 'MODERATOR' })
      .set(auth);

    expect(res.status).toBe(200);
    expect(prisma.donor.create).toHaveBeenCalledWith({
      data: { email: 'mod@b.com', role: 'MODERATOR' },
    });
    expect(res.body.email).toBe('mod@b.com');
    expect(res.body.role).toBe('MODERATOR');
  });

  it('POST /donors defaults role to USER', async () => {
    px.donor.create.mockResolvedValue({ id: 'd3', email: 'x@b.com', role: 'USER' });

    const res = await request(createApp())
      .post('/api/admin/donors')
      .send({ email: 'x@b.com' })
      .set(auth);

    expect(res.status).toBe(200);
    expect(prisma.donor.create).toHaveBeenCalledWith({
      data: { email: 'x@b.com', role: 'USER' },
    });
  });

  it('POST /donors rejects an invalid role', async () => {
    const res = await request(createApp())
      .post('/api/admin/donors')
      .send({ email: 'x@b.com', role: 'SUPERUSER' })
      .set(auth);

    expect(res.status).toBe(400);
    expect(px.donor.create).not.toHaveBeenCalled();
  });

  it('POST /donors requires an email', async () => {
    const res = await request(createApp()).post('/api/admin/donors').send({}).set(auth);

    expect(res.status).toBe(400);
  });

  it('POST /donors returns 409 on duplicate email', async () => {
    px.donor.create.mockRejectedValue({ code: 'P2002' });

    const res = await request(createApp())
      .post('/api/admin/donors')
      .send({ email: 'dup@b.com' })
      .set(auth);

    expect(res.status).toBe(409);
  });

  it('GET /donors/:id returns wallet', async () => {
    px.donor.findUnique.mockResolvedValue({
      id: 'd1',
      email: 'a@b.com',
      total_donated: 1000,
      balance_remaining: 500,
      role: 'USER',
      is_frozen: false,
      donations: [],
      reward_claims: [],
      poll_votes: [],
      fund_contributions: [],
      balance_adjustments: [],
    });

    const res = await request(createApp()).get('/api/admin/donors/d1').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('a@b.com');
  });

  it('POST /donors/:id/revoke-token clears token', async () => {
    px.donor.update.mockResolvedValue({ id: 'd1', email: 'a@b.com', magic_token: null });

    const res = await request(createApp()).post('/api/admin/donors/d1/revoke-token').set(auth);

    expect(res.status).toBe(200);
    expect(prisma.donor.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { magic_token: null, token_expires_at: null },
    });
  });

  it('POST /donors/:id/freeze toggles frozen status', async () => {
    px.donor.update.mockResolvedValue({ id: 'd1', email: 'a@b.com', is_frozen: true });

    const res = await request(createApp())
      .post('/api/admin/donors/d1/freeze')
      .send({ frozen: true })
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.is_frozen).toBe(true);
  });

  it('PATCH /donors/:id/role sets a valid role', async () => {
    px.donor.update.mockResolvedValue({ id: 'd1', email: 'a@b.com', role: 'MODERATOR' });

    const res = await request(createApp())
      .patch('/api/admin/donors/d1/role')
      .send({ role: 'MODERATOR' })
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('MODERATOR');
    expect(prisma.donor.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { role: 'MODERATOR' },
    });
  });

  it('PATCH /donors/:id/role rejects an invalid role', async () => {
    const res = await request(createApp())
      .patch('/api/admin/donors/d1/role')
      .send({ role: 'SUPERUSER' })
      .set(auth);

    expect(res.status).toBe(400);
    expect(px.donor.update).not.toHaveBeenCalled();
  });

  it('POST /donors/:id/adjust-balance adjusts balance', async () => {
    px.donor.findUnique.mockResolvedValue({
      id: 'd1',
      email: 'a@b.com',
      balance_remaining: 500,
    });
    px.donor.update.mockResolvedValue({ id: 'd1' });
    px.balanceAdjustment.create.mockResolvedValue({});

    const res = await request(createApp())
      .post('/api/admin/donors/d1/adjust-balance')
      .send({ amount_cents: 1000, type: 'MANUAL', reason: 'test' })
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.balance_before).toBe(500);
    expect(res.body.balance_after).toBe(1500);
  });

  it('POST /donors/:id/adjust-balance rejects negative result', async () => {
    px.donor.findUnique.mockResolvedValue({
      id: 'd1',
      email: 'a@b.com',
      balance_remaining: 50,
    });

    const res = await request(createApp())
      .post('/api/admin/donors/d1/adjust-balance')
      .send({ amount_cents: -100, type: 'MANUAL' })
      .set(auth);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('negative');
  });

  it('POST /donors/:id/reverse-spend reverses a reward claim', async () => {
    px.donor.findUnique.mockResolvedValue({ id: 'd1', email: 'a@b.com', balance_remaining: 0 });
    px.rewardClaim.findUnique.mockResolvedValue({
      id: 'c1',
      donor_id: 'd1',
      reward_id: 'r1',
      status: 'PENDING',
      reward: { cost_cents: 500, id: 'r1' },
    });
    px.reward.findUnique.mockResolvedValue({ id: 'r1' });
    px.rewardClaim.update = vi.fn().mockResolvedValue({});
    px.reward.update = vi.fn().mockResolvedValue({});
    px.balanceAdjustment.create.mockResolvedValue({});

    // Override $transaction to actually call each op
    px.$transaction.mockImplementation((ops: any) => Promise.all(ops));

    const res = await request(createApp())
      .post('/api/admin/donors/d1/reverse-spend')
      .send({ spend_type: 'claim', spend_id: 'c1' })
      .set(auth);

    expect(res.status).toBe(200);
    expect(prisma.balanceAdjustment.create).toHaveBeenCalled();
  });

  it('POST /polls/options/:id/refund refunds all unreversed votes atomically', async () => {
    px.pollOption.findUnique.mockResolvedValue({ id: 'o1', poll_id: 'p1', status: 'ACTIVE' });
    px.pollVote.findMany.mockResolvedValue([
      { id: 'v1', donor_id: 'd1', amount_cents: 250, created_at: new Date() },
      { id: 'v2', donor_id: 'd2', amount_cents: 500, created_at: new Date() },
    ]);
    px.donor.findUnique
      .mockResolvedValueOnce({ id: 'd1', balance_remaining: 100 })
      .mockResolvedValueOnce({ id: 'd2', balance_remaining: 200 });
    px.donor.update.mockResolvedValue({});
    px.pollVote.update.mockResolvedValue({});
    px.pollOption.update.mockResolvedValue({});
    px.poll.update.mockResolvedValue({});
    px.balanceAdjustment.create.mockResolvedValue({});
    px.$transaction.mockImplementation(async (callback: any) => callback(px));

    const res = await request(createApp()).post('/api/admin/polls/options/o1/refund').set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, refunded_count: 2, refunded_cents: 750 });
    expect(prisma.balanceAdjustment.create).toHaveBeenCalledTimes(2);
    expect(prisma.pollOption.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { votes_cents: { decrement: 750 } },
    });
  });

  it('POST /goals/:id/refund refunds all unreversed contributions atomically', async () => {
    px.fundGoal.findUnique.mockResolvedValue({
      id: 'g1',
      current_cents: 900,
      target_cents: 1000,
    });
    px.fundContribution.findMany.mockResolvedValue([
      { id: 'c1', donor_id: 'd1', amount_cents: 300, created_at: new Date() },
      { id: 'c2', donor_id: 'd1', amount_cents: 200, created_at: new Date() },
    ]);
    px.donor.findUnique
      .mockResolvedValueOnce({ id: 'd1', balance_remaining: 100 })
      .mockResolvedValueOnce({ id: 'd1', balance_remaining: 400 });
    px.donor.update.mockResolvedValue({});
    px.fundContribution.update.mockResolvedValue({});
    px.fundGoal.update.mockResolvedValue({});
    px.balanceAdjustment.create.mockResolvedValue({});
    px.$transaction.mockImplementation(async (callback: any) => callback(px));

    const res = await request(createApp()).post('/api/admin/goals/g1/refund').set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, refunded_count: 2, refunded_cents: 500 });
    expect(prisma.balanceAdjustment.create).toHaveBeenCalledTimes(2);
    expect(prisma.fundGoal.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { current_cents: { decrement: 500 }, is_complete: false },
    });
  });

  it('DELETE /polls/options/:id refunds allocated funds and preserves the option record', async () => {
    px.pollOption.findUnique.mockResolvedValue({ id: 'o1', poll_id: 'p1', status: 'ACTIVE' });
    px.pollVote.findMany.mockResolvedValue([
      { id: 'v1', donor_id: 'd1', amount_cents: 400, created_at: new Date() },
    ]);
    px.donor.findUnique.mockResolvedValue({ id: 'd1', balance_remaining: 100 });
    px.donor.update.mockResolvedValue({});
    px.pollVote.update.mockResolvedValue({});
    px.pollOption.update.mockResolvedValue({});
    px.poll.update.mockResolvedValue({});
    px.balanceAdjustment.create.mockResolvedValue({});
    px.$transaction.mockImplementation(async (callback: any) => callback(px));

    const res = await request(createApp()).delete('/api/admin/polls/options/o1').set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, refunded_count: 1, refunded_cents: 400 });
    expect(prisma.pollOption.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: 'REJECTED' },
    });
    expect(prisma.balanceAdjustment.create).toHaveBeenCalledTimes(1);
  });

  it('DELETE /goals/:id refunds allocated funds and deactivates the goal', async () => {
    px.fundGoal.findUnique.mockResolvedValue({ id: 'g1', current_cents: 400, target_cents: 1000 });
    px.fundContribution.findMany.mockResolvedValue([
      { id: 'c1', donor_id: 'd1', amount_cents: 400, created_at: new Date() },
    ]);
    px.donor.findUnique.mockResolvedValue({ id: 'd1', balance_remaining: 100 });
    px.donor.update.mockResolvedValue({});
    px.fundContribution.update.mockResolvedValue({});
    px.fundGoal.update.mockResolvedValue({});
    px.balanceAdjustment.create.mockResolvedValue({});
    px.$transaction.mockImplementation(async (callback: any) => callback(px));

    const res = await request(createApp()).delete('/api/admin/goals/g1').set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, refunded_count: 1, refunded_cents: 400 });
    expect(prisma.fundGoal.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { is_active: false },
    });
    expect(prisma.balanceAdjustment.create).toHaveBeenCalledTimes(1);
  });

  it('DELETE /rewards/:id deletes an unclaimed reward', async () => {
    px.rewardClaim.count.mockResolvedValue(0);
    px.reward.delete.mockResolvedValue({ id: 'r1' });

    const res = await request(createApp()).delete('/api/admin/rewards/r1').set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.reward.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });

  it('DELETE /rewards/:id returns 409 when the reward has claims', async () => {
    px.rewardClaim.count.mockResolvedValue(2);

    const res = await request(createApp()).delete('/api/admin/rewards/r1').set(auth);

    expect(res.status).toBe(409);
    expect(prisma.reward.delete).not.toHaveBeenCalled();
  });

  it('PUT /goals/:id disabling a goal does not refund contributions', async () => {
    px.fundGoal.update.mockResolvedValue({ id: 'g1', is_active: false });

    const res = await request(createApp())
      .put('/api/admin/goals/g1')
      .send({ is_active: false })
      .set(auth);

    expect(res.status).toBe(200);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.balanceAdjustment.create).not.toHaveBeenCalled();
    expect(prisma.fundGoal.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: {
        title: undefined,
        description: undefined,
        target_cents: undefined,
        is_active: false,
        is_complete: undefined,
        channel_id: null,
      },
    });
  });

  it('PUT /polls/:id closing a poll does not refund votes', async () => {
    px.poll.update.mockResolvedValue({ id: 'p1', is_active: false });

    const res = await request(createApp())
      .put('/api/admin/polls/p1')
      .send({ is_active: false })
      .set(auth);

    expect(res.status).toBe(200);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.balanceAdjustment.create).not.toHaveBeenCalled();
    expect(prisma.poll.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        title: undefined,
        description: undefined,
        is_active: false,
        ends_at: null,
        allow_custom_entries: false,
        max_entry_chars: null,
        auto_approve: true,
        channel_id: null,
      },
      include: { options: true },
    });
  });

  it('rejects non-admin requests', async () => {
    const res = await request(createApp()).get('/api/admin/donors');
    expect(res.status).toBe(401);
  });
});
