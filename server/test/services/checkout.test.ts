import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { planPledge } from '@dono/shared';
import { createPledge, createCheckoutForPledge } from '../../services/pledge.js';
import {
  cancelPledge,
  reconcilePledge,
  reconcileCheckoutNotification,
  getPledge,
} from '../../services/checkout.js';
import { pledgeResponse } from '../../services/pledge.js';
import { intakeDonation } from '../../services/donation.js';
import { createTestChannel } from '../helpers/fixtures.js';
import { sendMagicLink } from '../../services/email.js';
import { drainDestination } from '../../services/webhooks/dispatcher.js';

const stripe = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
  list: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: stripe };
  },
}));
vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));

const channels: string[] = [];
const donors: string[] = [];
const tokens: string[] = [];
const goals: string[] = [];
const destinations: string[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function pending({
  availableWallet,
  pledgeCents,
  goalCents,
  goalId,
}: Readonly<{ availableWallet: number; pledgeCents: number; goalCents: number; goalId?: string }>) {
  const channel = await createTestChannel(prisma);
  channels.push(channel.id);
  const donor = await prisma.donor.create({
    data: {
      email: `${crypto.randomUUID()}@example.com`,
      balance_remaining: availableWallet,
      magic_token: crypto.randomUUID(),
    },
  });
  donors.push(donor.id);
  const selections = goalId
    ? [{ kind: 'GOAL' as const, target_id: goalId, amount_cents: goalCents, insertion_order: 0 }]
    : [];
  const input = {
    draft_id: crypto.randomUUID(),
    pledge_amount_cents: pledgeCents,
    items: selections,
    channel_id: channel.id,
    walletDonorId: donor.id,
    comment: 'Original comment',
    display_name: 'Original name',
    plan: planPledge({
      pledge_amount_cents: pledgeCents,
      selections,
      available_wallet_cents: availableWallet,
    }),
  };
  const pledge = await createPledge(input);
  tokens.push(pledge.pledge_token);
  return { pledge, donor, input, channel };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sendMagicLink).mockResolvedValue(undefined);
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
});
afterEach(async () => {
  await Promise.all(destinations.map(drainDestination));
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_checkout_outbox');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_checkout_commit');
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: { in: tokens } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  channels.length = donors.length = tokens.length = goals.length = destinations.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => prisma.$disconnect());

describe('checkout lifecycle on real SQLite', () => {
  it.each(['open', null] as const)(
    'blocks cancellation and edits when Stripe is still open or unknown (%s)',
    async (status) => {
      const { pledge, donor } = await pending({
        availableWallet: 975,
        pledgeCents: 1000,
        goalCents: 0,
      });
      stripe.create.mockResolvedValue({
        id: 'cs_not_cancelled',
        url: 'https://checkout.stripe.com/pending',
        status: 'open',
        payment_status: 'unpaid',
      });
      await createCheckoutForPledge(pledge.pledge_token, donor);
      stripe.expire.mockRejectedValue(new Error('unclear expire'));
      stripe.retrieve.mockResolvedValue({
        id: 'cs_not_cancelled',
        status,
        payment_status: 'unpaid',
      });
      await expect(cancelPledge(pledge.pledge_token, donor)).rejects.toMatchObject({ status: 409 });
      expect(pledgeResponse(await getPledge(pledge.pledge_token))).toMatchObject({
        payment_state: 'UNKNOWN',
        can_edit: false,
        can_continue: false,
      });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 25,
        balance_held_cents: 950,
      });
    },
  );
  it('reconciles a paid webhook arriving before the create response without a DB lock spanning Stripe', async () => {
    const { pledge, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    const entered = deferred<void>();
    const response = deferred<{
      id: string;
      url: string;
      status: 'open';
      payment_status: 'unpaid';
    }>();
    stripe.create.mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    const creating = createCheckoutForPledge(pledge.pledge_token, donor);
    await entered.promise;
    expect(await getPledge(pledge.pledge_token)).toMatchObject({
      checkout_session_id: null,
      checkout_requested_at: expect.any(Date),
    });
    const notification = reconcileCheckoutNotification('checkout.session.completed', {
      id: 'cs_early',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 50,
      customer_email: donor.email,
      metadata: { pledge_token: pledge.pledge_token },
    });
    response.resolve({
      id: 'cs_early',
      url: 'https://checkout.stripe.com/early',
      status: 'open',
      payment_status: 'unpaid',
    });
    await Promise.all([creating, notification]);
    expect(await getPledge(pledge.pledge_token)).toMatchObject({
      status: 'FULFILLED',
      wallet_hold_status: 'CONSUMED',
    });
    expect(stripe.create).toHaveBeenCalledTimes(1);
    expect(await prisma.donation.count({ where: { external_id: 'cs_early' } })).toBe(1);
  });
  it('commits contradictory received cash, its review link and one outbox message together, or rolls all back', async () => {
    const { pledge, donor, input } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockResolvedValue({ id: 'cs_review_outbox', url: null });
    await createCheckoutForPledge(pledge.pledge_token, donor);
    stripe.expire.mockResolvedValue({
      id: 'cs_review_outbox',
      status: 'expired',
      payment_status: 'unpaid',
    });
    await cancelPledge(pledge.pledge_token, donor);
    const other = await createPledge({
      ...input,
      draft_id: crypto.randomUUID(),
      pledge_amount_cents: 950,
      plan: planPledge({ pledge_amount_cents: 950, selections: [], available_wallet_cents: 975 }),
    });
    tokens.push(other.pledge_token);
    await createCheckoutForPledge(other.pledge_token, donor);
    const destination = await prisma.webhookDestination.create({
      data: { url: 'http://127.0.0.1:1', secret: 'test', event_types: '["donation.created"]' },
    });
    destinations.push(destination.id);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_checkout_outbox BEFORE INSERT ON WebhookDelivery
      BEGIN SELECT RAISE(ABORT, 'review outbox failure'); END`);
    const paid = {
      id: 'cs_review_outbox',
      status: 'complete' as const,
      payment_status: 'paid' as const,
      customer_email: donor.email,
      amount_total: 50,
      metadata: { pledge_token: pledge.pledge_token },
    };
    stripe.retrieve.mockResolvedValue(paid);
    await expect(reconcilePledge(pledge.pledge_token)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      total_donated: 0,
    });
    expect(await prisma.donation.count({ where: { external_id: paid.id } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { destination_id: destination.id } })).toBe(
      0,
    );
    expect(await getPledge(pledge.pledge_token)).toMatchObject({
      status: 'CANCELLED',
      fulfilled_by_donation_id: null,
    });
    await prisma.$executeRawUnsafe('DROP TRIGGER reject_checkout_outbox');
    expect(await reconcilePledge(pledge.pledge_token)).toMatchObject({
      payment_state: 'PAYMENT_REVIEW',
    });
    await reconcileCheckoutNotification('checkout.session.async_payment_succeeded', paid);
    const queued = await prisma.webhookDelivery.findMany({
      where: { destination_id: destination.id },
    });
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.payload)).toMatchObject({
      data: { amount_cents: 50, donor_name: 'Original name', donor_comment: 'Original comment' },
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 75,
      balance_held_cents: 0,
      total_donated: 50,
    });
  });
  it('fulfills an already paid Session recovered from a lost create response, even after local expiry', async () => {
    const { pledge, donor, input } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockRejectedValueOnce(new Error('lost response'));
    await expect(createCheckoutForPledge(pledge.pledge_token, donor)).rejects.toThrow();
    await prisma.pendingPledge.update({
      where: { pledge_token: pledge.pledge_token },
      data: { status: 'EXPIRED' },
    });
    const retry = await createPledge({ ...input, plan: { ...input.plan, new_money_cents: 999 } });
    expect(retry).toMatchObject({
      pledge_token: pledge.pledge_token,
      new_money_cents: 50,
      wallet_applied_cents: 950,
    });
    stripe.create.mockResolvedValue({
      id: 'cs_recovered_paid',
      url: null,
      status: 'complete',
      payment_status: 'paid',
      amount_total: 50,
      customer_email: donor.email,
      metadata: { pledge_token: pledge.pledge_token },
    });
    expect(await createCheckoutForPledge(pledge.pledge_token, donor)).toMatchObject({
      donate_url: null,
    });
    expect(pledgeResponse(await getPledge(pledge.pledge_token))).toMatchObject({
      payment_state: 'FULFILLED',
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 0,
      total_donated: 50,
    });
  });
  it('does not overwrite fulfillment when cancellation returns an older expired Session', async () => {
    const { pledge, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockResolvedValue({ id: 'cs_race', url: 'https://checkout.stripe.com/race' });
    await createCheckoutForPledge(pledge.pledge_token, donor);
    const entered = deferred<void>();
    const expired = deferred<{ id: string; status: string; payment_status: string }>();
    stripe.expire.mockImplementation(() => {
      entered.resolve();
      return expired.promise;
    });
    const cancellation = cancelPledge(pledge.pledge_token, donor);
    await entered.promise;
    await Promise.all(
      [1, 2].map(() =>
        reconcileCheckoutNotification('checkout.session.async_payment_succeeded', {
          id: 'cs_race',
          status: 'complete',
          payment_status: 'paid',
          amount_total: 50,
          customer_email: donor.email,
          metadata: { pledge_token: pledge.pledge_token },
        }),
      ),
    );
    expired.resolve({ id: 'cs_race', status: 'expired', payment_status: 'unpaid' });
    expect(await cancellation).toMatchObject({ status: 'FULFILLED', payment_state: 'FULFILLED' });
    expect(await prisma.donation.count({ where: { external_id: 'cs_race' } })).toBe(1);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 0,
      total_donated: 50,
    });
  });

  it('rolls back release or late reacquisition together with the final pledge write', async () => {
    const { pledge, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockResolvedValue({
      id: 'cs_rollback',
      url: 'https://checkout.stripe.com/rollback',
    });
    await createCheckoutForPledge(pledge.pledge_token, donor);
    stripe.expire.mockResolvedValue({
      id: 'cs_rollback',
      status: 'expired',
      payment_status: 'unpaid',
    });
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_checkout_commit BEFORE UPDATE ON PendingPledge
      WHEN NEW.status = 'CANCELLED' BEGIN SELECT RAISE(ABORT, 'release must roll back'); END`);
    await expect(cancelPledge(pledge.pledge_token, donor)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
    });
    await prisma.$executeRawUnsafe('DROP TRIGGER reject_checkout_commit');
    await cancelPledge(pledge.pledge_token, donor);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_checkout_commit BEFORE UPDATE ON PendingPledge
      WHEN NEW.status = 'FULFILLED' BEGIN SELECT RAISE(ABORT, 'fulfillment must roll back'); END`);
    stripe.retrieve.mockResolvedValue({
      id: 'cs_rollback',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 50,
      customer_email: donor.email,
    });
    await expect(reconcilePledge(pledge.pledge_token)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 975,
      balance_held_cents: 0,
      total_donated: 0,
    });
    expect(await prisma.donation.count({ where: { external_id: 'cs_rollback' } })).toBe(0);
    expect(
      await prisma.pendingPledge.findUnique({ where: { pledge_token: pledge.pledge_token } }),
    ).toMatchObject({ wallet_hold_status: 'RELEASED' });
  });

  it('never replays a lost create key beyond 24 hours, but can discover its original Session without creating another', async () => {
    const { pledge, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockRejectedValue(new Error('lost response'));
    await expect(createCheckoutForPledge(pledge.pledge_token, donor)).rejects.toThrow();
    await prisma.pendingPledge.update({
      where: { pledge_token: pledge.pledge_token },
      data: { checkout_requested_at: new Date(Date.now() - 86400001) },
    });
    stripe.list.mockReturnValue((async function* () {})());
    await expect(cancelPledge(pledge.pledge_token, donor)).rejects.toMatchObject({ status: 409 });
    await expect(createCheckoutForPledge(pledge.pledge_token, donor)).rejects.toMatchObject({
      status: 409,
    });
    expect(stripe.create).toHaveBeenCalledTimes(1);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
    });
    stripe.list.mockReturnValue(
      (async function* () {
        yield {
          id: 'cs_discovered',
          status: 'expired',
          payment_status: 'unpaid',
          expires_at: Math.floor(new Date(pledge.expires_at).getTime() / 1000),
          client_reference_id: pledge.pledge_token,
          metadata: { pledge_token: pledge.pledge_token },
        };
      })(),
    );
    stripe.retrieve.mockResolvedValue({
      id: 'cs_discovered',
      status: 'expired',
      payment_status: 'unpaid',
    });
    expect(await reconcilePledge(pledge.pledge_token)).toMatchObject({
      payment_state: 'NON_PAYMENT',
    });
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'open', 'paid', 'unknown', 'processing', 'retryable'] as const)(
    'reconciles verified async failure against current Stripe state (%s)',
    async (current) => {
      const { pledge, donor } = await pending({
        availableWallet: 975,
        pledgeCents: 1000,
        goalCents: 0,
      });
      stripe.create.mockResolvedValue({ id: 'cs_async', url: 'https://checkout.stripe.com/async' });
      await createCheckoutForPledge(pledge.pledge_token, donor);
      const notification = {
        id: 'cs_async',
        status: 'complete' as const,
        payment_status: 'unpaid' as const,
        metadata: { pledge_token: pledge.pledge_token },
        customer_email: donor.email,
        amount_total: 50,
      };
      if (current === 'unknown') stripe.retrieve.mockRejectedValue(new Error('network'));
      else
        stripe.retrieve.mockResolvedValue({
          ...notification,
          status: current === 'open' ? 'open' : 'complete',
          payment_status: current === 'paid' ? 'paid' : 'unpaid',
          ...(current === 'processing' || current === 'retryable'
            ? {
                payment_intent: {
                  id: 'pi_in_progress',
                  status: current === 'processing' ? 'processing' : 'requires_payment_method',
                },
              }
            : {}),
        });
      if (current === 'unknown') {
        await expect(
          reconcileCheckoutNotification('checkout.session.async_payment_failed', notification),
        ).rejects.toMatchObject({ status: 409 });
      } else {
        expect(
          await reconcileCheckoutNotification(
            'checkout.session.async_payment_failed',
            notification,
          ),
        ).toMatchObject({
          payment_state:
            current === 'failed'
              ? 'NON_PAYMENT'
              : current === 'paid'
                ? 'FULFILLED'
                : current === 'open'
                  ? 'OPEN'
                  : 'PROCESSING',
        });
      }
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: current === 'failed' ? 975 : 25,
        balance_held_cents: current === 'failed' || current === 'paid' ? 0 : 950,
      });
    },
  );

  it('hands an existing legacy async failure to #188 without inventing a chargeback', async () => {
    const { donor, channel } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    const old = await prisma.pendingPledge.create({
      data: {
        pledge_token: crypto.randomUUID(),
        status: 'EXPIRED',
        expires_at: new Date(0),
        channel_id: channel.id,
        checkout_session_id: 'cs_legacy_failure',
      },
    });
    tokens.push(old.pledge_token);
    await reconcileCheckoutNotification('checkout.session.completed', {
      id: 'cs_legacy_failure',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 1000,
      customer_email: donor.email,
      metadata: { pledge_token: old.pledge_token },
    });
    const donation = await prisma.donation.findUniqueOrThrow({
      where: { external_id: 'cs_legacy_failure' },
    });
    expect(
      await reconcileCheckoutNotification('checkout.session.async_payment_failed', {
        id: 'cs_legacy_failure',
        status: 'complete',
        payment_status: 'unpaid',
        metadata: { pledge_token: old.pledge_token },
      }),
    ).toMatchObject({
      legacy_async_failure: { donation_id: donation.id, checkout_session_id: 'cs_legacy_failure' },
    });
    expect(await prisma.donation.findUnique({ where: { id: donation.id } })).toMatchObject({
      status: 'COMPLETED',
      amount_cents: 1000,
    });
    expect(await prisma.pendingPledge.findUnique({ where: { id: old.id } })).toMatchObject({
      payment_status: 'failed',
    });
  });
  it('rejects copied token metadata from a different Session and never falls through an unknown token to email', async () => {
    const { pledge, donor, channel } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockResolvedValue({ id: 'cs_bound', url: 'https://checkout.stripe.com/bound' });
    await createCheckoutForPledge(pledge.pledge_token, donor);
    await expect(
      reconcileCheckoutNotification('checkout.session.completed', {
        id: 'cs_copied',
        status: 'complete',
        payment_status: 'paid',
        amount_total: 50,
        customer_email: donor.email,
        metadata: { pledge_token: pledge.pledge_token },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      intakeDonation({
        source: 'stripe',
        pledgeToken: pledge.pledge_token,
        externalId: 'cs_copied',
        email: donor.email,
        donorName: 'Copied',
        amountCents: 50,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const legacy = await prisma.pendingPledge.create({
      data: {
        pledge_token: crypto.randomUUID(),
        donor_email: donor.email,
        total_cents: 50,
        expires_at: new Date(Date.now() + 7200000),
        channel_id: channel.id,
      },
    });
    tokens.push(legacy.pledge_token);
    const result = await intakeDonation({
      source: 'stripe',
      pledgeToken: 'unknown-token',
      externalId: 'cs_unknown',
      email: donor.email,
      amountCents: 50,
      donorName: 'Paid name',
    });
    expect(result).not.toHaveProperty('duplicate');
    await intakeDonation({
      source: 'stripe',
      pledgeToken: '',
      externalId: 'cs_empty_token',
      email: donor.email,
      amountCents: 50,
      donorName: 'Paid name',
    });
    expect(await prisma.pendingPledge.findUnique({ where: { id: legacy.id } })).toMatchObject({
      status: 'OPEN',
      fulfilled_by_donation_id: null,
    });
    expect(
      await prisma.pendingPledge.findUnique({ where: { pledge_token: pledge.pledge_token } }),
    ).toMatchObject({ wallet_hold_status: 'HELD' });
  });

  it.each([true, false])(
    'records an old-shape late exact-token payment without D or allocations (bound Session: %s)',
    async (bound) => {
      const { donor, channel } = await pending({
        availableWallet: 975,
        pledgeCents: 1000,
        goalCents: 0,
      });
      const goal = await prisma.fundGoal.create({
        data: { title: 'Old incentive', target_cents: 10000 },
      });
      goals.push(goal.id);
      const old = await prisma.pendingPledge.create({
        data: {
          pledge_token: crypto.randomUUID(),
          status: 'EXPIRED',
          expires_at: new Date(0),
          donor_email: donor.email,
          total_cents: 1000,
          channel_id: channel.id,
          comment: 'Old comment',
          display_name: 'Old name',
          checkout_session_id: bound ? 'cs_old' : null,
          items: { create: [{ kind: 'GOAL', target_id: goal.id, amount_cents: 1000 }] },
        },
      });
      tokens.push(old.pledge_token);
      const facts = {
        id: 'cs_old',
        status: 'complete' as const,
        payment_status: 'paid' as const,
        amount_total: 1200,
        total_details: { amount_shipping: 200, amount_discount: 0, amount_tax: 0 },
        customer_email: donor.email,
        metadata: { pledge_token: old.pledge_token },
      };
      expect(
        await reconcileCheckoutNotification('checkout.session.async_payment_succeeded', facts),
      ).toMatchObject({ status: 'EXPIRED', payment_state: 'LEGACY_PAID' });
      expect(
        await reconcileCheckoutNotification('checkout.session.completed', facts),
      ).toMatchObject({ status: 'EXPIRED', payment_state: 'LEGACY_PAID' });
      expect(await reconcilePledge(old.pledge_token)).toMatchObject({
        status: 'EXPIRED',
        payment_state: 'LEGACY_PAID',
        can_edit: false,
        can_continue: false,
        read_only: true,
      });
      const donation = await prisma.donation.findUniqueOrThrow({
        where: { external_id: 'cs_old' },
      });
      expect(donation).toMatchObject({
        amount_cents: 1000,
        pledge_amount_cents: null,
        wallet_applied_cents: 0,
        shipping_cents: 200,
        comment: 'Old comment',
        donor_name: 'Old name',
        channel_id: channel.id,
      });
      expect(await getPledge(old.pledge_token)).toMatchObject({
        status: 'EXPIRED',
        fulfilled_by_donation_id: donation.id,
        checkout_session_id: facts.id,
        payment_status: 'paid',
      });
      expect(await prisma.donation.count({ where: { external_id: facts.id } })).toBe(1);
      expect(await prisma.fundContribution.count({ where: { donation_id: donation.id } })).toBe(0);
      expect(await prisma.pollVote.count({ where: { donation_id: donation.id } })).toBe(0);
      expect(await prisma.rewardClaim.count({ where: { donation_id: donation.id } })).toBe(0);
      await expect(
        intakeDonation({
          source: 'stripe',
          externalId: 'cs_different_old',
          pledgeToken: old.pledge_token,
          email: donor.email,
          donorName: 'Copied',
          amountCents: 1000,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        reconcileCheckoutNotification('checkout.session.completed', {
          ...facts,
          id: 'cs_different_old',
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 1025,
        balance_held_cents: 950,
        total_donated: 1000,
      });
    },
  );
  it('preserves original legacy fulfillment and its allocation history after the deadline', async () => {
    const { donor, channel } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    const goal = await prisma.fundGoal.create({
      data: { title: 'Originally fulfilled incentive', target_cents: 10000 },
    });
    goals.push(goal.id);
    const old = await prisma.pendingPledge.create({
      data: {
        pledge_token: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 7200000),
        total_cents: 1000,
        channel_id: channel.id,
        checkout_session_id: 'cs_historical',
        items: { create: [{ kind: 'GOAL', target_id: goal.id, amount_cents: 1000 }] },
      },
    });
    tokens.push(old.pledge_token);
    const facts = {
      id: 'cs_historical',
      status: 'complete' as const,
      payment_status: 'paid' as const,
      amount_total: 1000,
      customer_email: donor.email,
      metadata: { pledge_token: old.pledge_token },
    };
    await reconcileCheckoutNotification('checkout.session.completed', facts);
    await prisma.pendingPledge.update({ where: { id: old.id }, data: { expires_at: new Date(0) } });
    const history = await getPledge(old.pledge_token);
    expect(history).toMatchObject({ status: 'FULFILLED' });
    expect(await reconcilePledge(old.pledge_token)).toMatchObject({
      format: 'LEGACY',
      status: 'FULFILLED',
      payment_state: 'FULFILLED',
    });
    await reconcileCheckoutNotification('checkout.session.completed', facts);
    expect(await getPledge(old.pledge_token)).toEqual(history);
    expect(await prisma.donation.count({ where: { external_id: facts.id } })).toBe(1);
    expect(
      await prisma.fundContribution.findMany({
        where: { donation_id: history.fulfilled_by_donation_id! },
      }),
    ).toMatchObject([{ goal_id: goal.id, amount_cents: 1000 }]);
  });

  it('keeps a previously stored dev LEGACY_PAID receipt readable and idempotent', async () => {
    const { donor, channel } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    const receipt = await prisma.donation.create({
      data: { external_id: 'cs_dev_legacy', donor_id: donor.id, amount_cents: 1000 },
    });
    const old = await prisma.pendingPledge.create({
      data: {
        pledge_token: crypto.randomUUID(),
        status: 'LEGACY_PAID',
        expires_at: new Date(0),
        channel_id: channel.id,
        checkout_session_id: receipt.external_id,
        fulfilled_by_donation_id: receipt.id,
        payment_status: 'paid',
      },
    });
    tokens.push(old.pledge_token);
    expect(await reconcilePledge(old.pledge_token)).toMatchObject({
      status: 'LEGACY_PAID',
      payment_state: 'LEGACY_PAID',
      read_only: true,
    });
    const facts = {
      source: 'stripe' as const,
      externalId: receipt.external_id,
      pledgeToken: old.pledge_token,
      email: donor.email,
      donorName: 'Old name',
      amountCents: 1000,
    };
    expect(await intakeDonation(facts)).toEqual({ duplicate: true });
    await expect(intakeDonation({ ...facts, externalId: 'cs_dev_copied' })).rejects.toMatchObject({
      status: 409,
    });
    expect(await getPledge(old.pledge_token)).toMatchObject({ status: 'LEGACY_PAID' });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
      total_donated: 0,
    });
  });

  it.each(['held', 'released-available', 'released-spent'] as const)(
    'handles a literal D1000/W950/cash50 late payment safely (%s)',
    async (funding) => {
      const goal = await prisma.fundGoal.create({
        data: { title: 'Original incentive', target_cents: 10000 },
      });
      goals.push(goal.id);
      const { pledge, donor, input } = await pending({
        availableWallet: 975,
        pledgeCents: 1000,
        goalCents: 100,
        goalId: goal.id,
      });
      stripe.create.mockResolvedValue({ id: 'cs_late', url: 'https://checkout.stripe.com/late' });
      await createCheckoutForPledge(pledge.pledge_token, donor);
      if (funding === 'held') {
        await prisma.pendingPledge.update({
          where: { pledge_token: pledge.pledge_token },
          data: { status: 'EXPIRED' },
        });
      } else {
        stripe.expire.mockResolvedValue({
          id: 'cs_late',
          status: 'expired',
          payment_status: 'unpaid',
        });
        await cancelPledge(pledge.pledge_token, donor);
        if (funding === 'released-spent') {
          const other = await createPledge({
            ...input,
            draft_id: crypto.randomUUID(),
            items: [],
            pledge_amount_cents: 950,
            plan: planPledge({
              pledge_amount_cents: 950,
              selections: [],
              available_wallet_cents: 975,
            }),
          });
          tokens.push(other.pledge_token);
          await createCheckoutForPledge(other.pledge_token, donor);
        }
      }
      stripe.retrieve.mockResolvedValue({
        id: 'cs_late',
        status: 'complete',
        payment_status: 'paid',
        amount_total: 250,
        total_details: { amount_shipping: 200 },
        customer_details: { email: 'replacement@example.com' },
      });
      const expected = funding === 'released-spent' ? 'PAYMENT_REVIEW' : 'FULFILLED';
      expect(await reconcilePledge(pledge.pledge_token)).toMatchObject({
        payment_state: expected,
        admin_review_required: funding === 'released-spent',
      });
      expect(await reconcilePledge(pledge.pledge_token)).toMatchObject({ payment_state: expected });
      const donation = await prisma.donation.findUniqueOrThrow({
        where: { external_id: 'cs_late' },
      });
      expect(donation).toMatchObject({
        donor_id: donor.id,
        amount_cents: 50,
        shipping_cents: 200,
        pledge_amount_cents: funding === 'released-spent' ? null : 1000,
        wallet_applied_cents: funding === 'released-spent' ? 0 : 950,
        comment: 'Original comment',
        donor_name: 'Original name',
        channel_id: input.channel_id,
      });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: funding === 'released-spent' ? 75 : 25,
        balance_held_cents: 0,
        total_donated: 50,
      });
      expect(
        await prisma.fundContribution.aggregate({
          where: { donation_id: donation.id },
          _sum: { amount_cents: true },
        }),
      ).toMatchObject({
        _sum: { amount_cents: funding === 'released-spent' ? null : 1000 },
      });
      expect(
        await prisma.pendingPledge.findUnique({ where: { pledge_token: pledge.pledge_token } }),
      ).toMatchObject({
        fulfilled_by_donation_id: donation.id,
        wallet_hold_status: funding === 'released-spent' ? 'RELEASED' : 'CONSUMED',
      });
    },
  );
  it('keeps complete/unpaid funding held, then fulfills paid money and consumes the hold only once', async () => {
    const { pledge, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create.mockResolvedValue({
      id: 'cs_processing',
      url: 'https://checkout.stripe.com/processing',
    });
    await createCheckoutForPledge(pledge.pledge_token, donor);
    stripe.expire.mockRejectedValue(new Error('not expireable'));
    stripe.retrieve.mockResolvedValue({
      id: 'cs_processing',
      status: 'complete',
      payment_status: 'unpaid',
    });
    expect(await cancelPledge(pledge.pledge_token, donor)).toMatchObject({
      payment_state: 'PROCESSING',
      can_edit: false,
      can_continue: false,
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
    });
    stripe.retrieve.mockResolvedValue({
      id: 'cs_processing',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 250,
      total_details: { amount_shipping: 200 },
      customer_details: { email: donor.email, name: 'Stripe name' },
      metadata: { pledge_token: pledge.pledge_token },
      payment_intent: 'pi_one',
    });
    const results = await Promise.all([
      reconcilePledge(pledge.pledge_token),
      reconcilePledge(pledge.pledge_token),
    ]);
    expect(results).toMatchObject([{ payment_state: 'FULFILLED' }, { payment_state: 'FULFILLED' }]);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 0,
      total_donated: 50,
    });
    expect(await prisma.donation.findMany({ where: { donor_id: donor.id } })).toMatchObject([
      {
        amount_cents: 50,
        pledge_amount_cents: 1000,
        wallet_applied_cents: 950,
        shipping_cents: 200,
        payment_intent: 'pi_one',
        donor_name: 'Original name',
        comment: 'Original comment',
      },
    ]);
  });
  it('recovers a lost create response before cancelling, releases only after exact Session expiration, once', async () => {
    const { pledge, donor } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    stripe.create
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue({ id: 'cs_lost', url: 'https://checkout.stripe.com/lost' });
    await expect(createCheckoutForPledge(pledge.pledge_token, donor)).rejects.toThrow(
      'lost response',
    );
    stripe.expire.mockRejectedValueOnce(new Error('timeout'));
    stripe.retrieve.mockRejectedValueOnce(new Error('unknown'));
    await expect(cancelPledge(pledge.pledge_token, donor)).rejects.toMatchObject({ status: 409 });
    expect(pledgeResponse(await getPledge(pledge.pledge_token))).toMatchObject({
      payment_state: 'UNKNOWN',
      can_continue: false,
      can_edit: false,
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
    });
    stripe.expire.mockResolvedValue({ id: 'cs_lost', status: 'expired', payment_status: 'unpaid' });
    expect(await cancelPledge(pledge.pledge_token, donor)).toMatchObject({
      payment_state: 'NON_PAYMENT',
      can_edit: true,
      status: 'CANCELLED',
    });
    expect(await cancelPledge(pledge.pledge_token, donor)).toMatchObject({
      payment_state: 'NON_PAYMENT',
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 975,
      balance_held_cents: 0,
    });
    expect(stripe.create).toHaveBeenCalledTimes(2);
    expect(stripe.create.mock.calls[1]).toEqual(stripe.create.mock.calls[0]);
    stripe.retrieve.mockResolvedValue({
      id: 'cs_lost',
      status: 'expired',
      payment_status: 'unpaid',
    });
    expect(await reconcilePledge(pledge.pledge_token)).toMatchObject({
      payment_state: 'NON_PAYMENT',
    });
  });
  it('serializes double checkout and reuses one payable Session with immutable funding and protocol', async () => {
    const { pledge, donor, input } = await pending({
      availableWallet: 975,
      pledgeCents: 1000,
      goalCents: 0,
    });
    const entered = deferred<void>();
    const response = deferred<{
      id: string;
      url: string;
      status: 'open';
      payment_status: 'unpaid';
    }>();
    stripe.create.mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    const first = createCheckoutForPledge(pledge.pledge_token, donor);
    await entered.promise;
    const retry = await createPledge({ ...input, plan: { ...input.plan, new_money_cents: 900 } });
    const second = createCheckoutForPledge(retry.pledge_token, donor);
    await getPledge(pledge.pledge_token); // Database checkpoint while the external create is still blocked.
    response.resolve({
      id: 'cs_one',
      url: 'https://checkout.stripe.com/one',
      status: 'open',
      payment_status: 'unpaid',
    });
    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ donate_url: 'https://checkout.stripe.com/one' });
    expect(stripe.create).toHaveBeenCalledTimes(1);
    expect(stripe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expires_at: Math.floor(new Date(pledge.expires_at).getTime() / 1000),
        client_reference_id: pledge.pledge_token,
        after_expiration: { recovery: { enabled: false } },
        cancel_url: expect.stringContaining(`/pledge/${pledge.pledge_token}?cancelled=1`),
        line_items: [
          expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 50 }) }),
        ],
      }),
      { idempotencyKey: pledge.pledge_token },
    );
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 25,
      balance_held_cents: 950,
    });
  });
});
