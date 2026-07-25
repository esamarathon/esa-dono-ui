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
    },
    rewardClaim: {
      findUnique: vi.fn(),
    },
    reward: {
      findUnique: vi.fn(),
    },
    pollVote: {
      findUnique: vi.fn(),
    },
    pollOption: {
      update: vi.fn(),
    },
    poll: {
      update: vi.fn(),
    },
    fundContribution: {
      findUnique: vi.fn(),
    },
    fundGoal: {
      findUnique: vi.fn(),
    },
    balanceAdjustment: {
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: any[]) =>
      Promise.all(ops.map((o) => (typeof o === 'function' ? o() : o))),
    ),
  },
}));

vi.mock('../../services/donation.js', () => ({
  processDonation: vi.fn(),
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
  });

  const auth = { 'x-admin-key': 'test-key' };

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

  it('GET /donors/:id returns wallet', async () => {
    px.donor.findUnique.mockResolvedValue({
      id: 'd1',
      email: 'a@b.com',
      total_donated: 1000,
      balance_remaining: 500,
      is_moderator: false,
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

  it('rejects non-admin requests', async () => {
    const res = await request(createApp()).get('/api/admin/donors');
    expect(res.status).toBe(401);
  });
});
