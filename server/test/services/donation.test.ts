import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import prisma from '../../lib/prisma.js';
import { intakeDonation } from '../../services/donation.js';
import { createPledge as createPooledPledge } from '../../services/pledge.js';
import { planPledge } from '@dono/shared';
import { getPledge, reconcileCheckoutNotification } from '../../services/checkout.js';
import { createDonationPublisher } from '../../services/webhooks/donationPublisher.js';
import type { TiltifyMessage } from '../../services/webhooks/tiltifyPayload.js';
import { sendMagicLink } from '../../services/email.js';
import { drainDestination } from '../../services/webhooks/dispatcher.js';
import { createTestChannel, createLegacyPledge as createPledge } from '../helpers/fixtures.js';

vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));

const emails: string[] = [];
const channels: string[] = [];
const rewards: string[] = [];
const pledges: string[] = [];
const polls: string[] = [];
const goals: string[] = [];
const destinations: string[] = [];
const events: string[] = [];
const blockedWords: string[] = [];

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
  // Intake promises immutable queued messages, not transport-attempt timestamps.
  // Keep the dispatcher real; its independent retries may update mutable fields.
  return prisma.webhookDelivery.findMany({
    where: { destination_id: destinationId },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      message_id: true,
      message_type: true,
      payload: true,
      routing_key: true,
    },
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(destinations.map(drainDestination));
  const donors = await prisma.donor.findMany({ where: { email: { in: emails } } });
  const donorIds = donors.map((donor) => donor.id);
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS intake_reject_delivery');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS pooled_reject_vote');
  await prisma.blockedWord.deleteMany({ where: { id: { in: blockedWords } } });
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pollOption.deleteMany({ where: { custom_entry: { donor_id: { in: donorIds } } } });
  await prisma.pollCustomEntry.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: { in: pledges } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
  await prisma.event.updateMany({
    where: { id: { in: events } },
    data: { primary_channel_id: null },
  });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  emails.length = channels.length = rewards.length = pledges.length = 0;
  polls.length = goals.length = destinations.length = events.length = blockedWords.length = 0;
});
afterAll(() => prisma.$disconnect());
afterEach(() => vi.unstubAllEnvs());

describe('Donation intake on SQLite', () => {
  it.each(
    ['', '   ', null, 'Chosen handle'].flatMap((displayName) =>
      ['cash', 'wallet', 'legacy-late', 'payment-review'].map((path) => ({ displayName, path })),
    ),
  )(
    'preserves confirmed public name $displayName through $path receipt and publication',
    async ({ displayName, path }) => {
      const email = `${crypto.randomUUID()}@example.test`;
      emails.push(email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const donor = await prisma.donor.create({
        data: {
          email,
          balance_remaining: path === 'wallet' ? 1000 : path === 'payment-review' ? 400 : 0,
          magic_token: crypto.randomUUID(),
        },
      });
      const confirmed = await createPooledPledge({
        draft_id: crypto.randomUUID(),
        pledge_amount_cents: 1000,
        channel_id: channel.id,
        walletDonorId: donor.id,
        display_name: displayName,
        comment: null,
        items: [],
        plan: planPledge({
          pledge_amount_cents: 1000,
          available_wallet_cents: donor.balance_remaining,
          selections: [],
        }),
      });
      pledges.push(confirmed.pledge_token);
      const expectedName = displayName === 'Chosen handle' ? 'Chosen handle' : null;
      expect(confirmed.display_name).toBe(expectedName);
      const externalId = `cs_${crypto.randomUUID()}`;
      await prisma.pendingPledge.update({
        where: { pledge_token: confirmed.pledge_token },
        data: {
          checkout_session_id: path === 'wallet' ? null : externalId,
          ...(path === 'legacy-late'
            ? { format: 'LEGACY', status: 'EXPIRED', total_cents: 1000, pledge_amount_cents: null }
            : {}),
          ...(path === 'payment-review'
            ? {
                status: 'CANCELLED',
                wallet_hold_status: 'RELEASED',
                non_payment_confirmed_at: new Date(),
              }
            : {}),
        },
      });
      // A contradictory late payment cannot borrow already-used original Wallet funding.
      if (path === 'payment-review')
        await prisma.donor.update({
          where: { id: donor.id },
          data: { balance_remaining: 0, balance_held_cents: 0 },
        });
      if (path === 'wallet')
        await intakeDonation({
          source: 'wallet',
          donor,
          pledge: await getPledge(confirmed.pledge_token),
        });
      else
        await reconcileCheckoutNotification('checkout.session.completed', {
          id: externalId,
          status: 'complete',
          payment_status: 'paid',
          amount_total: path === 'payment-review' ? 600 : 1000,
          total_details: { amount_shipping: 0, amount_discount: 0, amount_tax: 0 },
          customer_details: {
            email,
            name: 'PRIVATE LEGAL NAME',
            address: null,
            business_name: null,
            individual_name: null,
            phone: null,
            tax_exempt: null,
            tax_ids: null,
          },
          metadata: { pledge_token: confirmed.pledge_token },
        });
      const receipt = await prisma.donation.findFirstOrThrow({ where: { donor_id: donor.id } });
      expect(receipt).toMatchObject({
        donor_name: expectedName,
        comment: null,
        amount_cents: path === 'wallet' ? 0 : path === 'payment-review' ? 600 : 1000,
        pledge_amount_cents: ['legacy-late', 'payment-review'].includes(path) ? null : 1000,
        wallet_applied_cents: path === 'wallet' ? 1000 : 0,
        wallet_credit_granted_cents: 0,
        channel_id: channel.id,
      });
      expect(await getPledge(confirmed.pledge_token)).toMatchObject({
        status:
          path === 'legacy-late'
            ? 'EXPIRED'
            : path === 'payment-review'
              ? 'PAYMENT_REVIEW'
              : 'FULFILLED',
        fulfilled_by_donation_id: receipt.id,
      });
      const native: unknown[] = [];
      const tiltify: TiltifyMessage[] = [];
      await prisma.$transaction(async (tx) => {
        await createDonationPublisher(
          tx,
          async (_type, build) => {
            native.push(build());
          },
          async () => true,
          async (messages) => {
            tiltify.push(...messages);
          },
        ).publish(receipt.id, null);
      });
      expect(native).toMatchObject([{ data: { donor_name: expectedName, donor_comment: null } }]);
      expect(tiltify[0]!.payload).toMatchObject({
        donor_name: expectedName ?? 'Anonymous',
        donor_comment: null,
      });
      expect(JSON.stringify({ receipt, native, tiltify })).not.toContain('PRIVATE LEGAL NAME');
    },
  );
  it.each(['own-list', 'primary-list', 'closest-own', 'closest-shared', 'none'] as const)(
    'routes an unselected goal Pool through %s, never defaults polls, and permits overshoot',
    async (stage) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      const event = await prisma.event.create({
        data: { name: 'Fallback', slug: `fallback-${crypto.randomUUID()}` },
      });
      events.push(event.id);
      const channel = await createTestChannel(prisma, { event_id: event.id });
      channels.push(channel.id);
      const primary = await createTestChannel(prisma, { event_id: event.id });
      channels.push(primary.id);
      await prisma.event.update({
        where: { id: event.id },
        data: { primary_channel_id: primary.id },
      });
      const inactive = await prisma.fundGoal.create({
        data: {
          title: 'Preserved inactive',
          target_cents: 100,
          is_active: false,
          channel_id: channel.id,
        },
      });
      goals.push(inactive.id);
      const own = await prisma.fundGoal.create({
        data: {
          title: 'Own',
          target_cents: 200,
          channel_id: channel.id,
          is_active: stage !== 'closest-shared' && stage !== 'none',
        },
      });
      goals.push(own.id);
      const shared = await prisma.fundGoal.create({
        data: { title: 'Closer shared', target_cents: 100, is_active: stage !== 'none' },
      });
      goals.push(shared.id);
      const foreign = await prisma.fundGoal.create({
        data: { title: 'Primary own (ineligible)', target_cents: 1, channel_id: primary.id },
      });
      goals.push(foreign.id);
      await prisma.channelDefaultGoal.create({
        data: { channel_id: channel.id, goal_id: inactive.id, position: 0 },
      });
      if (stage === 'own-list')
        await prisma.channelDefaultGoal.create({
          data: { channel_id: channel.id, goal_id: own.id, position: 1 },
        });
      await prisma.channelDefaultGoal.create({
        data: { channel_id: primary.id, goal_id: foreign.id, position: 0 },
      });
      if (stage === 'primary-list')
        await prisma.channelDefaultGoal.create({
          data: { channel_id: primary.id, goal_id: shared.id, position: 1 },
        });
      const { pledge_token } = await createPooledPledge({
        draft_id: crypto.randomUUID(),
        pledge_amount_cents: 1000,
        channel_id: channel.id,
        items: [],
        plan: planPledge({
          pledge_amount_cents: 1000,
          available_wallet_cents: null,
          selections: [],
        }),
      });
      pledges.push(pledge_token);
      const result = await intakeDonation({
        source: 'admin',
        externalId: crypto.randomUUID(),
        email,
        donorName: 'Reader',
        amountCents: 1000,
        pledgeToken: pledge_token,
      });
      if ('duplicate' in result) throw new Error('Unexpected duplicate');
      const rows = await prisma.fundContribution.findMany({
        where: { donation_id: result.donation.id },
      });
      if (stage === 'none') expect(rows).toEqual([]);
      else {
        expect(rows).toMatchObject([
          {
            amount_cents: 1000,
            source: 'auto',
            goal_id: stage === 'primary-list' || stage === 'closest-shared' ? shared.id : own.id,
          },
        ]);
        expect(await prisma.fundGoal.findUnique({ where: { id: rows[0]!.goal_id } })).toMatchObject(
          { current_cents: 1000, is_complete: true },
        );
      }
      expect(await prisma.pollVote.count({ where: { donation_id: result.donation.id } })).toBe(0);
      expect(await prisma.donor.findUnique({ where: { id: result.donor.id } })).toMatchObject({
        balance_remaining: 0,
      });
      expect(
        await prisma.channelDefaultGoal.findMany({ where: { channel_id: channel.id } }),
      ).toContainEqual(expect.objectContaining({ goal_id: inactive.id }));
    },
  );
  it.each([
    { change: 'label limit', remaining: true },
    { change: 'label limit', remaining: false },
    { change: 'blocked word', remaining: true },
    { change: 'blocked word', remaining: false },
  ])(
    'a live $change change redistributes or reserves the full poll Pool (other selection: $remaining)',
    async ({ change, remaining }) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const custom = await prisma.poll.create({
        data: { title: 'Write-in', allow_custom_entries: true, max_entry_chars: 60 },
      });
      const active = await prisma.poll.create({
        data: { title: 'Other choice', options: { create: [{ label: 'A' }] } },
        include: { options: true },
      });
      polls.push(custom.id, active.id);
      const word = `word${crypto.randomUUID().replaceAll('-', '')}`;
      const selections = [
        {
          kind: 'POLL_CUSTOM' as const,
          target_id: custom.id,
          poll_id: custom.id,
          amount_cents: 100,
          insertion_order: 0,
          data: { label: `Original ${word.toUpperCase()}` },
        },
        ...(remaining
          ? [
              {
                kind: 'POLL_VOTE' as const,
                target_id: active.options[0]!.id,
                poll_id: active.id,
                amount_cents: 200,
                insertion_order: 1,
              },
            ]
          : []),
      ];
      const { pledge_token } = await createPooledPledge({
        draft_id: crypto.randomUUID(),
        pledge_amount_cents: 1000,
        channel_id: channel.id,
        items: selections,
        plan: planPledge({ pledge_amount_cents: 1000, selections, available_wallet_cents: null }),
      });
      pledges.push(pledge_token);
      if (change === 'label limit')
        await prisma.poll.update({ where: { id: custom.id }, data: { max_entry_chars: 3 } });
      else {
        const blocked = await prisma.blockedWord.create({ data: { word } });
        blockedWords.push(blocked.id);
      }
      const { native, tiltify } = await deliveryDestinations();
      const facts = {
        source: 'stripe' as const,
        externalId: crypto.randomUUID(),
        email,
        donorName: 'Reader',
        amountCents: 1000,
        pledgeToken: pledge_token,
      };
      await prisma.pendingPledge.update({
        where: { pledge_token },
        data: { checkout_session_id: facts.externalId },
      });
      const result = await intakeDonation(facts);
      if ('duplicate' in result) throw new Error('Unexpected duplicate');
      expect(result.pledge).toMatchObject({ totalSpent: remaining ? 1000 : 0, skipped: 1 });
      expect(result.donation).toMatchObject({
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        wallet_credit_granted_cents: 0,
      });
      expect(
        await prisma.pollVote.findMany({
          where: { donation_id: result.donation.id },
          orderBy: { amount_cents: 'asc' },
        }),
      ).toMatchObject(
        remaining
          ? [
              { poll_id: active.id, amount_cents: 200, source: 'donor' },
              { poll_id: active.id, amount_cents: 800, source: 'auto' },
            ]
          : [],
      );
      expect(await prisma.poolCredit.count({ where: { donation_id: result.donation.id } })).toBe(0);
      expect(await prisma.pollCustomEntry.count({ where: { poll_id: custom.id } })).toBe(0);
      expect(await prisma.poll.findUnique({ where: { id: active.id } })).toMatchObject({
        total_votes_cents: remaining ? 1000 : 0,
      });
      expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
        status: 'FULFILLED',
        fulfilled_by_donation_id: result.donation.id,
      });
      expect(await intakeDonation(facts)).toEqual({ duplicate: true });
      expect(await prisma.donor.findUnique({ where: { id: result.donor.id } })).toMatchObject({
        total_donated: 1000,
        balance_remaining: 0,
      });
      expect(await prisma.donation.count({ where: { donor_id: result.donor.id } })).toBe(1);
      expect(await deliveries(native.id)).toHaveLength(1);
      const queued = await deliveries(tiltify.id);
      expect(queued.map((row) => row.message_type)).toEqual([
        'tiltify.donation',
        'tiltify.fact.updated',
        'tiltify.fact.updated',
      ]);
      expect(JSON.parse(queued[0]!.payload).poll_votes).toEqual(
        remaining ? [{ poll_id: active.id, poll_option_id: active.options[0]!.id }] : [],
      );
      expect(sendMagicLink).toHaveBeenCalledTimes(1);
    },
  );

  it('redistributes freed poll/goal funding across the remaining choices, including a pending write-in', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const custom = await prisma.poll.create({
      data: { title: 'Pending', allow_custom_entries: true, auto_approve: false },
    });
    polls.push(custom.id);
    const active = await prisma.poll.create({
      data: { title: 'Open', options: { create: [{ label: 'A' }] } },
      include: { options: true },
    });
    polls.push(active.id);
    const ended = await prisma.poll.create({
      data: { title: 'Ending', options: { create: [{ label: 'B' }] } },
      include: { options: true },
    });
    polls.push(ended.id);
    const a = await prisma.fundGoal.create({
      data: { title: 'A', channel_id: channel.id, target_cents: 10000 },
    });
    goals.push(a.id);
    const b = await prisma.fundGoal.create({
      data: { title: 'B', channel_id: channel.id, target_cents: 10000 },
    });
    goals.push(b.id);
    const c = await prisma.fundGoal.create({
      data: { title: 'C', channel_id: channel.id, target_cents: 10000 },
    });
    goals.push(c.id);
    const selections = [
      {
        kind: 'POLL_CUSTOM' as const,
        target_id: custom.id,
        poll_id: custom.id,
        amount_cents: 100,
        insertion_order: 0,
        data: { label: 'Write me in' },
      },
      {
        kind: 'POLL_VOTE' as const,
        target_id: active.options[0]!.id,
        poll_id: active.id,
        amount_cents: 200,
        insertion_order: 1,
      },
      {
        kind: 'POLL_VOTE' as const,
        target_id: ended.options[0]!.id,
        poll_id: ended.id,
        amount_cents: 300,
        insertion_order: 2,
      },
      { kind: 'GOAL' as const, target_id: a.id, amount_cents: 100, insertion_order: 3 },
      { kind: 'GOAL' as const, target_id: b.id, amount_cents: 200, insertion_order: 4 },
      { kind: 'GOAL' as const, target_id: c.id, amount_cents: 300, insertion_order: 5 },
    ];
    const { pledge_token } = await createPooledPledge({
      draft_id: crypto.randomUUID(),
      pledge_amount_cents: 1000,
      channel_id: channel.id,
      items: selections,
      plan: planPledge({ pledge_amount_cents: 1000, selections, available_wallet_cents: null }),
    });
    pledges.push(pledge_token);
    await prisma.poll.update({
      where: { id: ended.id },
      data: { ends_at: new Date('2000-01-01') },
    });
    await prisma.fundGoal.update({ where: { id: c.id }, data: { is_complete: true } });
    const externalId = crypto.randomUUID();
    await prisma.pendingPledge.update({
      where: { pledge_token },
      data: { checkout_session_id: externalId },
    });
    const result = await intakeDonation({
      source: 'stripe',
      externalId,
      email,
      donorName: 'Reader',
      amountCents: 1000,
      pledgeToken: pledge_token,
    });
    if ('duplicate' in result) throw new Error('Unexpected duplicate');
    expect(result.pledge).toMatchObject({ totalSpent: 2000, skipped: 2 });
    const votes = await prisma.pollVote.findMany({
      where: { donation_id: result.donation.id },
      orderBy: { amount_cents: 'asc' },
    });
    expect(votes).toMatchObject([
      { poll_id: custom.id, amount_cents: 100, source: 'donor' },
      { poll_id: active.id, amount_cents: 200, source: 'donor' },
      { poll_id: custom.id, amount_cents: 233, source: 'auto' },
      { poll_id: active.id, amount_cents: 467, source: 'auto' },
    ]);
    expect(await prisma.pollOption.findFirst({ where: { poll_id: custom.id } })).toMatchObject({
      status: 'PENDING_APPROVAL',
      votes_cents: 0,
    });
    expect(await prisma.poll.findUnique({ where: { id: active.id } })).toMatchObject({
      total_votes_cents: 667,
    });
    expect(await prisma.fundGoal.findUnique({ where: { id: a.id } })).toMatchObject({
      current_cents: 333,
    });
    expect(await prisma.fundGoal.findUnique({ where: { id: b.id } })).toMatchObject({
      current_cents: 667,
    });
  });

  it('fulfills independent $10 Pools with $6 new money, separate $2 shipping and zero Wallet credit', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email, balance_remaining: 400, total_donated: 400, magic_token: crypto.randomUUID() },
    });
    const reward = await prisma.reward.create({
      data: { title: 'Locked physical', type: 'PHYSICAL', cost_cents: 600 },
    });
    rewards.push(reward.id);
    const poll = await prisma.poll.create({
      data: { title: 'Poll', options: { create: [{ label: 'A' }] } },
      include: { options: true },
    });
    polls.push(poll.id);
    const goal = await prisma.fundGoal.create({ data: { title: 'Goal', target_cents: 5000 } });
    goals.push(goal.id);
    const plan = planPledge({
      pledge_amount_cents: 1000,
      available_wallet_cents: 400,
      selections: [
        {
          kind: 'REWARD',
          target_id: reward.id,
          amount_cents: 600,
          unit_price_cents: 600,
          reward_type: 'PHYSICAL',
          insertion_order: 0,
        },
        {
          kind: 'POLL_VOTE',
          target_id: poll.options[0]!.id,
          poll_id: poll.id,
          amount_cents: 100,
          insertion_order: 1,
        },
        { kind: 'GOAL', target_id: goal.id, amount_cents: 300, insertion_order: 2 },
      ],
    });
    const { pledge_token } = await createPooledPledge({
      draft_id: crypto.randomUUID(),
      pledge_amount_cents: 1000,
      channel_id: channel.id,
      walletDonorId: donor.id,
      plan,
      items: plan.selections,
    });
    pledges.push(pledge_token);
    await prisma.reward.update({ where: { id: reward.id }, data: { cost_cents: 2000 } });
    const externalId = crypto.randomUUID();
    await prisma.pendingPledge.update({
      where: { pledge_token },
      data: { checkout_session_id: externalId },
    });
    const result = await intakeDonation({
      source: 'stripe',
      externalId,
      email,
      donorName: 'Reader',
      amountCents: 800,
      shippingCents: 200,
      pledgeToken: pledge_token,
    });
    if ('duplicate' in result) throw new Error('Unexpected duplicate');
    expect(result.donation).toMatchObject({
      amount_cents: 600,
      pledge_amount_cents: 1000,
      wallet_applied_cents: 400,
      shipping_cents: 200,
      wallet_credit_granted_cents: 0,
    });
    expect(result.pledge).toMatchObject({ totalSpent: 2600, skipped: 0 });
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      total_donated: 1000,
      balance_remaining: 0,
      balance_held_cents: 0,
    });
    expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
      wallet_hold_status: 'CONSUMED',
      held_wallet_cents: 400,
    });
    expect(
      await prisma.rewardClaim.findMany({ where: { donation_id: result.donation.id } }),
    ).toMatchObject([{ amount_cents: 600, donor_id: donor.id }]);
    expect(
      await prisma.pollVote.findMany({
        where: { donation_id: result.donation.id },
        orderBy: { amount_cents: 'asc' },
      }),
    ).toMatchObject([
      { amount_cents: 100, source: 'donor' },
      { amount_cents: 900, source: 'auto' },
    ]);
    expect(
      await prisma.fundContribution.findMany({
        where: { donation_id: result.donation.id },
        orderBy: { amount_cents: 'asc' },
      }),
    ).toMatchObject([
      { amount_cents: 300, source: 'donor' },
      { amount_cents: 700, source: 'auto' },
    ]);
  });
  it.each(['allocation', 'outbox'] as const)(
    'rolls pooled money, claims, votes, stock, consumed hold and mail back on a late %s failure',
    async (failure) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const donor = await prisma.donor.create({
        data: {
          email,
          balance_remaining: 400,
          total_donated: 400,
          magic_token: crypto.randomUUID(),
        },
      });
      const reward = await prisma.reward.create({
        data: { title: 'Rollback', cost_cents: 500, type: 'DIGITAL' },
      });
      rewards.push(reward.id);
      const poll = await prisma.poll.create({
        data: { title: 'Rollback poll', options: { create: [{ label: 'A' }] } },
        include: { options: true },
      });
      polls.push(poll.id);
      const selections = [
        {
          kind: 'REWARD' as const,
          target_id: reward.id,
          amount_cents: 500,
          unit_price_cents: 500,
          reward_type: 'DIGITAL',
          insertion_order: 0,
        },
        {
          kind: 'POLL_VOTE' as const,
          target_id: poll.options[0]!.id,
          poll_id: poll.id,
          amount_cents: 100,
          insertion_order: 1,
        },
      ];
      const { pledge_token } = await createPooledPledge({
        draft_id: crypto.randomUUID(),
        pledge_amount_cents: 1000,
        items: selections,
        channel_id: channel.id,
        walletDonorId: donor.id,
        plan: planPledge({ pledge_amount_cents: 1000, selections, available_wallet_cents: 400 }),
      });
      pledges.push(pledge_token);
      const { native, tiltify } = await deliveryDestinations();
      if (failure === 'allocation')
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER pooled_reject_vote BEFORE INSERT ON PollVote BEGIN SELECT RAISE(ABORT, 'late vote failure'); END`,
        );
      else
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER intake_reject_delivery BEFORE INSERT ON WebhookDelivery WHEN NEW.event_type = 'tiltify.fact.updated' BEGIN SELECT RAISE(ABORT, 'late outbox failure'); END`,
        );
      const externalId = crypto.randomUUID();
      await prisma.pendingPledge.update({
        where: { pledge_token },
        data: { checkout_session_id: externalId },
      });
      await expect(
        intakeDonation({
          source: 'stripe',
          email,
          donorName: 'Reader',
          amountCents: 600,
          externalId,
          pledgeToken: pledge_token,
        }),
      ).rejects.toThrow();
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        total_donated: 400,
        balance_remaining: 0,
        balance_held_cents: 400,
      });
      expect(await prisma.pendingPledge.findUnique({ where: { pledge_token } })).toMatchObject({
        status: 'OPEN',
        wallet_hold_status: 'HELD',
        fulfilled_by_donation_id: null,
      });
      expect(await prisma.rewardClaim.count({ where: { donor_id: donor.id } })).toBe(0);
      expect(await prisma.pollVote.count({ where: { donor_id: donor.id } })).toBe(0);
      expect(await prisma.donation.count({ where: { donor_id: donor.id } })).toBe(0);
      expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
        quantity_claimed: 0,
      });
      expect(await deliveries(native.id)).toEqual([]);
      expect(await deliveries(tiltify.id)).toEqual([]);
      expect(sendMagicLink).not.toHaveBeenCalled();
    },
  );

  it.each(['sold-out', 'type-change'] as const)(
    'skips an incompatible pooled reward at payment (%s) without repricing or Wallet credit',
    async (change) => {
      const email = `${crypto.randomUUID()}@example.com`;
      emails.push(email);
      const channel = await createTestChannel(prisma);
      channels.push(channel.id);
      const donor = await prisma.donor.create({
        data: {
          email,
          balance_remaining: 400,
          total_donated: 400,
          magic_token: crypto.randomUUID(),
        },
      });
      const reward = await prisma.reward.create({
        data: { title: 'Confirmed physical', type: 'PHYSICAL', cost_cents: 600, quantity_total: 1 },
      });
      rewards.push(reward.id);
      const selections = [
        {
          kind: 'REWARD' as const,
          target_id: reward.id,
          amount_cents: 600,
          unit_price_cents: 600,
          reward_type: 'PHYSICAL',
          insertion_order: 0,
        },
      ];
      const { pledge_token } = await createPooledPledge({
        draft_id: crypto.randomUUID(),
        pledge_amount_cents: 1000,
        items: selections,
        channel_id: channel.id,
        walletDonorId: donor.id,
        plan: planPledge({ pledge_amount_cents: 1000, selections, available_wallet_cents: 400 }),
      });
      pledges.push(pledge_token);
      await prisma.reward.update({
        where: { id: reward.id },
        data: change === 'sold-out' ? { quantity_claimed: 1 } : { type: 'DIGITAL' },
      });
      const externalId = crypto.randomUUID();
      await prisma.pendingPledge.update({
        where: { pledge_token },
        data: { checkout_session_id: externalId },
      });
      const result = await intakeDonation({
        source: 'stripe',
        externalId,
        email,
        donorName: 'Reader',
        amountCents: 600,
        pledgeToken: pledge_token,
      });
      if ('duplicate' in result) throw new Error('Unexpected duplicate');
      expect(result.pledge).toMatchObject({ skipped: 1 });
      expect(await prisma.rewardClaim.count({ where: { donation_id: result.donation.id } })).toBe(
        0,
      );
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        total_donated: 1000,
        balance_remaining: 0,
        balance_held_cents: 0,
      });
      expect(
        await prisma.pledgeItem.findFirst({ where: { pledge: { pledge_token }, kind: 'REWARD' } }),
      ).toMatchObject({ unit_price_cents: 600, confirmed_reward_type: 'PHYSICAL' });
    },
  );

  it('round-trips opaque falsy selection data without diverging from the confirmed plan', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const goal = await prisma.fundGoal.create({
      data: { title: 'Opaque data', target_cents: 5000 },
    });
    goals.push(goal.id);
    const items = [
      {
        kind: 'GOAL' as const,
        target_id: goal.id,
        amount_cents: 100,
        insertion_order: 0,
        data: false,
      },
    ];
    const { pledge_token } = await createPooledPledge({
      draft_id: crypto.randomUUID(),
      pledge_amount_cents: 1000,
      channel_id: channel.id,
      items,
      plan: planPledge({
        pledge_amount_cents: 1000,
        selections: items,
        available_wallet_cents: null,
      }),
    });
    pledges.push(pledge_token);
    const result = await intakeDonation({
      source: 'admin',
      externalId: crypto.randomUUID(),
      email,
      donorName: 'Reader',
      amountCents: 1000,
      pledgeToken: pledge_token,
    });
    if ('duplicate' in result) throw new Error('Unexpected duplicate');
    expect(result.pledge).toMatchObject({ totalSpent: 1000, skipped: 0 });
  });

  it('records Wallet-only pooled pledges as zero money and consumes their hold at most once', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const channel = await createTestChannel(prisma);
    channels.push(channel.id);
    const donor = await prisma.donor.create({
      data: {
        email,
        balance_remaining: 1000,
        total_donated: 1000,
        magic_token: crypto.randomUUID(),
      },
    });
    const reward = await prisma.reward.create({
      data: { title: 'Wallet digital', type: 'DIGITAL', cost_cents: 1000 },
    });
    rewards.push(reward.id);
    const selections = [
      {
        kind: 'REWARD' as const,
        target_id: reward.id,
        amount_cents: 1000,
        unit_price_cents: 1000,
        reward_type: 'DIGITAL',
        insertion_order: 0,
      },
    ];
    const { pledge_token } = await createPooledPledge({
      draft_id: crypto.randomUUID(),
      pledge_amount_cents: 1000,
      items: selections,
      channel_id: channel.id,
      walletDonorId: donor.id,
      plan: planPledge({ pledge_amount_cents: 1000, selections, available_wallet_cents: 1000 }),
    });
    pledges.push(pledge_token);
    const pledge = await prisma.pendingPledge.findUniqueOrThrow({
      where: { pledge_token },
      include: { items: true },
    });
    const results = await Promise.all([
      intakeDonation({ source: 'wallet', pledge, donor }),
      intakeDonation({ source: 'wallet', pledge, donor }),
    ]);
    expect(results.filter((result) => 'duplicate' in result)).toHaveLength(1);
    expect(await prisma.donation.findMany({ where: { donor_id: donor.id } })).toMatchObject([
      { amount_cents: 0, pledge_amount_cents: 1000, wallet_applied_cents: 1000, shipping_cents: 0 },
    ]);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      total_donated: 1000,
      balance_remaining: 0,
      balance_held_cents: 0,
    });
    expect(await prisma.rewardClaim.count({ where: { donor_id: donor.id } })).toBe(1);
    expect(sendMagicLink).toHaveBeenCalledTimes(1);
  });

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
    { source: 'stripe', amount: 3200, money: 2500, shipping: 700, totalAfterRepeat: 3000 },
    { source: 'admin', amount: 2500, money: 2500, shipping: 0, totalAfterRepeat: 3000 },
  ] as const)(
    '$source records money, allocations, stable identity and deliveries',
    async ({ source, amount, money, shipping, totalAfterRepeat }) => {
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
        total_donated: money,
        balance_remaining: 2500,
        role: 'USER',
      });
      expect(result.token).toMatch(/^[a-f0-9]{64}$/);
      expect(result.pledge).toMatchObject({ totalSpent: 1500, skipped: 0 });
      expect(await prisma.donor.findUnique({ where: { id: result.donor.id } })).toMatchObject({
        total_donated: money,
        balance_remaining: 1000,
        role: 'USER',
        email_verified: false,
      });
      const donation = await prisma.donation.findUniqueOrThrow({
        where: { id: result.donation.id },
      });
      expect(donation).toMatchObject({
        amount_cents: money,
        shipping_cents: shipping,
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
        amount_cents: money,
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
        amount: { value_cents: money },
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
