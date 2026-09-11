import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

vi.mock('../../services/pledge.js', () => ({
  createPledge: vi.fn(),
  createCheckoutForPledge: vi.fn(),
}));

import { createPledge, createCheckoutForPledge } from '../../services/pledge.js';
import pledgeRouter from '../../routes/pledge.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pledge', pledgeRouter);
  return app;
}

describe('POST /api/pledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards top_up_cents to createPledge and returns it in the response', async () => {
    vi.mocked(createPledge).mockResolvedValue({
      pledge_token: 'pledge-abc',
      total_cents: 2000,
      expires_at: new Date().toISOString(),
    } as any);
    vi.mocked(createCheckoutForPledge).mockResolvedValue({
      donate_url: 'https://checkout.stripe.com/cs_test',
      checkout_session_id: 'cs_test_1',
      wallet_discount_cents: 0,
    });

    const res = await request(createApp())
      .post('/api/pledge')
      .send({
        email: 'donor@example.com',
        comment: 'hello',
        top_up_cents: 1500,
        channel_id: 'event-1',
        items: [{ kind: 'REWARD', target_id: 'reward-1' }],
      });

    expect(res.status).toBe(200);
    expect(createPledge).toHaveBeenCalledWith({
      email: 'donor@example.com',
      comment: 'hello',
      top_up_cents: 1500,
      channel_id: 'event-1',
      items: [{ kind: 'REWARD', target_id: 'reward-1' }],
    });
    expect(res.body.total_cents).toBe(2000);
    expect(res.body.donate_url).toBe('https://checkout.stripe.com/cs_test');
    expect(res.body.has_checkout).toBe(true);
  });

  it('forwards display_name to createPledge (#54)', async () => {
    vi.mocked(createPledge).mockResolvedValue({
      pledge_token: 'pledge-abc',
      total_cents: 500,
      expires_at: new Date().toISOString(),
    } as any);
    vi.mocked(createCheckoutForPledge).mockResolvedValue({
      donate_url: null,
      checkout_session_id: null,
      wallet_discount_cents: 0,
    });

    await request(createApp())
      .post('/api/pledge')
      .send({
        email: 'donor@example.com',
        display_name: 'Jane Donor',
        channel_id: 'event-1',
        items: [{ kind: 'REWARD', target_id: 'reward-1' }],
      });

    expect(createPledge).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: 'Jane Donor' }),
    );
  });

  it('omits top_up_cents when not provided', async () => {
    vi.mocked(createPledge).mockResolvedValue({
      pledge_token: 'pledge-abc',
      total_cents: 500,
      expires_at: new Date().toISOString(),
    } as any);
    vi.mocked(createCheckoutForPledge).mockResolvedValue({
      donate_url: null,
      checkout_session_id: null,
      wallet_discount_cents: 0,
    });

    const res = await request(createApp())
      .post('/api/pledge')
      .send({
        email: 'donor@example.com',
        channel_id: 'event-1',
        items: [{ kind: 'REWARD', target_id: 'reward-1' }],
      });

    expect(res.status).toBe(200);
    expect(createPledge).toHaveBeenCalledWith({
      email: 'donor@example.com',
      top_up_cents: undefined,
      channel_id: 'event-1',
      items: [{ kind: 'REWARD', target_id: 'reward-1' }],
    });
    expect(res.body.has_checkout).toBe(false);
  });

  it('returns 400 when createPledge rejects with a status', async () => {
    vi.mocked(createPledge).mockRejectedValue(
      Object.assign(new Error('channel_id is required'), {
        status: 400,
      }),
    );

    const res = await request(createApp())
      .post('/api/pledge')
      .send({ email: 'donor@example.com', items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('channel_id is required');
  });

  it('applies a wallet discount when a valid donor token is provided', async () => {
    const token = crypto.randomBytes(16).toString('hex');
    const donor = await prisma.donor.create({
      data: {
        email: `pledge-${crypto.randomUUID()}@example.com`,
        balance_remaining: 1500,
        magic_token: token,
        token_expires_at: new Date(Date.now() + 60_000),
      },
    });
    vi.mocked(createPledge).mockResolvedValue({
      pledge_token: 'pledge-abc',
      total_cents: 500,
      expires_at: new Date().toISOString(),
    } as any);
    vi.mocked(createCheckoutForPledge).mockResolvedValue({
      donate_url: null,
      checkout_session_id: null,
      wallet_discount_cents: 0,
    });

    const res = await request(createApp())
      .post('/api/pledge')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: donor.email, channel_id: 'event-1', items: [] });

    expect(res.status).toBe(200);
    expect(createCheckoutForPledge).toHaveBeenCalledWith(
      'pledge-abc',
      expect.objectContaining({ id: donor.id, balance_remaining: 1500 }),
      donor.email,
    );

    await prisma.donor.delete({ where: { id: donor.id } });
  });
});

describe('GET /api/pledge/:token', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the pledge status', async () => {
    const pledge = await prisma.pendingPledge.create({
      data: {
        pledge_token: `tok-${crypto.randomUUID()}`,
        total_cents: 1000,
        expires_at: new Date(Date.now() + 60_000),
        items: { create: [{ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }] },
      },
    });

    const res = await request(createApp()).get(`/api/pledge/${pledge.pledge_token}`);

    expect(res.status).toBe(200);
    expect(res.body.pledge_token).toBe(pledge.pledge_token);
    expect(res.body.total_cents).toBe(1000);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].kind).toBe('REWARD');

    await prisma.pendingPledge.delete({ where: { id: pledge.id } });
  });

  it('never exposes a donor magic token, even for a fulfilled pledge (account takeover guard, #48)', async () => {
    const donor = await prisma.donor.create({
      data: { email: `pledge-${crypto.randomUUID()}@example.com`, magic_token: 'super-secret-tok' },
    });
    const pledge = await prisma.pendingPledge.create({
      data: {
        pledge_token: `tok-${crypto.randomUUID()}`,
        total_cents: 1000,
        expires_at: new Date(Date.now() + 60_000),
        items: { create: [{ kind: 'REWARD', target_id: 'r1', amount_cents: 1000 }] },
      },
    });
    const donation = await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 1000,
      },
    });
    await prisma.pendingPledge.update({
      where: { id: pledge.id },
      data: { status: 'FULFILLED', fulfilled_by_donation_id: donation.id },
    });

    const res = await request(createApp()).get(`/api/pledge/${pledge.pledge_token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FULFILLED');
    expect(res.body).not.toHaveProperty('magic_token');
    expect(res.body).not.toHaveProperty('is_new_donor');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-tok');

    await prisma.pendingPledge.delete({ where: { id: pledge.id } });
    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('returns 404 for an unknown token', async () => {
    const res = await request(createApp()).get('/api/pledge/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Pledge not found');
  });
});
