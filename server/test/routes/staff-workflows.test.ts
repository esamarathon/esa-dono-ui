import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
import prisma from '../../lib/prisma.js';
import admin from '../../routes/admin.js';
import moderator from '../../routes/moderator.js';
import { catchAsyncErrors, errorHandler } from '../../lib/httpError.js';
import { createTestChannel, DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

beforeAll(async () => {
  await ensureDefaultEvent(prisma);
});
import { applyPoolCreditTx } from '../../services/poolCredit.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
const extraDonors: string[] = [];
const extraRewards: string[] = [];
const extraGoals: string[] = [];
const app = express();
app.use(express.json());
app.use('/api/admin', admin);
app.use('/api/moderator', moderator);
catchAsyncErrors(app);
app.use(errorHandler);
const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };
let donorId: string;
let channelId: string;
let donationId: string;
let rewardId: string;
let pollId: string;
let claimId: string;
const marker = `private-${crypto.randomUUID()}@example.com`;
async function fixture({
  availableWallet,
  heldWallet,
  cash,
  pledge,
  latestCash,
  recordedClaim,
  currentPrice,
  pollAllocation,
}: Readonly<{
  availableWallet: number;
  heldWallet: number;
  cash: number;
  pledge: number;
  latestCash: number;
  recordedClaim: number;
  currentPrice: number;
  pollAllocation: number;
}>) {
  const donor = await prisma.donor.create({
    data: { email: marker, balance_remaining: availableWallet, balance_held_cents: heldWallet },
  });
  donorId = donor.id;
  channelId = (await createTestChannel(prisma)).id;
  const donation = await prisma.donation.create({
    data: {
      external_id: crypto.randomUUID(),
      donor_id: donorId,
      channel_id: channelId,
      amount_cents: cash,
      pledge_amount_cents: pledge,
      donor_name: null,
    },
  });
  donationId = donation.id;
  await prisma.donation.create({
    data: {
      external_id: crypto.randomUUID(),
      donor_id: donorId,
      amount_cents: latestCash,
      donor_name: 'Newest name',
      created_at: new Date(Date.now() + 1000),
    },
  });
  rewardId = (
    await prisma.reward.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Recorded reward',
        type: 'DIGITAL',
        cost_cents: currentPrice,
      },
    })
  ).id;
  claimId = (
    await prisma.rewardClaim.create({
      data: {
        donor_id: donorId,
        donation_id: donationId,
        reward_id: rewardId,
        amount_cents: recordedClaim,
      },
    })
  ).id;
  await prisma.rewardClaim.create({
    data: {
      donor_id: donorId,
      reward_id: rewardId,
      amount_cents: recordedClaim,
      status: 'REVERSED',
      reversed_at: new Date(),
    },
  });
  const poll = await prisma.poll.create({
    data: {
      event_id: DEFAULT_EVENT_ID,
      title: 'Live poll',
      options: { create: { label: 'Option' } },
    },
    include: { options: true },
  });
  pollId = poll.id;
  await prisma.pollVote.create({
    data: {
      donor_id: donorId,
      donation_id: donationId,
      poll_id: pollId,
      poll_option_id: poll.options[0]!.id,
      amount_cents: pollAllocation,
      source: 'auto',
    },
  });
}
afterEach(async () => {
  const ids = [donorId, ...extraDonors];
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: ids } } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: ids } } });
  await prisma.poolCreditRedemption.deleteMany({
    where: { credit: { donation: { donor_id: { in: ids } } } },
  });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: ids } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: ids } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: ids } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: ids } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: ids } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: extraGoals } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: ids } } });
  await prisma.donor.deleteMany({ where: { id: { in: ids } } });
  await prisma.reward.deleteMany({ where: { id: { in: [rewardId, ...extraRewards] } } });
  await prisma.poll.delete({ where: { id: pollId } });
  await prisma.channel.delete({ where: { id: channelId } });
  extraDonors.length = extraRewards.length = extraGoals.length = 0;
});
afterAll(() => prisma.$disconnect());
function privateFree(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(marker);
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      expect(key).not.toMatch(/^(email|donor_email)$/);
      privateFree(child);
    }
}
it('shows moderator live allocations, not stale pledge choices, and preserves own-donation null names', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const claims = await request(app).get('/api/moderator/claims').set(AUTH).expect(200);
  const own = claims.body.filter((c: { reward_id: string }) => c.reward_id === rewardId);
  expect(own).toEqual([
    expect.objectContaining({ id: claimId, donor_name: null, amount_cents: 500 }),
  ]);
  privateFree(claims.body);
  const donations = await request(app).get('/api/moderator/donations').set(AUTH).expect(200);
  const row = donations.body.find((d: { id: string }) => d.id === donationId);
  expect(row.allocations.poll).toEqual([
    expect.objectContaining({ label: 'Live poll: Option', source: 'auto', amount_cents: 700 }),
  ]);
  expect(row.unused_cents).toEqual({ poll: 300, goal: 1000 });
  privateFree(donations.body);
  const detail = await request(app).get(`/api/admin/donations/${donationId}`).set(AUTH).expect(200);
  expect(detail.body.donor.email).toBe(marker);
  expect(detail.body.pools.reward.live_cents).toBe(500);
});
it('paginates/filter pledges without changing the legacy array contract, and shows current versus confirmed reward prices', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const pledge = await prisma.pendingPledge.create({
    data: {
      pledge_token: crypto.randomUUID(),
      format: 'POOLED',
      status: 'OPEN',
      draft_id: crypto.randomUUID(),
      confirmed_plan: '{}',
      wallet_donor_id: donorId,
      pledge_amount_cents: 1000,
      new_money_cents: 50,
      held_wallet_cents: 950,
      wallet_hold_status: 'HELD',
      checkout_session_status: 'open',
      expires_at: new Date('2020-01-01'),
      items: {
        create: { kind: 'REWARD', target_id: rewardId, amount_cents: 500, unit_price_cents: 500 },
      },
    },
  });
  try {
    const response = await request(app)
      .get('/api/admin/pledges')
      .set(AUTH)
      .query({ status: 'OPEN', overdue: 'true', limit: 1, offset: 0 })
      .expect(200);
    expect(response.headers['x-total-count']).toBe('1');
    expect(response.body).toEqual([
      expect.objectContaining({
        id: pledge.id,
        overdue: true,
        payment_state: 'OPEN',
        items: [
          expect.objectContaining({
            unit_price_cents: 500,
            current_price_cents: 900,
            label: 'Recorded reward',
          }),
        ],
      }),
    ]);
    await request(app).get('/api/admin/pledges').set(AUTH).query({ limit: -1 }).expect(400);
    await request(app).get('/api/admin/pledges').set(AUTH).query({ status: 'all' }).expect(400);
  } finally {
    await prisma.pendingPledge.delete({ where: { id: pledge.id } });
  }
});

it('shares the actual Default goal recipient and fallback safely with moderators', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const goal = await prisma.fundGoal.create({
    data: { event_id: DEFAULT_EVENT_ID, title: 'Shared fallback', target_cents: 1000 },
  });
  try {
    await request(app)
      .put(`/api/moderator/channels/${channelId}`)
      .set(AUTH)
      .send({ default_goals: [goal.id] })
      .expect(200);
    const list = await request(app).get('/api/moderator/channels').set(AUTH).expect(200);
    expect(list.body.find((c: { id: string }) => c.id === channelId)).toMatchObject({
      default_goals: [goal.id],
      default_goal: { id: goal.id, title: 'Shared fallback' },
      has_eligible_default: true,
    });
    privateFree(list.body);
  } finally {
    await prisma.channelDefaultGoal.deleteMany({ where: { goal_id: goal.id } });
    await prisma.fundGoal.delete({ where: { id: goal.id } });
  }
});

it('filters canonical late LEGACY cash outcomes while preserving stored EXPIRED and original historical FULFILLED', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const receipt = await prisma.donation.create({
    data: { external_id: crypto.randomUUID(), donor_id: donorId, amount_cents: 1000 },
  });
  const historical = await prisma.donation.create({
    data: { external_id: crypto.randomUUID(), donor_id: donorId, amount_cents: 500 },
  });
  const late = await prisma.pendingPledge.create({
    data: {
      pledge_token: crypto.randomUUID(),
      format: 'LEGACY',
      status: 'EXPIRED',
      total_cents: 1000,
      expires_at: new Date('2020-01-01'),
      fulfilled_by_donation_id: receipt.id,
      payment_status: 'paid',
      checkout_session_status: 'complete',
    },
  });
  const original = await prisma.pendingPledge.create({
    data: {
      pledge_token: crypto.randomUUID(),
      format: 'LEGACY',
      status: 'FULFILLED',
      total_cents: 500,
      expires_at: new Date('2020-01-01'),
      fulfilled_by_donation_id: historical.id,
      payment_status: 'paid',
      checkout_session_status: 'complete',
    },
  });
  try {
    const response = await request(app)
      .get('/api/admin/pledges')
      .set(AUTH)
      .query({ payment_state: 'LEGACY_PAID', limit: 1, offset: 0 })
      .expect(200);
    expect(response.headers['x-total-count']).toBe('1');
    expect(response.body).toEqual([
      expect.objectContaining({
        id: late.id,
        status: 'EXPIRED',
        payment_state: 'LEGACY_PAID',
        fulfilled_by: expect.objectContaining({ id: receipt.id }),
      }),
    ]);
    const fulfilled = await request(app)
      .get('/api/admin/pledges')
      .set(AUTH)
      .query({ status: 'FULFILLED' })
      .expect(200);
    expect(fulfilled.body.find((row: { id: string }) => row.id === original.id)).toMatchObject({
      status: 'FULFILLED',
      payment_state: 'FULFILLED',
    });
  } finally {
    await prisma.pendingPledge.deleteMany({ where: { id: { in: [late.id, original.id] } } });
  }
});

it('rejects manual payment-status changes server-side', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  await request(app)
    .patch(`/api/admin/donations/${donationId}/status`)
    .set(AUTH)
    .send({ status: 'PENDING' })
    .expect(400);
  await request(app)
    .patch(`/api/admin/donations/${donationId}/status`)
    .set(AUTH)
    .send({ status: 'COMPLETED' })
    .expect(400);
});
it('previews category credit, original redemption destinations and legacy Wallet without exposing private identity', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const votes = await prisma.pollVote.findMany({ where: { donation_id: donationId } });
  const response = await request(app)
    .get(`/api/admin/donors/${donorId}/reverse-spend-preview`)
    .set(AUTH)
    .query({ spend_type: 'vote', spend_id: votes[0]!.id })
    .expect(200);
  expect(response.body).toEqual({
    destinations: [
      {
        category: 'poll',
        destination: 'Pool credit',
        donation_id: donationId,
        credit_id: null,
        amount_cents: 700,
      },
    ],
  });
  privateFree(response.body);
  const legacy = await prisma.donation.create({
    data: {
      external_id: crypto.randomUUID(),
      donor_id: donorId,
      amount_cents: 300,
      donor_name: 'Own historical name',
      created_at: new Date('2020-01-01'),
    },
  });
  const legacyClaim = await prisma.rewardClaim.create({
    data: { donation_id: legacy.id, donor_id: donorId, reward_id: rewardId, amount_cents: 300 },
  });
  const wallet = await request(app)
    .get(`/api/admin/donors/${donorId}/reverse-spend-preview`)
    .set(AUTH)
    .query({ spend_type: 'claim', spend_id: legacyClaim.id })
    .expect(200);
  expect(wallet.body).toEqual({
    destinations: [
      {
        destination: 'Wallet credit',
        category: 'reward',
        donation_id: legacy.id,
        credit_id: null,
        amount_cents: 300,
      },
    ],
  });
  const claims = await request(app).get('/api/moderator/claims').set(AUTH).expect(200);
  expect(claims.body.find((row: { id: string }) => row.id === legacyClaim.id)).toMatchObject({
    donor_name: 'Own historical name',
    amount_cents: 300,
  });
  privateFree(claims.body);
  await request(app)
    .get(`/api/admin/donors/${donorId}/reverse-spend-preview`)
    .query({ spend_type: 'vote', spend_id: votes[0]!.id })
    .expect(401);
});

it('GET donor detail returns the private admin Wallet and safe category summary through SQLite', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const response = await request(app).get(`/api/admin/donors/${donorId}`).set(AUTH).expect(200);
  expect(response.body.email).toBe(marker);
  expect(response.body.pool_credits).toMatchObject({ events: [] });
  expect(response.body.reward_claims).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: claimId,
        amount_cents: 500,
        funding_donation_ids: [donationId],
      }),
    ]),
  );
});

it('keeps one multisource claim, source-local allocations, original-grant previews and all-source locks without breaking retained-claim terminal actions', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const owner = await prisma.donor.create({
    data: { email: `multi-${crypto.randomUUID()}@example.com` },
  });
  extraDonors.push(owner.id);
  const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
  const donations = [];
  for (const name of ['First', 'Second']) {
    const donation = await prisma.donation.create({
      data: {
        donor_id: owner.id,
        external_id: crypto.randomUUID(),
        amount_cents: 500,
        pledge_amount_cents: 1000,
        wallet_applied_cents: 500,
        channel_id: channelId,
        event_id: channel.event_id,
        donor_name: name,
      },
    });
    donations.push(donation);
    const origin = await prisma.rewardClaim.create({
      data: {
        donor_id: owner.id,
        donation_id: donation.id,
        reward_id: rewardId,
        amount_cents: 500,
      },
    });
    await request(app)
      .post(`/api/admin/donors/${owner.id}/reverse-spend`)
      .set(AUTH)
      .send({ spend_type: 'claim', spend_id: origin.id })
      .expect(200);
  }
  const beforeSpend = await request(app).get(`/api/admin/donors/${owner.id}`).set(AUTH).expect(200);
  expect(beforeSpend.body).toMatchObject({
    balance_remaining: 0,
    balance_held_cents: 0,
    pool_credits: {
      events: [expect.objectContaining({ available_cents: { reward: 1000, poll: 0, goal: 0 } })],
    },
  });
  const target = await prisma.reward.create({
    data: {
      event_id: DEFAULT_EVENT_ID,
      title: 'Whole entitlement',
      type: 'DIGITAL',
      cost_cents: 1000,
    },
  });
  extraRewards.push(target.id);
  const result = await withWebhooks((tx, _emit, publisher) =>
    applyPoolCreditTx(
      tx,
      owner.id,
      channel.event_id,
      {
        idempotency_key: crypto.randomUUID(),
        reviewed_credit_cents: { reward: 1000, poll: 0, goal: 0 },
        selections: [
          {
            kind: 'REWARD',
            target_id: target.id,
            quantity: 1,
            unit_price_cents: 1000,
            reward_type: 'DIGITAL',
          },
        ],
      },
      publisher,
    ),
  );
  expect(result.claim_ids).toHaveLength(1);
  const claim = result.claim_ids[0]!;
  const preview = await request(app)
    .get(`/api/admin/donors/${owner.id}/reverse-spend-preview`)
    .set(AUTH)
    .query({ spend_type: 'claim', spend_id: claim })
    .expect(200);
  expect(preview.body.destinations).toEqual(
    expect.arrayContaining(
      donations.map((d) =>
        expect.objectContaining({
          donation_id: d.id,
          credit_id: expect.any(String),
          amount_cents: 500,
          destination: 'Pool credit',
        }),
      ),
    ),
  );
  for (const donation of donations) {
    const read = await request(app)
      .get(`/api/admin/donations/${donation.id}`)
      .set(AUTH)
      .expect(200);
    expect(read.body.allocations.reward).toEqual([
      expect.objectContaining({ id: claim, amount_cents: 500, recorded_amount_cents: 1000 }),
    ]);
  }
  await request(app)
    .patch(`/api/admin/claims/${claim}`)
    .set(AUTH)
    .send({ status: 'FULFILLED' })
    .expect(200);
  await request(app)
    .patch(`/api/admin/donations/${donations[1]!.id}/status`)
    .set(AUTH)
    .send({ status: 'CHARGEBACK' })
    .expect(200);
  const all = await request(app).get('/api/admin/claims').set(AUTH).expect(200);
  expect(all.body.find((c: { id: string }) => c.id === claim)).toMatchObject({
    toggle_disabled_reason: expect.stringContaining('charged-back'),
    funding_donation_ids: expect.arrayContaining(donations.map((d) => d.id)),
  });
  await request(app)
    .patch(`/api/admin/claims/${claim}`)
    .set(AUTH)
    .send({ status: 'PENDING' })
    .expect(409);
  const retained = await request(app)
    .get(`/api/admin/donations/${donations[0]!.id}/reversal-preview`)
    .set(AUTH)
    .query({ status: 'REFUNDED' })
    .expect(200);
  expect(retained.body.retained_claim_ids).toEqual([claim]);
  const mod = await request(app).get('/api/moderator/claims').set(AUTH).expect(200);
  expect(mod.body.find((c: { id: string }) => c.id === claim)).toMatchObject({
    donor_name: 'Second',
    amount_cents: 1000,
  });
  expect(JSON.stringify(mod.body)).not.toContain(owner.email);
});

it.each(['rewards', 'polls', 'goals', 'events', 'stats'])(
  'new moderator %s projection recursively omits private donor email',
  async (path) => {
    await fixture({
      availableWallet: 100,
      heldWallet: 200,
      cash: 0,
      pledge: 1000,
      latestCash: 100,
      recordedClaim: 500,
      currentPrice: 900,
      pollAllocation: 700,
    });
    const response = await request(app).get(`/api/moderator/${path}`).set(AUTH).expect(200);
    privateFree(response.body);
  },
);

it('reads recorded ended/completed target changes and resolved-item shipping attention, with moderator source attribution and destination preview', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  const owner = await prisma.donor.create({
    data: { email: `snapshot-${crypto.randomUUID()}@example.com` },
  });
  extraDonors.push(owner.id);
  const donation = await prisma.donation.create({
    data: {
      donor_id: owner.id,
      external_id: crypto.randomUUID(),
      amount_cents: 500,
      pledge_amount_cents: 500,
    },
  });
  const cancelled = await prisma.rewardClaim.create({
    data: {
      donor_id: owner.id,
      donation_id: donation.id,
      reward_id: rewardId,
      amount_cents: 500,
      status: 'REVERSED',
      reversed_at: new Date(),
    },
  });
  const goal = await prisma.fundGoal.create({
    data: {
      event_id: DEFAULT_EVENT_ID,
      title: 'Ended complete goal',
      current_cents: 500,
      target_cents: 1000,
      is_complete: true,
      is_active: false,
    },
  });
  extraGoals.push(goal.id);
  const contribution = await prisma.fundContribution.create({
    data: {
      donor_id: owner.id,
      donation_id: donation.id,
      goal_id: goal.id,
      amount_cents: 500,
      source: 'moderator',
      allocated_by: 'Staff operator',
      allocated_at: new Date(),
    },
  });
  const record = await prisma.paymentRefund.create({
    data: {
      donation_id: donation.id,
      claim_id: cancelled.id,
      item_cents: 500,
      shipping_cents: 200,
      status: 'RESOLVED',
      accepted_at: new Date(),
      resolution: 'RETURNED_OUTSIDE_APP',
      created_by: 'admin',
      pool_shrink_data: JSON.stringify({
        donation_id: donation.id,
        claim_id: cancelled.id,
        money_before_cents: 1000,
        money_after_cents: 500,
        pledge_before_cents: 1000,
        pledge_after_cents: 500,
        wallet_applied_cents: 0,
        failed_payment_wallet_credit_cents: 0,
        categories: {
          reward: {
            before_cents: 1000,
            after_cents: 500,
            unused_consumed_cents: 500,
            reduced_cents: 0,
          },
          poll: {
            before_cents: 1000,
            after_cents: 500,
            unused_consumed_cents: 500,
            reduced_cents: 0,
          },
          goal: {
            before_cents: 1000,
            after_cents: 500,
            unused_consumed_cents: 0,
            reduced_cents: 500,
          },
        },
        components: [
          {
            kind: 'contribution',
            id: contribution.id,
            category: 'goal',
            before_cents: 1000,
            after_cents: 500,
            target_id: goal.id,
            allocation_id: contribution.id,
            ended: true,
            completed: true,
            reduced_before_cents: 0,
            reduced_after_cents: 0,
          },
        ],
        affected_targets: [
          {
            category: 'goal',
            target_id: goal.id,
            poll_id: null,
            label: 'Ended complete goal',
            before_cents: 1000,
            after_cents: 500,
            ended: true,
            completed: true,
          },
        ],
      }),
    },
  });
  const detail = await request(app)
    .get(`/api/admin/donations/${donation.id}`)
    .set(AUTH)
    .expect(200);
  expect(detail.body).toMatchObject({
    needs_attention: true,
    flags: expect.arrayContaining(['Payment refund recovery']),
    ended_target_changes: [
      {
        payment_refund_id: record.id,
        category: 'goal',
        target_id: goal.id,
        poll_id: null,
        label: 'Ended complete goal',
        before_cents: 1000,
        after_cents: 500,
        ended: true,
        completed: true,
      },
    ],
  });
  expect(detail.body.allocations.goal).toEqual([
    expect.objectContaining({
      label: 'Ended complete goal',
      source: 'moderator',
      allocated_by: 'Staff operator',
      amount_cents: 500,
    }),
  ]);
  const open = await request(app).get('/api/admin/payment-refunds').set(AUTH).expect(200);
  expect(open.body.records).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: record.id })]),
  );
  const preview = await request(app)
    .get(`/api/admin/goals/${goal.id}/reversal-preview`)
    .set(AUTH)
    .expect(200);
  expect(preview.body).toEqual({
    destinations: [
      {
        category: 'goal',
        destination: 'Unused pool money',
        donation_id: donation.id,
        credit_id: null,
        amount_cents: 500,
      },
    ],
  });
  const mod = await request(app).get('/api/moderator/donations').set(AUTH).expect(200);
  expect(JSON.stringify(mod.body)).not.toContain(owner.email);
  const goals = await request(app).get('/api/moderator/goals').set(AUTH).expect(200);
  expect(goals.body.find((row: { id: string }) => row.id === goal.id)).toMatchObject({
    allocated_cents: 500,
    allocated_source_cents: { donor: 0, auto: 0, moderator: 500 },
  });
});

it('sweeps available Wallet only, preserving held credit', async () => {
  await fixture({
    availableWallet: 100,
    heldWallet: 200,
    cash: 0,
    pledge: 1000,
    latestCash: 100,
    recordedClaim: 500,
    currentPrice: 900,
    pollAllocation: 700,
  });
  await request(app)
    .post('/api/admin/donors/sweep-credits')
    .set(AUTH)
    .send({ confirm: true, min_balance_cents: 100, max_balance_cents: 100 })
    .expect(200);
  const wallet = await request(app).get(`/api/admin/donors/${donorId}`).set(AUTH).expect(200);
  expect(wallet.body).toMatchObject({ balance_remaining: 0, balance_held_cents: 200 });
});
