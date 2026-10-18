import crypto from 'node:crypto';
import express from 'express';
import requestHttp from 'supertest';
import type { CreditApplyRequest } from '@dono/shared';
import donorRouter from '../../routes/donor.js';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
import {
  applyPoolCreditTx,
  readPoolCreditEventTx,
  readPoolCreditSummaryTx,
} from '../../services/poolCredit.js';
import {
  reverseSpendTx,
  setClaimStatusTx,
  setDonationStatusTx,
  previewDonationReversalTx,
} from '../../services/reversal.js';
import { readDonationAccountingTx } from '../../services/poolAccounting.js';

vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
const donors: string[] = [],
  events: string[] = [],
  rewards: string[] = [],
  polls: string[] = [],
  goals: string[] = [],
  destinations: string[] = [];
async function extraCredits(
  f: Awaited<ReturnType<typeof fixture>>,
  { goalTarget }: Readonly<{ goalTarget: number }>,
) {
  const foreign = await prisma.channel.create({
    data: { event_id: f.event.id, name: crypto.randomUUID(), slug: crypto.randomUUID() },
  });
  const poll = await prisma.poll.create({
    data: {
      event_id: foreign.event_id,
      title: 'Foreign poll',
      channel_id: foreign.id,
      options: { create: { label: 'Yes' } },
    },
    include: { options: true },
  });
  polls.push(poll.id);
  const goal = await prisma.fundGoal.create({
    data: {
      event_id: foreign.event_id,
      title: 'Foreign goal',
      channel_id: foreign.id,
      target_cents: goalTarget,
    },
  });
  goals.push(goal.id);
  for (const { donation } of f.sources) {
    const vote = await prisma.pollVote.create({
      data: {
        donor_id: f.donor.id,
        donation_id: donation.id,
        poll_id: poll.id,
        poll_option_id: poll.options[0]!.id,
        amount_cents: donation.amount_cents,
        reversed_at: new Date(),
      },
    });
    const contribution = await prisma.fundContribution.create({
      data: {
        donor_id: f.donor.id,
        donation_id: donation.id,
        goal_id: goal.id,
        amount_cents: donation.amount_cents,
        reversed_at: new Date(),
      },
    });
    await prisma.poolCredit.create({
      data: {
        donation_id: donation.id,
        category: 'poll',
        amount_cents: donation.amount_cents,
        remaining_cents: donation.amount_cents,
        source_vote_id: vote.id,
        created_by: 'admin',
      },
    });
    await prisma.poolCredit.create({
      data: {
        donation_id: donation.id,
        category: 'goal',
        amount_cents: donation.amount_cents,
        remaining_cents: donation.amount_cents,
        source_contribution_id: contribution.id,
        created_by: 'admin',
      },
    });
  }
  return { poll, goal, foreign };
}
async function fixture({
  sourceGrants,
  rewardPrice,
  stock,
  availableWallet,
  reviewedRewardCents,
}: Readonly<{
  sourceGrants: readonly number[];
  rewardPrice: number;
  stock: number;
  availableWallet: number;
  reviewedRewardCents: number;
}>) {
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: availableWallet },
  });
  donors.push(donor.id);
  const event = await prisma.event.create({ data: { name: 'Credits', slug: crypto.randomUUID() } });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: crypto.randomUUID(), slug: crypto.randomUUID(), event_id: event.id },
  });
  const reward = await prisma.reward.create({
    data: {
      event_id: event.id,
      title: 'One entitlement',
      type: 'DIGITAL',
      cost_cents: rewardPrice,
      quantity_total: stock,
    },
  });
  rewards.push(reward.id);
  const sources = [];
  for (const [index, cents] of sourceGrants.entries()) {
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: crypto.randomUUID(),
        amount_cents: cents,
        pledge_amount_cents: cents,
        event_id: event.id,
        channel_id: channel.id,
        created_at: new Date(1000 + index),
      },
    });
    const origin = await prisma.rewardClaim.create({
      data: {
        reward_id: reward.id,
        donor_id: donor.id,
        donation_id: donation.id,
        amount_cents: cents,
        status: 'REVERSED',
        reversed_at: new Date(),
      },
    });
    const grant = await prisma.poolCredit.create({
      data: {
        donation_id: donation.id,
        category: 'reward',
        amount_cents: cents,
        remaining_cents: cents,
        source_claim_id: origin.id,
        created_by: 'admin',
      },
    });
    sources.push({ donation, grant });
  }
  const request = {
    idempotency_key: crypto.randomUUID(),
    reviewed_credit_cents: { reward: reviewedRewardCents, poll: 0, goal: 0 },
    selections: [
      {
        kind: 'REWARD' as const,
        target_id: reward.id,
        quantity: 1,
        unit_price_cents: rewardPrice,
        reward_type: 'DIGITAL',
      },
    ],
  };
  const apply = () =>
    withWebhooks((tx, _emit, publisher) =>
      applyPoolCreditTx(tx, donor.id, event.id, request, publisher),
    );
  const read = () => prisma.$transaction((tx) => readPoolCreditEventTx(tx, donor.id, event.id));
  return { donor, event, channel, reward, sources, request, apply, read };
}
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_credit');
  await prisma.poolCreditRedemption.deleteMany({ where: { batch: { donor_id: { in: donors } } } });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.updateMany({
    where: { donor_id: { in: donors } },
    data: { refund_id: null },
  });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  donors.length =
    events.length =
    rewards.length =
    polls.length =
    goals.length =
    destinations.length =
      0;
});
afterAll(() => prisma.$disconnect());
async function subscribers() {
  const native = await prisma.webhookDestination.create({
    data: { url: 'http://127.0.0.1:1', secret: 'secret', event_types: '["donation.updated"]' },
  });
  const tiltify = await prisma.webhookDestination.create({
    data: { url: '', secret: '', payload_format: 'TILTIFY', destination_type: 'RABBITMQ' },
  });
  destinations.push(native.id, tiltify.id);
  const read = async (id: string) =>
    (
      await prisma.webhookDelivery.findMany({
        where: { destination_id: id },
        orderBy: { seq: 'asc' },
      })
    ).map((row) => JSON.parse(row.payload));
  return { native, tiltify, read };
}
it('HTTP reads/writes are owner-scoped, safe and preserve one whole donor entitlement', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const token = crypto.randomUUID();
  await prisma.donor.update({
    where: { id: f.donor.id },
    data: { magic_token: token, token_expires_at: new Date(Date.now() + 60000) },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/donor', donorRouter);
  expect((await requestHttp(app).get('/api/donor/pool-credits')).status).toBe(401);
  const auth = { Authorization: `Bearer ${token}` };
  const summary = await requestHttp(app).get('/api/donor/pool-credits').set(auth);
  expect(summary.body).toMatchObject({
    wallet_credit_cents: 123,
    events: [{ available_cents: { reward: 1000, poll: 0, goal: 0 } }],
  });
  const catalog = await requestHttp(app).get(`/api/donor/pool-credits/${f.event.id}`).set(auth);
  expect(catalog.body.history).toHaveLength(2);
  expect(JSON.stringify(catalog.body)).not.toContain(f.donor.email);
  expect(JSON.stringify(catalog.body)).not.toContain('created_by');
  const applied = await requestHttp(app)
    .post(`/api/donor/pool-credits/${f.event.id}/apply`)
    .set(auth)
    .send(f.request);
  expect(applied.status).toBe(200);
  const owner = await requestHttp(app).get('/api/donor').set(auth);
  expect(
    owner.body.reward_claims.filter((row: { status: string }) => row.status === 'PENDING'),
  ).toMatchObject([{ id: applied.body.claim_ids[0], amount_cents: 1000, donation_id: null }]);
  const other = await prisma.donor.create({
    data: {
      email: `${crypto.randomUUID()}@example.com`,
      magic_token: crypto.randomUUID(),
      token_expires_at: new Date(Date.now() + 60000),
    },
  });
  donors.push(other.id);
  const none = await requestHttp(app)
    .get(`/api/donor/pool-credits/${f.event.id}`)
    .set('Authorization', `Bearer ${other.magic_token}`);
  expect(none.body).toMatchObject({
    history: [],
    available_cents: { reward: 0, poll: 0, goal: 0 },
  });
  expect(
    (
      await requestHttp(app)
        .post(`/api/donor/pool-credits/${f.event.id}/apply`)
        .set('Authorization', `Bearer ${other.magic_token}`)
        .send(f.request)
    ).status,
  ).toBe(409);
});
it('native publishes both source shares; Tiltify lists ONE whole entitlement on stable oldest carrier and republishes all status/reversal sources', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const messages = await subscribers();
  const result = await f.apply();
  const native = await messages.read(messages.native.id);
  expect(native).toMatchObject([
    {
      data: {
        donation_id: f.sources[0]!.donation.id,
        amount_cents: 600,
        allocations: { reward: [{ id: result.claim_ids[0], amount_cents: 600 }] },
      },
    },
    {
      data: {
        donation_id: f.sources[1]!.donation.id,
        amount_cents: 400,
        allocations: { reward: [{ id: result.claim_ids[0], amount_cents: 400 }] },
      },
    },
  ]);
  expect(JSON.stringify(native)).not.toContain(f.donor.email);
  expect(JSON.stringify(native)).not.toContain('created_by');
  const tiltify = await messages.read(messages.tiltify.id);
  expect(tiltify).toHaveLength(1);
  expect(tiltify[0]).toMatchObject({
    id: f.sources[0]!.donation.id,
    campaign_id: f.channel.id,
    reward_id: f.reward.id,
    reward_claims: [{ id: result.claim_ids[0], reward_id: f.reward.id, quantity: 1 }],
  });
  await withWebhooks((tx, _emit, publisher) =>
    setClaimStatusTx(tx, result.claim_ids[0]!, 'FULFILLED', publisher),
  );
  expect(await messages.read(messages.native.id)).toHaveLength(4);
  expect(await messages.read(messages.tiltify.id)).toHaveLength(1); // private status is not in Tiltify content
  await withWebhooks((tx, _emit, publisher) =>
    setClaimStatusTx(tx, result.claim_ids[0]!, 'PENDING', publisher),
  );
  await withWebhooks((tx, _emit, publisher) =>
    setDonationStatusTx(tx, f.sources[0]!.donation.id, 'REFUNDED', undefined, 'admin', publisher),
  );
  const last = (await messages.read(messages.native.id)).slice(-2);
  expect(last).toMatchObject([
    {
      data: {
        donation_id: f.sources[0]!.donation.id,
        status: 'REFUNDED',
        allocations: { reward: [] },
      },
    },
    { data: { donation_id: f.sources[1]!.donation.id, allocations: { reward: [] } } },
  ]);
  expect((await messages.read(messages.tiltify.id)).flatMap((d) => d.reward_claims)).toHaveLength(
    1,
  );
});
it.each([
  'price',
  'physical',
  'stock',
  'closed',
  'ended',
  'otherEvent',
  'category',
  'staleCredit',
  'fractional',
  'REQUESTED',
])('invalid reviewed batch (%s) applies NONE of its otherwise valid selections', async (change) => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const { poll, goal } = await extraCredits(f, { goalTarget: 1 });
  const reviewed: CreditApplyRequest = {
    ...f.request,
    reviewed_credit_cents: { reward: 1000, poll: 1000, goal: 1000 },
    selections: [{ kind: 'GOAL', target_id: goal.id, amount_cents: 100 }, ...f.request.selections],
  };
  if (change === 'price')
    await prisma.reward.update({ where: { id: f.reward.id }, data: { cost_cents: 1001 } });
  if (change === 'physical')
    await prisma.reward.update({ where: { id: f.reward.id }, data: { type: 'PHYSICAL' } });
  if (change === 'stock')
    await prisma.reward.update({ where: { id: f.reward.id }, data: { quantity_claimed: 3 } });
  if (change === 'closed')
    await prisma.reward.update({ where: { id: f.reward.id }, data: { is_active: false } });
  if (change === 'ended')
    await prisma.event.update({ where: { id: f.event.id }, data: { ended_at: new Date() } });
  if (change === 'otherEvent') {
    const foreignEvent = await prisma.event.create({
      data: { name: 'Other Event', slug: crypto.randomUUID() },
    });
    events.push(foreignEvent.id);
    const foreign = await prisma.channel.create({
      data: { name: crypto.randomUUID(), slug: crypto.randomUUID(), event_id: foreignEvent.id },
    });
    await prisma.reward.update({
      where: { id: f.reward.id },
      data: { event_id: foreignEvent.id, channel_id: foreign.id },
    });
  }
  if (change === 'category')
    reviewed.selections.push({
      kind: 'POLL_VOTE',
      target_id: poll.options[0]!.id,
      poll_id: poll.id,
      amount_cents: 1001,
    });
  if (change === 'fractional')
    reviewed.selections.push({
      kind: 'POLL_VOTE',
      target_id: poll.options[0]!.id,
      poll_id: poll.id,
      amount_cents: 0.5,
    });
  if (change === 'staleCredit')
    await prisma.poolCredit.update({
      where: { id: f.sources[0]!.grant.id },
      data: { remaining_cents: 599 },
    });
  if (change === 'REQUESTED')
    await prisma.paymentRefund.create({
      data: {
        donation_id: f.sources[0]!.donation.id,
        claim_id: f.sources[0]!.grant.source_claim_id!,
        item_cents: 600,
        created_by: 'admin',
      },
    });
  const before = await f.read();
  await expect(
    withWebhooks((tx, _emit, publisher) =>
      applyPoolCreditTx(tx, f.donor.id, f.event.id, reviewed, publisher),
    ),
  ).rejects.toMatchObject({ status: change === 'fractional' ? 400 : 409 });
  expect(await f.read()).toEqual(before);
  expect(await prisma.poolCreditBatch.count({ where: { donor_id: f.donor.id } })).toBe(0);
  expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
    current_cents: 0,
  });
});
it.each(['PoolCreditRedemption', 'WebhookDelivery'])(
  'late %s failure rolls back credit, entitlement, stock, tallies, batch and outbox',
  async (table) => {
    const f = await fixture({
      sourceGrants: [600, 400],
      rewardPrice: 1000,
      stock: 3,
      availableWallet: 123,
      reviewedRewardCents: 1000,
    });
    const { goal } = await extraCredits(f, { goalTarget: 1 });
    const messages = await subscribers();
    const reviewed: CreditApplyRequest = {
      ...f.request,
      reviewed_credit_cents: { reward: 1000, poll: 1000, goal: 1000 },
      selections: [
        { kind: 'GOAL', target_id: goal.id, amount_cents: 601 },
        ...f.request.selections,
      ],
    };
    const before = await f.read();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER fail_credit BEFORE INSERT ON ${table} ${table === 'PoolCreditRedemption' ? 'WHEN NEW.claim_id IS NOT NULL' : ''} BEGIN SELECT RAISE(ABORT, 'late credit failure'); END`,
    );
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        applyPoolCreditTx(tx, f.donor.id, f.event.id, reviewed, publisher),
      ),
    ).rejects.toThrow();
    expect(await f.read()).toEqual(before);
    expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
      quantity_claimed: 0,
    });
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      current_cents: 0,
      is_complete: false,
    });
    expect(await prisma.poolCreditBatch.count({ where: { donor_id: f.donor.id } })).toBe(0);
    expect(await messages.read(messages.native.id)).toEqual([]);
    expect(await messages.read(messages.tiltify.id)).toEqual([]);
  },
);
it('concurrent shared-entitlement reversals restore original funding and stock exactly once', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const applied = await f.apply();
  const reverse = () =>
    withWebhooks((tx, _emit, publisher) =>
      reverseSpendTx(tx, f.donor.id, 'claim', applied.claim_ids[0]!, 'admin', publisher),
    );
  const results = await Promise.allSettled([reverse(), reverse()]);
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(await f.read()).toMatchObject({ available_cents: { reward: 1000 } });
  expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
    quantity_claimed: 0,
  });
});
it('several whole units keep one claim per unit, split financial components and restore stock once per entitlement', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  await prisma.reward.update({ where: { id: f.reward.id }, data: { cost_cents: 350 } });
  f.request.selections[0]!.unit_price_cents = 350;
  f.request.selections[0]!.quantity = 2;
  const applied = await f.apply();
  expect(applied.claim_ids).toHaveLength(2);
  expect(await f.read()).toMatchObject({ available_cents: { reward: 300 } });
  await withWebhooks(async (tx, _emit, publisher) => {
    for (const id of applied.claim_ids)
      await reverseSpendTx(tx, f.donor.id, 'claim', id, 'admin', publisher);
  });
  expect(await f.read()).toMatchObject({ available_cents: { reward: 1000 } });
  expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
    quantity_claimed: 0,
  });
});
it('an inconsistent second source budget rolls back the already reduced first source', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  await prisma.donation.update({
    where: { id: f.sources[1]!.donation.id },
    data: { pledge_amount_cents: 100 },
  });
  const before = await f.read();
  await expect(f.apply()).rejects.toMatchObject({ status: 409 });
  expect(await f.read()).toEqual(before);
  expect(await prisma.poolCreditBatch.count({ where: { donor_id: f.donor.id } })).toBe(0);
});
it('competing different batches cannot consume reviewed funds twice', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const other = { ...f.request, idempotency_key: crypto.randomUUID() };
  const results = await Promise.allSettled([
    f.apply(),
    withWebhooks((tx, _emit, publisher) =>
      applyPoolCreditTx(tx, f.donor.id, f.event.id, other, publisher),
    ),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
    quantity_claimed: 1,
  });
});
it('partial reward draw uses oldest donation then oldest grant and leaves a positive unaffordable remainder', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  await prisma.rewardClaim.update({
    where: { id: f.sources[0]!.grant.source_claim_id! },
    data: { amount_cents: 400 },
  });
  await prisma.poolCredit.update({
    where: { id: f.sources[0]!.grant.id },
    data: { amount_cents: 400, remaining_cents: 400, created_at: new Date(5000) },
  });
  const origin = await prisma.rewardClaim.create({
    data: {
      reward_id: f.reward.id,
      donor_id: f.donor.id,
      donation_id: f.sources[0]!.donation.id,
      amount_cents: 200,
      status: 'REVERSED',
      reversed_at: new Date(),
    },
  });
  const older = await prisma.poolCredit.create({
    data: {
      donation_id: f.sources[0]!.donation.id,
      category: 'reward',
      amount_cents: 200,
      remaining_cents: 200,
      source_claim_id: origin.id,
      created_at: new Date(3000),
      created_by: 'admin',
    },
  });
  await prisma.reward.update({ where: { id: f.reward.id }, data: { cost_cents: 350 } });
  f.request.selections[0]!.unit_price_cents = 350;
  await f.apply();
  const state = await f.read();
  expect(state.history.find((row) => row.id === older.id)).toMatchObject({ remaining_cents: 0 });
  expect(state.history.find((row) => row.id === f.sources[0]!.grant.id)).toMatchObject({
    remaining_cents: 250,
  });
  expect(state.history.find((row) => row.id === f.sources[1]!.grant.id)).toMatchObject({
    remaining_cents: 400,
  });
  expect(state.available_cents.reward).toBe(650);
  await prisma.reward.update({ where: { id: f.reward.id }, data: { cost_cents: 1000 } });
  expect(await f.read()).toMatchObject({
    available_cents: { reward: 650 },
    reasons: { reward: expect.stringContaining('No affordable') },
  });
});
it('a cleared original grant can restore ONLY retained funding after Wallet refund, never the extinguished remainder', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  await prisma.reward.update({ where: { id: f.reward.id }, data: { cost_cents: 700 } });
  f.request.selections[0]!.unit_price_cents = 700;
  const result = await f.apply();
  await withWebhooks((tx, _emit, publisher) =>
    setClaimStatusTx(tx, result.claim_ids[0]!, 'FULFILLED', publisher),
  );
  await withWebhooks((tx, _emit, publisher) =>
    setDonationStatusTx(tx, f.sources[1]!.donation.id, 'REFUNDED', undefined, 'admin', publisher),
  );
  expect(
    await prisma.poolCredit.findUnique({ where: { id: f.sources[1]!.grant.id } }),
  ).toMatchObject({ remaining_cents: 0, cleared_at: expect.any(Date) });
  await withWebhooks(async (tx, _emit, publisher) => {
    await setClaimStatusTx(tx, result.claim_ids[0]!, 'PENDING', publisher);
    await reverseSpendTx(tx, f.donor.id, 'claim', result.claim_ids[0]!, 'admin', publisher);
  });
  expect(await f.read()).toMatchObject({ available_cents: { reward: 700 } });
  expect(
    await prisma.poolCredit.findUnique({ where: { id: f.sources[1]!.grant.id } }),
  ).toMatchObject({ remaining_cents: 100, cleared_at: null });
  expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
    balance_remaining: 423,
  });
  expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(1);
});
it.each(['REFUNDED', 'CHARGEBACK'])(
  'terminal action on A cancels one shared whole claim, extinguishes A and restores B (%s)',
  async (status) => {
    const f = await fixture({
      sourceGrants: [600, 400],
      rewardPrice: 1000,
      stock: 3,
      availableWallet: 123,
      reviewedRewardCents: 1000,
    });
    const result = await f.apply();
    await withWebhooks((tx, _emit, publisher) =>
      setDonationStatusTx(tx, f.sources[0]!.donation.id, status, undefined, 'admin', publisher),
    );
    expect(await f.read()).toMatchObject({ available_cents: { reward: 400 } });
    expect(
      await prisma.rewardClaim.findUnique({ where: { id: result.claim_ids[0] } }),
    ).toMatchObject({ status: 'REVERSED' });
    expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
      quantity_claimed: 0,
    });
    expect(
      await prisma.poolCredit.findUnique({ where: { id: f.sources[1]!.grant.id } }),
    ).toMatchObject({ remaining_cents: 400 });
  },
);
it('retained whole claim uses source-local 600 max rule, then restores retained REFUNDED credit without another Wallet grant', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  // A has D1000, of which the retained credit component consumes 600, not the whole 1000 entitlement.
  await prisma.donation.update({
    where: { id: f.sources[0]!.donation.id },
    data: { pledge_amount_cents: 1000, amount_cents: 1000 },
  });
  const result = await f.apply();
  await withWebhooks((tx, _emit, publisher) =>
    setClaimStatusTx(tx, result.claim_ids[0]!, 'FULFILLED', publisher),
  );
  expect(
    await prisma.$transaction((tx) =>
      previewDonationReversalTx(tx, f.sources[0]!.donation.id, 'REFUNDED'),
    ),
  ).toMatchObject({ wallet_adjustment_cents: 400, retained_claim_ids: result.claim_ids });
  await withWebhooks((tx, _emit, publisher) =>
    setDonationStatusTx(tx, f.sources[0]!.donation.id, 'REFUNDED', undefined, 'admin', publisher),
  );
  await withWebhooks(async (tx, _emit, publisher) => {
    await setClaimStatusTx(tx, result.claim_ids[0]!, 'PENDING', publisher);
    await reverseSpendTx(tx, f.donor.id, 'claim', result.claim_ids[0]!, 'admin', publisher);
  });
  expect(await f.read()).toMatchObject({ available_cents: { reward: 1000 } });
  expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
    balance_remaining: 523,
  });
  expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(1);
  f.request.idempotency_key = crypto.randomUUID();
  await f.apply();
});
it.each([
  ['REFUNDED', 'CHARGEBACK'],
  ['CHARGEBACK', 'CHARGEBACK'],
  ['REFUNDED', 'REQUESTED'],
  ['CHARGEBACK', 'REQUESTED'],
] as const)(
  'terminal action on A (%s) retains its fulfilled shared claim despite B (%s)',
  async (status, otherStatus) => {
    const f = await fixture({
      sourceGrants: [600, 400],
      rewardPrice: 1000,
      stock: 3,
      availableWallet: 123,
      reviewedRewardCents: 1000,
    });
    // A retains 600 of its D1000; B funds the other 400 of ONE whole entitlement.
    await prisma.donation.update({
      where: { id: f.sources[0]!.donation.id },
      data: { pledge_amount_cents: 1000, amount_cents: 1000 },
    });
    const result = await f.apply();
    expect(result.claim_ids).toHaveLength(1);
    await withWebhooks((tx, _emit, publisher) =>
      setClaimStatusTx(tx, result.claim_ids[0]!, 'FULFILLED', publisher),
    );
    if (otherStatus === 'CHARGEBACK')
      await withWebhooks((tx, _emit, publisher) =>
        setDonationStatusTx(
          tx,
          f.sources[1]!.donation.id,
          'CHARGEBACK',
          undefined,
          'admin',
          publisher,
        ),
      );
    else
      await prisma.paymentRefund.create({
        data: {
          donation_id: f.sources[1]!.donation.id,
          claim_id: result.claim_ids[0]!,
          item_cents: 400,
          created_by: 'admin',
        },
      });
    expect(
      await prisma.$transaction((tx) =>
        previewDonationReversalTx(tx, f.sources[0]!.donation.id, status),
      ),
    ).toMatchObject({
      wallet_adjustment_cents: status === 'REFUNDED' ? 400 : 0,
      retained_claim_ids: result.claim_ids,
      reversed_rows: { reward: 0 },
    });
    await withWebhooks((tx, _emit, publisher) =>
      setDonationStatusTx(tx, f.sources[0]!.donation.id, status, undefined, 'admin', publisher),
    );
    const summary = await prisma.$transaction((tx) => readPoolCreditSummaryTx(tx, f.donor.id));
    expect(summary.wallet_credit_cents).toBe(status === 'REFUNDED' ? 523 : 123);
    const credits = await f.read();
    expect(credits.available_cents.reward).toBe(0);
    expect(credits.catalog.rewards.find((row) => row.id === f.reward.id)?.remaining).toBe(2);
    expect(credits.history).toHaveLength(2);
    for (const grant of credits.history) {
      expect(grant.remaining_cents).toBe(0);
      expect(grant.redemptions).toMatchObject([
        { allocation_id: result.claim_ids[0], reversed: false },
      ]);
    }
    const otherDonationStatus = otherStatus === 'CHARGEBACK' ? 'CHARGEBACK' : 'COMPLETED';
    for (const [index, sourceStatus] of [status, otherDonationStatus].entries()) {
      const accounting = await prisma.$transaction((tx) =>
        readDonationAccountingTx(tx, f.sources[index]!.donation.id),
      );
      expect(accounting.status).toBe(sourceStatus);
      expect(accounting.wallet_credit_granted_cents).toBe(
        index === 0 && status === 'REFUNDED' ? 400 : 0,
      );
      expect(accounting.allocations.reward).toEqual([
        expect.objectContaining({
          id: result.claim_ids[0],
          status: 'FULFILLED',
          amount_cents: index === 0 ? 600 : 400,
          entitlement_amount_cents: 1000,
        }),
      ]);
    }
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        setClaimStatusTx(tx, result.claim_ids[0]!, 'PENDING', publisher),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        reverseSpendTx(tx, f.donor.id, 'claim', result.claim_ids[0]!, 'admin', publisher),
      ),
    ).rejects.toMatchObject({ status: 409 });
  },
);
it.each(['REQUESTED', 'CHARGEBACK'])(
  'every funding source protects whole claim from status/reverse and terminal actions (%s)',
  async (status) => {
    const f = await fixture({
      sourceGrants: [600, 400],
      rewardPrice: 1000,
      stock: 3,
      availableWallet: 123,
      reviewedRewardCents: 1000,
    });
    const result = await f.apply();
    if (status === 'REQUESTED')
      await prisma.paymentRefund.create({
        data: {
          donation_id: f.sources[1]!.donation.id,
          claim_id: result.claim_ids[0]!,
          item_cents: 400,
          created_by: 'admin',
        },
      });
    else
      await prisma.donation.update({ where: { id: f.sources[1]!.donation.id }, data: { status } });
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        setClaimStatusTx(tx, result.claim_ids[0]!, 'FULFILLED', publisher),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        reverseSpendTx(tx, f.donor.id, 'claim', result.claim_ids[0]!, 'admin', publisher),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.$transaction((tx) =>
        previewDonationReversalTx(tx, f.sources[0]!.donation.id, 'REFUNDED'),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        setDonationStatusTx(
          tx,
          f.sources[0]!.donation.id,
          'REFUNDED',
          undefined,
          'admin',
          publisher,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  },
);
it('concurrent lost-response retries return the original result before changed catalog/ended checks', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const [a, b] = await Promise.all([f.apply(), f.apply()]);
  expect(b).toEqual(a);
  await prisma.reward.update({
    where: { id: f.reward.id },
    data: { cost_cents: 9999, is_active: false },
  });
  await prisma.event.update({ where: { id: f.event.id }, data: { ended_at: new Date() } });
  expect(await f.apply()).toEqual(a);
  f.request.selections[0]!.quantity = 2;
  await expect(f.apply()).rejects.toMatchObject({ status: 409 });
});
it('source-local native accounting projects 600/400, not two whole entitlements', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const result = await f.apply();
  const a = await prisma.$transaction((tx) =>
    readDonationAccountingTx(tx, f.sources[0]!.donation.id),
  );
  const b = await prisma.$transaction((tx) =>
    readDonationAccountingTx(tx, f.sources[1]!.donation.id),
  );
  expect(a.allocations.reward).toMatchObject([
    {
      id: result.claim_ids[0],
      amount_cents: 600,
      entitlement_amount_cents: 1000,
      carrier_donation_id: f.sources[0]!.donation.id,
    },
  ]);
  expect(b.allocations.reward).toMatchObject([{ id: result.claim_ids[0], amount_cents: 400 }]);
});
it('cross-Channel poll cents, shared rewards and goal overshoot split sources; reversing restores original grants only', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  const { poll, goal } = await extraCredits(f, { goalTarget: 1 });
  const request = {
    ...f.request,
    reviewed_credit_cents: { reward: 1000, poll: 1000, goal: 1000 },
    selections: [
      {
        kind: 'POLL_VOTE' as const,
        target_id: poll.options[0]!.id,
        poll_id: poll.id,
        amount_cents: 601,
      },
      { kind: 'GOAL' as const, target_id: goal.id, amount_cents: 1000 },
    ],
  };
  const result = await withWebhooks((tx, _emit, publisher) =>
    applyPoolCreditTx(tx, f.donor.id, f.event.id, request, publisher),
  );
  expect(result).toMatchObject({ spent_cents: { reward: 0, poll: 601, goal: 1000 } });
  expect(await f.read()).toMatchObject({ available_cents: { reward: 1000, poll: 399, goal: 0 } });
  await withWebhooks(async (tx, _emit, publisher) => {
    for (const id of result.vote_ids)
      await reverseSpendTx(tx, f.donor.id, 'vote', id, 'admin', publisher);
    for (const id of result.contribution_ids)
      await reverseSpendTx(tx, f.donor.id, 'contribution', id, 'admin', publisher);
  });
  expect(await f.read()).toMatchObject({ available_cents: { poll: 1000, goal: 1000 } });
  expect(await prisma.poolCredit.count({ where: { donation: { donor_id: f.donor.id } } })).toBe(6);
});
it('A600+B400 buys one C1000 entitlement, stock once, and reversal restores original grants repeatedly', async () => {
  const f = await fixture({
    sourceGrants: [600, 400],
    rewardPrice: 1000,
    stock: 3,
    availableWallet: 123,
    reviewedRewardCents: 1000,
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    f.request.idempotency_key = crypto.randomUUID();
    const applied = await f.apply();
    expect(applied.claim_ids).toHaveLength(1);
    expect(await f.read()).toMatchObject({ available_cents: { reward: 0 } });
    expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
      quantity_claimed: 1,
    });
    expect(
      await prisma.rewardClaim.findUnique({ where: { id: applied.claim_ids[0] } }),
    ).toMatchObject({ donation_id: null, amount_cents: 1000 });
    expect(await f.apply()).toEqual(applied);
    await withWebhooks((tx, _emit, publisher) =>
      reverseSpendTx(tx, f.donor.id, 'claim', applied.claim_ids[0]!, 'admin', publisher),
    );
    expect(await f.read()).toMatchObject({ available_cents: { reward: 1000 } });
    expect(await prisma.poolCredit.count({ where: { donation: { donor_id: f.donor.id } } })).toBe(
      2,
    );
    expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
      balance_remaining: 123,
    });
  }
});
