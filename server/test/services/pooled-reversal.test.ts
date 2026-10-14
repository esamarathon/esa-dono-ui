import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
import {
  setDonationStatusTx,
  previewDonationReversalTx,
  reverseSpendTx,
  refundGoalContributions,
  refundPollOptionVotes,
  setClaimStatusTx,
  acknowledgeChargebackClaimTx,
} from '../../services/reversal.js';
import { readDonationAccountingTx } from '../../services/poolAccounting.js';

vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
const donors: string[] = [];
const rewards: string[] = [];
const polls: string[] = [];
const goals: string[] = [];
const channels: string[] = [];
const events: string[] = [];
const destinations: string[] = [];

async function route(donationId: string) {
  const event = await prisma.event.create({
    data: { name: 'Reversal', slug: crypto.randomUUID() },
  });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: crypto.randomUUID(), slug: crypto.randomUUID(), event_id: event.id },
  });
  channels.push(channel.id);
  await prisma.donation.update({
    where: { id: donationId },
    data: { channel_id: channel.id, event_id: event.id },
  });
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
  return { native, tiltify, channel, event };
}
async function queued(destinationId: string) {
  return (
    await prisma.webhookDelivery.findMany({
      where: { destination_id: destinationId },
      orderBy: { seq: 'asc' },
    })
  ).map((row) => ({ type: row.message_type, payload: JSON.parse(row.payload) }));
}

async function fixture(pledge: number | null = 1000, wallet = 0, balance = 100) {
  const donor = await prisma.donor.create({
    data: {
      email: `${crypto.randomUUID()}@example.com`,
      balance_remaining: balance,
      total_donated: 1000 - wallet,
    },
  });
  donors.push(donor.id);
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: 1000 - wallet,
      pledge_amount_cents: pledge,
      wallet_applied_cents: wallet,
    },
  });
  const reward = await prisma.reward.create({
    data: { title: 'Locked price', type: 'PHYSICAL', cost_cents: 9000, quantity_claimed: 1 },
  });
  rewards.push(reward.id);
  const claim = await prisma.rewardClaim.create({
    data: {
      donor_id: donor.id,
      donation_id: donation.id,
      reward_id: reward.id,
      amount_cents: 1000 - wallet,
    },
  });
  const poll = await prisma.poll.create({
    data: {
      title: 'Poll',
      total_votes_cents: 1000,
      options: { create: { label: 'A', votes_cents: 1000 } },
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
      amount_cents: 1000,
    },
  });
  const goal = await prisma.fundGoal.create({
    data: { title: 'Goal', target_cents: 1000, current_cents: 1100, is_complete: true },
  });
  goals.push(goal.id);
  const contribution = await prisma.fundContribution.create({
    data: { donor_id: donor.id, donation_id: donation.id, goal_id: goal.id, amount_cents: 1000 },
  });
  return { donor, donation, reward, claim, poll, vote, goal, contribution };
}
function status(id: string, value: string) {
  return withWebhooks((tx, _emit, publisher) =>
    setDonationStatusTx(tx, id, value, undefined, 'admin', publisher),
  );
}
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_pooled_reversal');
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.balanceAdjustment.updateMany({
    where: { donor_id: { in: donors } },
    data: { donation_id: null },
  });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
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
    channels.length =
    events.length =
    destinations.length =
      0;
});
afterAll(() => prisma.$disconnect());

describe('ADR-0011 terminal reversals through real SQLite', () => {
  it.each([
    { status: 'REFUNDED' as const, after: 500 },
    { status: 'CHARGEBACK' as const, after: 0 },
  ])('historical PENDING preview counts zero before $status', async ({ status, after }) => {
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@example.com` },
    });
    donors.push(donor.id);
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: crypto.randomUUID(),
        status: 'PENDING',
        amount_cents: 500,
        pledge_amount_cents: null,
      },
    });
    const preview = await prisma.$transaction((tx) =>
      previewDonationReversalTx(tx, donation.id, status),
    );
    expect(preview).toMatchObject({ money_before_cents: 0, money_after_cents: after });
  });

  it.each([
    { wallet: 400, prior: 0, balance: 100, expected: 500, delta: 400 },
    { wallet: 400, prior: 250, balance: 100, expected: 250, delta: 150 },
    { wallet: 200, prior: 700, balance: 100, expected: 0, delta: -100 },
  ])(
    'chargeback returns original W minus grants, capped at available ($delta)',
    async ({ wallet, prior, balance, expected, delta }) => {
      const f = await fixture(1000, wallet, balance);
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { wallet_credit_granted_cents: prior, failed_payment_wallet_credit_cents: prior },
      });
      await prisma.rewardClaim.update({
        where: { id: f.claim.id },
        data: { status: 'FULFILLED', amount_cents: Math.min(1000 - wallet, 1000 - prior) },
      });
      if (prior) {
        await prisma.pollVote.update({
          where: { id: f.vote.id },
          data: { amount_cents: 1000 - prior },
        });
        await prisma.pollOption.update({
          where: { id: f.vote.poll_option_id },
          data: { votes_cents: 1000 - prior },
        });
        await prisma.poll.update({
          where: { id: f.poll.id },
          data: { total_votes_cents: 1000 - prior },
        });
        await prisma.fundContribution.update({
          where: { id: f.contribution.id },
          data: { amount_cents: 1000 - prior },
        });
        await prisma.fundGoal.update({
          where: { id: f.goal.id },
          data: { current_cents: 1100 - prior },
        });
      }
      const preview = await prisma.$transaction((tx) =>
        previewDonationReversalTx(tx, f.donation.id, 'CHARGEBACK'),
      );
      expect(preview).toMatchObject({
        wallet_adjustment_cents: delta,
        money_after_cents: 0,
        retained_claim_ids: [f.claim.id],
      });
      await status(f.donation.id, 'CHARGEBACK');
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: expected,
      });
      expect(await prisma.fundGoal.findUnique({ where: { id: f.goal.id } })).toMatchObject({
        current_cents: 100,
        is_complete: true,
      });
      expect(await prisma.rewardClaim.findUnique({ where: { id: f.claim.id } })).toMatchObject({
        status: 'FULFILLED',
        chargeback_flagged_at: expect.any(Date),
      });
      await expect(
        withWebhooks((tx, _emit, publisher) =>
          setClaimStatusTx(tx, f.claim.id, 'PENDING', publisher),
        ),
      ).rejects.toMatchObject({ status: 409 });
      const acknowledged = await prisma.$transaction((tx) =>
        acknowledgeChargebackClaimTx(tx, f.claim.id, 'admin', 'Shipped before bank reversal'),
      );
      expect(acknowledged).toMatchObject({
        chargeback_flagged_at: null,
        chargeback_acknowledged_at: expect.any(Date),
        chargeback_acknowledged_by: 'admin',
        chargeback_acknowledgement_note: 'Shipped before bank reversal',
      });
      await expect(status(f.donation.id, 'REFUNDED')).rejects.toMatchObject({ status: 400 });
    },
  );
  it.each(['donor', 'auto', 'moderator'])(
    'per-item %s rows return category credit or computed Unused, never Wallet',
    async (source) => {
      const f = await fixture();
      await prisma.pollVote.update({
        where: { id: f.vote.id },
        data: {
          source,
          ...(source === 'moderator'
            ? { allocated_by: 'staff-marker', allocated_at: new Date() }
            : {}),
        },
      });
      await prisma.fundContribution.update({
        where: { id: f.contribution.id },
        data: {
          source,
          ...(source === 'moderator'
            ? { allocated_by: 'staff-marker', allocated_at: new Date() }
            : {}),
        },
      });
      await withWebhooks(async (tx, _emit, publisher) => {
        await refundPollOptionVotes(tx, f.vote.poll_option_id, 'admin', publisher);
        await refundGoalContributions(tx, f.goal.id, 'admin', publisher);
      });
      const state = await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id));
      expect(state.pools.poll).toMatchObject({
        live_cents: 0,
        pool_credit_cents: source === 'moderator' ? 0 : 1000,
        unused_cents: source === 'moderator' ? 1000 : 0,
        used_cents: 1000,
      });
      expect(state.pools.goal).toMatchObject({
        live_cents: 0,
        pool_credit_cents: source === 'moderator' ? 0 : 1000,
        unused_cents: source === 'moderator' ? 1000 : 0,
      });
      expect(JSON.stringify(state)).not.toContain('staff-marker');
      expect(JSON.stringify(state)).not.toContain(f.donor.email);
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(0);
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: 100,
      });
    },
  );

  it.each([
    { retained: 0, prior: 0, delta: 1000 },
    { retained: 600, prior: 100, delta: 300 },
    { retained: 1000, prior: 0, delta: 0 },
  ])(
    'Wallet refund max rule retains $retained and subtracts $prior prior grants',
    async ({ retained, prior, delta }) => {
      const f = await fixture();
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { wallet_credit_granted_cents: prior, failed_payment_wallet_credit_cents: prior },
      });
      if (retained)
        await prisma.rewardClaim.update({
          where: { id: f.claim.id },
          data: { status: 'FULFILLED', amount_cents: retained },
        });
      if (prior) {
        await prisma.pollVote.update({
          where: { id: f.vote.id },
          data: { amount_cents: 1000 - prior },
        });
        await prisma.poll.update({
          where: { id: f.poll.id },
          data: { total_votes_cents: 1000 - prior },
        });
        await prisma.pollOption.update({
          where: { id: f.vote.poll_option_id },
          data: { votes_cents: 1000 - prior },
        });
      }
      await withWebhooks((tx, _emit, publisher) =>
        reverseSpendTx(tx, f.donor.id, 'vote', f.vote.id, 'admin', publisher),
      );
      expect(
        (await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id))).pools.poll
          .outstanding_credit_cents,
      ).toBe(1000 - prior);
      await status(f.donation.id, 'REFUNDED');
      const accounting = await prisma.$transaction((tx) =>
        readDonationAccountingTx(tx, f.donation.id),
      );
      expect(accounting.pools.poll).toMatchObject({ outstanding_credit_cents: 0, unused_cents: 0 });
      expect(accounting.pools.goal).toMatchObject({ outstanding_credit_cents: 0, unused_cents: 0 });
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: 100 + delta,
      });
      expect(
        await prisma.poolCredit.findMany({ where: { donation_id: f.donation.id } }),
      ).toMatchObject([{ remaining_cents: 0, cleared_at: expect.any(Date), cleared_by: 'admin' }]);
    },
  );

  it.each([
    { kind: 'claim', source: 'donor', category: 'reward' as const },
    { kind: 'vote', source: 'donor', category: 'poll' as const },
    { kind: 'vote', source: 'auto', category: 'poll' as const },
    { kind: 'vote', source: 'moderator', category: 'poll' as const },
    { kind: 'contribution', source: 'donor', category: 'goal' as const },
    { kind: 'contribution', source: 'auto', category: 'goal' as const },
    { kind: 'contribution', source: 'moderator', category: 'goal' as const },
  ])(
    'concurrent pooled $source $kind reversals preserve provenance and grant once',
    async ({ kind, source, category }) => {
      const f = await fixture();
      const { native, tiltify } = await route(f.donation.id);
      if (kind === 'vote')
        await prisma.pollVote.update({
          where: { id: f.vote.id },
          data: {
            source,
            ...(source === 'moderator'
              ? { allocated_by: 'staff-marker', allocated_at: new Date() }
              : {}),
          },
        });
      if (kind === 'contribution')
        await prisma.fundContribution.update({
          where: { id: f.contribution.id },
          data: {
            source,
            ...(source === 'moderator'
              ? { allocated_by: 'staff-marker', allocated_at: new Date() }
              : {}),
          },
        });
      const id = kind === 'claim' ? f.claim.id : kind === 'vote' ? f.vote.id : f.contribution.id;
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          withWebhooks((tx, _emit, publisher) =>
            reverseSpendTx(tx, f.donor.id, kind, id, 'admin', publisher),
          ),
        ),
      );
      expect(results.map((row) => row.status).sort()).toEqual(['fulfilled', 'rejected']);
      const state = await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id));
      expect(state.pools[category]).toMatchObject({
        live_cents: 0,
        pool_credit_cents: source === 'moderator' ? 0 : 1000,
        unused_cents: source === 'moderator' ? 1000 : 0,
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(0);
      expect(await queued(native.id)).toHaveLength(1);
      expect((await queued(tiltify.id)).map((row) => row.type)).toEqual(['tiltify.donation']);
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: 100,
      });
    },
  );

  it.each(['REFUNDED', 'CHARGEBACK'])(
    'legacy %s uses the sum of live linked rows, not Pools or the live reward price',
    async (action) => {
      const f = await fixture(null, 0, 50);
      await prisma.rewardClaim.update({
        where: { id: f.claim.id },
        data: { amount_cents: 200, status: 'FULFILLED' },
      });
      await prisma.pollVote.update({ where: { id: f.vote.id }, data: { amount_cents: 300 } });
      await prisma.fundContribution.update({
        where: { id: f.contribution.id },
        data: { amount_cents: 400 },
      });
      await status(f.donation.id, action);
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: action === 'REFUNDED' ? 750 : 0,
      });
      expect(await prisma.rewardClaim.findUnique({ where: { id: f.claim.id } })).toMatchObject({
        status: 'FULFILLED',
        reversed_at: null,
      });
      expect(await prisma.poolCredit.count({ where: { donation_id: f.donation.id } })).toBe(0);
    },
  );

  it.each(['claim', 'vote', 'contribution'])(
    'blocks charged-back %s reverse-spend without repairing terminal history',
    async (kind) => {
      const f = await fixture(null);
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { status: 'CHARGEBACK' },
      });
      const id = kind === 'claim' ? f.claim.id : kind === 'vote' ? f.vote.id : f.contribution.id;
      await expect(
        withWebhooks((tx, _emit, publisher) =>
          reverseSpendTx(tx, f.donor.id, kind, id, 'admin', publisher),
        ),
      ).rejects.toMatchObject({ status: 409 });
      await withWebhooks(async (tx, _emit, publisher) => {
        await refundGoalContributions(tx, f.goal.id, 'admin', publisher);
        await refundPollOptionVotes(tx, f.vote.poll_option_id, 'admin', publisher);
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(0);
      expect(await prisma.rewardClaim.findUnique({ where: { id: f.claim.id } })).toMatchObject({
        reversed_at: null,
      });
    },
  );

  it('a retained shipped claim marked pending after Wallet refund returns recorded reward Pool credit', async () => {
    const f = await fixture();
    await prisma.rewardClaim.update({
      where: { id: f.claim.id },
      data: { status: 'FULFILLED', amount_cents: 600 },
    });
    await status(f.donation.id, 'REFUNDED');
    await withWebhooks(async (tx, _emit, publisher) => {
      await setClaimStatusTx(tx, f.claim.id, 'PENDING', publisher);
      await reverseSpendTx(tx, f.donor.id, 'claim', f.claim.id, 'admin', publisher);
    });
    const accounting = await prisma.$transaction((tx) =>
      readDonationAccountingTx(tx, f.donation.id),
    );
    expect(accounting.pools.reward).toMatchObject({ live_cents: 0, pool_credit_cents: 600 });
    expect(accounting.pools.poll.unused_cents).toBe(0);
    expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
      balance_remaining: 500,
    });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(1);
  });

  it('legacy chargeback returns the linked Wallet-funded excess when live allocations exceed new money', async () => {
    const f = await fixture(null);
    await prisma.rewardClaim.update({ where: { id: f.claim.id }, data: { amount_cents: 400 } });
    await prisma.pollVote.update({ where: { id: f.vote.id }, data: { amount_cents: 600 } });
    await prisma.fundContribution.update({
      where: { id: f.contribution.id },
      data: { amount_cents: 400 },
    });
    await status(f.donation.id, 'CHARGEBACK');
    expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
      balance_remaining: 500,
    });
    expect(
      await prisma.balanceAdjustment.findMany({ where: { donor_id: f.donor.id } }),
    ).toMatchObject([{ type: 'CHARGEBACK', amount_cents: 400 }]);
  });

  it('safe accounting derives ended-category credit without transfers and keeps reward credit reserved', async () => {
    const f = await fixture();
    const { event } = await route(f.donation.id);
    await withWebhooks(async (tx, _emit, publisher) => {
      await reverseSpendTx(tx, f.donor.id, 'claim', f.claim.id, 'admin', publisher);
      await reverseSpendTx(tx, f.donor.id, 'vote', f.vote.id, 'admin', publisher);
      await reverseSpendTx(tx, f.donor.id, 'contribution', f.contribution.id, 'admin', publisher);
    });
    await prisma.event.update({ where: { id: event.id }, data: { ended_at: new Date() } });
    const ended = await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id));
    expect(ended.pools.reward).toMatchObject({
      pool_credit_cents: 0,
      unused_cents: 0,
      used_cents: 1000,
      outstanding_credit_cents: 1000,
    });
    expect(ended.pools.poll).toMatchObject({
      pool_credit_cents: 0,
      unused_cents: 1000,
      used_cents: 1000,
    });
    expect(ended.pools.goal).toMatchObject({
      pool_credit_cents: 0,
      unused_cents: 1000,
      used_cents: 1000,
    });
    await prisma.event.update({ where: { id: event.id }, data: { ended_at: null } });
    const reopened = await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id));
    expect(reopened.pools.poll).toMatchObject({ pool_credit_cents: 1000, unused_cents: 0 });
    expect(reopened.pools.reward).toMatchObject({ pool_credit_cents: 1000 });
    expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
      balance_remaining: 100,
    });
  });

  it('REQUESTED Payment refund blocks every conflicting mutation and zero money blocks chargeback', async () => {
    const f = await fixture();
    await prisma.paymentRefund.create({
      data: {
        donation_id: f.donation.id,
        claim_id: f.claim.id,
        item_cents: 1000,
        created_by: 'admin',
      },
    });
    await expect(status(f.donation.id, 'REFUNDED')).rejects.toMatchObject({ status: 409 });
    await expect(status(f.donation.id, 'CHARGEBACK')).rejects.toMatchObject({ status: 409 });
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        setClaimStatusTx(tx, f.claim.id, 'FULFILLED', publisher),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        reverseSpendTx(tx, f.donor.id, 'claim', f.claim.id, 'admin', publisher),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await prisma.paymentRefund.deleteMany({ where: { donation_id: f.donation.id } });
    await prisma.donation.update({
      where: { id: f.donation.id },
      data: { amount_cents: 0, wallet_applied_cents: 1000 },
    });
    await expect(status(f.donation.id, 'CHARGEBACK')).rejects.toMatchObject({ status: 400 });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(0);
  });

  it.each(['REFUNDED', 'CHARGEBACK'])(
    'concurrent %s reverses all sources once and queues live-only full state atomically',
    async (action) => {
      const f = await fixture();
      const { native, tiltify } = await route(f.donation.id);
      await prisma.pollVote.update({ where: { id: f.vote.id }, data: { source: 'auto' } });
      await prisma.fundContribution.update({
        where: { id: f.contribution.id },
        data: { source: 'moderator', allocated_by: 'staff-marker', allocated_at: new Date() },
      });
      const results = await Promise.allSettled([
        status(f.donation.id, action),
        status(f.donation.id, action),
      ]);
      expect(results.map((row) => row.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(1);
      const messages = await queued(native.id);
      expect(messages).toMatchObject([
        {
          type: 'donation.updated',
          payload: {
            data: {
              status: action,
              amount_cents: 1000,
              pledge_amount_cents: 1000,
              allocations: { reward: [], poll: [], goal: [] },
            },
          },
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain('staff-marker');
      const alerts = await queued(tiltify.id);
      expect(alerts.map((row) => row.type)).toEqual(
        action === 'REFUNDED'
          ? ['tiltify.donation']
          : ['tiltify.donation', 'tiltify.fact.updated', 'tiltify.fact.updated'],
      );
      expect(alerts[0]!.payload).toMatchObject({
        id: f.donation.id,
        amount: { value: '10.00' },
        reward_claims: [],
        poll_votes: [],
        target_contributions: [],
      });
    },
  );

  it.each(['REFUNDED', 'CHARGEBACK'])(
    'a competing item reversal and %s cannot mint extra Wallet money',
    async (action) => {
      const f = await fixture();
      const results = await Promise.allSettled([
        withWebhooks((tx, _emit, publisher) =>
          reverseSpendTx(tx, f.donor.id, 'vote', f.vote.id, 'admin', publisher),
        ),
        status(f.donation.id, action),
      ]);
      expect(results[1]!.status).toBe('fulfilled');
      const accounting = await prisma.$transaction((tx) =>
        readDonationAccountingTx(tx, f.donation.id),
      );
      expect(accounting.pools.poll).toMatchObject({
        live_cents: 0,
        outstanding_credit_cents: 0,
        unused_cents: 0,
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: f.donor.id } })).toBe(1);
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: action === 'REFUNDED' ? 1100 : 100,
      });
    },
  );

  it.each(['REFUNDED', 'CHARGEBACK'])(
    'a later %s uses reduced D and only the remaining donation money',
    async (action) => {
      const f = await fixture(1000, 400);
      const { tiltify } = await route(f.donation.id);
      // An earlier accepted Payment refund removed 200 cash and shrank the Pools.
      await prisma.donation.update({
        where: { id: f.donation.id },
        data: { amount_cents: 400, pledge_amount_cents: 800 },
      });
      await prisma.rewardClaim.update({ where: { id: f.claim.id }, data: { amount_cents: 400 } });
      await prisma.pollVote.update({ where: { id: f.vote.id }, data: { amount_cents: 800 } });
      await prisma.pollOption.update({
        where: { id: f.vote.poll_option_id },
        data: { votes_cents: 800 },
      });
      await prisma.poll.update({ where: { id: f.poll.id }, data: { total_votes_cents: 800 } });
      await prisma.fundContribution.update({
        where: { id: f.contribution.id },
        data: { amount_cents: 800 },
      });
      await status(f.donation.id, action);
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: action === 'REFUNDED' ? 900 : 500,
      });
      const messages = await queued(tiltify.id);
      expect(messages[0]!.payload.amount.value).toBe('4.00');
      const totals = messages.filter((row) => row.type === 'tiltify.fact.updated');
      expect(totals).toHaveLength(action === 'REFUNDED' ? 0 : 2);
      for (const message of totals) expect(message.payload.total_amount_raised.value).toBe('0.00');
    },
  );

  it.each(['REFUNDED', 'CHARGEBACK', 'item'])(
    'late SQL failure rolls back %s allocations, credit, tallies, stock, flags and queued messages',
    async (action) => {
      const f = await fixture();
      const { native, tiltify } = await route(f.donation.id);
      if (action === 'CHARGEBACK')
        await prisma.rewardClaim.update({
          where: { id: f.claim.id },
          data: { status: 'FULFILLED' },
        });
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER fail_pooled_reversal BEFORE INSERT ON WebhookDelivery WHEN NEW.destination_id = '${tiltify.id}' BEGIN SELECT RAISE(ABORT, 'late outbox failure'); END`,
      );
      await expect(
        action === 'item'
          ? withWebhooks((tx, _emit, publisher) =>
              reverseSpendTx(tx, f.donor.id, 'claim', f.claim.id, 'admin', publisher),
            )
          : status(f.donation.id, action),
      ).rejects.toThrow();
      const accounting = await prisma.$transaction((tx) =>
        readDonationAccountingTx(tx, f.donation.id),
      );
      expect(accounting).toMatchObject({
        status: 'COMPLETED',
        wallet_credit_granted_cents: 0,
        pools: {
          reward: { live_cents: 1000, pool_credit_cents: 0 },
          poll: { live_cents: 1000 },
          goal: { live_cents: 1000 },
        },
      });
      expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
        quantity_claimed: 1,
      });
      expect(await prisma.fundGoal.findUnique({ where: { id: f.goal.id } })).toMatchObject({
        current_cents: 1100,
        is_complete: true,
      });
      expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
        balance_remaining: 100,
      });
      expect(await prisma.rewardClaim.findUnique({ where: { id: f.claim.id } })).toMatchObject({
        status: action === 'CHARGEBACK' ? 'FULFILLED' : 'PENDING',
        chargeback_flagged_at: null,
      });
      expect(await queued(native.id)).toEqual([]);
      expect(await queued(tiltify.id)).toEqual([]);
    },
  );

  it('Wallet refund returns D=$10, not the $30 backed allocations, with money unchanged', async () => {
    const f = await fixture();
    const result = await status(f.donation.id, 'REFUNDED');
    expect(result).toMatchObject({
      status: 'REFUNDED',
      amount_cents: 1000,
      wallet_credit_granted_cents: 1000,
    });
    expect(JSON.stringify(result)).not.toContain(f.donor.email);
    expect(await prisma.donor.findUnique({ where: { id: f.donor.id } })).toMatchObject({
      balance_remaining: 1100,
      total_donated: 1000,
    });
    expect(await prisma.rewardClaim.findUnique({ where: { id: f.claim.id } })).toMatchObject({
      status: 'REVERSED',
    });
    expect(await prisma.reward.findUnique({ where: { id: f.reward.id } })).toMatchObject({
      quantity_claimed: 0,
    });
    expect(await prisma.poll.findUnique({ where: { id: f.poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.fundGoal.findUnique({ where: { id: f.goal.id } })).toMatchObject({
      current_cents: 100,
      is_complete: false,
    });
    expect(
      await prisma.balanceAdjustment.findMany({ where: { donor_id: f.donor.id } }),
    ).toMatchObject([{ type: 'WALLET_REFUND', amount_cents: 1000, donation_id: f.donation.id }]);
  });
});
