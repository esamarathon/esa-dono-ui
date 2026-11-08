import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../../lib/databaseClient.js';

const prisma = createDatabaseClient();
const events: string[] = [];
const donors: string[] = [];
const pledgeTokens: string[] = [];

async function event() {
  const row = await prisma.event.create({ data: { name: 'Invariants', slug: randomUUID() } });
  events.push(row.id);
  return row;
}

async function donor() {
  const row = await prisma.donor.create({ data: { email: `${randomUUID()}@invariants.example` } });
  donors.push(row.id);
  return row;
}

async function fixture() {
  const owner = await event();
  const channel = await prisma.channel.create({
    data: { event_id: owner.id, name: randomUUID(), slug: randomUUID() },
  });
  return { event: owner, channel, donor: await donor() };
}

function pledge(data: Partial<Prisma.PendingPledgeUncheckedCreateInput>) {
  const token = randomUUID();
  pledgeTokens.push(token);
  return prisma.pendingPledge.create({
    data: { pledge_token: token, expires_at: new Date(Date.now() + 60_000), ...data },
  });
}

async function allocations() {
  const f = await fixture();
  const donation = await prisma.donation.create({
    data: {
      donor_id: f.donor.id,
      event_id: f.event.id,
      channel_id: f.channel.id,
      external_id: randomUUID(),
      amount_cents: 100,
      pledge_amount_cents: 100,
    },
  });
  const reward = await prisma.reward.create({
    data: { title: 'Reward', type: 'DIGITAL', cost_cents: 100, event_id: f.event.id },
  });
  const poll = await prisma.poll.create({ data: { title: 'Poll', event_id: f.event.id } });
  const option = await prisma.pollOption.create({ data: { poll_id: poll.id, label: 'Yes' } });
  const goal = await prisma.fundGoal.create({
    data: { title: 'Goal', target_cents: 100, event_id: f.event.id },
  });
  const claim = await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: donation.id,
      reward_id: reward.id,
      amount_cents: 100,
    },
  });
  const vote = await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: donation.id,
      poll_id: poll.id,
      poll_option_id: option.id,
      amount_cents: 100,
    },
  });
  const contribution = await prisma.fundContribution.create({
    data: { donor_id: f.donor.id, donation_id: donation.id, goal_id: goal.id, amount_cents: 100 },
  });
  return { ...f, donation, reward, poll, option, goal, claim, vote, contribution };
}

async function redemptionFixture() {
  const f = await allocations();
  const credit = await prisma.poolCredit.create({
    data: {
      donation_id: f.donation.id,
      category: 'reward',
      source_claim_id: f.claim.id,
      amount_cents: 100,
      remaining_cents: 100,
      created_by: 'admin',
    },
  });
  const batch = await prisma.poolCreditBatch.create({
    data: {
      donor_id: f.donor.id,
      event_id: f.event.id,
      idempotency_key: randomUUID(),
      request_data: '{}',
    },
  });
  return { ...f, credit, batch };
}

afterEach(async () => {
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: { in: pledgeTokens } } });
  await prisma.poolCreditRedemption.deleteMany({ where: { batch: { donor_id: { in: donors } } } });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { event_id: { in: events } } });
  await prisma.poll.deleteMany({ where: { event_id: { in: events } } });
  await prisma.fundGoal.deleteMany({ where: { event_id: { in: events } } });
  await prisma.auction.deleteMany({ where: { event_id: { in: events } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  events.length = donors.length = pledgeTokens.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('current-schema database invariants', () => {
  describe('Pending pledge shape and Wallet hold', () => {
    it('accepts legacy totals with a null pledge amount and zero-valued pooled pledges', async () => {
      await expect(
        pledge({
          format: 'LEGACY',
          pledge_amount_cents: null,
          new_money_cents: null,
          total_cents: 1000,
          top_up_cents: 100,
          wallet_discount_cents: 200,
        }),
      ).resolves.toMatchObject({ format: 'LEGACY', pledge_amount_cents: null });
      await expect(
        pledge({
          format: 'POOLED',
          pledge_amount_cents: 0,
          new_money_cents: 0,
          draft_id: randomUUID(),
          confirmed_plan: '{}',
          held_wallet_cents: 0,
          wallet_hold_status: 'NONE',
          total_cents: 0,
          top_up_cents: 0,
          wallet_discount_cents: 0,
        }),
      ).resolves.toMatchObject({ pledge_amount_cents: 0, new_money_cents: 0 });
    });

    it.each([
      { format: 'UNKNOWN' },
      { format: 'LEGACY', pledge_amount_cents: 1000 },
      { pledge_amount_cents: null },
      { pledge_amount_cents: -1 },
      { draft_id: null },
      { confirmed_plan: null },
      { new_money_cents: null },
      { new_money_cents: -1, pledge_amount_cents: 299 },
      { pledge_amount_cents: 999 },
      { total_cents: 1 },
      { top_up_cents: 1 },
      { wallet_discount_cents: 1 },
    ] satisfies Partial<Prisma.PendingPledgeUncheckedCreateInput>[])(
      'rejects invalid pooled/legacy shape on insert and update: %j',
      async (invalid) => {
        const f = await fixture();
        const valid = {
          format: 'POOLED',
          pledge_amount_cents: 1000,
          new_money_cents: 700,
          held_wallet_cents: 300,
          wallet_donor_id: f.donor.id,
          wallet_hold_status: 'HELD',
          draft_id: randomUUID(),
          confirmed_plan: '{}',
          total_cents: 0,
          top_up_cents: 0,
          wallet_discount_cents: 0,
        };
        // Keep draft uniqueness out of shape failures.
        const row = await pledge({ ...valid, status: 'CANCELLED' });
        await expect(pledge({ ...valid, ...invalid })).rejects.toThrow();
        await expect(
          prisma.pendingPledge.update({
            where: { id: row.id },
            data: invalid,
          }),
        ).rejects.toThrow();
        expect(await prisma.pendingPledge.findUnique({ where: { id: row.id } })).toMatchObject(
          valid,
        );
      },
    );

    it.each(['HELD', 'CONSUMED', 'RELEASED'])(
      'accepts positive Wallet holds with a donor and %s status, including Wallet-only pooled funding',
      async (wallet_hold_status) => {
        const owner = await donor();
        await expect(
          pledge({
            format: 'POOLED',
            pledge_amount_cents: 300,
            new_money_cents: 0,
            draft_id: randomUUID(),
            confirmed_plan: '{}',
            held_wallet_cents: 300,
            wallet_donor_id: owner.id,
            wallet_hold_status,
          }),
        ).resolves.toMatchObject({ held_wallet_cents: 300, wallet_hold_status });
      },
    );

    it.each([
      { held_wallet_cents: -1, wallet_hold_status: 'NONE', hasDonor: true },
      { held_wallet_cents: 0, wallet_hold_status: 'HELD', hasDonor: true },
      { held_wallet_cents: 0, wallet_hold_status: 'CONSUMED', hasDonor: true },
      { held_wallet_cents: 0, wallet_hold_status: 'RELEASED', hasDonor: true },
      { held_wallet_cents: 0, wallet_hold_status: 'UNKNOWN', hasDonor: true },
      { held_wallet_cents: 100, wallet_hold_status: 'NONE', hasDonor: true },
      { held_wallet_cents: 100, wallet_hold_status: 'UNKNOWN', hasDonor: true },
      { held_wallet_cents: 100, wallet_hold_status: 'HELD', hasDonor: false },
      { held_wallet_cents: 100, wallet_hold_status: 'CONSUMED', hasDonor: false },
      { held_wallet_cents: 100, wallet_hold_status: 'RELEASED', hasDonor: false },
    ])('rejects invalid Wallet hold on insert and update: %j', async ({ hasDonor, ...hold }) => {
      const owner = await donor();
      const row = await pledge({
        format: 'LEGACY',
        held_wallet_cents: 100,
        wallet_hold_status: 'HELD',
        wallet_donor_id: owner.id,
      });
      const invalid = { ...hold, wallet_donor_id: hasDonor ? owner.id : null };
      await expect(pledge({ format: 'LEGACY', ...invalid })).rejects.toThrow();
      await expect(
        prisma.pendingPledge.update({
          where: { id: row.id },
          data: invalid,
        }),
      ).rejects.toThrow();
      expect(await prisma.pendingPledge.findUnique({ where: { id: row.id } })).toMatchObject({
        held_wallet_cents: 100,
        wallet_hold_status: 'HELD',
        wallet_donor_id: owner.id,
      });
    });
  });

  describe.each(['poll', 'goal'] as const)('%s allocation source and attribution', (kind) => {
    it.each([
      { source: 'donor', allocated_by: null, allocated_at: null },
      { source: 'auto', allocated_by: null, allocated_at: null },
      { source: 'moderator', allocated_by: 'mod', allocated_at: new Date('2026-01-01') },
    ])('accepts valid attribution: %j', async (attribution) => {
      const f = await allocations();
      const data = { donor_id: f.donor.id, amount_cents: 100, ...attribution };
      const row =
        kind === 'poll'
          ? await prisma.pollVote.create({
              data: { ...data, poll_id: f.poll.id, poll_option_id: f.option.id },
            })
          : await prisma.fundContribution.create({ data: { ...data, goal_id: f.goal.id } });
      expect(row).toMatchObject(attribution);
    });

    it.each([
      { source: 'UNKNOWN', allocated_by: 'mod', allocated_at: new Date('2026-01-01') },
      { source: 'moderator', allocated_by: null, allocated_at: null },
      { source: 'moderator', allocated_by: 'mod', allocated_at: null },
      { source: 'moderator', allocated_by: null, allocated_at: new Date('2026-01-01') },
    ])('rejects invalid source/attribution on insert and update: %j', async (attribution) => {
      const f = await allocations();
      const data = { donor_id: f.donor.id, amount_cents: 100, ...attribution };
      const create = () =>
        kind === 'poll'
          ? prisma.pollVote.create({
              data: { ...data, poll_id: f.poll.id, poll_option_id: f.option.id },
            })
          : prisma.fundContribution.create({ data: { ...data, goal_id: f.goal.id } });
      const update = () =>
        kind === 'poll'
          ? prisma.pollVote.update({ where: { id: f.vote.id }, data: attribution })
          : prisma.fundContribution.update({ where: { id: f.contribution.id }, data: attribution });
      await expect(create()).rejects.toThrow();
      await expect(update()).rejects.toThrow();
      const row =
        kind === 'poll'
          ? await prisma.pollVote.findUnique({ where: { id: f.vote.id } })
          : await prisma.fundContribution.findUnique({ where: { id: f.contribution.id } });
      expect(row).toMatchObject({ source: 'donor', allocated_by: null, allocated_at: null });
    });
  });

  describe('Pool credit grant bounds and provenance', () => {
    it.each([0, 100])(
      'accepts remaining credit at the inclusive boundary %i',
      async (remaining_cents) => {
        const f = await allocations();
        await expect(
          prisma.poolCredit.create({
            data: {
              donation_id: f.donation.id,
              category: 'reward',
              source_claim_id: f.claim.id,
              amount_cents: 100,
              remaining_cents,
              created_by: 'admin',
            },
          }),
        ).resolves.toMatchObject({ amount_cents: 100, remaining_cents });
      },
    );

    it.each([
      { amount_cents: 0, remaining_cents: 0 },
      { amount_cents: -1, remaining_cents: 0 },
      { amount_cents: 100, remaining_cents: -1 },
      { amount_cents: 100, remaining_cents: 101 },
    ])('rejects invalid grant bounds on insert and update: %j', async (bounds) => {
      const f = await allocations();
      const data = {
        donation_id: f.donation.id,
        category: 'reward',
        source_claim_id: f.claim.id,
        amount_cents: 100,
        remaining_cents: 100,
        created_by: 'admin',
      };
      await expect(prisma.poolCredit.create({ data: { ...data, ...bounds } })).rejects.toThrow();
      const credit = await prisma.poolCredit.create({ data });
      await expect(
        prisma.poolCredit.update({ where: { id: credit.id }, data: bounds }),
      ).rejects.toThrow();
      expect(await prisma.poolCredit.findUnique({ where: { id: credit.id } })).toMatchObject({
        amount_cents: 100,
        remaining_cents: 100,
      });
    });

    it('accepts each category origin once, permits nullable other sources, and rejects duplicate origins', async () => {
      const f = await allocations();
      const sources = [
        { category: 'reward', source_claim_id: f.claim.id },
        { category: 'poll', source_vote_id: f.vote.id },
        { category: 'goal', source_contribution_id: f.contribution.id },
      ];
      for (const source of sources) {
        const data = {
          donation_id: f.donation.id,
          amount_cents: 100,
          remaining_cents: 100,
          created_by: 'admin',
          ...source,
        };
        await expect(prisma.poolCredit.create({ data })).resolves.toMatchObject(source);
        await expect(prisma.poolCredit.create({ data })).rejects.toMatchObject({ code: 'P2002' });
      }
      expect(await prisma.poolCredit.count({ where: { donation_id: f.donation.id } })).toBe(3);
    });

    it.each([
      { category: 'UNKNOWN', claim: true, vote: false, contribution: false },
      { category: 'reward', claim: false, vote: false, contribution: false },
      { category: 'poll', claim: false, vote: false, contribution: false },
      { category: 'goal', claim: false, vote: false, contribution: false },
      { category: 'reward', claim: false, vote: true, contribution: false },
      { category: 'poll', claim: false, vote: false, contribution: true },
      { category: 'goal', claim: true, vote: false, contribution: false },
      { category: 'reward', claim: true, vote: true, contribution: false },
      { category: 'poll', claim: false, vote: true, contribution: true },
      { category: 'goal', claim: true, vote: false, contribution: true },
      { category: 'reward', claim: true, vote: true, contribution: true },
    ])(
      'rejects missing, wrong-category or multiple origins on insert and update: %j',
      async (origin) => {
        const f = await allocations();
        const data = {
          donation_id: f.donation.id,
          category: 'reward',
          source_claim_id: f.claim.id,
          amount_cents: 100,
          remaining_cents: 100,
          created_by: 'admin',
        };
        const invalid = {
          category: origin.category,
          source_claim_id: origin.claim ? f.claim.id : null,
          source_vote_id: origin.vote ? f.vote.id : null,
          source_contribution_id: origin.contribution ? f.contribution.id : null,
        };
        await expect(prisma.poolCredit.create({ data: { ...data, ...invalid } })).rejects.toThrow();
        const credit = await prisma.poolCredit.create({ data });
        await expect(
          prisma.poolCredit.update({ where: { id: credit.id }, data: invalid }),
        ).rejects.toThrow();
        expect(await prisma.poolCredit.findUnique({ where: { id: credit.id } })).toMatchObject({
          category: 'reward',
          source_claim_id: f.claim.id,
          source_vote_id: null,
          source_contribution_id: null,
        });
      },
    );
  });

  describe('Pool credit redemptions', () => {
    it.each(['claim_id', 'vote_id', 'contribution_id'] as const)(
      'accepts a single %s target and reductions at both inclusive boundaries',
      async (target) => {
        const f = await redemptionFixture();
        const targets = {
          claim_id: f.claim.id,
          vote_id: f.vote.id,
          contribution_id: f.contribution.id,
        };
        for (const reduced_cents of [0, 100]) {
          await expect(
            prisma.poolCreditRedemption.create({
              data: {
                credit_id: f.credit.id,
                batch_id: f.batch.id,
                amount_cents: 100,
                reduced_cents,
                [target]: targets[target],
              },
            }),
          ).resolves.toMatchObject({ amount_cents: 100, reduced_cents, [target]: targets[target] });
        }
      },
    );

    it.each([
      { claim: false, vote: false, contribution: false },
      { claim: true, vote: true, contribution: false },
      { claim: true, vote: false, contribution: true },
      { claim: false, vote: true, contribution: true },
      { claim: true, vote: true, contribution: true },
    ])('rejects zero or several targets on insert and update: %j', async (targets) => {
      const f = await redemptionFixture();
      const data = {
        credit_id: f.credit.id,
        batch_id: f.batch.id,
        amount_cents: 100,
        claim_id: f.claim.id,
      };
      const invalid = {
        claim_id: targets.claim ? f.claim.id : null,
        vote_id: targets.vote ? f.vote.id : null,
        contribution_id: targets.contribution ? f.contribution.id : null,
      };
      await expect(
        prisma.poolCreditRedemption.create({ data: { ...data, ...invalid } }),
      ).rejects.toThrow();
      const row = await prisma.poolCreditRedemption.create({ data });
      await expect(
        prisma.poolCreditRedemption.update({ where: { id: row.id }, data: invalid }),
      ).rejects.toThrow();
      expect(await prisma.poolCreditRedemption.findUnique({ where: { id: row.id } })).toMatchObject(
        {
          claim_id: f.claim.id,
          vote_id: null,
          contribution_id: null,
        },
      );
    });

    it.each([
      { amount_cents: 0, reduced_cents: 0 },
      { amount_cents: -1, reduced_cents: 0 },
      { amount_cents: 100, reduced_cents: -1 },
      { amount_cents: 100, reduced_cents: 101 },
    ])('rejects invalid consumption/reduction bounds on insert and update: %j', async (bounds) => {
      const f = await redemptionFixture();
      const data = {
        credit_id: f.credit.id,
        batch_id: f.batch.id,
        claim_id: f.claim.id,
        amount_cents: 100,
        reduced_cents: 0,
      };
      await expect(
        prisma.poolCreditRedemption.create({ data: { ...data, ...bounds } }),
      ).rejects.toThrow();
      const row = await prisma.poolCreditRedemption.create({ data });
      await expect(
        prisma.poolCreditRedemption.update({ where: { id: row.id }, data: bounds }),
      ).rejects.toThrow();
      expect(await prisma.poolCreditRedemption.findUnique({ where: { id: row.id } })).toMatchObject(
        {
          amount_cents: 100,
          reduced_cents: 0,
        },
      );
    });
  });

  it('makes batch idempotency keys unique per donor, not per Event or globally', async () => {
    const f = await fixture();
    const otherEvent = await event();
    const otherDonor = await donor();
    const data = {
      donor_id: f.donor.id,
      event_id: f.event.id,
      idempotency_key: randomUUID(),
      request_data: '{}',
    };
    await prisma.poolCreditBatch.create({ data });
    await expect(
      prisma.poolCreditBatch.create({ data: { ...data, event_id: otherEvent.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.poolCreditBatch.create({ data: { ...data, donor_id: otherDonor.id } }),
    ).resolves.toMatchObject({ idempotency_key: data.idempotency_key });
    const otherKey = await prisma.poolCreditBatch.create({
      data: { ...data, idempotency_key: randomUUID() },
    });
    await expect(
      prisma.poolCreditBatch.update({
        where: { id: otherKey.id },
        data: { idempotency_key: data.idempotency_key },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows only one OPEN pledge per non-null draft and releases the slot on status change', async () => {
    const draft_id = randomUUID();
    const open = await pledge({ format: 'LEGACY', status: 'OPEN', draft_id });
    await expect(pledge({ format: 'LEGACY', status: 'OPEN', draft_id })).rejects.toMatchObject({
      code: 'P2002',
    });
    const closed = [];
    for (const status of ['FULFILLED', 'EXPIRED', 'CANCELLED', 'PAYMENT_REVIEW']) {
      closed.push(await pledge({ format: 'LEGACY', status, draft_id }));
    }
    const cancelled = closed[2]!;
    await expect(
      prisma.pendingPledge.update({ where: { id: cancelled.id }, data: { status: 'OPEN' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const other = await pledge({ format: 'LEGACY', status: 'OPEN', draft_id: randomUUID() });
    await expect(
      prisma.pendingPledge.update({ where: { id: other.id }, data: { draft_id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await pledge({ format: 'LEGACY', status: 'OPEN', draft_id: null });
    await pledge({ format: 'LEGACY', status: 'OPEN', draft_id: null });
    await prisma.pendingPledge.update({ where: { id: open.id }, data: { status: 'EXPIRED' } });
    await expect(
      prisma.pendingPledge.update({ where: { id: cancelled.id }, data: { status: 'OPEN' } }),
    ).resolves.toMatchObject({ status: 'OPEN', draft_id });
  });

  it('allows only one REQUESTED Payment refund per donation and releases the slot on status change', async () => {
    const f = await allocations();
    const data = {
      donation_id: f.donation.id,
      claim_id: f.claim.id,
      item_cents: 100,
      created_by: 'admin',
    };
    const requested = await prisma.paymentRefund.create({ data: { ...data, status: 'REQUESTED' } });
    await expect(
      prisma.paymentRefund.create({ data: { ...data, status: 'REQUESTED' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    for (const status of ['PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'RESOLVED']) {
      await prisma.paymentRefund.create({ data: { ...data, status } });
      await prisma.paymentRefund.create({ data: { ...data, status } });
    }
    const failed = await prisma.paymentRefund.create({ data: { ...data, status: 'FAILED' } });
    await expect(
      prisma.paymentRefund.update({ where: { id: failed.id }, data: { status: 'REQUESTED' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const otherDonation = await prisma.donation.create({
      data: {
        donor_id: f.donor.id,
        external_id: randomUUID(),
        amount_cents: 100,
        event_id: f.event.id,
      },
    });
    await prisma.paymentRefund.create({
      data: { ...data, donation_id: otherDonation.id, status: 'REQUESTED' },
    });
    await prisma.paymentRefund.update({ where: { id: requested.id }, data: { status: 'PENDING' } });
    await expect(
      prisma.paymentRefund.update({ where: { id: failed.id }, data: { status: 'REQUESTED' } }),
    ).resolves.toMatchObject({ donation_id: f.donation.id, status: 'REQUESTED' });
  });

  describe('incentive Event/Channel ownership', () => {
    type Ownership = { event_id: string; channel_id: string | null };
    const models = [
      {
        kind: 'Reward',
        create: (owner: Ownership) =>
          prisma.reward.create({
            data: { title: 'Reward', type: 'DIGITAL', cost_cents: 100, ...owner },
          }),
        update: (id: string, owner: Partial<Ownership>) =>
          prisma.reward.update({ where: { id }, data: owner }),
        read: (id: string) => prisma.reward.findUnique({ where: { id } }),
      },
      {
        kind: 'Poll',
        create: (owner: Ownership) => prisma.poll.create({ data: { title: 'Poll', ...owner } }),
        update: (id: string, owner: Partial<Ownership>) =>
          prisma.poll.update({ where: { id }, data: owner }),
        read: (id: string) => prisma.poll.findUnique({ where: { id } }),
      },
      {
        kind: 'FundGoal',
        create: (owner: Ownership) =>
          prisma.fundGoal.create({ data: { title: 'Goal', target_cents: 100, ...owner } }),
        update: (id: string, owner: Partial<Ownership>) =>
          prisma.fundGoal.update({ where: { id }, data: owner }),
        read: (id: string) => prisma.fundGoal.findUnique({ where: { id } }),
      },
      {
        kind: 'Auction',
        create: (owner: Ownership) =>
          prisma.auction.create({
            data: {
              title: 'Auction',
              type: 'DIGITAL',
              starting_price_cents: 100,
              min_increment_cents: 1,
              ends_at: new Date(Date.now() + 60_000),
              ...owner,
            },
          }),
        update: (id: string, owner: Partial<Ownership>) =>
          prisma.auction.update({ where: { id }, data: owner }),
        read: (id: string) => prisma.auction.findUnique({ where: { id } }),
      },
    ];

    it.each(models)(
      '$kind rejects mismatched inserts/updates and blocks its Channel from moving',
      async (model) => {
        const f = await fixture();
        const there = await event();
        const otherChannel = await prisma.channel.create({
          data: { name: randomUUID(), slug: randomUUID(), event_id: there.id },
        });
        await expect(
          model.create({ event_id: there.id, channel_id: f.channel.id }),
        ).rejects.toThrow();
        const own = await model.create({ event_id: f.event.id, channel_id: f.channel.id });
        await expect(model.update(own.id, { event_id: there.id })).rejects.toThrow();
        await expect(model.update(own.id, { channel_id: otherChannel.id })).rejects.toThrow();
        expect(await model.read(own.id)).toMatchObject({
          event_id: f.event.id,
          channel_id: f.channel.id,
        });
        await expect(
          prisma.channel.update({ where: { id: f.channel.id }, data: { event_id: there.id } }),
        ).rejects.toThrow();
        await expect(
          prisma.channel.update({ where: { id: f.channel.id }, data: { event_id: f.event.id } }),
        ).resolves.toMatchObject({ event_id: f.event.id });
        const shared = await model.create({ event_id: there.id, channel_id: null });
        await expect(model.update(shared.id, { channel_id: f.channel.id })).rejects.toThrow();
        await expect(
          model.update(shared.id, { channel_id: otherChannel.id }),
        ).resolves.toMatchObject({ event_id: there.id, channel_id: otherChannel.id });
        await expect(model.update(own.id, { channel_id: null })).resolves.toMatchObject({
          event_id: f.event.id,
          channel_id: null,
        });
        await expect(
          prisma.channel.update({ where: { id: f.channel.id }, data: { event_id: there.id } }),
        ).resolves.toMatchObject({ event_id: there.id });
      },
    );
  });
});
