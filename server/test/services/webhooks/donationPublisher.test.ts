import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import { withWebhooks } from '../../../services/webhooks/outbox.js';
import { moderateCustomEntryTx, reverseSpendTx } from '../../../services/reversal.js';
import { proposeCustomEntryTx, votePollTx } from '../../../services/spend.js';
import { createPledge } from '../../../services/pledge.js';
import { intakeDonation } from '../../../services/donation.js';
import { planPledge } from '@dono/shared';
import { DEFAULT_EVENT_ID } from '../../helpers/fixtures.js';

// Only replace the network delivery boundary, never the outbox or database.
vi.mock('../../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
vi.mock('../../../services/email.js', () => ({
  sendMagicLink: vi.fn().mockResolvedValue(undefined),
}));

const donors: string[] = [];
const destinations: string[] = [];
const channels: string[] = [];
const events: string[] = [];
const polls: string[] = [];
const pledges: string[] = [];

async function fixture() {
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@example.com` },
  });
  donors.push(donor.id);
  const event = await prisma.event.create({
    data: { name: 'Marathon', slug: crypto.randomUUID() },
  });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: `Stream ${crypto.randomUUID()}`, slug: crypto.randomUUID(), event_id: event.id },
  });
  channels.push(channel.id);
  const native = await prisma.webhookDestination.create({
    data: {
      url: 'http://127.0.0.1:1',
      secret: 'test',
      event_types: JSON.stringify([
        'donation.created',
        'donation.moderated',
        'donation.hidden',
        'donation.unhidden',
      ]),
    },
  });
  const tiltify = await prisma.webhookDestination.create({
    data: {
      url: '',
      secret: '',
      destination_type: 'RABBITMQ',
      payload_format: 'TILTIFY',
      event_types: '[]',
    },
  });
  destinations.push(native.id, tiltify.id);
  return { donor, event, channel, native, tiltify };
}

async function messages(destinationId: string) {
  const rows = await prisma.webhookDelivery.findMany({
    where: { destination_id: destinationId },
    orderBy: { seq: 'asc' },
  });
  return rows.map((row) => ({
    type: row.message_type,
    key: row.routing_key,
    payload: JSON.parse(row.payload),
  }));
}

async function pooledWriteIn({ pledge, directed }: Readonly<{ pledge: number; directed: number }>) {
  const context = await fixture();
  const poll = await prisma.poll.create({
    data: {
      event_id: context.channel.event_id,
      title: 'Pooled write-in',
      channel_id: context.channel.id,
      allow_custom_entries: true,
      auto_approve: false,
    },
  });
  polls.push(poll.id);
  const selections = [
    {
      kind: 'POLL_CUSTOM' as const,
      target_id: poll.id,
      poll_id: poll.id,
      amount_cents: directed,
      insertion_order: 0,
      data: { label: 'Idea' },
    },
  ];
  const { pledge_token } = await createPledge({
    draft_id: crypto.randomUUID(),
    pledge_amount_cents: pledge,
    channel_id: context.channel.id,
    items: selections,
    plan: planPledge({ pledge_amount_cents: pledge, selections, available_wallet_cents: null }),
  });
  pledges.push(pledge_token);
  const externalId = crypto.randomUUID();
  await prisma.pendingPledge.update({
    where: { pledge_token },
    data: { checkout_session_id: externalId },
  });
  const intake = await intakeDonation({
    source: 'stripe',
    externalId,
    email: context.donor.email,
    donorName: 'Reader',
    amountCents: pledge,
    pledgeToken: pledge_token,
  });
  if ('duplicate' in intake) throw new Error('Unexpected duplicate');
  const entry = await prisma.pollCustomEntry.findFirstOrThrow({ where: { poll_id: poll.id } });
  const option = await prisma.pollOption.findUniqueOrThrow({
    where: { custom_entry_id: entry.id },
  });
  return { ...context, poll, entry, option, donation: intake.donation };
}

afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_pooled_rejection');
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.pollCustomEntry.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: { in: pledges } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  donors.length =
    destinations.length =
    channels.length =
    events.length =
    polls.length =
    pledges.length =
      0;
});
afterAll(() => prisma.$disconnect());

describe('Donation publisher through the SQLite outbox', () => {
  it('opt-in donation.updated carries stable safe full state, even with no active Tiltify Destination', async () => {
    const { donor, channel, event, native, tiltify } = await fixture();
    await prisma.webhookDestination.update({
      where: { id: tiltify.id },
      data: { is_active: false },
    });
    const optedIn = await prisma.webhookDestination.create({
      data: {
        url: 'http://127.0.0.1:1',
        secret: 'test',
        event_types: '["donation.created","donation.updated"]',
      },
    });
    destinations.push(optedIn.id);
    const poll = await prisma.poll.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Sources', options: { create: { label: 'A' } } },
      include: { options: true },
    });
    polls.push(poll.id);
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: crypto.randomUUID(),
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        channel_id: channel.id,
        event_id: event.id,
        moderated_by: 'staff-marker',
      },
    });
    const vote = await prisma.pollVote.create({
      data: {
        donor_id: donor.id,
        donation_id: donation.id,
        poll_id: poll.id,
        poll_option_id: poll.options[0]!.id,
        amount_cents: 1000,
        source: 'moderator',
        allocated_by: 'staff-marker',
        allocated_at: new Date(),
      },
    });
    await withWebhooks(async (tx, _emit, publisher) => {
      await publisher.publish(donation.id, null);
      const before = await publisher.snapshot(donation.id);
      await publisher.publish(donation.id, before);
      await tx.donation.update({ where: { id: donation.id }, data: { status: 'REFUNDED' } });
      await tx.pollVote.update({ where: { id: vote.id }, data: { reversed_at: new Date() } });
      await publisher.publish([donation.id, donation.id], before);
      const after = await publisher.snapshot(donation.id);
      await publisher.publish(donation.id, after);
    });
    const queued = await messages(optedIn.id);
    expect(queued.map((message) => message.type)).toEqual(['donation.created', 'donation.updated']);
    expect(queued[0]!.payload.data).toMatchObject({
      status: 'COMPLETED',
      pledge_amount_cents: 1000,
      amount_cents: 1000,
      allocations: { poll: [{ id: vote.id, amount_cents: 1000, source: 'moderator' }] },
    });
    expect(queued[1]!.payload.data).toMatchObject({
      status: 'REFUNDED',
      pledge_amount_cents: 1000,
      amount_cents: 1000,
      allocations: { reward: [], poll: [], goal: [] },
    });
    expect(JSON.stringify(queued)).not.toContain(donor.email);
    expect(JSON.stringify(queued)).not.toContain('staff-marker');
    expect((await messages(native.id)).map((message) => message.type)).toEqual([
      'donation.created',
    ]);
    expect(await messages(tiltify.id)).toEqual([]);
  });
  it('approves the full $1 donor plus $9 auto write-in funding once and publishes one combined vote', async () => {
    const { donor, poll, entry, option, donation, native, tiltify } = await pooledWriteIn({
      pledge: 1000,
      directed: 100,
    });
    expect(
      await prisma.pollVote.findMany({
        where: { donation_id: donation.id },
        orderBy: { amount_cents: 'asc' },
      }),
    ).toMatchObject([
      { amount_cents: 100, source: 'donor', reversed_at: null },
      { amount_cents: 900, source: 'auto', reversed_at: null },
    ]);
    const beforeNative = await messages(native.id);
    const beforeTiltify = await messages(tiltify.id);
    expect(beforeTiltify[0]!.payload.poll_votes).toEqual([]);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        withWebhooks((tx, _emit, publisher) =>
          moderateCustomEntryTx(tx, entry.id, 'APPROVED', 'moderator', publisher),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 400, message: 'Only pending entries can be moderated' },
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 1000,
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'ACTIVE',
      votes_cents: 1000,
    });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      total_donated: 1000,
      balance_remaining: 0,
    });
    expect(await messages(native.id)).toEqual(beforeNative);
    expect((await messages(tiltify.id)).slice(beforeTiltify.length)).toEqual([
      {
        type: 'tiltify.donation',
        key: expect.any(String),
        payload: expect.objectContaining({
          id: donation.id,
          poll_id: poll.id,
          poll_option_id: option.id,
          poll_votes: [{ poll_id: poll.id, poll_option_id: option.id }],
        }),
      },
    ]);
  });
  it('reversing one funding row leaves the write-in pending so approval counts all remaining live funding', async () => {
    const { donor, donation, poll, entry, option } = await pooledWriteIn({
      pledge: 1000,
      directed: 100,
    });
    const donorVote = await prisma.pollVote.findFirstOrThrow({
      where: { donation_id: donation.id, source: 'donor' },
    });
    await withWebhooks((tx, _emit, publisher) =>
      reverseSpendTx(tx, donor.id, 'vote', donorVote.id, 'admin', publisher),
    );
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'PENDING_APPROVAL',
      votes_cents: 0,
    });
    await withWebhooks((tx, _emit, publisher) =>
      moderateCustomEntryTx(tx, entry.id, 'APPROVED', 'moderator', publisher),
    );
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 900,
    });
    expect(await prisma.poolCredit.findMany({ where: { donation_id: donation.id } })).toMatchObject(
      [{ category: 'poll', remaining_cents: 100, source_vote_id: donorVote.id }],
    );
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 0,
    });
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    '%s handles every donor and donation funding the pending option',
    async (status) => {
      const { donor, poll, entry, option, donation, native, tiltify, channel } =
        await pooledWriteIn({ pledge: 1000, directed: 100 });
      const second = await intakeDonation({
        source: 'admin',
        externalId: crypto.randomUUID(),
        email: `${crypto.randomUUID()}@example.com`,
        donorName: 'Other reader',
        amountCents: 500,
        channelId: channel.id,
      });
      if ('duplicate' in second) throw new Error('Unexpected duplicate');
      donors.push(second.donor.id);
      await prisma.$transaction((tx) =>
        votePollTx(tx, second.donor.id, poll.id, option.id, 500, second.donation.id),
      );
      const beforeNative = await messages(native.id);
      const beforeTiltify = await messages(tiltify.id);
      await withWebhooks((tx, _emit, publisher) =>
        moderateCustomEntryTx(tx, entry.id, status, 'moderator', publisher),
      );
      const approved = status === 'APPROVED';
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: approved ? 1500 : 0,
      });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 0,
      });
      expect(await prisma.donor.findUnique({ where: { id: second.donor.id } })).toMatchObject({
        balance_remaining: approved ? 0 : 500,
      });
      expect(
        await prisma.pollVote.count({ where: { poll_option_id: option.id, reversed_at: null } }),
      ).toBe(approved ? 3 : 0);
      expect(await messages(native.id)).toEqual(beforeNative);
      const queued = (await messages(tiltify.id)).slice(beforeTiltify.length);
      expect(queued).toHaveLength(approved ? 2 : 0);
      expect(queued.map((message) => message.payload.id).sort()).toEqual(
        approved ? [donation.id, second.donation.id].sort() : [],
      );
      for (const message of queued)
        expect(message).toMatchObject({
          type: 'tiltify.donation',
          payload: {
            poll_id: poll.id,
            poll_option_id: option.id,
            poll_votes: [{ poll_id: poll.id, poll_option_id: option.id }],
          },
        });
    },
  );

  it.each([
    ['APPROVED', 'REJECTED'],
    ['REJECTED', 'APPROVED'],
    ['REJECTED', 'REJECTED'],
  ] as const)(
    'pooled moderation rechecks all funding when %s queues before %s',
    async (firstStatus, secondStatus) => {
      const { donor, poll, entry, option, native, tiltify } = await pooledWriteIn({
        pledge: 1000,
        directed: 100,
      });
      const beforeNative = await messages(native.id);
      const beforeTiltify = await messages(tiltify.id);
      let release!: () => void;
      let started!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        release = resolve;
      });
      const isOpen = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = withWebhooks(async (tx, _emit, publisher) => {
        const result = await moderateCustomEntryTx(
          tx,
          entry.id,
          firstStatus,
          'moderator',
          publisher,
        );
        started();
        await mayCommit;
        return result;
      });
      await Promise.race([isOpen, first]);
      const second = withWebhooks((tx, _emit, publisher) =>
        moderateCustomEntryTx(tx, entry.id, secondStatus, 'other', publisher),
      );
      release();
      const results = await Promise.allSettled([first, second]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: firstStatus } });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { status: 400, message: 'Only pending entries can be moderated' },
      });
      const approved = firstStatus === 'APPROVED';
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: approved ? 1000 : 0,
      });
      expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
        status: approved ? 'ACTIVE' : 'REJECTED',
        votes_cents: approved ? 1000 : 0,
      });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        total_donated: 1000,
        balance_remaining: 0,
      });
      const votes = await prisma.pollVote.findMany({
        where: { poll_option_id: option.id },
        orderBy: { amount_cents: 'asc' },
      });
      expect(votes).toHaveLength(2);
      for (const vote of votes)
        expect(vote.reversed_at).toEqual(approved ? null : expect.any(Date));
      const adjustments = await prisma.balanceAdjustment.findMany({
        where: { donor_id: donor.id },
        orderBy: { amount_cents: 'asc' },
      });
      expect(adjustments).toEqual([]);
      expect(
        await prisma.poolCredit.findMany({
          where: { donation: { donor_id: donor.id } },
          orderBy: { amount_cents: 'asc' },
        }),
      ).toMatchObject(
        approved
          ? []
          : [
              {
                category: 'poll',
                amount_cents: 100,
                remaining_cents: 100,
                source_vote_id: votes[0]!.id,
              },
              {
                category: 'poll',
                amount_cents: 900,
                remaining_cents: 900,
                source_vote_id: votes[1]!.id,
              },
            ],
      );
      expect(await messages(native.id)).toEqual(beforeNative);
      expect((await messages(tiltify.id)).slice(beforeTiltify.length)).toHaveLength(
        approved ? 1 : 0,
      );
    },
  );

  it('rolls back every pooled rejection credit and funding row when the second category credit write fails', async () => {
    const { donor, poll, entry, option, native, tiltify } = await pooledWriteIn({
      pledge: 1000,
      directed: 100,
    });
    const beforeNative = await messages(native.id);
    const beforeTiltify = await messages(tiltify.id);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_pooled_rejection BEFORE INSERT ON PoolCredit
      WHEN (SELECT COUNT(*) FROM PoolCredit WHERE donation_id IN (SELECT id FROM Donation WHERE donor_id = '${donor.id}')) = 1
      BEGIN SELECT RAISE(ABORT, 'late rejection ledger failure'); END`);
    await expect(
      withWebhooks((tx, _emit, publisher) =>
        moderateCustomEntryTx(tx, entry.id, 'REJECTED', 'moderator', publisher),
      ),
    ).rejects.toThrow();
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 0,
    });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: donor.id } })).toBe(0);
    expect(
      await prisma.pollVote.count({ where: { poll_option_id: option.id, reversed_at: null } }),
    ).toBe(2);
    expect(await prisma.pollCustomEntry.findUnique({ where: { id: entry.id } })).toMatchObject({
      status: 'PENDING',
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'PENDING_APPROVAL',
      votes_cents: 0,
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await messages(native.id)).toEqual(beforeNative);
    expect(await messages(tiltify.id)).toEqual(beforeTiltify);
  });

  it.each<{
    name: string;
    initial?: Prisma.DonationUncheckedUpdateInput;
    change: Prisma.DonationUncheckedUpdateInput;
    nativeTypes: string[];
    tiltifyTypes: string[];
  }>([
    { name: 'unchanged review', change: { moderated: false }, nativeTypes: [], tiltifyTypes: [] },
    {
      name: 'review timestamp only',
      initial: { moderated: true },
      change: { moderated_at: new Date() },
      nativeTypes: [],
      tiltifyTypes: [],
    },
    {
      name: 'review on',
      change: { moderated: true },
      nativeTypes: ['donation.moderated'],
      tiltifyTypes: [],
    },
    {
      name: 'review off',
      initial: { moderated: true },
      change: { moderated: false },
      nativeTypes: ['donation.moderated'],
      tiltifyTypes: [],
    },
    {
      name: 'hide',
      change: { hidden_from_overlay: true },
      nativeTypes: ['donation.hidden'],
      tiltifyTypes: ['tiltify.donation'],
    },
    {
      name: 'show',
      initial: { hidden_from_overlay: true },
      change: { hidden_from_overlay: false },
      nativeTypes: ['donation.unhidden'],
      tiltifyTypes: ['tiltify.donation'],
    },
    {
      name: 'review then hide',
      change: { moderated: true, hidden_from_overlay: true },
      nativeTypes: ['donation.moderated', 'donation.hidden'],
      tiltifyTypes: ['tiltify.donation'],
    },
    {
      name: 'hide twice',
      initial: { hidden_from_overlay: true },
      change: { hidden_from_overlay: true },
      nativeTypes: [],
      tiltifyTypes: [],
    },
    {
      name: 'unassigned moderation',
      initial: { channel_id: null, event_id: null },
      change: { moderated: true, hidden_from_overlay: true },
      nativeTypes: [],
      tiltifyTypes: [],
    },
    {
      name: 'refund keeps counted money',
      change: { status: 'REFUNDED' },
      nativeTypes: [],
      tiltifyTypes: [],
    },
    {
      name: 'chargeback removes counted money',
      change: { status: 'CHARGEBACK' },
      nativeTypes: [],
      tiltifyTypes: ['tiltify.fact.updated', 'tiltify.fact.updated'],
    },
    {
      name: 'zero-money chargeback',
      initial: { amount_cents: 0 },
      change: { status: 'CHARGEBACK' },
      nativeTypes: [],
      tiltifyTypes: [],
    },
    {
      name: 'counted amount decrease',
      change: { amount_cents: 500 },
      nativeTypes: [],
      tiltifyTypes: ['tiltify.donation', 'tiltify.fact.updated', 'tiltify.fact.updated'],
    },
  ])(
    '$name publishes only observable changes',
    async ({ initial, change, nativeTypes, tiltifyTypes }) => {
      const { donor, event, channel, native, tiltify } = await fixture();
      const donation = await prisma.donation.create({
        data: {
          donor_id: donor.id,
          external_id: crypto.randomUUID(),
          amount_cents: 1200,
          donor_name: 'Reader',
          comment: 'Hello',
          channel_id: channel.id,
          event_id: event.id,
        },
      });
      if (initial) await prisma.donation.update({ where: { id: donation.id }, data: initial });
      await withWebhooks(async (tx, _emit, publisher) => {
        const before = await publisher.snapshot(donation.id);
        await tx.donation.update({ where: { id: donation.id }, data: change });
        await publisher.publish(donation.id, before);
      });
      const nativeMessages = await messages(native.id);
      const tiltifyMessages = await messages(tiltify.id);
      expect(nativeMessages.map((m) => m.type)).toEqual(nativeTypes);
      expect(tiltifyMessages.map((m) => m.type)).toEqual(tiltifyTypes);
      for (const message of nativeMessages) {
        expect(message.payload.data.donation_id).toBe(donation.id);
        expect(message.payload.data).not.toHaveProperty('email');
        expect(message.payload.data).not.toHaveProperty('moderated_by');
      }
      for (const message of tiltifyMessages) {
        expect(message.key).toBe(
          message.type === 'tiltify.donation'
            ? `${channel.slug}.donation`
            : `${message.payload.id === channel.id ? channel.slug : event.slug}.fact.updated`,
        );
      }
    },
  );

  it('publishes each newly assigned donation before deduplicated Channel and Event totals', async () => {
    const { donor, event, channel, native, tiltify } = await fixture();
    const otherChannel = await prisma.channel.create({
      data: {
        name: `Other ${crypto.randomUUID()}`,
        slug: crypto.randomUUID(),
        event_id: event.id,
      },
    });
    channels.push(otherChannel.id);
    const created = await Promise.all(
      [100, 200, 300].map((amount_cents) =>
        prisma.donation.create({
          data: { donor_id: donor.id, external_id: crypto.randomUUID(), amount_cents },
        }),
      ),
    );
    const ids = created.map((d) => d.id);
    await withWebhooks(async (tx, _emit, publisher) => {
      const before = await publisher.snapshot(ids);
      for (const [index, donation] of created.entries()) {
        await tx.donation.update({
          where: { id: donation.id },
          data: {
            channel_id: index === 2 ? otherChannel.id : channel.id,
            event_id: event.id,
            moderated: true,
            hidden_from_overlay: true,
          },
        });
      }
      await publisher.publish(ids, before);
    });
    expect((await messages(native.id)).map((m) => [m.type, m.payload.data.donation_id])).toEqual(
      ids.flatMap((id) => [
        ['donation.created', id],
        ['donation.moderated', id],
        ['donation.hidden', id],
      ]),
    );
    const queued = await messages(tiltify.id);
    expect(queued.map((m) => m.type)).toEqual([
      'tiltify.donation',
      'tiltify.donation',
      'tiltify.donation',
      'tiltify.fact.updated',
      'tiltify.fact.updated',
      'tiltify.fact.updated',
    ]);
    expect(queued.slice(3).map((m) => [m.payload.id, m.payload.total_amount_raised.value])).toEqual(
      expect.arrayContaining([
        [channel.id, '3.00'],
        [otherChannel.id, '3.00'],
        [event.id, '6.00'],
      ]),
    );
  });

  it.each([
    ['APPROVED', 'REJECTED'],
    ['REJECTED', 'APPROVED'],
    ['APPROVED', 'APPROVED'],
  ] as const)(
    'serializes %s before %s without counting or publishing reversed funding',
    async (firstStatus, secondStatus) => {
      const { donor, event, channel, native, tiltify } = await fixture();
      await prisma.donor.update({ where: { id: donor.id }, data: { balance_remaining: 1000 } });
      const donation = await prisma.donation.create({
        data: {
          donor_id: donor.id,
          external_id: crypto.randomUUID(),
          amount_cents: 1000,
          channel_id: channel.id,
          event_id: event.id,
        },
      });
      const poll = await prisma.poll.create({
        data: {
          event_id: DEFAULT_EVENT_ID,
          title: 'Write-in',
          allow_custom_entries: true,
          auto_approve: false,
        },
      });
      polls.push(poll.id);
      const { entry, option } = await prisma.$transaction((tx) =>
        proposeCustomEntryTx(tx, donor.id, poll.id, 'Idea', 400, donation.id),
      );
      let release!: () => void;
      let started!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        release = resolve;
      });
      const isOpen = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = withWebhooks(async (tx, _emit, publisher) => {
        const result = await moderateCustomEntryTx(
          tx,
          entry.id,
          firstStatus,
          'moderator',
          publisher,
        );
        started();
        await mayCommit;
        return result;
      });
      await Promise.race([isOpen, first]);
      const second = withWebhooks((tx, _emit, publisher) =>
        moderateCustomEntryTx(tx, entry.id, secondStatus, 'moderator', publisher),
      );
      release();
      const results = await Promise.allSettled([first, second]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      const approved = firstStatus === 'APPROVED';
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: approved ? 400 : 0,
      });
      expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
        votes_cents: approved ? 400 : 0,
      });
      expect(await messages(native.id)).toEqual([]);
      const queued = await messages(tiltify.id);
      expect(queued).toHaveLength(approved ? 1 : 0);
      if (approved)
        expect(queued[0]).toMatchObject({
          type: 'tiltify.donation',
          payload: {
            poll_id: poll.id,
            poll_option_id: option.id,
            poll_votes: [{ poll_id: poll.id, poll_option_id: option.id }],
          },
        });
      else
        expect(
          await prisma.pollVote.findFirst({ where: { poll_option_id: option.id } }),
        ).toMatchObject({ reversed_at: expect.any(Date) });
    },
  );

  it('a rolled-back approval changes neither the vote tally nor the outbox', async () => {
    const { donor, event, channel, native, tiltify } = await fixture();
    await prisma.donor.update({ where: { id: donor.id }, data: { balance_remaining: 1000 } });
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: crypto.randomUUID(),
        amount_cents: 1000,
        channel_id: channel.id,
        event_id: event.id,
      },
    });
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Write-in',
        allow_custom_entries: true,
        auto_approve: false,
      },
    });
    polls.push(poll.id);
    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, donor.id, poll.id, 'Idea', 400, donation.id),
    );
    await expect(
      withWebhooks(async (tx, _emit, publisher) => {
        await moderateCustomEntryTx(tx, entry.id, 'APPROVED', 'moderator', publisher);
        throw new Error('abort after publication');
      }),
    ).rejects.toThrow('abort after publication');
    expect(await messages(native.id)).toEqual([]);
    expect(await messages(tiltify.id)).toEqual([]);
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'PENDING_APPROVAL',
      votes_cents: 0,
    });
    expect(await prisma.pollCustomEntry.findUnique({ where: { id: entry.id } })).toMatchObject({
      status: 'PENDING',
    });
  });

  it('with no active Tiltify Destination still publishes native changes, not alerts or totals', async () => {
    const { donor, event, channel, native, tiltify } = await fixture();
    await prisma.webhookDestination.update({
      where: { id: tiltify.id },
      data: { is_active: false },
    });
    await withWebhooks(async (tx, _emit, publisher) => {
      const created = await tx.donation.create({
        data: {
          donor_id: donor.id,
          external_id: crypto.randomUUID(),
          amount_cents: 1000,
          channel_id: channel.id,
          event_id: event.id,
        },
      });
      await publisher.publish(created.id, null);
      const before = await publisher.snapshot(created.id);
      await tx.donation.update({ where: { id: created.id }, data: { hidden_from_overlay: true } });
      await publisher.publish(created.id, before);
    });
    expect((await messages(native.id)).map((m) => m.type)).toEqual([
      'donation.created',
      'donation.hidden',
    ]);
    expect(await messages(tiltify.id)).toEqual([]);
  });

  it('withholds a new unassigned donation until routing supplies a Channel', async () => {
    const { donor, native, tiltify } = await fixture();
    await withWebhooks(async (tx, _emit, publisher) => {
      const created = await tx.donation.create({
        data: {
          donor_id: donor.id,
          external_id: crypto.randomUUID(),
          amount_cents: 1000,
        },
      });
      await publisher.publish(created.id, null);
    });
    expect(await messages(native.id)).toEqual([]);
    expect(await messages(tiltify.id)).toEqual([]);
  });

  it('reserves forced Tiltify donation and totals publication for transition corrections', async () => {
    const { donor, event, channel, native, tiltify } = await fixture();
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: crypto.randomUUID(),
        amount_cents: 0,
        channel_id: channel.id,
        event_id: event.id,
      },
    });
    await withWebhooks(async (_tx, _emit, publisher) => {
      await publisher.forceForTransition([donation.id, donation.id]);
    });
    expect(await messages(native.id)).toEqual([]);
    expect((await messages(tiltify.id)).map((m) => m.type)).toEqual([
      'tiltify.donation',
      'tiltify.fact.updated',
      'tiltify.fact.updated',
    ]);
  });

  it('introduces a routed donation in native and Tiltify formats before its totals', async () => {
    const { donor, event, channel, native, tiltify } = await fixture();
    const donation = await withWebhooks(async (tx, _emit, publisher) => {
      const created = await tx.donation.create({
        data: {
          donor_id: donor.id,
          external_id: crypto.randomUUID(),
          amount_cents: 1200,
          donor_name: 'Reader',
          comment: 'Hello',
          channel_id: channel.id,
          event_id: event.id,
        },
      });
      await publisher.publish(created.id, null);
      return created;
    });
    expect(await messages(native.id)).toEqual([
      {
        type: 'donation.created',
        key: null,
        payload: {
          id: expect.any(String),
          type: 'donation.created',
          created_at: expect.any(String),
          data: {
            donation_id: donation.id,
            external_id: donation.external_id,
            amount_cents: 1200,
            status: 'COMPLETED',
            pledge_amount_cents: null,
            wallet_applied_cents: 0,
            allocations: { reward: [], poll: [], goal: [] },
            channel_id: channel.id,
            event_id: event.id,
            donor_ref: donor.id,
            donor_name: 'Reader',
            donor_comment: 'Hello',
            hidden_from_overlay: false,
          },
        },
      },
    ]);
    const queued = await messages(tiltify.id);
    expect(queued.map((m) => [m.type, m.key])).toEqual([
      ['tiltify.donation', `${channel.slug}.donation`],
      ['tiltify.fact.updated', `${channel.slug}.fact.updated`],
      ['tiltify.fact.updated', `${event.slug}.fact.updated`],
    ]);
    expect(queued[0]?.payload).toMatchObject({
      id: donation.id,
      amount: { value: '12.00' },
      donor_name: 'Reader',
    });
    expect(queued.slice(1).map((m) => m.payload.total_amount_raised.value)).toEqual([
      '12.00',
      '12.00',
    ]);
  });
});
