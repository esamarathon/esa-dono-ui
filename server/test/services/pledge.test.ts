import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { createPledge, resolvePledge, createCheckoutForPledge } from '../../services/pledge.js';
import { processDonation } from '../../services/donation.js';

const prisma = new PrismaClient();

describe('Pledge Service', () => {
  let channelId: string;
  let otherEventId: string;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.APP_BASE_URL = 'http://localhost:5173';

    const event = await prisma.channel.create({
      data: { name: `Event A ${crypto.randomUUID()}` },
    });
    channelId = event.id;
    const other = await prisma.channel.create({ data: { name: `Event B ${crypto.randomUUID()}` } });
    otherEventId = other.id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: { in: [channelId, otherEventId] } } });
    await prisma.$disconnect();
  });

  describe('createPledge', () => {
    it('rejects empty items with no additional donation', async () => {
      await expect(createPledge({ items: [], channel_id: channelId })).rejects.toThrow(
        'At least one item or an additional donation is required',
      );
    });

    it('rejects negative top_up_cents', async () => {
      await expect(
        createPledge({ items: [], top_up_cents: -1, channel_id: channelId }),
      ).rejects.toThrow('top_up_cents must be a non-negative integer');
    });

    it('rejects a missing channel_id', async () => {
      await expect(createPledge({ items: [], top_up_cents: 1000 })).rejects.toThrow(
        'channel_id is required',
      );
    });

    it('rejects an unknown/inactive channel_id', async () => {
      await expect(
        createPledge({ items: [], top_up_cents: 1000, channel_id: 'does-not-exist' }),
      ).rejects.toThrow('Channel not found or inactive');
    });

    it('creates a pure top-up pledge with no items', async () => {
      const result = await createPledge({
        email: 'topup@example.com',
        items: [],
        top_up_cents: 1000,
        channel_id: channelId,
      });
      expect(result.pledge_token).toBeTruthy();
      expect(result.total_cents).toBe(1000);
      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
    }, 10000);

    it('adds top_up_cents to the item total and persists it', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Top-up Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const result = await createPledge({
        email: 'topup2@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        top_up_cents: 1500,
        channel_id: channelId,
      });
      expect(result.total_cents).toBe(500 + 1500);

      const stored = await prisma.pendingPledge.findUnique({
        where: { pledge_token: result.pledge_token },
      });
      expect(stored?.top_up_cents).toBe(1500);
      expect(stored?.total_cents).toBe(2000);
      expect(stored?.channel_id).toBe(channelId);

      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('rejects invalid item kind', async () => {
      await expect(
        createPledge({
          items: [{ kind: 'INVALID' as any, target_id: 'x' }],
          channel_id: channelId,
        }),
      ).rejects.toThrow('Invalid item kind');
    });

    it('creates a reward pledge', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const result = await createPledge({
        email: 'test@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });
      expect(result.pledge_token).toBeTruthy();
      expect(result.total_cents).toBe(500);
      expect(result.expires_at).toBeTruthy();
      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('creates a multi-item pledge', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const poll = await prisma.poll.create({
        data: {
          title: 'Test Poll',
          is_active: true,
          options: { create: [{ label: 'A' }, { label: 'B' }] },
        },
        include: { options: true },
      });
      const goal = await prisma.fundGoal.create({
        data: { title: 'Test Goal', target_cents: 10000 },
      });

      const result = await createPledge({
        email: 'multi@example.com',
        items: [
          { kind: 'REWARD', target_id: reward.id },
          {
            kind: 'POLL_VOTE',
            target_id: poll.options[0]!.id,
            poll_id: poll.id,
            amount_cents: 200,
          },
          { kind: 'GOAL', target_id: goal.id, amount_cents: 1000 },
        ],
        channel_id: channelId,
      });
      expect(result.total_cents).toBe(500 + 200 + 1000);

      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
      await prisma.poll.delete({ where: { id: poll.id } });
      await prisma.fundGoal.delete({ where: { id: goal.id } });
    }, 10000);
  });

  describe('createPledge — channel scoping', () => {
    it('allows a shared incentive (null channel_id) in any event cart', async () => {
      const reward = await prisma.reward.create({
        data: {
          title: 'Shared Reward',
          type: 'DIGITAL',
          cost_cents: 500,
          quantity_total: 10,
          channel_id: null,
        },
      });
      const result = await createPledge({
        email: 'shared@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });
      expect(result.total_cents).toBe(500);

      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('rejects an incentive tied to a different event', async () => {
      const reward = await prisma.reward.create({
        data: {
          title: 'Other Event Reward',
          type: 'DIGITAL',
          cost_cents: 500,
          quantity_total: 10,
          channel_id: otherEventId,
        },
      });

      await expect(
        createPledge({
          email: 'mismatch@example.com',
          items: [{ kind: 'REWARD', target_id: reward.id }],
          channel_id: channelId,
        }),
      ).rejects.toThrow('belongs to a different channel');

      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('allows an incentive tied to the matching event', async () => {
      const reward = await prisma.reward.create({
        data: {
          title: 'Matching Event Reward',
          type: 'DIGITAL',
          cost_cents: 500,
          quantity_total: 10,
          channel_id: channelId,
        },
      });
      const result = await createPledge({
        email: 'match@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });
      expect(result.total_cents).toBe(500);

      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);
  });

  describe('createPledge — POLL_CUSTOM', () => {
    it('validates a funded write-in and includes it in the total', async () => {
      const poll = await prisma.poll.create({
        data: { title: 'Write-in poll', is_active: true, allow_custom_entries: true },
      });

      const result = await createPledge({
        email: 'writein@example.com',
        items: [
          {
            kind: 'POLL_CUSTOM',
            target_id: poll.id,
            poll_id: poll.id,
            amount_cents: 300,
            data: { label: 'my option' },
          },
        ],
        channel_id: channelId,
      });
      expect(result.total_cents).toBe(300);

      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.poll.delete({ where: { id: poll.id } });
    }, 10000);

    it('rejects when poll does not allow custom entries', async () => {
      const poll = await prisma.poll.create({
        data: { title: 'No write-ins', is_active: true, allow_custom_entries: false },
      });

      await expect(
        createPledge({
          items: [
            {
              kind: 'POLL_CUSTOM',
              target_id: poll.id,
              poll_id: poll.id,
              amount_cents: 300,
              data: { label: 'my option' },
            },
          ],
          channel_id: channelId,
        }),
      ).rejects.toThrow('does not allow custom entries');

      await prisma.poll.delete({ where: { id: poll.id } });
    }, 10000);

    it('rejects a missing label', async () => {
      const poll = await prisma.poll.create({
        data: { title: 'Write-in poll 2', is_active: true, allow_custom_entries: true },
      });

      await expect(
        createPledge({
          items: [{ kind: 'POLL_CUSTOM', target_id: poll.id, poll_id: poll.id, amount_cents: 300 }],
          channel_id: channelId,
        }),
      ).rejects.toThrow('requires a label');

      await prisma.poll.delete({ where: { id: poll.id } });
    }, 10000);
  });

  describe('resolvePledge', () => {
    it('resolves by pledge token', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const { pledge_token } = await createPledge({
        email: 'resolve@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });

      const resolved = await resolvePledge({ pledgeToken: pledge_token, amountCents: 1000 });
      expect(resolved).toBeTruthy();
      expect(resolved!.pledge_token).toBe(pledge_token);

      await prisma.pendingPledge.delete({ where: { pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('returns null for insufficient amount', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const { pledge_token } = await createPledge({
        email: 'short@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });

      const resolved = await resolvePledge({ pledgeToken: pledge_token, amountCents: 200 });
      expect(resolved).toBeNull();

      await prisma.pendingPledge.delete({ where: { pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('falls back to email lookup', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const { pledge_token } = await createPledge({
        email: 'fallback@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });

      const resolved = await resolvePledge({
        email: 'fallback@example.com',
        amountCents: 1000,
      });
      expect(resolved).toBeTruthy();
      expect(resolved!.pledge_token).toBe(pledge_token);

      await prisma.pendingPledge.delete({ where: { pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);
  });

  describe('createCheckoutForPledge — wallet discount', () => {
    it('never applies wallet balance to the additional contribution', async () => {
      const reward = await prisma.reward.create({
        data: {
          title: 'Top-up discount reward',
          type: 'DIGITAL',
          cost_cents: 500,
          quantity_total: 10,
        },
      });
      const { pledge_token } = await createPledge({
        email: 'walletdiscount@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        top_up_cents: 1500,
        channel_id: channelId,
      });
      const donor = await prisma.donor.create({
        data: {
          email: 'walletdiscount@example.com',
          total_donated: 10000,
          balance_remaining: 10000,
          magic_token: 'tok-wallet-discount',
          token_expires_at: new Date(Date.now() + 60000),
        },
      });

      const result = await createCheckoutForPledge(
        pledge_token,
        {
          id: donor.id,
          email: donor.email,
          balance_remaining: donor.balance_remaining,
          magic_token: donor.magic_token,
        },
        'walletdiscount@example.com',
      );

      // Incentive total is 500; the wallet covers all of it but none of the
      // 1500 additional contribution, which must come from real money.
      expect(result.wallet_discount_cents).toBe(500);

      await prisma.donor.delete({ where: { id: donor.id } });
      await prisma.pendingPledge.delete({ where: { pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);
  });

  describe('fulfillPledge via processDonation', () => {
    it('fulfills a reward pledge, credits remainder, and propagates the event to the donation', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const { pledge_token } = await createPledge({
        email: 'fulfill@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
        channel_id: channelId,
      });

      const result = await processDonation({
        externalId: `test-${crypto.randomUUID()}`,
        email: 'fulfill@example.com',
        donorName: 'Test',
        amountCents: 1000,
        pledgeToken: pledge_token,
      });

      expect((result as any).pledge).toBeTruthy();
      expect((result as any).pledge.totalSpent).toBe(500);
      expect((result as any).pledge.skipped).toBe(0);

      const donor = await prisma.donor.findUnique({ where: { email: 'fulfill@example.com' } });
      const donation = await prisma.donation.findFirst({ where: { donor_id: donor!.id } });
      expect(donation?.channel_id).toBe(channelId);

      await prisma.donation.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donor.delete({ where: { id: donor!.id } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('fulfills a POLL_CUSTOM write-in pledge (auto_approve) and updates the tally', async () => {
      const poll = await prisma.poll.create({
        data: { title: 'Fulfill write-in poll', is_active: true, allow_custom_entries: true },
      });
      const { pledge_token } = await createPledge({
        email: 'writein-fulfill@example.com',
        items: [
          {
            kind: 'POLL_CUSTOM',
            target_id: poll.id,
            poll_id: poll.id,
            amount_cents: 300,
            data: { label: 'my write-in' },
          },
        ],
        channel_id: channelId,
      });

      const result = await processDonation({
        externalId: `test-${crypto.randomUUID()}`,
        email: 'writein-fulfill@example.com',
        donorName: 'Test',
        amountCents: 300,
        pledgeToken: pledge_token,
      });

      expect((result as any).pledge.totalSpent).toBe(300);
      expect((result as any).pledge.skipped).toBe(0);

      const updatedPoll = await prisma.poll.findUnique({ where: { id: poll.id } });
      expect(updatedPoll!.total_votes_cents).toBe(300);

      const option = await prisma.pollOption.findFirst({ where: { poll_id: poll.id } });
      expect(option!.status).toBe('ACTIVE');
      expect(option!.votes_cents).toBe(300);

      const donor = await prisma.donor.findUnique({
        where: { email: 'writein-fulfill@example.com' },
      });
      expect(donor!.balance_remaining).toBe(0);

      await prisma.pollVote.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donation.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donor.delete({ where: { id: donor!.id } });
      await prisma.poll.delete({ where: { id: poll.id } });
    }, 10000);

    it('fulfills a POLL_CUSTOM write-in pledge but excludes it from the tally when auto_approve is false', async () => {
      const poll = await prisma.poll.create({
        data: {
          title: 'Reviewed write-in poll',
          is_active: true,
          allow_custom_entries: true,
          auto_approve: false,
        },
      });
      const { pledge_token } = await createPledge({
        email: 'writein-review@example.com',
        items: [
          {
            kind: 'POLL_CUSTOM',
            target_id: poll.id,
            poll_id: poll.id,
            amount_cents: 300,
            data: { label: 'needs review' },
          },
        ],
        channel_id: channelId,
      });

      const result = await processDonation({
        externalId: `test-${crypto.randomUUID()}`,
        email: 'writein-review@example.com',
        donorName: 'Test',
        amountCents: 300,
        pledgeToken: pledge_token,
      });

      expect((result as any).pledge.totalSpent).toBe(300);

      const updatedPoll = await prisma.poll.findUnique({ where: { id: poll.id } });
      expect(updatedPoll!.total_votes_cents).toBe(0);

      const option = await prisma.pollOption.findFirst({ where: { poll_id: poll.id } });
      expect(option!.status).toBe('PENDING_APPROVAL');
      expect(option!.votes_cents).toBe(0);

      // Funds are still committed (spent-immediately, Model B)
      const donor = await prisma.donor.findUnique({
        where: { email: 'writein-review@example.com' },
      });
      expect(donor!.balance_remaining).toBe(0);

      await prisma.pollVote.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donation.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donor.delete({ where: { id: donor!.id } });
      await prisma.poll.delete({ where: { id: poll.id } });
    }, 10000);

    it('gracefully degrades when no pledge matches', async () => {
      const result = await processDonation({
        externalId: `test-${crypto.randomUUID()}`,
        email: 'nopledge@example.com',
        donorName: 'Test',
        amountCents: 1000,
      });

      expect((result as any).pledge).toBeNull();
      expect((result as any).donor.balance_remaining).toBe(1000);

      const donor = await prisma.donor.findUnique({ where: { email: 'nopledge@example.com' } });
      await prisma.donation.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donor.delete({ where: { id: donor!.id } });
    }, 10000);

    it('handles duplicate donation idempotently', async () => {
      const externalId = `test-dup-${crypto.randomUUID()}`;
      const result1 = await processDonation({
        externalId,
        email: 'dup@example.com',
        donorName: 'Test',
        amountCents: 1000,
      });
      expect((result1 as any).duplicate).toBeFalsy();

      const result2 = await processDonation({
        externalId,
        email: 'dup@example.com',
        donorName: 'Test',
        amountCents: 1000,
      });
      expect((result2 as any).duplicate).toBe(true);

      const donor = await prisma.donor.findUnique({ where: { email: 'dup@example.com' } });
      await prisma.donation.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donor.delete({ where: { id: donor!.id } });
    }, 10000);
  });
});
