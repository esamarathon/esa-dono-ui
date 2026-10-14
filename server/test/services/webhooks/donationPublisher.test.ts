import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import { withWebhooks } from '../../../services/webhooks/outbox.js';
import { moderateCustomEntryTx } from '../../../services/reversal.js';
import { proposeCustomEntryTx } from '../../../services/spend.js';

// Only replace the network delivery boundary, never the outbox or database.
vi.mock('../../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));

const donors: string[] = [];
const destinations: string[] = [];
const channels: string[] = [];
const events: string[] = [];
const polls: string[] = [];

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

afterEach(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.pollCustomEntry.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  donors.length = destinations.length = channels.length = events.length = polls.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('Donation publisher through the SQLite outbox', () => {
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
