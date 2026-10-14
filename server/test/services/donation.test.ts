import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import prisma from '../../lib/prisma.js';
import { intakeDonation } from '../../services/donation.js';
import { createPledge } from '../../services/pledge.js';
import { sendMagicLink } from '../../services/email.js';
import { createTestChannel } from '../helpers/fixtures.js';

vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));

const emails: string[] = [];
const channels: string[] = [];
const rewards: string[] = [];
const pledges: string[] = [];
const polls: string[] = [];
const goals: string[] = [];
const destinations: string[] = [];

async function deliveryDestinations() {
  const native = await prisma.webhookDestination.create({
    data: { url: 'http://127.0.0.1:1', secret: 'test', event_types: '["donation.created"]' },
  });
  const tiltify = await prisma.webhookDestination.create({
    data: { url: '', secret: '', destination_type: 'RABBITMQ', payload_format: 'TILTIFY' },
  });
  destinations.push(native.id, tiltify.id);
  return { native, tiltify };
}

async function deliveries(destinationId: string) {
  return prisma.webhookDelivery.findMany({
    where: { destination_id: destinationId },
    orderBy: { seq: 'asc' },
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  const donors = await prisma.donor.findMany({ where: { email: { in: emails } } });
  const donorIds = donors.map((donor) => donor.id);
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS intake_reject_delivery');
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: { in: pledges } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  emails.length = channels.length = rewards.length = pledges.length = 0;
  polls.length = goals.length = destinations.length = 0;
});
afterAll(() => prisma.$disconnect());
afterEach(() => vi.unstubAllEnvs());

describe('Donation intake on SQLite', () => {
  it('records a wallet-only pledge against the signed-in donor without crediting money again', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const reward = await prisma.reward.create({
      data: { title: 'Digital reward', type: 'DIGITAL', cost_cents: 500 },
    });
    rewards.push(reward.id);
    const { pledge_token } = await createPledge({
      email: 'not-the-signed-in-donor@example.com',
      display_name: 'Wallet Reader',
      comment: 'Wallet message',
      items: [{ kind: 'REWARD', target_id: reward.id }],
      channel_id: channel.id,
    });
    pledges.push(pledge_token);
    const pledge = await prisma.pendingPledge.findUniqueOrThrow({
      where: { pledge_token },
      include: { items: true },
    });
    const donor = await prisma.donor.create({
      data: {
        email,
        magic_token: crypto.randomUUID(),
        total_donated: 1000,
        balance_remaining: 1000,
      },
    });

    const { native, tiltify } = await deliveryDestinations();
    const result = await intakeDonation({ source: 'wallet', pledge, donor });
    if ('duplicate' in result) throw new Error('Unexpected duplicate');
    expect(result.donor.id).toBe(donor.id);
    expect(result.token).toBe(donor.magic_token);
    expect(result.pledge).toMatchObject({ totalSpent: 500, skipped: 0 });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      total_donated: 1000,
      balance_remaining: 500,
    });
    expect(await prisma.donation.findUnique({ where: { id: result.donation.id } })).toMatchObject({
      external_id: expect.stringMatching(/^wallet-/),
      amount_cents: 500,
      donor_name: 'Wallet Reader',
      comment: 'Wallet message',
      channel_id: channel.id,
      event_id: channel.event_id,
      donor_id: donor.id,
    });
    expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
      status: 'FULFILLED',
      wallet_discount_cents: 500,
      fulfilled_by_donation_id: result.donation.id,
    });
    expect(await prisma.rewardClaim.findMany({ where: { donor_id: donor.id } })).toMatchObject([
      { donation_id: result.donation.id, reward_id: reward.id },
    ]);
    expect(sendMagicLink).toHaveBeenCalledWith(email, donor.magic_token);
    expect((await deliveries(native.id)).map((row) => row.message_type)).toEqual([
      'donation.created',
    ]);
    const queued = await deliveries(tiltify.id);
    expect(queued.map((row) => row.message_type)).toEqual([
      'tiltify.donation',
      'tiltify.fact.updated',
      'tiltify.fact.updated',
    ]);
    expect(JSON.parse(queued[0]!.payload)).toMatchObject({
      amount: { value: '5.00' },
      reward_claims: [{ reward_id: reward.id, quantity: 1 }],
    });
    expect(JSON.parse(queued[1]!.payload)).toMatchObject({
      total_amount_raised: { value: '5.00' },
    });
  });

  it.each([
    { source: 'stripe', amount: 3200, shipping: 700, totalAfterRepeat: 3700 },
    { source: 'admin', amount: 2500, shipping: 0, totalAfterRepeat: 3000 },
  ] as const)(
    '$source records money, allocations, stable identity and deliveries',
    async ({ source, amount, shipping, totalAfterRepeat }) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      vi.stubEnv('MODERATOR_EMAILS', email);
      vi.stubEnv('ADMIN_EMAILS', email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const reward = await prisma.reward.create({
        data: { title: 'Two units', type: 'DIGITAL', cost_cents: 500, quantity_total: 5 },
      });
      rewards.push(reward.id);
      const poll = await prisma.poll.create({
        data: { title: 'Vote', options: { create: [{ label: 'Option' }] } },
        include: { options: true },
      });
      polls.push(poll.id);
      const goal = await prisma.fundGoal.create({ data: { title: 'Goal', target_cents: 10000 } });
      goals.push(goal.id);
      const { pledge_token } = await createPledge({
        email,
        display_name: 'Pledge Reader',
        comment: 'Pledge message',
        channel_id: channel.id,
        items: [
          { kind: 'REWARD', target_id: reward.id, quantity: 2 },
          {
            kind: 'POLL_VOTE',
            target_id: poll.options[0]!.id,
            poll_id: poll.id,
            amount_cents: 300,
          },
          { kind: 'GOAL', target_id: goal.id, amount_cents: 200 },
        ],
      });
      pledges.push(pledge_token);
      const { native, tiltify } = await deliveryDestinations();
      const facts = {
        externalId: crypto.randomUUID(),
        email: `  ${email.toUpperCase()}  `,
        donorName: 'Source Reader',
        amountCents: amount,
        pledgeToken: pledge_token,
      };
      const occurredAt = new Date('2026-01-15T12:00:00.000Z');
      const result = await intakeDonation(
        source === 'stripe'
          ? { source, ...facts, shippingCents: shipping }
          : { source, ...facts, comment: 'Admin fallback', channelId: channel.id, occurredAt },
      );
      if ('duplicate' in result) throw new Error('Unexpected duplicate');
      expect(result.donor).toMatchObject({
        email,
        total_donated: amount,
        balance_remaining: 2500,
        role: 'USER',
      });
      expect(result.token).toMatch(/^[a-f0-9]{64}$/);
      expect(result.pledge).toMatchObject({ totalSpent: 1500, skipped: 0 });
      expect(await prisma.donor.findUnique({ where: { id: result.donor.id } })).toMatchObject({
        total_donated: amount,
        balance_remaining: 1000,
        role: 'USER',
        email_verified: false,
      });
      const donation = await prisma.donation.findUniqueOrThrow({
        where: { id: result.donation.id },
      });
      expect(donation).toMatchObject({
        amount_cents: amount,
        donor_id: result.donor.id,
        channel_id: channel.id,
        event_id: channel.event_id,
        donor_name: 'Pledge Reader',
        comment: 'Pledge message',
        status: 'COMPLETED',
      });
      if (source === 'admin') expect(donation.created_at).toEqual(occurredAt);
      expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
        status: 'FULFILLED',
        fulfilled_by_donation_id: donation.id,
      });
      expect(
        await prisma.rewardClaim.findMany({ where: { donation_id: donation.id } }),
      ).toMatchObject([
        { reward_id: reward.id, donor_id: result.donor.id },
        { reward_id: reward.id, donor_id: result.donor.id },
      ]);
      expect(await prisma.pollVote.findMany({ where: { donation_id: donation.id } })).toMatchObject(
        [{ amount_cents: 300, poll_option_id: poll.options[0]!.id }],
      );
      expect(
        await prisma.fundContribution.findMany({ where: { donation_id: donation.id } }),
      ).toMatchObject([{ amount_cents: 200, goal_id: goal.id }]);
      const nativeRows = await deliveries(native.id);
      expect(nativeRows).toHaveLength(1);
      expect(JSON.parse(nativeRows[0]!.payload).data).toMatchObject({
        donation_id: donation.id,
        amount_cents: amount,
        channel_id: channel.id,
        donor_name: 'Pledge Reader',
      });
      const tiltifyRows = await deliveries(tiltify.id);
      expect(tiltifyRows.map((row) => row.message_type)).toEqual([
        'tiltify.donation',
        'tiltify.fact.updated',
        'tiltify.fact.updated',
      ]);
      expect(JSON.parse(tiltifyRows[0]!.payload)).toMatchObject({
        id: donation.id,
        amount: { value_cents: amount },
        reward_claims: [{ reward_id: reward.id }, { reward_id: reward.id }],
        poll_votes: [{ poll_id: poll.id, poll_option_id: poll.options[0]!.id }],
        target_contributions: [{ target_id: goal.id, amount: { value: '2.00' } }],
      });

      // A repeat payment keeps identity and token, extends TTL, and cannot
      // fulfill the already fulfilled pledge a second time.
      const expiredAt = new Date('2020-01-01T00:00:00Z');
      await prisma.donor.update({
        where: { id: result.donor.id },
        data: { token_expires_at: expiredAt },
      });
      const repeatFacts = {
        externalId: crypto.randomUUID(),
        email,
        donorName: 'Repeat',
        amountCents: 500,
      };
      const repeat = await intakeDonation(
        source === 'stripe'
          ? { source, ...repeatFacts }
          : { source, ...repeatFacts, channelId: channel.id },
      );
      if ('duplicate' in repeat) throw new Error('Unexpected duplicate');
      expect(repeat.donor.id).toBe(result.donor.id);
      expect(repeat.token).toBe(result.token);
      expect(repeat.pledge).toBeNull();
      expect(await prisma.donor.findUnique({ where: { id: result.donor.id } })).toMatchObject({
        total_donated: totalAfterRepeat,
        balance_remaining: 1500,
        magic_token: result.token,
        role: 'USER',
        token_expires_at: expect.any(Date),
      });
      expect(repeat.donor.token_expires_at!.getTime()).toBeGreaterThan(Date.now());
      expect(sendMagicLink).toHaveBeenNthCalledWith(1, email, result.token);
      expect(sendMagicLink).toHaveBeenNthCalledWith(2, email, result.token);
    },
  );

  it.each(['stripe', 'admin', 'wallet'] as const)(
    '$source sends mail only after its donation, claims and deliveries commit',
    async (source) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const reward = await prisma.reward.create({
        data: { title: 'Committed claim', type: 'DIGITAL', cost_cents: 500 },
      });
      rewards.push(reward.id);
      const { pledge_token } = await createPledge({
        email,
        channel_id: channel.id,
        items: [{ kind: 'REWARD', target_id: reward.id }],
      });
      pledges.push(pledge_token);
      const pledge = await prisma.pendingPledge.findUniqueOrThrow({
        where: { pledge_token },
        include: { items: true },
      });
      const donor =
        source === 'wallet'
          ? await prisma.donor.create({
              data: {
                email,
                balance_remaining: 1000,
                total_donated: 1000,
                magic_token: crypto.randomUUID(),
              },
            })
          : null;
      const { native, tiltify } = await deliveryDestinations();
      // A synchronous, read-only observer checks the committed snapshot at the
      // exact mail boundary. An async read could race the transaction's commit.
      const observer = new DatabaseSync(inject('testDatabaseUrl').slice('file:'.length), {
        readOnly: true,
      });
      const visible: unknown[] = [];
      vi.mocked(sendMagicLink).mockImplementation(async (recipient) => {
        visible.push({
          donations: observer
            .prepare(
              `SELECT COUNT(*) AS count FROM Donation d
          JOIN Donor donor ON donor.id = d.donor_id WHERE donor.email = ?`,
            )
            .get(recipient)?.count,
          claims: observer
            .prepare(
              `SELECT COUNT(*) AS count FROM RewardClaim c
          JOIN Donor donor ON donor.id = c.donor_id WHERE donor.email = ?`,
            )
            .get(recipient)?.count,
          deliveries: observer
            .prepare(
              `SELECT COUNT(*) AS count FROM WebhookDelivery
          WHERE destination_id IN (?, ?)`,
            )
            .get(native.id, tiltify.id)?.count,
        });
      });
      try {
        const facts = {
          externalId: crypto.randomUUID(),
          email,
          donorName: 'Reader',
          amountCents: 1000,
          pledgeToken: pledge_token,
        };
        const result = await intakeDonation(
          source === 'wallet' ? { source, pledge, donor: donor! } : { source, ...facts },
        );
        expect(result).not.toHaveProperty('duplicate');
        expect(visible).toEqual([{ donations: 1, claims: 1, deliveries: 4 }]);
      } finally {
        observer.close();
        vi.mocked(sendMagicLink).mockResolvedValue(undefined);
      }
    },
  );

  it.each(['stripe', 'admin', 'wallet'] as const)(
    '$source rolls back accounting, allocations and earlier messages on a late outbox failure, without mail',
    async (source) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const reward = await prisma.reward.create({
        data: { title: 'Rollback claim', type: 'DIGITAL', cost_cents: 500 },
      });
      rewards.push(reward.id);
      const { pledge_token } = await createPledge({
        email,
        channel_id: channel.id,
        items: [{ kind: 'REWARD', target_id: reward.id }],
      });
      pledges.push(pledge_token);
      const pledge = await prisma.pendingPledge.findUniqueOrThrow({
        where: { pledge_token },
        include: { items: true },
      });
      const donor = await prisma.donor.create({
        data: {
          email,
          balance_remaining: 1000,
          total_donated: 1000,
          magic_token: crypto.randomUUID(),
        },
      });
      const { native, tiltify } = await deliveryDestinations();
      // Native and Tiltify donation messages have already been inserted when
      // the totals fail. Exercise SQLite rollback, not a mocked transaction.
      await prisma.$executeRawUnsafe(`CREATE TRIGGER intake_reject_delivery
      BEFORE INSERT ON WebhookDelivery WHEN NEW.event_type = 'tiltify.fact.updated'
      BEGIN SELECT RAISE(ABORT, 'intake delivery failure'); END`);
      const facts = {
        externalId: crypto.randomUUID(),
        email,
        donorName: 'Reader',
        amountCents: 1000,
        pledgeToken: pledge_token,
      };
      await expect(
        intakeDonation(source === 'wallet' ? { source, pledge, donor } : { source, ...facts }),
      ).rejects.toThrow();
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toEqual(donor);
      expect(await prisma.donation.findMany({ where: { donor_id: donor.id } })).toEqual([]);
      expect(await prisma.rewardClaim.findMany({ where: { donor_id: donor.id } })).toEqual([]);
      expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
        quantity_claimed: 0,
      });
      expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
        status: 'OPEN',
        fulfilled_by_donation_id: null,
        wallet_discount_cents: 0,
      });
      expect(await deliveries(native.id)).toEqual([]);
      expect(await deliveries(tiltify.id)).toEqual([]);
      expect(
        await prisma.webhookDestinationSeq.findMany({
          where: { destination_id: { in: [native.id, tiltify.id] } },
        }),
      ).toEqual([]);
      expect(sendMagicLink).not.toHaveBeenCalled();
    },
  );

  it.each(['stripe', 'admin'] as const)(
    '$source duplicates preserve the original intake and cannot create or credit a donor, fulfill a pledge or send mail',
    async (source) => {
      const email = `${crypto.randomUUID()}@example.com`;
      const otherEmail = `${crypto.randomUUID()}@example.com`;
      emails.push(email, otherEmail);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const { pledge_token: initialToken } = await createPledge({
        email,
        channel_id: channel.id,
        items: [],
        top_up_cents: 1000,
      });
      pledges.push(initialToken);
      const { native, tiltify } = await deliveryDestinations();
      const externalId = crypto.randomUUID();
      const facts = { externalId, email, donorName: 'Reader', amountCents: 1000 };
      const first = await intakeDonation({ source, ...facts, pledgeToken: initialToken });
      if ('duplicate' in first) throw new Error('Unexpected duplicate');
      const original = await prisma.donor.findUniqueOrThrow({ where: { id: first.donor.id } });
      const nativeBefore = await deliveries(native.id);
      const tiltifyBefore = await deliveries(tiltify.id);
      const reward = await prisma.reward.create({
        data: { title: 'Not fulfilled', type: 'DIGITAL', cost_cents: 500 },
      });
      rewards.push(reward.id);
      const { pledge_token } = await createPledge({
        email,
        channel_id: channel.id,
        items: [{ kind: 'REWARD', target_id: reward.id }],
      });
      pledges.push(pledge_token);
      vi.mocked(sendMagicLink).mockClear();

      expect(await intakeDonation({ source, ...facts, pledgeToken: pledge_token })).toEqual({
        duplicate: true,
      });
      expect(
        await intakeDonation({ source, ...facts, email: otherEmail, pledgeToken: pledge_token }),
      ).toEqual({ duplicate: true });
      expect(await prisma.donor.findUnique({ where: { id: first.donor.id } })).toEqual(original);
      expect(await prisma.donor.findUnique({ where: { email: otherEmail } })).toBeNull();
      expect(await prisma.donation.findMany({ where: { donor_id: first.donor.id } })).toHaveLength(
        1,
      );
      expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
        status: 'OPEN',
        fulfilled_by_donation_id: null,
      });
      expect(await prisma.rewardClaim.findMany({ where: { donor_id: first.donor.id } })).toEqual(
        [],
      );
      expect(await deliveries(native.id)).toEqual(nativeBefore);
      expect(await deliveries(tiltify.id)).toEqual(tiltifyBefore);
      expect(sendMagicLink).not.toHaveBeenCalled();
    },
  );
});
