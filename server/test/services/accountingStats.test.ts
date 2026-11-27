import crypto from 'node:crypto';
import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import adminRouter from '../../routes/admin.js';
import moderatorRouter from '../../routes/moderator.js';
import { register } from '../../lib/metrics.js';
import { metricsAuth } from '../../middleware/metricsAuth.js';
import { refreshBusinessMetrics } from '../../services/metrics.js';
import prisma from '../../lib/prisma.js';
import { readAccountingStatsTx } from '../../services/accountingStats.js';
import { DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

beforeAll(async () => {
  await ensureDefaultEvent(prisma);
});

const donors: string[] = [],
  events: string[] = [],
  rewards: string[] = [],
  polls: string[] = [],
  goals: string[] = [];
async function fixture({
  cash,
  pledge,
  walletApplied,
  shipping,
  availableWallet,
  heldWallet,
  goalTarget,
}: Readonly<{
  cash: number;
  pledge: number;
  walletApplied: number;
  shipping: number;
  availableWallet: number;
  heldWallet: number;
  goalTarget: number;
}>) {
  const donor = await prisma.donor.create({
    data: {
      email: `PRIVATE-${crypto.randomUUID()}@marker.example`,
      balance_remaining: availableWallet,
      balance_held_cents: heldWallet,
    },
  });
  donors.push(donor.id);
  const event = await prisma.event.create({ data: { name: 'Stats', slug: crypto.randomUUID() } });
  events.push(event.id);
  const a = await prisma.channel.create({
    data: {
      name: `Source A ${crypto.randomUUID()}`,
      slug: crypto.randomUUID(),
      event_id: event.id,
    },
  });
  const b = await prisma.channel.create({
    data: {
      name: `Target B ${crypto.randomUUID()}`,
      slug: crypto.randomUUID(),
      event_id: event.id,
    },
  });
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: cash,
      pledge_amount_cents: pledge,
      wallet_applied_cents: walletApplied,
      shipping_cents: shipping,
      channel_id: a.id,
      event_id: event.id,
      comment: 'choice',
    },
  });
  const reward = await prisma.reward.create({
    data: {
      event_id: b.event_id,
      title: 'Recorded not catalog',
      type: 'DIGITAL',
      cost_cents: 9999,
      channel_id: b.id,
    },
  });
  rewards.push(reward.id);
  const poll = await prisma.poll.create({
    data: { event_id: DEFAULT_EVENT_ID, title: 'Shared', options: { create: { label: 'Yes' } } },
    include: { options: true },
  });
  polls.push(poll.id);
  const goal = await prisma.fundGoal.create({
    data: { event_id: b.event_id, title: 'Goal B', channel_id: b.id, target_cents: goalTarget },
  });
  goals.push(goal.id);
  return { donor, event, a, b, donation, reward, poll, goal };
}
async function credit(
  f: Awaited<ReturnType<typeof fixture>>,
  category: 'reward' | 'poll' | 'goal',
  cents: number,
) {
  const data = {
    donor_id: f.donor.id,
    donation_id: f.donation.id,
    amount_cents: cents,
    reversed_at: new Date(),
  };
  const origin =
    category === 'reward'
      ? {
          source_claim_id: (
            await prisma.rewardClaim.create({
              data: { ...data, reward_id: f.reward.id, status: 'REVERSED' },
            })
          ).id,
        }
      : category === 'poll'
        ? {
            source_vote_id: (
              await prisma.pollVote.create({
                data: { ...data, poll_id: f.poll.id, poll_option_id: f.poll.options[0]!.id },
              })
            ).id,
          }
        : {
            source_contribution_id: (
              await prisma.fundContribution.create({ data: { ...data, goal_id: f.goal.id } })
            ).id,
          };
  return prisma.poolCredit.create({
    data: {
      ...origin,
      donation_id: f.donation.id,
      category,
      amount_cents: cents,
      remaining_cents: cents,
      created_by: 'admin',
    },
  });
}
const read = (now?: Date) => prisma.$transaction((tx) => readAccountingStatsTx(tx, now));
afterEach(async () => {
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.poolCreditRedemption.deleteMany({ where: { batch: { donor_id: { in: donors } } } });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pendingPledge.deleteMany({ where: { channel: { event_id: { in: events } } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  donors.length = events.length = rewards.length = polls.length = goals.length = 0;
});
afterAll(() => prisma.$disconnect());

const app = express();
app.use('/api/admin', adminRouter);
app.use('/api/moderator', moderatorRouter);
app.get('/api/metrics', metricsAuth, async (_req, res) => {
  res.type(register.contentType).send(await register.metrics());
});
async function assertPublished() {
  const snapshot = await read();
  const admin = await request(app)
    .get('/api/admin/stats')
    .set('Authorization', 'Bearer key_admin_test-admin-key');
  expect(admin.status).toBe(200);
  expect(admin.body).toEqual(snapshot.admin);
  const moderator = await request(app)
    .get('/api/moderator/stats')
    .set('Authorization', 'Bearer key_admin_test-admin-key');
  expect(moderator.status).toBe(200);
  expect(moderator.body).toEqual(snapshot.moderator);
  await refreshBusinessMetrics();
  const scrape = await request(app)
    .get('/api/metrics')
    .set('Authorization', 'Bearer key_metrics_test-metrics-key');
  expect(scrape.status).toBe(200);
  const metrics = await register.getMetricsAsJSON();
  const value = (name: string, labels: Record<string, string> = {}) =>
    metrics
      .find((m) => m.name === name)
      ?.values.find((v) => Object.entries(labels).every(([key, val]) => v.labels[key] === val))
      ?.value;
  expect(value('dono_donated_cents_total')).toBe(admin.body.total_raised_cents);
  expect(value('dono_reward_claims_total')).toBe(admin.body.claims);
  expect(value('dono_wallet_credit_cents', { state: 'available' })).toBe(
    admin.body.wallet_credit_cents.available,
  );
  expect(value('dono_wallet_credit_cents', { state: 'held' })).toBe(
    admin.body.wallet_credit_cents.held,
  );
  expect(value('dono_pledges_open')).toBe(admin.body.pledges.open);
  expect(value('dono_pledges_overdue')).toBe(admin.body.pledges.overdue);
  expect(value('dono_payment_refunds', { status: 'requested' })).toBe(
    admin.body.payment_refunds.requested,
  );
  expect(value('dono_payment_refunds', { status: 'failed' })).toBe(
    admin.body.payment_refunds.failed,
  );
  for (const allocation of snapshot.allocations) {
    const { cents, ...labels } = allocation;
    expect(value('dono_incentive_allocated_cents_by_channel', labels)).toBe(cents);
  }
  for (const channel of snapshot.admin.channels) {
    const scope = snapshot.donation_channels.find((c) => c.channel === channel.slug);
    if (!scope) continue;
    const labels = { event: scope.event, channel: scope.channel };
    expect(value('dono_donated_cents_by_channel', labels)).toBe(channel.raised_cents);
    for (const category of ['reward', 'poll', 'goal'] as const)
      expect(value('dono_pool_credit_cents_by_channel', { ...labels, category })).toBe(
        channel.pool_credit_cents[category],
      );
    for (const category of ['poll', 'goal'] as const)
      expect(value('dono_pool_unused_cents_by_channel', { ...labels, category })).toBe(
        channel.unused_pool_cents[category],
      );
  }
  expect(JSON.stringify(moderator.body)).not.toContain('PRIVATE-');
  return { admin, moderator, scrape, value };
}

it('publishes the same safe aggregation through real admin/moderator stats and cached public gauges', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await credit(f, 'poll', 75);
  await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      reward_id: f.reward.id,
      amount_cents: 200,
      status: 'CANCELLING',
    },
  });
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 300,
      source: 'auto',
    },
  });
  const { admin, moderator, scrape } = await assertPublished();
  expect(admin.body).not.toHaveProperty('unallocated_credits_cents');
  expect(moderator.body.unused_pool.with_comment).toEqual({
    donations: 1,
    cents: { poll: 625, goal: 1000 },
  });
  expect(scrape.text).toContain(
    `dono_incentive_allocated_cents_by_channel{event="${f.event.slug}",channel="${f.b.slug}",category="reward",source="donor"} 200`,
  );
  expect(JSON.stringify(moderator.body)).not.toContain(f.donor.email);
});

it.each(['donor', 'auto', 'moderator'])(
  'publishes %s poll/goal cents once at current stored amounts, even with reduced redemption history',
  async (source) => {
    const f = await fixture({
      cash: 700,
      pledge: 1000,
      walletApplied: 300,
      shipping: 200,
      availableWallet: 123,
      heldWallet: 456,
      goalTarget: 1000,
    });
    const staff = source === 'moderator' ? { allocated_by: 'staff', allocated_at: new Date() } : {};
    const vote = await prisma.pollVote.create({
      data: {
        donor_id: f.donor.id,
        donation_id: f.donation.id,
        poll_id: f.poll.id,
        poll_option_id: f.poll.options[0]!.id,
        amount_cents: 27,
        source,
        ...staff,
      },
    });
    const contribution = await prisma.fundContribution.create({
      data: {
        donor_id: f.donor.id,
        donation_id: f.donation.id,
        goal_id: f.goal.id,
        amount_cents: 19,
        source,
        ...staff,
      },
    });
    // Pending/ended polls and completed goals still reserve live allocations.
    await prisma.poll.update({
      where: { id: f.poll.id },
      data: { ends_at: new Date('2000-01-01') },
    });
    await prisma.pollOption.update({
      where: { id: f.poll.options[0]!.id },
      data: { status: 'PENDING_APPROVAL' },
    });
    await prisma.fundGoal.update({ where: { id: f.goal.id }, data: { is_complete: true } });
    if (source === 'donor') {
      const batch = await prisma.poolCreditBatch.create({
        data: {
          donor_id: f.donor.id,
          event_id: f.event.id,
          idempotency_key: crypto.randomUUID(),
          request_data: '{}',
        },
      });
      const pollCredit = await credit(f, 'poll', 37),
        goalCredit = await credit(f, 'goal', 29);
      await prisma.poolCredit.updateMany({
        where: { id: { in: [pollCredit.id, goalCredit.id] } },
        data: { remaining_cents: 0 },
      });
      await prisma.poolCreditRedemption.create({
        data: {
          credit_id: pollCredit.id,
          batch_id: batch.id,
          vote_id: vote.id,
          amount_cents: 37,
          reduced_cents: 10,
        },
      });
      await prisma.poolCreditRedemption.create({
        data: {
          credit_id: goalCredit.id,
          batch_id: batch.id,
          contribution_id: contribution.id,
          amount_cents: 29,
          reduced_cents: 10,
        },
      });
    }
    const { admin, value } = await assertPublished();
    expect(admin.body.shared.allocated_cents.poll).toBe(27);
    expect(
      admin.body.channels.find((c: { id: string }) => c.id === f.b.id).allocated_cents.goal,
    ).toBe(19);
    expect(
      value('dono_incentive_allocated_cents_by_channel', {
        event: '',
        channel: '',
        category: 'poll',
        source,
      }),
    ).toBe(27);
    expect(
      value('dono_incentive_allocated_cents_by_channel', {
        channel: f.b.slug,
        category: 'goal',
        source,
      }),
    ).toBe(19);
  },
);

it('counts legacy linked and unlinked live claims at recorded amounts and excludes reversed claims regardless of status', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await prisma.donation.update({
    where: { id: f.donation.id },
    data: { pledge_amount_cents: null, wallet_applied_cents: 0 },
  });
  await prisma.reward.update({ where: { id: f.reward.id }, data: { channel_id: null } });
  for (const [donationId, status, reversedAt, cents] of [
    [f.donation.id, 'PENDING', null, 40],
    [null, 'FULFILLED', null, 60],
    [null, 'CANCELLING', null, 80],
    [null, 'REVERSED', null, 100],
    [f.donation.id, 'PENDING', new Date(), 200],
  ] as const) {
    await prisma.rewardClaim.create({
      data: {
        donor_id: f.donor.id,
        donation_id: donationId,
        reward_id: f.reward.id,
        amount_cents: cents,
        status,
        reversed_at: reversedAt,
      },
    });
  }
  const { admin, value } = await assertPublished();
  expect(admin.body).toMatchObject({
    claims: 3,
    pledged_cents: 0,
    total_raised_cents: 700,
    shared: { allocated_cents: { reward: 180, poll: 0, goal: 0 } },
  });
  expect(
    admin.body.channels.find((c: { id: string }) => c.id === f.a.id).unused_pool_cents,
  ).toEqual({ poll: 0, goal: 0 });
  expect(value('dono_reward_claims_by_channel', { event: '', channel: '' })).toBe(3);
});

it('counts current D, not original cash, only for pooled counted statuses; Wallet-only pledges add no money', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await prisma.donation.update({
    where: { id: f.donation.id },
    data: { pledge_amount_cents: 800, amount_cents: 500 },
  });
  for (const [status, cash, pledge] of [
    ['COMPLETED', 0, 200],
    ['REFUNDED', 300, 400],
    ['CHARGEBACK', 100, 100],
    ['PENDING', 100, 100],
  ] as const) {
    await prisma.donation.create({
      data: {
        donor_id: f.donor.id,
        external_id: crypto.randomUUID(),
        channel_id: f.a.id,
        event_id: f.event.id,
        status,
        amount_cents: cash,
        pledge_amount_cents: pledge,
        wallet_applied_cents: pledge - cash,
        shipping_cents: 999,
      },
    });
  }
  const { admin } = await assertPublished();
  expect(admin.body).toMatchObject({ total_raised_cents: 800, pledged_cents: 1400, donations: 5 });
  expect(admin.body.channels.find((c: { id: string }) => c.id === f.a.id)).toMatchObject({
    raised_cents: 800,
    pledged_cents: 1400,
    donations: 5,
    unused_pool_cents: { poll: 1000, goal: 1000 },
  });
});

it('groups distinct unused donations by nonblank comment without counting fully assigned, terminal, legacy or ended work', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  for (const [status, pledge, comment] of [
    ['COMPLETED', 200, null],
    ['COMPLETED', 300, '  '],
    ['REFUNDED', 400, 'ignored'],
    ['CHARGEBACK', 500, 'ignored'],
    ['COMPLETED', null, 'legacy'],
  ] as const) {
    await prisma.donation.create({
      data: {
        donor_id: f.donor.id,
        external_id: crypto.randomUUID(),
        channel_id: f.a.id,
        event_id: f.event.id,
        amount_cents: pledge ?? 600,
        pledge_amount_cents: pledge,
        status,
        comment,
      },
    });
  }
  const full = await prisma.donation.create({
    data: {
      donor_id: f.donor.id,
      external_id: crypto.randomUUID(),
      channel_id: f.a.id,
      event_id: f.event.id,
      amount_cents: 50,
      pledge_amount_cents: 50,
      comment: 'fully assigned',
    },
  });
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: full.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 50,
    },
  });
  await prisma.fundContribution.create({
    data: { donor_id: f.donor.id, donation_id: full.id, goal_id: f.goal.id, amount_cents: 50 },
  });
  const ended = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await prisma.event.update({ where: { id: ended.event.id }, data: { ended_at: new Date() } });
  const { moderator } = await assertPublished();
  expect(moderator.body.unused_pool).toEqual({
    with_comment: { donations: 1, cents: { poll: 1000, goal: 1000 } },
    all: { donations: 3, cents: { poll: 1500, goal: 1500 } },
  });
  expect(JSON.stringify(moderator.body)).not.toContain(f.donor.email);
  expect(JSON.stringify(moderator.body)).not.toContain(ended.donor.email);
});

it("reads its caller's uncommitted accounting snapshot, with no global-client escape", async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.donation.update({
        where: { id: f.donation.id },
        data: { amount_cents: 50, pledge_amount_cents: 350 },
      });
      const snapshot = await readAccountingStatsTx(tx);
      expect(snapshot.admin).toMatchObject({ total_raised_cents: 50, pledged_cents: 350 });
      throw new Error('rollback snapshot');
    }),
  ).rejects.toThrow('rollback snapshot');
  expect((await read()).admin).toMatchObject({ total_raised_cents: 700, pledged_cents: 1000 });
});

it('retains stats authentication and role boundaries', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  const token = crypto.randomUUID();
  await prisma.donor.update({
    where: { id: f.donor.id },
    data: { magic_token: token, token_expires_at: new Date(Date.now() + 60000), role: 'MODERATOR' },
  });
  expect((await request(app).get('/api/admin/stats')).status).toBe(401);
  expect((await request(app).get('/api/moderator/stats')).status).toBe(401);
  expect(
    (await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`)).status,
  ).toBe(403);
  expect(
    (await request(app).get('/api/moderator/stats').set('Authorization', `Bearer ${token}`)).status,
  ).toBe(200);
  await prisma.donor.update({ where: { id: f.donor.id }, data: { role: 'USER' } });
  expect(
    (await request(app).get('/api/moderator/stats').set('Authorization', `Bearer ${token}`)).status,
  ).toBe(403);
});

it('reports OPEN/overdue separately from completed Sessions and all six refund record states', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  const now = new Date();
  for (const [status, session, deadline] of [
    ['OPEN', null, -1],
    ['OPEN', 'open', -1],
    ['OPEN', 'expired', -1],
    ['OPEN', 'unknown', -1],
    ['OPEN', 'complete', -1],
    ['OPEN', 'unknown', 1],
    ['OPEN', null, 0],
    ['EXPIRED', 'expired', -1],
    ['FULFILLED', 'complete', -1],
  ] as const) {
    await prisma.pendingPledge.create({
      data: {
        pledge_token: crypto.randomUUID(),
        channel_id: f.a.id,
        status,
        checkout_session_status: session,
        payment_status: session === 'complete' ? 'unpaid' : null,
        expires_at: new Date(now.getTime() + deadline * 60000),
      },
    });
  }
  const claim = await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      reward_id: f.reward.id,
      amount_cents: 100,
      status: 'CANCELLING',
    },
  });
  for (const status of [
    'REQUESTED',
    'PENDING',
    'REQUIRES_ACTION',
    'SUCCEEDED',
    'FAILED',
    'RESOLVED',
  ]) {
    await prisma.paymentRefund.create({
      data: {
        donation_id: f.donation.id,
        claim_id: claim.id,
        item_cents: 100,
        shipping_cents: 500,
        status,
        created_by: 'staff',
        created_at: new Date(now.getTime() - 120000),
        resolution: status === 'RESOLVED' ? 'REJECTED' : null,
      },
    });
  }
  await prisma.paymentRefund.create({
    data: {
      donation_id: f.donation.id,
      claim_id: claim.id,
      item_cents: 100,
      shipping_cents: 500,
      status: 'RESOLVED',
      resolution: 'RETURNED_OUTSIDE_APP',
      accepted_at: now,
      created_by: 'staff',
    },
  });
  const stats = await read(now);
  expect(stats.admin.pledges).toEqual({ open: 7, overdue: 4 });
  expect(stats.admin.payment_refunds).toEqual({ requested: 1, failed: 1 });
  expect(stats.payment_refunds).toEqual({
    requested: 1,
    pending: 1,
    requires_action: 1,
    succeeded: 1,
    failed: 1,
    resolved: 2,
  });
  expect(stats.oldest_requested_age_seconds).toBe(120);
  expect(stats.admin.total_raised_cents).toBe(700);
  const published = await assertPublished();
  for (const status of ['requested', 'pending', 'requires_action', 'succeeded', 'failed'])
    expect(published.value('dono_payment_refunds', { status })).toBe(1);
  expect(published.value('dono_payment_refunds', { status: 'resolved' })).toBe(2);
  expect(
    published.value('dono_payment_refunds_oldest_requested_age_seconds'),
  ).toBeGreaterThanOrEqual(120);
  expect(published.value('dono_payment_refunds_oldest_requested_age_seconds')).toBeLessThan(125);
  expect(published.admin.body.claims).toBe(1);
  await prisma.paymentRefund.updateMany({
    where: { status: 'REQUESTED' },
    data: { status: 'RESOLVED', resolution: 'REJECTED' },
  });
  expect((await read(now)).oldest_requested_age_seconds).toBe(0);
  const resolved = await assertPublished();
  expect(resolved.value('dono_payment_refunds_oldest_requested_age_seconds')).toBe(0);
  expect(resolved.value('dono_payment_refunds', { status: 'resolved' })).toBe(3);
});

it('separates source money and pledge from incentive allocations and shared rows', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      reward_id: f.reward.id,
      amount_cents: 200,
      status: 'CANCELLING',
    },
  });
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 300,
      source: 'auto',
    },
  });
  await prisma.fundContribution.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      goal_id: f.goal.id,
      amount_cents: 400,
      source: 'moderator',
      allocated_by: 'staff',
      allocated_at: new Date(),
    },
  });
  const stats = await read();
  expect(stats.admin).toMatchObject({
    total_raised_cents: 700,
    pledged_cents: 1000,
    claims: 1,
    wallet_credit_cents: { available: 123, held: 456 },
    shared: { allocated_cents: { reward: 0, poll: 300, goal: 0 } },
  });
  expect(stats.admin.channels.find((c) => c.id === f.a.id)).toMatchObject({
    raised_cents: 700,
    pledged_cents: 1000,
    allocated_cents: { reward: 0, poll: 0, goal: 0 },
    unused_pool_cents: { poll: 700, goal: 600 },
  });
  expect(stats.admin.channels.find((c) => c.id === f.b.id)).toMatchObject({
    raised_cents: 0,
    pledged_cents: 0,
    allocated_cents: { reward: 200, poll: 0, goal: 400 },
  });
  expect(stats.allocations).toContainEqual({
    event: f.event.slug,
    channel: f.b.slug,
    category: 'reward',
    source: 'donor',
    cents: 200,
  });
  expect(stats.allocations).toContainEqual({
    event: '',
    channel: '',
    category: 'poll',
    source: 'auto',
    cents: 300,
  });
});

it('counts one multi-source reward entitlement with effective component cents, not its whole price per source', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  const second = await prisma.donation.create({
    data: {
      donor_id: f.donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: 400,
      pledge_amount_cents: 400,
      channel_id: f.b.id,
      event_id: f.event.id,
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
  const claim = await prisma.rewardClaim.create({
    data: { donor_id: f.donor.id, reward_id: f.reward.id, amount_cents: 1000 },
  });
  for (const [donation, original, reduced] of [
    [f.donation, 300, 100],
    [f.donation, 300, 100],
    [second, 400, 100],
  ] as const) {
    const origin = await prisma.rewardClaim.create({
      data: {
        donor_id: f.donor.id,
        donation_id: donation.id,
        reward_id: f.reward.id,
        amount_cents: original,
        status: 'REVERSED',
        reversed_at: new Date(),
      },
    });
    const grant = await prisma.poolCredit.create({
      data: {
        donation_id: donation.id,
        category: 'reward',
        source_claim_id: origin.id,
        amount_cents: original,
        remaining_cents: 0,
        created_by: 'admin',
      },
    });
    await prisma.poolCreditRedemption.create({
      data: {
        credit_id: grant.id,
        batch_id: batch.id,
        claim_id: claim.id,
        amount_cents: original,
        reduced_cents: reduced,
      },
    });
  }
  const stats = await read();
  expect(stats.admin.claims).toBe(1);
  expect(stats.admin.channels.find((c) => c.id === f.b.id)?.allocated_cents.reward).toBe(700);
  expect(stats.allocations).toContainEqual({
    event: f.event.slug,
    channel: f.b.slug,
    category: 'reward',
    source: 'donor',
    cents: 700,
  });
  const { value } = await assertPublished();
  expect(value('dono_reward_claims_by_channel', { channel: f.b.slug })).toBe(1);
  await prisma.rewardClaim.update({
    where: { id: claim.id },
    data: { status: 'REVERSED', reversed_at: new Date() },
  });
  const reversed = await assertPublished();
  expect(reversed.admin.body.claims).toBe(0);
  expect(
    reversed.value('dono_incentive_allocated_cents_by_channel', {
      channel: f.b.slug,
      category: 'reward',
    }),
  ).toBeUndefined();
});

it('derives ended credit conversion before clamping Unused and excludes ended Events from moderator work', async () => {
  const f = await fixture({
    cash: 700,
    pledge: 1000,
    walletApplied: 300,
    shipping: 200,
    availableWallet: 123,
    heldWallet: 456,
    goalTarget: 1000,
  });
  await prisma.donation.update({
    where: { id: f.donation.id },
    data: { failed_payment_wallet_credit_cents: 100 },
  });
  await credit(f, 'reward', 150);
  await credit(f, 'poll', 400);
  await credit(f, 'goal', 250);
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 200,
    },
  });
  await prisma.fundContribution.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      goal_id: f.goal.id,
      amount_cents: 100,
    },
  });
  let stats = await read();
  expect(stats.admin.channels.find((c) => c.id === f.a.id)).toMatchObject({
    unused_pool_cents: { poll: 300, goal: 550 },
    pool_credit_cents: { reward: 150, poll: 400, goal: 250 },
  });
  expect(stats.moderator.unused_pool).toEqual({
    with_comment: { donations: 1, cents: { poll: 300, goal: 550 } },
    all: { donations: 1, cents: { poll: 300, goal: 550 } },
  });
  await prisma.event.update({ where: { id: f.event.id }, data: { ended_at: new Date() } });
  stats = await read();
  expect(stats.admin.channels.find((c) => c.id === f.a.id)).toMatchObject({
    unused_pool_cents: { poll: 700, goal: 800 },
    pool_credit_cents: { reward: 0, poll: 0, goal: 0 },
  });
  expect(stats.moderator.unused_pool.all).toEqual({ donations: 0, cents: { poll: 0, goal: 0 } });
  await assertPublished();
  await prisma.event.update({ where: { id: f.event.id }, data: { ended_at: null } });
  const restored = await assertPublished();
  expect(restored.admin.body.channels.find((c: { id: string }) => c.id === f.a.id)).toMatchObject({
    unused_pool_cents: { poll: 300, goal: 550 },
    pool_credit_cents: { reward: 150, poll: 400, goal: 250 },
  });
  await prisma.event.update({ where: { id: f.event.id }, data: { ended_at: new Date() } });
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 700,
      source: 'moderator',
      allocated_by: 'staff',
      allocated_at: new Date(),
    },
  });
  expect((await read()).admin.channels.find((c) => c.id === f.a.id)?.unused_pool_cents.poll).toBe(
    0,
  );
  await assertPublished();
});
