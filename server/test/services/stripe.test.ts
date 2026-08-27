import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCheckoutSession, verifyWebhook, isStripeConfigured } from '../../services/stripe.js';

const mocks = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: mocks.sessionsCreate } };
    webhooks = { constructEvent: mocks.constructEvent };
  },
}));

describe('stripe service', () => {
  const origKey = process.env.STRIPE_SECRET_KEY;
  const origSecret = process.env.STRIPE_WEBHOOK_SECRET;

  afterEach(() => {
    vi.clearAllMocks();
    if (origKey) process.env.STRIPE_SECRET_KEY = origKey;
    else delete process.env.STRIPE_SECRET_KEY;
    if (origSecret) process.env.STRIPE_WEBHOOK_SECRET = origSecret;
    else delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it('isStripeConfigured is false without a secret key', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isStripeConfigured()).toBe(false);
  });

  it('isStripeConfigured is true with a secret key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    expect(isStripeConfigured()).toBe(true);
  });

  it('createCheckoutSession throws without a key', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(createCheckoutSession({ pledgeToken: 'tok', amountCents: 100 })).rejects.toThrow(
      'STRIPE_SECRET_KEY is not configured',
    );
  });

  it('createCheckoutSession creates a session when configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    mocks.sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com' });

    const result = await createCheckoutSession({ pledgeToken: 'tok', amountCents: 1000 });

    expect(result.id).toBe('cs_1');
    expect(result.url).toBe('https://checkout.stripe.com');
    expect(mocks.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ client_reference_id: 'tok' }),
    );
  });

  it('verifyWebhook parses raw JSON when no secret is set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const evt = await verifyWebhook(
      Buffer.from('{"type":"checkout.session.completed"}'),
      undefined,
    );
    expect(evt.type).toBe('checkout.session.completed');
  });

  it('verifyWebhook delegates to constructEvent when a secret is set', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    mocks.constructEvent.mockReturnValue({ type: 'checkout.session.completed' });

    const evt = await verifyWebhook(Buffer.from('{}'), 'sig');

    expect(evt.type).toBe('checkout.session.completed');
    expect(mocks.constructEvent).toHaveBeenCalled();
  });
});
