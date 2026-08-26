import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

vi.mock('../../services/donation.js', () => ({
  processDonation: vi.fn(),
}));

vi.mock('../../services/auction.js', () => ({
  advanceCascadeTx: vi.fn(),
  settleWinTx: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  default: { $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({})) },
}));

import { processDonation } from '../../services/donation.js';
import { advanceCascadeTx, settleWinTx } from '../../services/auction.js';
import webhookRouter from '../../routes/webhook.js';

function createApp() {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use('/api/webhooks/stripe', webhookRouter);
  return app;
}

const webhookSecret = 'whsec_test_secret';

function signedHeaders(payload: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        amount_total: 2500,
        customer_details: { email: 'donor@example.com', name: 'Test Donor' },
        metadata: { pledge_token: 'pledge-abc' },
        ...overrides,
      },
    },
  };
}

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = '';
    process.env.STRIPE_SECRET_KEY = '';
  });

  it('returns 200 for a non-checkout-completed event', async () => {
    const payload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.expired',
      data: { object: {} },
    });

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signedHeaders(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(processDonation).not.toHaveBeenCalled();
  });

  it('processes a checkout.session.completed event when no secret is set', async () => {
    vi.mocked(processDonation).mockResolvedValue({ donor: { id: 'donor-1' } } as any);

    const payload = JSON.stringify(checkoutEvent());

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(processDonation).toHaveBeenCalledWith({
      externalId: 'cs_test_123',
      email: 'donor@example.com',
      donorName: 'Test Donor',
      amountCents: 2500,
      comment: null,
      pledgeToken: 'pledge-abc',
      shippingCents: 0,
    });
  });

  it('processes a valid signed event', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    vi.mocked(processDonation).mockResolvedValue({ donor: { id: 'donor-1' } } as any);

    const payload = JSON.stringify(checkoutEvent());

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signedHeaders(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(processDonation).toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';

    const payload = JSON.stringify(checkoutEvent());

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=12345,v1=invalidsignature')
      .send(payload);

    expect(res.status).toBe(400);
    expect(processDonation).not.toHaveBeenCalled();
  });

  it('skips when email is missing', async () => {
    const payload = JSON.stringify(checkoutEvent({ customer_details: {} }));

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('missing email or id');
    expect(processDonation).not.toHaveBeenCalled();
  });

  it('extracts shipping amount but no shipping address for physical rewards', async () => {
    vi.mocked(processDonation).mockResolvedValue({ donor: { id: 'donor-1' } } as any);

    const payload = JSON.stringify(
      checkoutEvent({
        amount_total: 3200,
        total_details: { amount_shipping: 700 },
        shipping_details: {
          name: 'Recipient Name',
          address: {
            line1: '123 Main St',
            line2: 'Apt 4',
            city: 'Springfield',
            country: 'US',
          },
        },
      }),
    );

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(processDonation).toHaveBeenCalledWith({
      externalId: 'cs_test_123',
      email: 'donor@example.com',
      donorName: 'Test Donor',
      amountCents: 3200,
      comment: null,
      pledgeToken: 'pledge-abc',
      shippingCents: 700,
    });
  });
});

describe('auction session events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = '';
    process.env.STRIPE_SECRET_KEY = '';
  });

  it('settles a paid auction session without touching processDonation', async () => {
    vi.mocked(settleWinTx).mockResolvedValue({ settled: true });

    const payload = JSON.stringify(
      checkoutEvent({ id: 'cs_auction_1', metadata: { auction_id: 'auc_1' } }),
    );

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(settleWinTx).toHaveBeenCalledWith({}, 'auc_1', 'cs_auction_1');
    expect(processDonation).not.toHaveBeenCalled();
  });

  it('advances the cascade on an expired auction session', async () => {
    vi.mocked(advanceCascadeTx).mockResolvedValue({ advanced: true, status: 'AWAITING_PAYMENT' });

    const payload = JSON.stringify({
      id: 'evt_test_2',
      type: 'checkout.session.expired',
      data: {
        object: { id: 'cs_auction_2', metadata: { auction_id: 'auc_2' } },
      },
    });

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(advanceCascadeTx).toHaveBeenCalledWith({}, 'auc_2', 'cs_auction_2');
  });

  it('ignores an expired session with no auction metadata (pledge sessions)', async () => {
    const payload = JSON.stringify({
      id: 'evt_test_3',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_pledge_1', metadata: {} } },
    });

    const res = await request(createApp())
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(advanceCascadeTx).not.toHaveBeenCalled();
    expect(processDonation).not.toHaveBeenCalled();
  });
});
