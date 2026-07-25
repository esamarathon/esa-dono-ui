import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/donation.js', () => ({
  processDonation: vi.fn(),
}));

import { processDonation } from '../../services/donation.js';
import webhookRouter from '../../routes/webhook.js';

function createApp() {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use('/api/webhooks/tiltify', webhookRouter);
  return app;
}

describe('POST /api/webhooks/tiltify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TILTIFY_WEBHOOK_SECRET = '';
  });

  it('returns 200 for non-donation events', async () => {
    const payload = {
      meta: { event_type: 'test.donation.updated' },
      data: {},
    };

    const res = await request(createApp())
      .post('/api/webhooks/tiltify')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(processDonation).not.toHaveBeenCalled();
  });

  it('processes a valid donation.completed event', async () => {
    vi.mocked(processDonation).mockResolvedValue({ donor: { id: 'donor-1' } } as any);

    const payload = {
      meta: { event_type: 'donation.completed' },
      data: {
        id: '12345',
        donor_email: 'donor@example.com',
        donor_name: 'Test Donor',
        amount: { value: '25.00' },
        comment: 'Great cause!',
      },
    };

    const res = await request(createApp())
      .post('/api/webhooks/tiltify')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(processDonation).toHaveBeenCalledWith({
      tiltifyId: '12345',
      email: 'donor@example.com',
      donorName: 'Test Donor',
      amountCents: 2500,
      comment: 'Great cause!',
      pledgeToken: null,
    });
  });

  it('skips when email is missing', async () => {
    const payload = {
      meta: { event_type: 'donation.completed' },
      data: {
        id: '12345',
        amount: { value: '25.00' },
      },
    };

    const res = await request(createApp())
      .post('/api/webhooks/tiltify')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('missing email or id');
    expect(processDonation).not.toHaveBeenCalled();
  });

  it('validates HMAC signature when secret is set', async () => {
    process.env.TILTIFY_WEBHOOK_SECRET = 'my-secret';
    const crypto = await import('crypto');

    const payload = JSON.stringify({
      meta: { event_type: 'donation.completed' },
      data: { id: '12345', donor_email: 'donor@test.com', amount: { value: '10.00' } },
    });

    const timestamp = Date.now().toString();
    const message = timestamp + '.' + payload;
    const signature = crypto.createHmac('sha256', 'my-secret').update(message).digest('hex');

    const res = await request(createApp())
      .post('/api/webhooks/tiltify')
      .set('Content-Type', 'application/json')
      .set('x-tiltify-timestamp', timestamp)
      .set('x-tiltify-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(processDonation).toHaveBeenCalled();
  });

  it('rejects invalid HMAC signature', async () => {
    process.env.TILTIFY_WEBHOOK_SECRET = 'my-secret';

    const res = await request(createApp())
      .post('/api/webhooks/tiltify')
      .set('Content-Type', 'application/json')
      .set('x-tiltify-timestamp', '12345')
      .set('x-tiltify-signature', 'invalid-sig')
      .send(JSON.stringify({ meta: { event_type: 'donation.completed' }, data: {} }));

    expect(res.status).toBe(401);
    expect(processDonation).not.toHaveBeenCalled();
  });
});
