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
    webhookDestination: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    webhookDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn(async (ops: any) =>
      typeof ops === 'function' ? ops(px) : Promise.all(ops),
    ),
  },
}));

vi.mock('../../services/donation.js', () => ({
  intakeDonation: vi.fn(),
}));

// The outbox runs the route's change against the mocked prisma client; emits are
// recorded but queue nothing. Delivery itself is covered in services/webhooks tests.
const outbox = vi.hoisted(() => ({
  emit: vi.fn(async (_type: string, build: () => unknown) => {
    build();
  }),
}));
vi.mock('../../services/webhooks/outbox.js', async () => {
  const { default: db } = await import('../../lib/prisma.js');
  return { withWebhooks: vi.fn(async (fn: any) => fn(db, outbox.emit)) };
});
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));

vi.mock('../../services/webhooks/delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/webhooks/delivery.js')>()),
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
import * as reversal from '../../services/reversal.js';

vi.mock('../../services/reversal.js', () => ({
  adjustWalletCreditTx: vi.fn(),
  refundGoalContributions: vi.fn(),
  refundPollOptionVotes: vi.fn(),
  reverseSpendTx: vi.fn(),
  setDonationStatusTx: vi.fn(),
  sweepWalletCreditsTx: vi.fn(),
  previewDonationReversalTx: vi.fn(),
  setClaimStatusTx: vi.fn(),
  acknowledgeChargebackClaimTx: vi.fn(),
}));

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

  // GET donor detail now composes real Pool-credit reads. Its positive contract
  // is covered through SQLite in staff-workflows.test.ts, not accounting-call mocks.

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

  it('POST /donors/:id/adjust-balance preserves the response shape', async () => {
    px.donor.findUnique.mockResolvedValue({ email: 'a@b.com' });
    vi.mocked(reversal.adjustWalletCreditTx).mockResolvedValue({
      success: true,
      balance_before: 500,
      balance_after: 1500,
      adjustment: 1000,
    });
    const res = await request(createApp())
      .post('/api/admin/donors/d1/adjust-balance')
      .send({ amount_cents: 1000, type: 'MANUAL', reason: 'test' })
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      email: 'a@b.com',
      balance_before: 500,
      balance_after: 1500,
      adjustment: 1000,
    });
  });

  it.each([
    [{ amount_cents: 0, type: 'MANUAL' }, 'amount_cents must be a non-zero integer'],
    [{ amount_cents: 100, type: 'UNKNOWN' }, 'Invalid adjustment type'],
  ])('POST /donors/:id/adjust-balance validates input', async (body, error) => {
    const res = await request(createApp())
      .post('/api/admin/donors/d1/adjust-balance')
      .send(body)
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
  });

  it.each(['claim', 'vote', 'contribution'])(
    'POST /donors/:id/reverse-spend returns success for %s',
    async (spend_type) => {
      vi.mocked(reversal.reverseSpendTx).mockResolvedValue();
      const res = await request(createApp())
        .post('/api/admin/donors/d1/reverse-spend')
        .send({ spend_type, spend_id: 's1' })
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    },
  );

  it('POST /donors/:id/reverse-spend requires a target', async () => {
    const res = await request(createApp())
      .post('/api/admin/donors/d1/reverse-spend')
      .send({})
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'spend_type and spend_id required' });
  });

  it.each([
    [
      '/donors/d1/adjust-balance',
      reversal.adjustWalletCreditTx,
      { amount_cents: -100, type: 'MANUAL' },
      400,
      'Adjustment would result in negative balance',
    ],
    [
      '/donors/d1/reverse-spend',
      reversal.reverseSpendTx,
      { spend_type: 'claim', spend_id: 'c1' },
      400,
      'Claim already reversed',
    ],
    [
      '/donors/d1/reverse-spend',
      reversal.reverseSpendTx,
      { spend_type: 'vote', spend_id: 'v1' },
      404,
      'Vote not found',
    ],
    ['/polls/options/o1/refund', reversal.refundPollOptionVotes, {}, 404, 'Poll option not found'],
    ['/goals/g1/refund', reversal.refundGoalContributions, {}, 404, 'Goal not found'],
  ])('maps Reversal errors for %s', async (path, action, body, status, error) => {
    vi.mocked(action).mockRejectedValueOnce(Object.assign(new Error(error), { status }));
    const res = await request(createApp())
      .post('/api/admin' + path)
      .send(body)
      .set(auth);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });

  it.each([
    ['/polls/options/o1/refund', reversal.refundPollOptionVotes],
    ['/goals/g1/refund', reversal.refundGoalContributions],
  ])('preserves the refund summary for %s', async (path, action) => {
    vi.mocked(action).mockResolvedValueOnce({ refunded_count: 2, refunded_cents: 750 });
    const res = await request(createApp())
      .post('/api/admin' + path)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, refunded_count: 2, refunded_cents: 750 });
  });

  // Incentive state/history/messages are covered through the real SQLite lifecycle
  // suite; request mappings and role gates are in routes/incentiveLifecycle.test.ts.

  it('rejects non-admin requests', async () => {
    const res = await request(createApp()).get('/api/admin/donors');
    expect(res.status).toBe(401);
  });
});
