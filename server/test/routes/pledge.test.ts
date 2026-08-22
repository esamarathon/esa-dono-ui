import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/pledge.js', () => ({
  createPledge: vi.fn(),
  createCheckoutForPledge: vi.fn(),
}));

import { createPledge, createCheckoutForPledge } from '../../services/pledge.js';
import pledgeRouter from '../../routes/pledge.js';

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
});
