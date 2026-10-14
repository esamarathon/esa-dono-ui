import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Keep the real outbox; replace only the delivery adapter so no network calls run.
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import {
  reverseSpendTx,
  setDonationStatusTx,
  refundPollOptionVotes,
  refundGoalContributions,
  adjustWalletCreditTx,
  sweepWalletCreditsTx,
  moderateCustomEntryTx,
} from '../../services/reversal.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
import { proposeCustomEntryTx } from '../../services/spend.js';

const donorIds: string[] = [];
const rewardIds: string[] = [];
const pollIds: string[] = [];
const goalIds: string[] = [];
const channelIds: string[] = [];
const eventIds: string[] = [];
const destinationIds: string[] = [];

async function donor(balance: number) {
  const row = await prisma.donor.create({
    data: { email: `reversal-${crypto.randomUUID()}@example.com`, balance_remaining: balance },
  });
  donorIds.push(row.id);
  return row;
}

afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_reversal_adjustment');
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: pollIds } } });
  await prisma.pollCustomEntry.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.poll.deleteMany({ where: { id: { in: pollIds } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goalIds } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donorIds } } });
  await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
  await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinationIds } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinationIds } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinationIds } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewardIds } } });
  donorIds.length = 0;
  rewardIds.length = 0;
  pollIds.length = 0;
  goalIds.length = 0;
  channelIds.length = 0;
  eventIds.length = 0;
  destinationIds.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('Reversal accounting on SQLite', () => {
  it('a per-goal reversal with no live rows preserves even a manually set completion flag', async () => {
    const goal = await prisma.fundGoal.create({
      data: { title: 'Manual completion', target_cents: 1000, current_cents: 0, is_complete: true },
    });
    goalIds.push(goal.id);
    expect(
      await prisma.$transaction((tx) => refundGoalContributions(tx, goal.id, 'admin')),
    ).toEqual({ refunded_count: 0, refunded_cents: 0 });
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      current_cents: 0,
      is_complete: true,
    });
  });

  it.each(['REFUNDED', 'CHARGEBACK'])(
    '%s preserves the existing outbox publication rule',
    async (status) => {
      const owner = await donor(1000);
      const event = await prisma.event.create({
        data: { name: 'Event', slug: `reversal-${crypto.randomUUID()}` },
      });
      eventIds.push(event.id);
      const channel = await prisma.channel.create({
        data: {
          name: `Channel ${crypto.randomUUID()}`,
          slug: `reversal-${crypto.randomUUID()}`,
          event_id: event.id,
        },
      });
      channelIds.push(channel.id);
      const donation = await prisma.donation.create({
        data: {
          donor_id: owner.id,
          external_id: crypto.randomUUID(),
          amount_cents: 1000,
          channel_id: channel.id,
          event_id: event.id,
        },
      });
      const destination = await prisma.webhookDestination.create({
        data: {
          url: 'http://127.0.0.1:1/hook',
          secret: 's',
          payload_format: 'TILTIFY',
          event_types: '[]',
        },
      });
      destinationIds.push(destination.id);
      const native = await prisma.webhookDestination.create({
        data: { url: 'http://127.0.0.1:1/hook', secret: 's', event_types: '["donation.created"]' },
      });
      destinationIds.push(native.id);
      await withWebhooks((tx, _emit, publisher) =>
        setDonationStatusTx(tx, donation.id, status, undefined, 'admin', publisher),
      );
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { destination_id: destination.id },
      });
      if (status === 'REFUNDED') {
        expect(deliveries).toEqual([]);
      } else {
        expect(deliveries).toHaveLength(2);
        expect(
          deliveries.map((row) => ({
            type: row.message_type,
            key: row.routing_key,
            payload: JSON.parse(row.payload),
          })),
        ).toEqual(
          expect.arrayContaining([
            {
              type: 'tiltify.fact.updated',
              key: `${channel.slug}.fact.updated`,
              payload: {
                id: channel.id,
                slug: channel.slug,
                name: channel.name,
                total_amount_raised: { currency: 'USD', value: '0.00' },
              },
            },
            {
              type: 'tiltify.fact.updated',
              key: `${event.slug}.fact.updated`,
              payload: {
                id: event.id,
                slug: event.slug,
                name: event.name,
                total_amount_raised: { currency: 'USD', value: '0.00' },
              },
            },
          ]),
        );
      }
      expect(await prisma.webhookDelivery.count({ where: { destination_id: native.id } })).toBe(0);
    },
  );

  it.each([
    'claim',
    'vote',
    'contribution',
    'status',
    'write-in',
    'manual',
    'sweep',
    'poll-option',
    'goal',
  ])('%s rolls back every change if the ledger write fails', async (action) => {
    const owner = await donor(2000);
    const donation = await prisma.donation.create({
      data: { donor_id: owner.id, external_id: crypto.randomUUID(), amount_cents: 1000 },
    });
    const reward = await prisma.reward.create({
      data: { title: 'Reward', type: 'DIGITAL', cost_cents: 500, quantity_claimed: 1 },
    });
    rewardIds.push(reward.id);
    const claim = await prisma.rewardClaim.create({
      data: { donor_id: owner.id, reward_id: reward.id },
    });
    const goal = await prisma.fundGoal.create({
      data: { title: 'Goal', target_cents: 500, current_cents: 700, is_complete: true },
    });
    goalIds.push(goal.id);
    const contribution = await prisma.fundContribution.create({
      data: { donor_id: owner.id, goal_id: goal.id, amount_cents: 700 },
    });
    const poll = await prisma.poll.create({
      data: { title: 'Write-ins', allow_custom_entries: true, auto_approve: false },
    });
    pollIds.push(poll.id);
    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, owner.id, poll.id, 'Idea', 400),
    );
    const vote = await prisma.pollVote.findFirstOrThrow({ where: { poll_option_id: option.id } });

    // Fail at the actual database boundary, after the donor balance has been changed.
    // The interpolated id is a database-generated UUID, not external input.
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_reversal_adjustment BEFORE INSERT ON BalanceAdjustment
      WHEN NEW.donor_id = '${owner.id}' BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END`);
    await expect(
      withWebhooks(async (tx, _emit, publisher) => {
        switch (action) {
          case 'claim':
            return reverseSpendTx(tx, owner.id, 'claim', claim.id, 'admin');
          case 'vote':
            return reverseSpendTx(tx, owner.id, 'vote', vote.id, 'admin');
          case 'contribution':
            return reverseSpendTx(tx, owner.id, 'contribution', contribution.id, 'admin');
          case 'status':
            return setDonationStatusTx(
              tx,
              donation.id,
              'CHARGEBACK',
              undefined,
              'admin',
              publisher,
            );
          case 'write-in':
            return moderateCustomEntryTx(tx, entry.id, 'REJECTED', 'moderator', publisher);
          case 'manual':
            return adjustWalletCreditTx(tx, owner.id, 200, 'MANUAL', undefined, 'admin');
          case 'sweep':
            return sweepWalletCreditsTx(tx, { id: owner.id }, true, 'admin');
          case 'poll-option':
            return refundPollOptionVotes(tx, option.id, 'admin');
          case 'goal':
            return refundGoalContributions(tx, goal.id, 'admin');
          default:
            throw new Error('Unknown test action');
        }
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 1600,
    });
    expect(await prisma.rewardClaim.findUnique({ where: { id: claim.id } })).toMatchObject({
      status: 'PENDING',
      reversed_at: null,
    });
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
      quantity_claimed: 1,
    });
    expect(
      await prisma.fundContribution.findUnique({ where: { id: contribution.id } }),
    ).toMatchObject({ reversed_at: null });
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      current_cents: 700,
      is_complete: true,
    });
    expect(await prisma.pollVote.findUnique({ where: { id: vote.id } })).toMatchObject({
      reversed_at: null,
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'PENDING_APPROVAL',
      votes_cents: 0,
    });
    expect(await prisma.pollCustomEntry.findUnique({ where: { id: entry.id } })).toMatchObject({
      status: 'PENDING',
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.donation.findUnique({ where: { id: donation.id } })).toMatchObject({
      status: 'COMPLETED',
      refund_id: null,
    });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: owner.id } })).toBe(0);
  });

  it.each(['poll-option', 'goal', 'sweep'])(
    '%s rolls back earlier credits when a later donor ledger write fails',
    async (action) => {
      const first = await donor(100);
      const second = await donor(200);
      const poll = await prisma.poll.create({
        data: {
          title: 'Poll',
          total_votes_cents: 750,
          options: { create: { label: 'A', votes_cents: 750 } },
        },
        include: { options: true },
      });
      pollIds.push(poll.id);
      const option = poll.options[0]!;
      const goal = await prisma.fundGoal.create({
        data: { title: 'Goal', target_cents: 500, current_cents: 750, is_complete: true },
      });
      goalIds.push(goal.id);
      await prisma.pollVote.createMany({
        data: [
          {
            donor_id: first.id,
            poll_id: poll.id,
            poll_option_id: option.id,
            amount_cents: 250,
            created_at: new Date('2026-01-01'),
          },
          {
            donor_id: second.id,
            poll_id: poll.id,
            poll_option_id: option.id,
            amount_cents: 500,
            created_at: new Date('2026-01-02'),
          },
        ],
      });
      await prisma.fundContribution.createMany({
        data: [
          {
            donor_id: first.id,
            goal_id: goal.id,
            amount_cents: 250,
            created_at: new Date('2026-01-01'),
          },
          {
            donor_id: second.id,
            goal_id: goal.id,
            amount_cents: 500,
            created_at: new Date('2026-01-02'),
          },
        ],
      });
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_reversal_adjustment BEFORE INSERT ON BalanceAdjustment
      WHEN (SELECT COUNT(*) FROM BalanceAdjustment WHERE donor_id IN ('${first.id}', '${second.id}')) = 1
      BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END`);
      await expect(
        prisma.$transaction(async (tx) => {
          if (action === 'poll-option') return refundPollOptionVotes(tx, option.id, 'admin');
          if (action === 'goal') return refundGoalContributions(tx, goal.id, 'admin');
          return sweepWalletCreditsTx(tx, { id: { in: [first.id, second.id] } }, true, 'admin');
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.donor.findUnique({ where: { id: first.id } })).toMatchObject({
        balance_remaining: 100,
      });
      expect(await prisma.donor.findUnique({ where: { id: second.id } })).toMatchObject({
        balance_remaining: 200,
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: { in: donorIds } } })).toBe(
        0,
      );
      expect(await prisma.pollVote.count({ where: { poll_id: poll.id, reversed_at: null } })).toBe(
        2,
      );
      expect(
        await prisma.fundContribution.count({ where: { goal_id: goal.id, reversed_at: null } }),
      ).toBe(2);
      expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
        votes_cents: 750,
      });
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: 750,
      });
      expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
        current_cents: 750,
        is_complete: true,
      });
    },
  );

  it.each(['APPROVED', 'REJECTED'] as const)(
    'a queued moderation request rechecks the state after %s commits',
    async (firstStatus) => {
      const owner = await donor(1000);
      const poll = await prisma.poll.create({
        data: { title: 'Write-ins', allow_custom_entries: true, auto_approve: false },
      });
      pollIds.push(poll.id);
      const { entry, option } = await prisma.$transaction((tx) =>
        proposeCustomEntryTx(tx, owner.id, poll.id, 'Idea', 400),
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
          'staff@example.com',
          publisher,
        );
        started();
        await mayCommit;
        return result;
      });
      await Promise.race([isOpen, first]);
      const second = withWebhooks((tx, _emit, publisher) =>
        moderateCustomEntryTx(
          tx,
          entry.id,
          firstStatus === 'APPROVED' ? 'REJECTED' : 'APPROVED',
          'other@example.com',
          publisher,
        ),
      );
      release();
      const results = await Promise.allSettled([first, second]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: firstStatus } });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { status: 400, message: 'Only pending entries can be moderated' },
      });
      expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
        status: firstStatus === 'APPROVED' ? 'ACTIVE' : 'REJECTED',
        votes_cents: firstStatus === 'APPROVED' ? 400 : 0,
      });
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: firstStatus === 'APPROVED' ? 400 : 0,
      });
      expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
        balance_remaining: firstStatus === 'APPROVED' ? 600 : 1000,
      });
      expect(await prisma.balanceAdjustment.count({ where: { donor_id: owner.id } })).toBe(
        firstStatus === 'APPROVED' ? 0 : 1,
      );
    },
  );

  it('vote reversal rejects an uncredited write-in and a later approval or rejection cannot reuse its funding', async () => {
    const owner = await donor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Write-ins', allow_custom_entries: true, auto_approve: false },
    });
    pollIds.push(poll.id);
    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, owner.id, poll.id, 'Idea', 400),
    );
    const vote = await prisma.pollVote.findFirstOrThrow({ where: { poll_option_id: option.id } });
    await prisma.$transaction((tx) => reverseSpendTx(tx, owner.id, 'vote', vote.id, 'admin'));
    for (const status of ['APPROVED', 'REJECTED'] as const) {
      await expect(
        withWebhooks((tx, _emit, publisher) =>
          moderateCustomEntryTx(tx, entry.id, status, 'moderator', publisher),
        ),
      ).rejects.toMatchObject({ status: 404, message: 'Associated funding vote not found' });
    }
    expect(await prisma.pollCustomEntry.findUnique({ where: { id: entry.id } })).toMatchObject({
      status: 'PENDING',
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'REJECTED',
      votes_cents: 0,
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 1000,
    });
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: owner.id } })).toBe(1);
  });

  it('concurrent write-in rejection and vote reversal return the funding at most once', async () => {
    const owner = await donor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Write-ins', allow_custom_entries: true, auto_approve: false },
    });
    pollIds.push(poll.id);
    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, owner.id, poll.id, 'Idea', 400),
    );
    const vote = await prisma.pollVote.findFirstOrThrow({ where: { poll_option_id: option.id } });
    const results = await Promise.allSettled([
      withWebhooks((tx, _emit, publisher) =>
        moderateCustomEntryTx(tx, entry.id, 'REJECTED', 'moderator', publisher),
      ),
      prisma.$transaction((tx) => reverseSpendTx(tx, owner.id, 'vote', vote.id, 'admin')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'REJECTED',
      votes_cents: 0,
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 1000,
    });
    expect(await prisma.balanceAdjustment.findMany({ where: { donor_id: owner.id } })).toEqual([
      expect.objectContaining({
        amount_cents: 400,
        balance_after_cents: 1000,
        reference_id: vote.id,
      }),
    ]);
  });

  it.each(['PENDING_APPROVAL', 'REJECTED'])(
    'per-option reversal for %s does not decrement the public tally',
    async (status) => {
      const owner = await donor(100);
      const poll = await prisma.poll.create({
        data: { title: 'Poll', options: { create: { label: 'A', status } } },
        include: { options: true },
      });
      pollIds.push(poll.id);
      const option = poll.options[0]!;
      await prisma.pollVote.create({
        data: {
          poll_id: poll.id,
          poll_option_id: option.id,
          donor_id: owner.id,
          amount_cents: 400,
        },
      });
      expect(
        await prisma.$transaction((tx) => refundPollOptionVotes(tx, option.id, 'admin')),
      ).toEqual({ refunded_count: 1, refunded_cents: 400 });
      expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
        status,
        votes_cents: 0,
      });
      expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
        total_votes_cents: 0,
      });
      expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
        balance_remaining: 500,
      });
      expect(await prisma.balanceAdjustment.findMany({ where: { donor_id: owner.id } })).toEqual([
        expect.objectContaining({ amount_cents: 400, balance_after_cents: 500 }),
      ]);
    },
  );

  it('rejecting a pending write-in returns its funding once without decrementing uncredited tallies', async () => {
    const owner = await donor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Write-ins', allow_custom_entries: true, auto_approve: false },
    });
    pollIds.push(poll.id);
    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, owner.id, poll.id, 'Idea', 400),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        withWebhooks((tx, _emit, publisher) =>
          moderateCustomEntryTx(tx, entry.id, 'REJECTED', 'staff@example.com', publisher),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 400, message: 'Only pending entries can be moderated' },
    });
    expect(await prisma.pollCustomEntry.findUnique({ where: { id: entry.id } })).toMatchObject({
      status: 'REJECTED',
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      status: 'REJECTED',
      votes_cents: 0,
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 1000,
    });
    const vote = await prisma.pollVote.findFirstOrThrow({ where: { poll_option_id: option.id } });
    expect(vote).toMatchObject({ reversed_at: expect.any(Date), reversed_by: 'staff@example.com' });
    expect(await prisma.balanceAdjustment.findMany({ where: { donor_id: owner.id } })).toEqual([
      expect.objectContaining({
        reference_id: vote.id,
        type: 'REFUND',
        amount_cents: 400,
        balance_after_cents: 1000,
        reason: 'Rejected custom poll entry',
        created_by: 'staff@example.com',
      }),
    ]);
  });

  it('credit sweeps preview without writes and confirmed duplicates record one adjustment per current balance', async () => {
    const named = await donor(900);
    const anonymous = await donor(300);
    const excluded = await donor(50);
    await prisma.donation.create({
      data: {
        external_id: crypto.randomUUID(),
        donor_id: named.id,
        amount_cents: 900,
        donor_name: 'Sweep Target',
      },
    });
    const where = {
      id: { in: [named.id, anonymous.id, excluded.id] },
      balance_remaining: { gt: 0, gte: 100, lte: 1000 },
    };
    const preview = await prisma.$transaction((tx) =>
      sweepWalletCreditsTx(tx, where, false, 'admin'),
    );
    expect(preview).toMatchObject({ preview: true, donor_count: 2, total_cents: 1200 });
    expect('sample' in preview && preview.sample).toEqual(
      expect.arrayContaining([
        { id: named.id, balance_remaining: 900, donor_name: 'Sweep Target' },
        { id: anonymous.id, balance_remaining: 300, donor_name: null },
      ]),
    );
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: { in: donorIds } } })).toBe(0);
    expect(await prisma.donor.findUnique({ where: { id: named.id } })).toMatchObject({
      balance_remaining: 900,
    });

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        prisma.$transaction((tx) => sweepWalletCreditsTx(tx, where, true, 'admin')),
      ),
    );
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { success: true, donor_count: 2, total_cents: 1200 },
        { success: true, donor_count: 0, total_cents: 0 },
      ]),
    );
    expect(await prisma.donor.findUnique({ where: { id: excluded.id } })).toMatchObject({
      balance_remaining: 50,
    });
    expect(
      await prisma.donor.findMany({ where: { id: { in: [named.id, anonymous.id] } } }),
    ).toEqual([
      expect.objectContaining({ balance_remaining: 0 }),
      expect.objectContaining({ balance_remaining: 0 }),
    ]);
    expect(
      await prisma.balanceAdjustment.findMany({ where: { donor_id: { in: donorIds } } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          donor_id: named.id,
          type: 'FREEZE_ZERO',
          amount_cents: -900,
          balance_after_cents: 0,
          reason: 'Bulk credit sweep (Sweep Target)',
        }),
        expect.objectContaining({
          donor_id: anonymous.id,
          type: 'FREEZE_ZERO',
          amount_cents: -300,
          balance_after_cents: 0,
          reason: 'Bulk credit sweep (Anonymous)',
        }),
      ]),
    );
    expect(await prisma.balanceAdjustment.count({ where: { donor_id: { in: donorIds } } })).toBe(2);
  });

  it('manual credit adjustments check the current balance and record its committed value', async () => {
    const owner = await donor(500);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        prisma.$transaction((tx) =>
          adjustWalletCreditTx(tx, owner.id, -400, 'MANUAL', 'Correction', 'admin'),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 400, message: 'Adjustment would result in negative balance' },
    });
    expect(
      await prisma.$transaction((tx) =>
        adjustWalletCreditTx(tx, owner.id, 250, 'MANUAL', undefined, 'admin'),
      ),
    ).toEqual({
      success: true,
      email: owner.email,
      balance_before: 100,
      balance_after: 350,
      adjustment: 250,
    });
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 350,
    });
    expect(
      await prisma.balanceAdjustment.findMany({
        where: { donor_id: owner.id },
        orderBy: { created_at: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({
        amount_cents: -400,
        balance_after_cents: 100,
        type: 'MANUAL',
        reason: 'Correction',
        created_by: 'admin',
        reference_id: null,
      }),
      expect.objectContaining({ amount_cents: 250, balance_after_cents: 350, reason: null }),
    ]);
  });

  it.each([
    { current: 1200, remaining: 450, complete: false },
    { current: 2000, remaining: 1250, complete: true },
    { current: 750, remaining: 0, complete: false },
  ])(
    'per-goal reversal recomputes completion at $remaining cents and credits live contributions only',
    async ({ current, remaining, complete }) => {
      const owner = await donor(100);
      const goal = await prisma.fundGoal.create({
        data: { title: 'Goal', target_cents: 1000, current_cents: current, is_complete: true },
      });
      goalIds.push(goal.id);
      await prisma.fundContribution.createMany({
        data: [
          { goal_id: goal.id, donor_id: owner.id, amount_cents: 250 },
          { goal_id: goal.id, donor_id: owner.id, amount_cents: 500 },
          { goal_id: goal.id, donor_id: owner.id, amount_cents: 900, reversed_at: new Date() },
        ],
      });
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          prisma.$transaction((tx) => refundGoalContributions(tx, goal.id, 'admin')),
        ),
      );
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          { refunded_count: 2, refunded_cents: 750 },
          { refunded_count: 0, refunded_cents: 0 },
        ]),
      );
      expect(
        await prisma.$transaction((tx) => refundGoalContributions(tx, goal.id, 'admin')),
      ).toEqual({ refunded_count: 0, refunded_cents: 0 });
      expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
        current_cents: remaining,
        is_complete: complete,
      });
      expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
        balance_remaining: 850,
      });
      expect(
        await prisma.fundContribution.count({ where: { goal_id: goal.id, reversed_at: null } }),
      ).toBe(0);
      expect(
        await prisma.balanceAdjustment.findMany({
          where: { donor_id: owner.id },
          orderBy: { created_at: 'asc' },
        }),
      ).toEqual([
        expect.objectContaining({
          amount_cents: 250,
          balance_after_cents: 350,
          reason: 'Refunded removed fundraising goal',
          created_by: 'admin',
        }),
        expect.objectContaining({ amount_cents: 500, balance_after_cents: 850 }),
      ]);
    },
  );

  it('per-option reversal credits each live vote, ignores reversed rows, and is safe to repeat', async () => {
    const owner = await donor(100);
    const poll = await prisma.poll.create({
      data: {
        title: 'Poll',
        total_votes_cents: 750,
        options: { create: { label: 'A', votes_cents: 750 } },
      },
      include: { options: true },
    });
    pollIds.push(poll.id);
    const option = poll.options[0]!;
    await prisma.pollVote.createMany({
      data: [
        { poll_id: poll.id, poll_option_id: option.id, donor_id: owner.id, amount_cents: 250 },
        { poll_id: poll.id, poll_option_id: option.id, donor_id: owner.id, amount_cents: 500 },
        {
          poll_id: poll.id,
          poll_option_id: option.id,
          donor_id: owner.id,
          amount_cents: 900,
          reversed_at: new Date(),
        },
      ],
    });
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        prisma.$transaction((tx) => refundPollOptionVotes(tx, option.id, 'admin')),
      ),
    );
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { refunded_count: 2, refunded_cents: 750 },
        { refunded_count: 0, refunded_cents: 0 },
      ]),
    );
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 850,
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      votes_cents: 0,
      status: 'ACTIVE',
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(
      await prisma.pollVote.count({ where: { poll_option_id: option.id, reversed_at: null } }),
    ).toBe(0);
    expect(
      await prisma.balanceAdjustment.findMany({
        where: { donor_id: owner.id },
        orderBy: { created_at: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({
        amount_cents: 250,
        balance_after_cents: 350,
        reason: 'Refunded removed poll option',
        created_by: 'admin',
      }),
      expect.objectContaining({ amount_cents: 500, balance_after_cents: 850 }),
    ]);
  });

  it.each([
    { status: 'REFUNDED', balance: 300, after: 0, amount: -300, type: 'REFUND' },
    { status: 'CHARGEBACK', balance: 300, after: 0, amount: -300, type: 'CHARGEBACK' },
    { status: 'REFUNDED', balance: 1500, after: 500, amount: -1000, type: 'REFUND' },
    { status: 'CHARGEBACK', balance: 1500, after: 500, amount: -1000, type: 'CHARGEBACK' },
    { status: 'REFUNDED', balance: 0, after: 0, amount: 0, type: 'REFUND' },
    { status: 'CHARGEBACK', balance: 0, after: 0, amount: 0, type: 'CHARGEBACK' },
  ])(
    '$status with $balance cents caps the wallet clawback, leaves allocations and completion alone, and links one adjustment',
    async ({ status, balance, after, amount, type }) => {
      const owner = await donor(balance);
      const donation = await prisma.donation.create({
        data: { external_id: crypto.randomUUID(), donor_id: owner.id, amount_cents: 1000 },
      });
      const goal = await prisma.fundGoal.create({
        data: { title: 'Completed goal', target_cents: 500, current_cents: 700, is_complete: true },
      });
      goalIds.push(goal.id);
      const contribution = await prisma.fundContribution.create({
        data: { goal_id: goal.id, donor_id: owner.id, amount_cents: 700, donation_id: donation.id },
      });
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          withWebhooks((tx, _emit, publisher) =>
            setDonationStatusTx(tx, donation.id, status, 'Recorded by staff', 'admin', publisher),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: {
          status: 400,
          message: 'Donation is refunded/charged back and cannot change status',
        },
      });
      const updated = await prisma.donation.findUniqueOrThrow({ where: { id: donation.id } });
      expect(updated).toMatchObject({ status, refund_id: expect.any(String), amount_cents: 1000 });
      expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
        balance_remaining: after,
      });
      expect(
        await prisma.fundContribution.findUnique({ where: { id: contribution.id } }),
      ).toMatchObject({ reversed_at: null });
      expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
        current_cents: 700,
        is_complete: true,
      });
      expect(await prisma.balanceAdjustment.findMany({ where: { donor_id: owner.id } })).toEqual([
        expect.objectContaining({
          id: updated.refund_id,
          amount_cents: amount,
          balance_after_cents: after,
          type,
          reference_id: donation.id,
          reason: 'Recorded by staff',
          created_by: 'admin',
        }),
      ]);
    },
  );

  it('single contribution reversal keeps a completed goal complete below target, but clears it at zero', async () => {
    const owner = await donor(100);
    const goal = await prisma.fundGoal.create({
      data: { title: 'Complete goal', target_cents: 1000, current_cents: 1200, is_complete: true },
    });
    goalIds.push(goal.id);
    const first = await prisma.fundContribution.create({
      data: { goal_id: goal.id, donor_id: owner.id, amount_cents: 500 },
    });
    const second = await prisma.fundContribution.create({
      data: { goal_id: goal.id, donor_id: owner.id, amount_cents: 700 },
    });

    await prisma.$transaction((tx) =>
      reverseSpendTx(tx, owner.id, 'contribution', first.id, 'admin'),
    );
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      current_cents: 700,
      is_complete: true,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        prisma.$transaction((tx) =>
          reverseSpendTx(tx, owner.id, 'contribution', second.id, 'admin'),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 400, message: 'Contribution already reversed' },
    });
    expect(await prisma.fundGoal.findUnique({ where: { id: goal.id } })).toMatchObject({
      current_cents: 0,
      is_complete: false,
    });
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 1300,
    });
    expect(await prisma.fundContribution.findMany({ where: { goal_id: goal.id } })).toEqual([
      expect.objectContaining({
        id: first.id,
        reversed_at: expect.any(Date),
        reversed_by: 'admin',
      }),
      expect.objectContaining({
        id: second.id,
        reversed_at: expect.any(Date),
        reversed_by: 'admin',
      }),
    ]);
    expect(
      await prisma.balanceAdjustment.findMany({
        where: { donor_id: owner.id },
        orderBy: { created_at: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({
        amount_cents: 500,
        balance_after_cents: 600,
        reference_id: first.id,
        reason: 'Reversed fund contribution',
      }),
      expect.objectContaining({
        amount_cents: 700,
        balance_after_cents: 1300,
        reference_id: second.id,
      }),
    ]);
  });

  it('concurrent vote reversals apply exactly one credit and tally decrement', async () => {
    const owner = await donor(100);
    const poll = await prisma.poll.create({
      data: {
        title: 'Poll',
        total_votes_cents: 400,
        options: { create: { label: 'A', votes_cents: 400 } },
      },
      include: { options: true },
    });
    pollIds.push(poll.id);
    const option = poll.options[0]!;
    const vote = await prisma.pollVote.create({
      data: { poll_id: poll.id, poll_option_id: option.id, donor_id: owner.id, amount_cents: 400 },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        prisma.$transaction((tx) => reverseSpendTx(tx, owner.id, 'vote', vote.id, 'admin')),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 400, message: 'Vote already reversed' },
    });
    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 500,
    });
    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toMatchObject({
      total_votes_cents: 0,
    });
    expect(await prisma.pollOption.findUnique({ where: { id: option.id } })).toMatchObject({
      votes_cents: 0,
      status: 'ACTIVE',
    });
    expect(await prisma.pollVote.findUnique({ where: { id: vote.id } })).toMatchObject({
      reversed_at: expect.any(Date),
      reversed_by: 'admin',
    });
    expect(await prisma.balanceAdjustment.findMany({ where: { donor_id: owner.id } })).toEqual([
      expect.objectContaining({
        amount_cents: 400,
        balance_after_cents: 500,
        reference_id: vote.id,
        reason: 'Reversed poll vote',
      }),
    ]);
  });

  it('reverses a pending claim once using the live reward price and releases its stock', async () => {
    const owner = await donor(100);
    const reward = await prisma.reward.create({
      data: { title: 'Reward', type: 'DIGITAL', cost_cents: 500, quantity_claimed: 1 },
    });
    rewardIds.push(reward.id);
    const claim = await prisma.rewardClaim.create({
      data: { donor_id: owner.id, reward_id: reward.id },
    });
    await prisma.reward.update({ where: { id: reward.id }, data: { cost_cents: 700 } });

    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        prisma.$transaction((tx) => reverseSpendTx(tx, owner.id, 'claim', claim.id, 'admin')),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 400, message: 'Claim already reversed' },
    });
    await expect(
      prisma.$transaction((tx) => reverseSpendTx(tx, owner.id, 'claim', claim.id, 'admin')),
    ).rejects.toMatchObject({ status: 400, message: 'Claim already reversed' });

    expect(await prisma.donor.findUnique({ where: { id: owner.id } })).toMatchObject({
      balance_remaining: 800,
    });
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
      quantity_claimed: 0,
    });
    expect(await prisma.rewardClaim.findUnique({ where: { id: claim.id } })).toMatchObject({
      status: 'REVERSED',
      reversed_by: 'admin',
      reversed_at: expect.any(Date),
    });
    expect(await prisma.balanceAdjustment.findMany({ where: { donor_id: owner.id } })).toEqual([
      expect.objectContaining({
        amount_cents: 700,
        balance_after_cents: 800,
        type: 'REFUND',
        reason: 'Reversed reward claim',
        reference_id: claim.id,
        created_by: 'admin',
      }),
    ]);
  });
});
