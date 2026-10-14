import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import express from 'express';
import request from 'supertest';
import adminRouter from '../../routes/admin.js';
import webhookRouter from '../../routes/webhook.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
import {
  setDonationStatusTx,
  setClaimStatusTx,
  reverseSpendTx,
  moderateCustomEntryTx,
} from '../../services/reversal.js';
import { endEventTx, undoEventEndTx } from '../../services/eventEnd.js';
import { assignUnusedTx } from '../../services/unusedPool.js';
import prisma from '../../lib/prisma.js';
import {
  requestPaymentRefund,
  previewPaymentRefundTx,
  getPaymentRefundTx,
  retryPaymentRefund,
  reconcilePaymentRefund,
  listPaymentRefundsTx,
  resolvePaymentRefundItem,
  resolvePaymentRefundShipping,
} from '../../services/paymentRefund.js';
import { readDonationAccountingTx } from '../../services/poolAccounting.js';

const stripe = vi.hoisted(() => ({
  createPaymentRefund: vi.fn(),
  listPaymentRefunds: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
}));
vi.mock('../../services/stripe.js', async (original) => ({
  ...(await original<typeof import('../../services/stripe.js')>()),
  ...stripe,
}));
const donors: string[] = [],
  rewards: string[] = [],
  polls: string[] = [],
  goals: string[] = [],
  events: string[] = [],
  channels: string[] = [],
  destinations: string[] = [];
async function fixture(item = 300, cash = 1000, wallet = 0, shipping = 200) {
  const event = await prisma.event.create({
    data: { name: 'Payment refund', slug: crypto.randomUUID() },
  });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: crypto.randomUUID(), slug: crypto.randomUUID(), event_id: event.id },
  });
  channels.push(channel.id);
  const donor = await prisma.donor.create({
    data: {
      email: `${crypto.randomUUID()}@marker.invalid`,
      total_donated: cash,
      balance_remaining: 50,
    },
  });
  donors.push(donor.id);
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: `cs_${crypto.randomUUID()}`,
      payment_intent: `pi_${crypto.randomUUID()}`,
      amount_cents: cash,
      pledge_amount_cents: cash + wallet,
      wallet_applied_cents: wallet,
      shipping_cents: shipping,
      channel_id: channel.id,
      event_id: event.id,
      donor_name: 'Public donor',
      comment: 'Public comment',
    },
  });
  const reward = await prisma.reward.create({
    data: { title: 'Physical', type: 'PHYSICAL', cost_cents: 9999, quantity_claimed: 1 },
  });
  rewards.push(reward.id);
  const claim = await prisma.rewardClaim.create({
    data: {
      donor_id: donor.id,
      donation_id: donation.id,
      reward_id: reward.id,
      amount_cents: item,
      claim_data: '{"private":"answer"}',
    },
  });
  const poll = await prisma.poll.create({
    data: {
      title: 'Ended poll',
      is_active: false,
      ends_at: new Date(0),
      total_votes_cents: cash + wallet,
      options: { create: { label: 'A', votes_cents: cash + wallet } },
    },
    include: { options: true },
  });
  polls.push(poll.id);
  const vote = await prisma.pollVote.create({
    data: {
      donor_id: donor.id,
      donation_id: donation.id,
      poll_id: poll.id,
      poll_option_id: poll.options[0]!.id,
      amount_cents: cash + wallet,
    },
  });
  const goal = await prisma.fundGoal.create({
    data: {
      title: 'Completed goal',
      target_cents: cash + wallet,
      current_cents: cash + wallet,
      is_complete: true,
    },
  });
  goals.push(goal.id);
  const contribution = await prisma.fundContribution.create({
    data: {
      donor_id: donor.id,
      donation_id: donation.id,
      goal_id: goal.id,
      amount_cents: cash + wallet,
    },
  });
  return { event, channel, donor, donation, reward, claim, poll, vote, goal, contribution };
}
async function messages() {
  const native = await prisma.webhookDestination.create({
    data: { url: 'http://127.0.0.1:1', secret: 's', event_types: '["donation.updated"]' },
  });
  const tiltify = await prisma.webhookDestination.create({
    data: {
      url: '',
      secret: '',
      payload_format: 'TILTIFY',
      destination_type: 'RABBITMQ',
      event_types: '[]',
    },
  });
  destinations.push(native.id, tiltify.id);
  return { native, tiltify };
}
async function queued(id: string) {
  return (
    await prisma.webhookDelivery.findMany({
      where: { destination_id: id },
      orderBy: { seq: 'asc' },
    })
  ).map((row) => ({ type: row.message_type, payload: JSON.parse(row.payload) }));
}
beforeEach(() => {
  stripe.createPaymentRefund.mockImplementation(async (input) => ({
    id: `re_${input.refundId}`,
    amount: input.itemCents + input.shippingCents,
    payment_intent: input.paymentIntent,
    metadata: {
      payment_refund_id: input.refundId,
      donation_id: input.donationId,
      claim_id: input.claimId,
    },
    status: 'pending',
  }));
  stripe.listPaymentRefunds.mockResolvedValue([]);
});
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_payment_refund');
  await prisma.balanceAdjustment.deleteMany({
    where: { donor_id: { in: donors }, payment_refund_id: { not: null } },
  });
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.poolCreditRedemption.deleteMany({
    where: { credit: { donation: { donor_id: { in: donors } } } },
  });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pendingPledge.deleteMany({ where: { fulfilled_by: { donor_id: { in: donors } } } });
  await prisma.balanceAdjustment.updateMany({
    where: { donor_id: { in: donors } },
    data: { donation_id: null },
  });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollOption.updateMany({
    where: { poll_id: { in: polls } },
    data: { custom_entry_id: null },
  });
  await prisma.pollCustomEntry.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.eventEndAudit.deleteMany({ where: { event_id: { in: events } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  donors.length =
    rewards.length =
    polls.length =
    goals.length =
    events.length =
    channels.length =
    destinations.length =
      0;
  vi.clearAllMocks();
});
afterAll(() => prisma.$disconnect());

describe('physical Payment refund public interface / real SQLite and outbox', () => {
  it('admin-only read/preview/list/retry/item/shipping API and signed raw refund notifications share the real state machine', async () => {
    const f = await fixture();
    const app = express();
    app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRouter);
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    const moderator = await prisma.donor.create({
      data: {
        email: `${crypto.randomUUID()}@staff.invalid`,
        magic_token: crypto.randomUUID(),
        token_expires_at: new Date(Date.now() + 60000),
        role: 'MODERATOR',
      },
    });
    donors.push(moderator.id);
    const paths = [
      ['get', `/claims/${f.claim.id}/payment-refund-preview`],
      ['post', `/claims/${f.claim.id}/payment-refund`],
      ['get', '/payment-refunds'],
      ['get', '/payment-refunds/unknown'],
      ['post', '/payment-refunds/unknown/retry'],
      ['post', '/payment-refunds/unknown/resolve-item'],
      ['post', '/payment-refunds/unknown/resolve-shipping'],
    ] as const;
    for (const [method, path] of paths) {
      expect((await request(app)[method](`/api/admin${path}`)).status).toBe(401);
      const deniedRequest = request(app)[method](`/api/admin${path}`);
      const denied = await deniedRequest.set('Authorization', `Bearer ${moderator.magic_token}`);
      expect(denied.status).toBe(403);
    }
    const auth = 'Bearer key_admin_test-admin-key';
    const preview = await request(app)
      .get(`/api/admin/claims/${f.claim.id}/payment-refund-preview`)
      .set('Authorization', auth);
    expect(preview.status).toBe(200);
    expect(preview.body.eligible).toBe(true);
    const created = await request(app)
      .post(`/api/admin/claims/${f.claim.id}/payment-refund`)
      .set('Authorization', auth);
    expect(created.status).toBe(200);
    const id = created.body.id;
    expect(
      (await request(app).get(`/api/admin/payment-refunds/${id}`).set('Authorization', auth)).body
        .status,
    ).toBe('PENDING');
    expect(
      (await request(app).get('/api/admin/payment-refunds').set('Authorization', auth)).body.total,
    ).toBe(1);
    expect(
      (await request(app).get('/api/admin/payment-refunds?limit=201').set('Authorization', auth))
        .status,
    ).toBe(400);
    expect(
      (await request(app).get('/api/admin/payment-refunds?status=WRONG').set('Authorization', auth))
        .status,
    ).toBe(400);
    expect(JSON.stringify(preview.body)).not.toContain(f.donor.email);
    const receipt = {
      object: 'refund',
      id: created.body.stripe_refund_id,
      amount: 500,
      status: 'failed',
      payment_intent: f.donation.payment_intent,
      metadata: { payment_refund_id: id, donation_id: f.donation.id, claim_id: f.claim.id },
    };
    const payload = JSON.stringify({
      id: 'evt_refund',
      type: 'refund.failed',
      data: { object: receipt },
    });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    try {
      expect(
        (
          await request(app)
            .post('/api/webhooks/stripe')
            .set('Content-Type', 'application/json')
            .set('stripe-signature', 't=123,v1=wrong')
            .send(payload)
        ).status,
      ).toBe(400);
      const time = Math.floor(Date.now() / 1000);
      const hash = crypto
        .createHmac('sha256', 'whsec_test')
        .update(`${time}.${payload}`)
        .digest('hex');
      expect(
        (
          await request(app)
            .post('/api/webhooks/stripe')
            .set('Content-Type', 'application/json')
            .set('stripe-signature', `t=${time},v1=${hash}`)
            .send(payload)
        ).status,
      ).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      (await request(app).post(`/api/admin/payment-refunds/${id}/retry`).set('Authorization', auth))
        .body.status,
    ).toBe('FAILED');
    expect(
      (
        await request(app)
          .post(`/api/admin/payment-refunds/${id}/resolve-item`)
          .set('Authorization', auth)
          .send({ resolution: 'RETURNED_OUTSIDE_APP' })
      ).body.resolution,
    ).toBe('RETURNED_OUTSIDE_APP');
    expect(
      (
        await request(app)
          .post(`/api/admin/payment-refunds/${id}/resolve-shipping`)
          .set('Authorization', auth)
          .send({ resolution: 'RETURNED_OUTSIDE_APP' })
      ).body.shipping_resolution,
    ).toBe('RETURNED_OUTSIDE_APP');
  });

  it('resolves and durably stores the exact Checkout PaymentIntent before Stripe create, outside SQLite transactions', async () => {
    const f = await fixture();
    await prisma.donation.update({ where: { id: f.donation.id }, data: { payment_intent: null } });
    stripe.retrieveCheckoutSession.mockImplementationOnce(async (id) => {
      expect(id).toBe(f.donation.external_id);
      // A second real write would time out if retrieval ran in an open transaction.
      await prisma.donor.update({ where: { id: f.donor.id }, data: { total_donated: 1000 } });
      return { id, payment_intent: { id: 'pi_resolved' } };
    });
    const create = stripe.createPaymentRefund.getMockImplementation()!;
    stripe.createPaymentRefund.mockImplementationOnce(async (input) => {
      expect(
        await prisma.donation.findUniqueOrThrow({ where: { id: f.donation.id } }),
      ).toMatchObject({ payment_intent: 'pi_resolved' });
      return create(input);
    });
    expect(await requestPaymentRefund(f.claim.id, 'admin')).toMatchObject({ status: 'PENDING' });
  });

  it.each(['error', 'failed', 'canceled'])(
    'definite creation rejection (%s) resolves REJECTED, unlocks PENDING and changes no money',
    async (kind) => {
      const f = await fixture();
      const { native, tiltify } = await messages();
      if (kind === 'error')
        stripe.createPaymentRefund.mockRejectedValueOnce(
          new Stripe.errors.StripeInvalidRequestError({
            message: 'charge_disputed',
            statusCode: 400,
          }),
        );
      else {
        const create = stripe.createPaymentRefund.getMockImplementation()!;
        stripe.createPaymentRefund.mockImplementationOnce(async (input) => ({
          ...(await create(input)),
          status: kind,
        }));
      }
      const result = await requestPaymentRefund(f.claim.id, 'admin');
      expect(result).toMatchObject({
        status: 'RESOLVED',
        resolution: 'REJECTED',
        accepted_at: null,
        resolved_at: expect.any(Date),
      });
      expect(
        await prisma.rewardClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
      ).toMatchObject({ status: 'PENDING', reversed_at: null });
      expect(
        await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id)),
      ).toMatchObject({
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        pools: { poll: { live_cents: 1000 } },
      });
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
        total_donated: 1000,
        balance_remaining: 50,
      });
      expect(
        (await queued(native.id)).map((row) => row.payload.data.allocations.reward[0].status),
      ).toEqual(['CANCELLING', 'PENDING']);
      expect(await queued(tiltify.id)).toEqual([]);
      expect(await prisma.$transaction((tx) => listPaymentRefundsTx(tx))).toMatchObject({
        total: 0,
      });
      expect(
        await prisma.$transaction((tx) => listPaymentRefundsTx(tx, { status: 'RESOLVED' })),
      ).toMatchObject({ total: 1 });
    },
  );

  it.each([
    new Error('timeout'),
    new Stripe.errors.StripeAPIError({ message: 'server error', statusCode: 500 }),
  ])(
    'unknown Stripe creation leaves REQUESTED and every conflict locked until metadata-match retry',
    async (error) => {
      const f = await fixture();
      stripe.createPaymentRefund.mockRejectedValueOnce(error);
      const result = await requestPaymentRefund(f.claim.id, 'admin');
      if (!result) throw new Error('No refund record');
      expect(result).toMatchObject({ status: 'REQUESTED', accepted_at: null });
      expect(
        await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id)),
      ).toMatchObject({ amount_cents: 1000, pledge_amount_cents: 1000 });
      await expect(
        withWebhooks((tx, _emit, pub) =>
          setDonationStatusTx(tx, f.donation.id, 'REFUNDED', undefined, 'admin', pub),
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        withWebhooks((tx, _emit, pub) => setClaimStatusTx(tx, f.claim.id, 'FULFILLED', pub)),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        withWebhooks((tx, _emit, pub) =>
          reverseSpendTx(tx, f.donor.id, 'vote', f.vote.id, 'admin', pub),
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        withWebhooks((tx, _emit, pub) =>
          assignUnusedTx(tx, f.donation.id, 'poll', f.vote.poll_option_id, 100, 'moderator', pub),
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        prisma.$transaction((tx) => endEventTx(tx, f.event.id, f.event.slug, 'admin')),
      ).rejects.toMatchObject({ status: 409 });
      const receipt = {
        id: 're_recovered',
        amount: 500,
        status: 'succeeded',
        payment_intent: f.donation.payment_intent,
        metadata: {
          payment_refund_id: result.id,
          donation_id: f.donation.id,
          claim_id: f.claim.id,
        },
      };
      await prisma.paymentRefund.update({
        where: { id: result.id },
        data: { created_at: new Date(Date.now() - 172800000) },
      });
      stripe.listPaymentRefunds.mockResolvedValueOnce([receipt]);
      expect(await retryPaymentRefund(result.id)).toMatchObject({
        status: 'SUCCEEDED',
        stripe_refund_id: receipt.id,
      });
      expect(stripe.createPaymentRefund).toHaveBeenCalledTimes(1);
      expect(await reconcilePaymentRefund(receipt)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
        total_donated: 700,
      });
    },
  );

  it.each(['COMPLETED', 'REFUNDED', 'CHARGEBACK'])(
    'later failure on %s has explicit at-most-once item and separate shipping resolutions',
    async (status) => {
      const f = await fixture(300, 800, 200);
      const result = await requestPaymentRefund(f.claim.id, 'admin');
      if (!result) throw new Error('No refund record');
      const receipt = {
        id: result.stripe_refund_id!,
        amount: 500,
        status: 'failed',
        failure_reason: 'declined',
        payment_intent: f.donation.payment_intent,
        metadata: {
          payment_refund_id: result.id,
          donation_id: f.donation.id,
          claim_id: f.claim.id,
        },
      };
      await reconcilePaymentRefund(receipt);
      await reconcilePaymentRefund(receipt);
      if (status !== 'COMPLETED')
        await withWebhooks((tx, _emit, pub) =>
          setDonationStatusTx(tx, f.donation.id, status, undefined, 'admin', pub),
        );
      const before = await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } });
      const { native, tiltify } = await messages();
      if (status === 'CHARGEBACK') {
        await expect(
          resolvePaymentRefundItem(result.id, 'WALLET_CREDIT', 'operator'),
        ).rejects.toMatchObject({ status: 409 });
        expect(
          await resolvePaymentRefundItem(result.id, 'SETTLED_BY_DISPUTE', 'operator'),
        ).toMatchObject({ status: 'RESOLVED', resolution: 'SETTLED_BY_DISPUTE' });
        expect(await queued(tiltify.id)).toEqual([]);
      } else {
        await expect(
          resolvePaymentRefundItem(result.id, 'SETTLED_BY_DISPUTE', 'operator'),
        ).rejects.toMatchObject({ status: 409 });
        const resolutions = await Promise.all([
          resolvePaymentRefundItem(result.id, 'WALLET_CREDIT', 'operator'),
          resolvePaymentRefundItem(result.id, 'WALLET_CREDIT', 'operator'),
        ]);
        expect(resolutions).toMatchObject([
          { status: 'RESOLVED', resolution: 'WALLET_CREDIT' },
          { status: 'RESOLVED', resolution: 'WALLET_CREDIT' },
        ]);
        expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
          total_donated: 800,
          balance_remaining: before.balance_remaining + 300,
        });
        expect(
          await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id)),
        ).toMatchObject({
          amount_cents: 800,
          pledge_amount_cents: 1000,
          failed_payment_wallet_credit_cents: 300,
          wallet_credit_granted_cents: (status === 'REFUNDED' ? 700 : 0) + 300,
          pools: { poll: { live_cents: status === 'COMPLETED' ? 700 : 0, unused_cents: 0 } },
        });
        expect(
          await prisma.balanceAdjustment.findMany({ where: { payment_refund_id: result.id } }),
        ).toMatchObject([
          {
            type: 'FAILED_PAYMENT_REFUND',
            amount_cents: 300,
            donation_id: f.donation.id,
            reference_id: result.id,
          },
        ]);
        expect(await queued(native.id)).toHaveLength(1);
        expect((await queued(tiltify.id)).map((row) => row.type)).toEqual([
          'tiltify.donation',
          'tiltify.fact.updated',
          'tiltify.fact.updated',
        ]);
      }
      expect(await prisma.$transaction((tx) => listPaymentRefundsTx(tx))).toMatchObject({
        total: 1,
      });
      expect(
        await resolvePaymentRefundShipping(result.id, 'KEPT_BY_AGREEMENT', 'shipping-operator'),
      ).toMatchObject({
        shipping_resolution: 'KEPT_BY_AGREEMENT',
        shipping_resolved_by: 'shipping-operator',
      });
      await resolvePaymentRefundShipping(result.id, 'KEPT_BY_AGREEMENT', 'shipping-operator');
      await expect(
        resolvePaymentRefundShipping(result.id, 'RETURNED_OUTSIDE_APP', 'other'),
      ).rejects.toMatchObject({ status: 409 });
      const settled = await prisma.$transaction((tx) => getPaymentRefundTx(tx, result.id));
      await reconcilePaymentRefund({ ...receipt, status: 'pending' });
      await reconcilePaymentRefund(receipt);
      expect(await prisma.$transaction((tx) => getPaymentRefundTx(tx, result.id))).toEqual(settled);
    },
  );

  it.each(['APPROVED', 'REJECTED'] as const)(
    'REQUESTED blocks %s write-in moderation on the same funding donation',
    async (action) => {
      const f = await fixture();
      const entry = await prisma.pollCustomEntry.create({
        data: { poll_id: f.poll.id, donor_id: f.donor.id, label: 'Pending choice' },
      });
      await prisma.pollOption.update({
        where: { id: f.vote.poll_option_id },
        data: { status: 'PENDING_APPROVAL', custom_entry_id: entry.id, votes_cents: 0 },
      });
      await prisma.poll.update({ where: { id: f.poll.id }, data: { total_votes_cents: 0 } });
      stripe.createPaymentRefund.mockRejectedValueOnce(new Error('timeout'));
      await requestPaymentRefund(f.claim.id, 'admin');
      await expect(
        withWebhooks((tx, _emit, pub) =>
          moderateCustomEntryTx(tx, entry.id, action, 'moderator', pub),
        ),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it('outside item and shipping returns do not repair accounting or grant any credit', async () => {
    const f = await fixture();
    const result = await requestPaymentRefund(f.claim.id, 'admin');
    if (!result) throw new Error('No refund record');
    await reconcilePaymentRefund({
      id: result.stripe_refund_id!,
      amount: 500,
      status: 'canceled',
      payment_intent: f.donation.payment_intent,
      metadata: { payment_refund_id: result.id, donation_id: f.donation.id, claim_id: f.claim.id },
    });
    await resolvePaymentRefundShipping(result.id, 'RETURNED_OUTSIDE_APP', 'operator');
    await resolvePaymentRefundItem(result.id, 'RETURNED_OUTSIDE_APP', 'operator');
    await resolvePaymentRefundItem(result.id, 'RETURNED_OUTSIDE_APP', 'operator');
    await expect(
      resolvePaymentRefundItem(result.id, 'WALLET_CREDIT', 'operator'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
      total_donated: 700,
      balance_remaining: 50,
    });
    expect(await prisma.balanceAdjustment.count({ where: { payment_refund_id: result.id } })).toBe(
      0,
    );
  });

  it.each(['pending', 'requires_action', 'succeeded'])(
    'webhook %s before the create response applies once; stale pending cannot undo a later failure/resolution',
    async (accepted) => {
      const f = await fixture();
      const create = stripe.createPaymentRefund.getMockImplementation()!;
      stripe.createPaymentRefund.mockImplementationOnce(async (input) => {
        const receipt = { ...(await create(input)), status: accepted };
        await reconcilePaymentRefund(receipt);
        await reconcilePaymentRefund({ ...receipt, status: 'failed', failure_reason: 'declined' });
        return { ...receipt, status: 'pending' };
      });
      const result = await requestPaymentRefund(f.claim.id, 'admin');
      expect(result).toMatchObject({ status: 'FAILED', failure_reason: 'declined' });
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
        total_donated: 700,
      });
      expect(await prisma.reward.findUniqueOrThrow({ where: { id: f.reward.id } })).toMatchObject({
        quantity_claimed: 0,
      });
    },
  );

  it.each(['metadata', 'amount', 'payment_intent', 'stripe_id', 'donation', 'claim'])(
    'mismatched %s receipt cannot apply or change our record; unrelated refunds are ignored',
    async (mismatch) => {
      const f = await fixture();
      const record = await requestPaymentRefund(f.claim.id, 'admin');
      if (!record) throw new Error('No record');
      const receipt = {
        id: record.stripe_refund_id!,
        amount: 500,
        status: 'failed',
        payment_intent: f.donation.payment_intent,
        metadata: {
          payment_refund_id: record.id,
          donation_id: f.donation.id,
          claim_id: f.claim.id,
        },
      };
      if (mismatch === 'metadata') {
        expect(await reconcilePaymentRefund({ ...receipt, metadata: null })).toBeNull();
        return;
      }
      if (mismatch === 'amount') receipt.amount++;
      if (mismatch === 'payment_intent') receipt.payment_intent = 'pi_unrelated';
      if (mismatch === 'stripe_id') receipt.id = 're_unrelated';
      if (mismatch === 'donation') receipt.metadata.donation_id = 'unrelated';
      if (mismatch === 'claim') receipt.metadata.claim_id = 'unrelated';
      await expect(reconcilePaymentRefund(receipt)).rejects.toMatchObject({ status: 409 });
      expect(await prisma.$transaction((tx) => getPaymentRefundTx(tx, record.id))).toMatchObject({
        status: 'PENDING',
      });
    },
  );

  it('settled success is monotonic against old pending/requires_action notifications', async () => {
    const f = await fixture();
    const record = await requestPaymentRefund(f.claim.id, 'admin');
    if (!record) throw new Error('No record');
    const receipt = {
      id: record.stripe_refund_id!,
      amount: 500,
      status: 'succeeded',
      payment_intent: f.donation.payment_intent,
      metadata: { payment_refund_id: record.id, donation_id: f.donation.id, claim_id: f.claim.id },
    };
    await reconcilePaymentRefund(receipt);
    expect(await reconcilePaymentRefund({ ...receipt, status: 'requires_action' })).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(await reconcilePaymentRefund({ ...receipt, status: 'pending' })).toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it.each(['rejected', 'unknown', 'accepted'])(
    'per-donation serialization locks another claim until %s outcome',
    async (outcome) => {
      const f = await fixture(200);
      const second = await prisma.rewardClaim.create({
        data: {
          donor_id: f.donor.id,
          donation_id: f.donation.id,
          reward_id: f.reward.id,
          amount_cents: 200,
        },
      });
      await prisma.reward.update({ where: { id: f.reward.id }, data: { quantity_claimed: 2 } });
      const create = stripe.createPaymentRefund.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      stripe.createPaymentRefund.mockImplementationOnce(async (input) => {
        started();
        await gate;
        if (outcome === 'unknown') throw new Error('timeout');
        return { ...(await create(input)), status: outcome === 'rejected' ? 'failed' : 'pending' };
      });
      const first = requestPaymentRefund(f.claim.id, 'admin');
      await entered;
      await expect(requestPaymentRefund(second.id, 'admin')).rejects.toMatchObject({ status: 409 });
      release();
      const record = await first;
      expect(record).toMatchObject({
        shipping_cents: 0,
        status:
          outcome === 'unknown' ? 'REQUESTED' : outcome === 'rejected' ? 'RESOLVED' : 'PENDING',
      });
      if (outcome !== 'unknown') {
        const next = await requestPaymentRefund(second.id, 'admin');
        expect(next).toMatchObject({ shipping_cents: outcome === 'accepted' ? 200 : 0 });
      }
    },
  );

  it('last noncanceled physical claim includes fulfilled claims; nonphysical and reversed claims do not reserve shipping', async () => {
    const f = await fixture();
    const other = await prisma.rewardClaim.create({
      data: {
        reward_id: f.reward.id,
        donor_id: f.donor.id,
        donation_id: f.donation.id,
        amount_cents: 200,
        status: 'FULFILLED',
      },
    });
    expect(await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id))).toMatchObject(
      { shipping_cents: 0 },
    );
    await prisma.rewardClaim.update({
      where: { id: other.id },
      data: { reversed_at: new Date(), status: 'REVERSED' },
    });
    await prisma.donation.update({
      where: { id: f.donation.id },
      data: { shipping_refunded_cents: 75 },
    });
    expect(await requestPaymentRefund(f.claim.id, 'admin')).toMatchObject({ shipping_cents: 125 });
  });

  it.each(['PHYSICAL', 'DIGITAL'])(
    'confirmed %s wins over an opposite catalog type edit',
    async (confirmed) => {
      const f = await fixture();
      await prisma.pendingPledge.create({
        data: {
          pledge_token: crypto.randomUUID(),
          format: 'POOLED',
          draft_id: crypto.randomUUID(),
          confirmed_plan: '{}',
          pledge_amount_cents: 1000,
          new_money_cents: 1000,
          fulfilled_by_donation_id: f.donation.id,
          status: 'FULFILLED',
          expires_at: new Date(),
          items: {
            create: {
              kind: 'REWARD',
              target_id: f.reward.id,
              amount_cents: 300,
              unit_price_cents: 300,
              confirmed_reward_type: confirmed,
            },
          },
        },
      });
      await prisma.reward.update({
        where: { id: f.reward.id },
        data: { type: confirmed === 'PHYSICAL' ? 'DIGITAL' : 'PHYSICAL' },
      });
      expect(
        await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id)),
      ).toMatchObject({ eligible: confirmed === 'PHYSICAL' });
    },
  );

  it('credit funding never becomes physical-refund eligible after catalog type changes, even with a matching original pledge item', async () => {
    const f = await fixture();
    const origin = await prisma.rewardClaim.create({
      data: {
        reward_id: f.reward.id,
        donor_id: f.donor.id,
        donation_id: f.donation.id,
        amount_cents: 300,
        reversed_at: new Date(),
        status: 'REVERSED',
      },
    });
    const grant = await prisma.poolCredit.create({
      data: {
        donation_id: f.donation.id,
        category: 'reward',
        amount_cents: 300,
        remaining_cents: 0,
        source_claim_id: origin.id,
        created_by: 'admin',
      },
    });
    const batch = await prisma.poolCreditBatch.create({
      data: {
        donor_id: f.donor.id,
        event_id: f.event.id,
        idempotency_key: crypto.randomUUID(),
        request_data: '{}',
      },
    });
    await prisma.poolCreditRedemption.create({
      data: { credit_id: grant.id, batch_id: batch.id, amount_cents: 300, claim_id: f.claim.id },
    });
    expect(await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id))).toMatchObject(
      { eligible: false, reason: 'Only a directly funded physical claim is eligible' },
    );
    await expect(requestPaymentRefund(f.claim.id, 'admin')).rejects.toMatchObject({ status: 409 });
  });

  it('a retry with no metadata match reuses the exact record id and amounts after exhaustive discovery, not a new refund record', async () => {
    const f = await fixture();
    stripe.createPaymentRefund.mockRejectedValueOnce(new Error('timeout'));
    const record = await requestPaymentRefund(f.claim.id, 'admin');
    const result = await retryPaymentRefund(record!.id);
    expect(result).toMatchObject({ id: record!.id, status: 'PENDING' });
    expect(stripe.listPaymentRefunds).toHaveBeenCalledWith(f.donation.payment_intent);
    expect(stripe.createPaymentRefund.mock.calls[1]![0]).toEqual(
      stripe.createPaymentRefund.mock.calls[0]![0],
    );
    expect(await prisma.paymentRefund.count({ where: { donation_id: f.donation.id } })).toBe(1);
  });

  it.each(['REFUNDED', 'CHARGEBACK'])(
    'a later %s uses only reduced D and remaining cash',
    async (status) => {
      const f = await fixture(300, 800, 200);
      await requestPaymentRefund(f.claim.id, 'admin');
      const { tiltify } = await messages();
      await withWebhooks((tx, _emit, pub) =>
        setDonationStatusTx(tx, f.donation.id, status, undefined, 'admin', pub),
      );
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: status === 'REFUNDED' ? 750 : 250,
        total_donated: 500,
      });
      const totals = (await queued(tiltify.id)).filter(
        (row) => row.type === 'tiltify.fact.updated',
      );
      expect(totals).toHaveLength(status === 'REFUNDED' ? 0 : 2);
      for (const row of totals) expect(row.payload.total_amount_raised.value).toBe('0.00');
    },
  );

  it('recorded item price is capped at remaining new money and a zero-funded poll/goal is retired, never a wire-visible vote', async () => {
    const f = await fixture(1500, 1000);
    const { native, tiltify } = await messages();
    expect(await requestPaymentRefund(f.claim.id, 'admin')).toMatchObject({ item_cents: 1000 });
    expect(
      await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id)),
    ).toMatchObject({
      amount_cents: 0,
      pledge_amount_cents: 0,
      allocations: { reward: [], poll: [], goal: [] },
    });
    expect((await queued(native.id)).at(-1)!.payload.data.allocations).toEqual({
      reward: [],
      poll: [],
      goal: [],
    });
    expect((await queued(tiltify.id))[0]!.payload).toMatchObject({
      poll_votes: [],
      target_contributions: [],
      poll_id: null,
      target_id: null,
    });
    expect(await prisma.poolCredit.count({ where: { donation_id: f.donation.id } })).toBe(0);
  });

  it('Unused shrinks before live funding and outstanding credit; largest remainders total exact cents on ended targets', async () => {
    const f = await fixture(501);
    await prisma.pollVote.update({ where: { id: f.vote.id }, data: { amount_cents: 333 } });
    await prisma.pollOption.update({
      where: { id: f.vote.poll_option_id },
      data: { votes_cents: 333 },
    });
    await prisma.poll.update({ where: { id: f.poll.id }, data: { total_votes_cents: 333 } });
    const reversed = await prisma.pollVote.create({
      data: {
        donor_id: f.donor.id,
        donation_id: f.donation.id,
        poll_id: f.poll.id,
        poll_option_id: f.vote.poll_option_id,
        amount_cents: 333,
        reversed_at: new Date(),
      },
    });
    const credit = await prisma.poolCredit.create({
      data: {
        donation_id: f.donation.id,
        category: 'poll',
        amount_cents: 333,
        remaining_cents: 333,
        source_vote_id: reversed.id,
        created_by: 'admin',
      },
    });
    await prisma.fundContribution.update({
      where: { id: f.contribution.id },
      data: { amount_cents: 400 },
    });
    await prisma.fundGoal.update({ where: { id: f.goal.id }, data: { current_cents: 400 } });
    const record = await requestPaymentRefund(f.claim.id, 'admin');
    if (!record?.pool_shrink_data) throw new Error('No audit');
    expect(JSON.parse(record.pool_shrink_data).categories).toMatchObject({
      poll: { unused_consumed_cents: 334, reduced_cents: 167 },
      goal: { unused_consumed_cents: 501, reduced_cents: 0 },
    });
    expect(
      await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id)),
    ).toMatchObject({
      pools: {
        poll: { live_cents: 249, outstanding_credit_cents: 250, unused_cents: 0 },
        goal: { live_cents: 400, unused_cents: 99 },
      },
    });
    expect(await prisma.poolCredit.findUniqueOrThrow({ where: { id: credit.id } })).toMatchObject({
      amount_cents: 333,
      remaining_cents: 250,
    });
  });

  it('Event end closes eligibility and Undo end reopens it without repair', async () => {
    const f = await fixture();
    await prisma.$transaction((tx) => endEventTx(tx, f.event.id, f.event.slug, 'admin'));
    expect(await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id))).toMatchObject(
      { eligible: false },
    );
    await expect(requestPaymentRefund(f.claim.id, 'admin')).rejects.toMatchObject({ status: 409 });
    await prisma.$transaction((tx) => undoEventEndTx(tx, f.event.id, f.event.slug, 'admin'));
    expect(await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id))).toMatchObject(
      { eligible: true },
    );
  });

  it.each([
    'legacy',
    'terminal',
    'no_event',
    'no_stripe',
    'fulfilled',
    'reversed',
    'digital',
    'unknown_shipping',
    'zero_cash',
  ])('eligibility rejects %s without contacting Stripe', async (boundary) => {
    const f = await fixture();
    if (boundary === 'legacy')
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { pledge_amount_cents: null },
      });
    if (boundary === 'terminal')
      await prisma.donation.update({ where: { id: f.donation.id }, data: { status: 'REFUNDED' } });
    if (boundary === 'no_event')
      await prisma.donation.update({ where: { id: f.donation.id }, data: { event_id: null } });
    if (boundary === 'no_stripe')
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { external_id: 'sim_unrelated' },
      });
    if (boundary === 'fulfilled')
      await prisma.rewardClaim.update({ where: { id: f.claim.id }, data: { status: 'FULFILLED' } });
    if (boundary === 'reversed')
      await prisma.rewardClaim.update({
        where: { id: f.claim.id },
        data: { reversed_at: new Date() },
      });
    if (boundary === 'digital')
      await prisma.reward.update({ where: { id: f.reward.id }, data: { type: 'DIGITAL' } });
    if (boundary === 'unknown_shipping')
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { shipping_cents: null },
      });
    if (boundary === 'zero_cash')
      await prisma.donation.update({ where: { id: f.donation.id }, data: { amount_cents: 0 } });
    expect(await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id))).toMatchObject(
      { eligible: false, reason: expect.any(String) },
    );
    await expect(requestPaymentRefund(f.claim.id, 'admin')).rejects.toMatchObject({ status: 409 });
    expect(stripe.createPaymentRefund).not.toHaveBeenCalled();
  });

  it.each(['request', 'acceptance', 'resolution'])(
    'late outbox failure rolls back %s completely and retries safely',
    async (stage) => {
      const f = await fixture();
      const { native, tiltify } = await messages();
      let record: Awaited<ReturnType<typeof requestPaymentRefund>> | null = null;
      if (stage !== 'request') {
        stripe.createPaymentRefund.mockRejectedValueOnce(new Error('timeout'));
        record = await requestPaymentRefund(f.claim.id, 'admin');
        if (!record) throw new Error('No record');
        stripe.listPaymentRefunds.mockResolvedValue([
          {
            id: 're_retry',
            amount: 500,
            status: 'pending',
            payment_intent: f.donation.payment_intent,
            metadata: {
              payment_refund_id: record.id,
              donation_id: f.donation.id,
              claim_id: f.claim.id,
            },
          },
        ]);
        if (stage === 'resolution') {
          await retryPaymentRefund(record.id);
          await reconcilePaymentRefund({
            id: 're_retry',
            amount: 500,
            status: 'failed',
            payment_intent: f.donation.payment_intent,
            metadata: {
              payment_refund_id: record.id,
              donation_id: f.donation.id,
              claim_id: f.claim.id,
            },
          });
        }
      }
      const rows = await queued(native.id);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER fail_payment_refund BEFORE INSERT ON WebhookDelivery WHEN NEW.destination_id = '${stage === 'request' ? native.id : tiltify.id}' BEGIN SELECT RAISE(ABORT, 'late outbox failure'); END`,
      );
      await expect(
        stage === 'request'
          ? requestPaymentRefund(f.claim.id, 'admin')
          : stage === 'acceptance'
            ? retryPaymentRefund(record!.id)
            : resolvePaymentRefundItem(record!.id, 'WALLET_CREDIT', 'admin'),
      ).rejects.toThrow();
      expect(await queued(native.id)).toEqual(rows);
      expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
        total_donated: stage === 'resolution' ? 700 : 1000,
        balance_remaining: 50,
      });
      expect(await prisma.reward.findUniqueOrThrow({ where: { id: f.reward.id } })).toMatchObject({
        quantity_claimed: stage === 'resolution' ? 0 : 1,
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(0);
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_payment_refund');
      if (stage === 'acceptance')
        expect(await retryPaymentRefund(record!.id)).toMatchObject({ status: 'PENDING' });
    },
  );

  it('acceptance cancels one recorded-price claim, preserves W, shrinks ended targets without reopening and publishes money once', async () => {
    const f = await fixture(300, 800, 200);
    const { native, tiltify } = await messages();
    const preview = await prisma.$transaction((tx) => previewPaymentRefundTx(tx, f.claim.id));
    expect(preview).toMatchObject({
      eligible: true,
      item_cents: 300,
      shipping_cents: 200,
      money_before_cents: 800,
      money_after_cents: 500,
      pledge_before_cents: 1000,
      pledge_after_cents: 700,
    });
    const result = await requestPaymentRefund(f.claim.id, 'admin-marker');
    expect(result).not.toBeNull();
    if (!result) throw new Error('No refund record');
    expect(result).toMatchObject({
      status: 'PENDING',
      item_cents: 300,
      shipping_cents: 200,
      accepted_at: expect.any(Date),
    });
    expect(await prisma.$transaction((tx) => getPaymentRefundTx(tx, result.id))).toMatchObject({
      id: result.id,
      pool_shrink_data: expect.any(String),
    });
    expect(
      await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id)),
    ).toMatchObject({
      status: 'COMPLETED',
      amount_cents: 500,
      pledge_amount_cents: 700,
      wallet_applied_cents: 200,
      pools: {
        reward: { live_cents: 0, pool_credit_cents: 0 },
        poll: { live_cents: 700 },
        goal: { live_cents: 700 },
      },
    });
    expect(await prisma.rewardClaim.findUniqueOrThrow({ where: { id: f.claim.id } })).toMatchObject(
      { status: 'REVERSED', reversed_by: 'admin-marker' },
    );
    expect(await prisma.reward.findUniqueOrThrow({ where: { id: f.reward.id } })).toMatchObject({
      quantity_claimed: 0,
    });
    expect(await prisma.donation.findUniqueOrThrow({ where: { id: f.donation.id } })).toMatchObject(
      { shipping_refunded_cents: 200 },
    );
    expect(await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).toMatchObject({
      total_donated: 500,
      balance_remaining: 50,
    });
    expect(await prisma.fundGoal.findUniqueOrThrow({ where: { id: f.goal.id } })).toMatchObject({
      current_cents: 700,
      is_complete: true,
    });
    expect(await prisma.poll.findUniqueOrThrow({ where: { id: f.poll.id } })).toMatchObject({
      total_votes_cents: 700,
      is_active: false,
      ends_at: new Date(0),
    });
    const safe = await queued(native.id);
    expect(
      safe.map((row) =>
        row.payload.data.allocations.reward.map((claim: { status: string }) => claim.status),
      ),
    ).toEqual([['CANCELLING'], []]);
    expect(JSON.stringify(safe)).not.toContain(f.donor.email);
    expect(JSON.stringify(safe)).not.toContain('private');
    expect(JSON.stringify(safe)).not.toContain('admin-marker');
    expect((await queued(tiltify.id)).map((row) => row.type)).toEqual([
      'tiltify.donation',
      'tiltify.fact.updated',
      'tiltify.fact.updated',
    ]);
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(0);
  });
});
