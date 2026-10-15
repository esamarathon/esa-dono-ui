import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { planPledge } from '@dono/shared';
import { createPledge, createCheckoutForPledge } from '../../services/pledge.js';
import { createTestChannel } from '../helpers/fixtures.js';
import webhookRouter from '../../routes/webhook.js';

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() }));
vi.mock('stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('stripe')>();
  return {
    ...actual,
    default: class extends actual.default {
      constructor(...args: ConstructorParameters<typeof actual.default>) {
        super(...args);
        this.checkout.sessions.create = stripe.create;
        this.checkout.sessions.retrieve = stripe.retrieve;
        this.checkout.sessions.expire = stripe.expire;
      }
    },
  };
});
vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));

const donors: string[] = [];
const channels: string[] = [];
const tokens: string[] = [];
const auctions: string[] = [];
function app() {
  const app = express();
  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRouter);
  app.use(express.json());
  return app;
}
async function pending({
  availableWallet,
  pledgeCents,
  paidCents,
}: Readonly<{ availableWallet: number; pledgeCents: number; paidCents: number }>) {
  const channel = await createTestChannel(prisma);
  channels.push(channel.id);
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: availableWallet },
  });
  donors.push(donor.id);
  const pledge = await createPledge({
    draft_id: crypto.randomUUID(),
    pledge_amount_cents: pledgeCents,
    items: [],
    channel_id: channel.id,
    walletDonorId: donor.id,
    plan: planPledge({
      pledge_amount_cents: pledgeCents,
      selections: [],
      available_wallet_cents: availableWallet,
    }),
  });
  tokens.push(pledge.pledge_token);
  const id = `cs_${crypto.randomUUID()}`;
  stripe.create.mockResolvedValue({ id, url: 'https://checkout.stripe.com/test' });
  await createCheckoutForPledge(pledge.pledge_token, donor);
  const session = {
    id,
    status: 'complete',
    payment_status: 'paid',
    amount_total: paidCents,
    customer_details: { email: donor.email, name: 'Reader' },
    metadata: { pledge_token: pledge.pledge_token },
  };
  return { pledge, donor, session };
}
async function notify(type: string, session: object, signature?: string) {
  const payload = JSON.stringify({ id: 'evt_test', type, data: { object: session } });
  const req = request(app()).post('/api/webhooks/stripe').set('Content-Type', 'application/json');
  if (signature === 'valid') {
    const time = Math.floor(Date.now() / 1000);
    const hash = crypto
      .createHmac('sha256', 'whsec_test')
      .update(`${time}.${payload}`)
      .digest('hex');
    req.set('stripe-signature', `t=${time},v1=${hash}`);
  } else if (signature) req.set('stripe-signature', signature);
  return req.send(payload);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
});
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_legacy_webhook');
  await prisma.auction.updateMany({
    where: { id: { in: auctions } },
    data: { current_offer_id: null },
  });
  await prisma.auctionWin.deleteMany({ where: { auction_id: { in: auctions } } });
  await prisma.auctionOffer.deleteMany({ where: { auction_id: { in: auctions } } });
  await prisma.bid.deleteMany({ where: { auction_id: { in: auctions } } });
  await prisma.auction.deleteMany({ where: { id: { in: auctions } } });
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: { in: tokens } } });
  await prisma.balanceAdjustment.updateMany({
    where: { donor_id: { in: donors } },
    data: { donation_id: null },
  });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  donors.length = channels.length = tokens.length = auctions.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => prisma.$disconnect());

describe('Stripe webhook with real SQLite intake/reconciliation', () => {
  it('consumes duplicate legacy async failures as one common legacy chargeback before acknowledging', async () => {
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: 700 },
    });
    donors.push(donor.id);
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: `cs_${crypto.randomUUID()}`,
        amount_cents: 1000,
        channel_id: channel.id,
        event_id: channel.event_id,
      },
    });
    const results = await Promise.all([
      notify('checkout.session.async_payment_failed', { id: donation.external_id }),
      notify('checkout.session.async_payment_failed', { id: donation.external_id }),
    ]);
    expect(results.map((row) => row.status)).toEqual([200, 200]);
    expect(results.map((row) => row.body)).toEqual([{ received: true }, { received: true }]);
    expect(await prisma.donation.findUnique({ where: { id: donation.id } })).toMatchObject({
      status: 'CHARGEBACK',
      pledge_amount_cents: null,
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 0,
    });
    expect(
      await prisma.balanceAdjustment.findMany({ where: { donor_id: donor.id } }),
    ).toMatchObject([{ type: 'CHARGEBACK', amount_cents: -700 }]);
  });
  it('does not acknowledge a failed legacy reversal transaction and safely retries it', async () => {
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: 1000 },
    });
    donors.push(donor.id);
    const donation = await prisma.donation.create({
      data: { donor_id: donor.id, external_id: `cs_${crypto.randomUUID()}`, amount_cents: 1000 },
    });
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER fail_legacy_webhook BEFORE INSERT ON BalanceAdjustment WHEN NEW.donor_id = '${donor.id}' BEGIN SELECT RAISE(ABORT, 'late legacy ledger failure'); END`,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        (await notify('checkout.session.async_payment_failed', { id: donation.external_id }))
          .status,
      ).toBe(500);
    } finally {
      log.mockRestore();
    }
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 1000,
    });
    expect(await prisma.donation.findUnique({ where: { id: donation.id } })).toMatchObject({
      status: 'COMPLETED',
      refund_id: null,
    });
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_legacy_webhook');
    expect(
      (await notify('checkout.session.async_payment_failed', { id: donation.external_id })).status,
    ).toBe(200);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 0,
    });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: donor.id } })).toBe(1);
  });
  it('verifies the raw signed body and fulfills duplicate paid notifications once', async () => {
    const { session, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      paidCents: 50,
    });
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    const results = await Promise.all([
      notify('checkout.session.completed', session, 'valid'),
      notify('checkout.session.async_payment_succeeded', session, 'valid'),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await prisma.donation.count({ where: { external_id: session.id } })).toBe(1);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 0,
      total_donated: 50,
    });
  });
  it('rejects an invalid signature before accounting', async () => {
    const { session, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      paidCents: 50,
    });
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    expect((await notify('checkout.session.completed', session, 't=12345,v1=invalid')).status).toBe(
      400,
    );
    expect(await prisma.donation.count({ where: { donor_id: donor.id } })).toBe(0);
  });
  it('leaves completed/unpaid processing held and accepts later async success', async () => {
    const { session, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      paidCents: 50,
    });
    expect(
      (await notify('checkout.session.completed', { ...session, payment_status: 'unpaid' })).status,
    ).toBe(200);
    expect(await prisma.donation.count({ where: { donor_id: donor.id } })).toBe(0);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_held_cents: 950,
    });
    expect((await notify('checkout.session.async_payment_succeeded', session)).status).toBe(200);
    expect(await prisma.donation.count({ where: { donor_id: donor.id } })).toBe(1);
  });
  it.each(['checkout.session.expired', 'checkout.session.async_payment_failed'])(
    'reconciles %s and releases the hold once',
    async (type) => {
      const { session, donor, pledge } = await pending({
        availableWallet: 975,
        pledgeCents: 1000,
        paidCents: 50,
      });
      stripe.retrieve.mockResolvedValue({ ...session, payment_status: 'unpaid' });
      const notification = {
        ...session,
        payment_status: 'unpaid',
        status: type.endsWith('expired') ? 'expired' : 'complete',
      };
      expect((await notify(type, notification)).status).toBe(200);
      expect((await notify(type, notification)).status).toBe(200);
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 975,
        balance_held_cents: 0,
      });
      expect(
        await prisma.pendingPledge.findUnique({ where: { pledge_token: pledge.pledge_token } }),
      ).toMatchObject({ status: 'EXPIRED', wallet_hold_status: 'RELEASED' });
    },
  );
  it('records shipping outside money and never stores a shipping address', async () => {
    const { session, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      paidCents: 50,
    });
    expect(
      (
        await notify('checkout.session.completed', {
          ...session,
          amount_total: 250,
          total_details: { amount_shipping: 200 },
          shipping_details: { address: { line1: 'Private address marker' } },
        })
      ).status,
    ).toBe(200);
    const donation = await prisma.donation.findUnique({ where: { external_id: session.id } });
    expect(donation).toMatchObject({ amount_cents: 50, shipping_cents: 200 });
    expect(JSON.stringify(donation)).not.toContain('Private address marker');
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      total_donated: 50,
    });
  });
  it('ignores unrelated events and malformed sessions without creating money', async () => {
    expect((await notify('payment_intent.created', {})).status).toBe(200);
    expect((await notify('checkout.session.expired', {})).status).toBe(200);
  });
  it.each(['checkout.session.completed', 'checkout.session.expired'])(
    'preserves the separate auction %s branch',
    async (type) => {
      const { donor } = await pending({ availableWallet: 975, pledgeCents: 1000, paidCents: 50 });
      const auction = await prisma.auction.create({
        data: {
          title: 'Auction item',
          type: 'DIGITAL',
          starting_price_cents: 1000,
          min_increment_cents: 100,
          ends_at: new Date(),
          status: 'AWAITING_PAYMENT',
        },
      });
      auctions.push(auction.id);
      const bid = await prisma.bid.create({
        data: { auction_id: auction.id, donor_id: donor.id, amount_cents: 1000 },
      });
      const offer = await prisma.auctionOffer.create({
        data: {
          auction_id: auction.id,
          donor_id: donor.id,
          bid_id: bid.id,
          rank: 1,
          amount_cents: 1000,
          checkout_session_id: 'cs_auction',
          expires_at: new Date(),
        },
      });
      await prisma.auction.update({
        where: { id: auction.id },
        data: { current_offer_id: offer.id },
      });
      expect(
        (await notify(type, { id: 'cs_auction', metadata: { auction_id: auction.id } })).status,
      ).toBe(200);
      expect(await prisma.auction.findUnique({ where: { id: auction.id } })).toMatchObject({
        status: type.endsWith('expired') ? 'UNSOLD' : 'SETTLED',
      });
      expect(await prisma.donation.count({ where: { donor_id: donor.id } })).toBe(0);
    },
  );
});
