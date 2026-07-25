import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { createPledge, resolvePledge } from '../../services/pledge.js';
import { processDonation } from '../../services/donation.js';

const prisma = new PrismaClient();

describe('Pledge Service', () => {
  beforeAll(async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.APP_BASE_URL = 'http://localhost:5173';
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('createPledge', () => {
    it('rejects empty items', async () => {
      await expect(createPledge({ items: [] })).rejects.toThrow('At least one item required');
    });

    it('rejects invalid item kind', async () => {
      await expect(
        createPledge({ items: [{ kind: 'INVALID' as any, target_id: 'x' }] }),
      ).rejects.toThrow('Invalid item kind');
    });

    it('creates a reward pledge', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const result = await createPledge({
        email: 'test@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
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
      });
      expect(result.total_cents).toBe(500 + 200 + 1000);

      await prisma.pendingPledge.delete({ where: { pledge_token: result.pledge_token } });
      await prisma.reward.delete({ where: { id: reward.id } });
      await prisma.poll.delete({ where: { id: poll.id } });
      await prisma.fundGoal.delete({ where: { id: goal.id } });
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

  describe('fulfillPledge via processDonation', () => {
    it('fulfills a reward pledge and credits remainder', async () => {
      const reward = await prisma.reward.create({
        data: { title: 'Test Reward', type: 'DIGITAL', cost_cents: 500, quantity_total: 10 },
      });
      const { pledge_token } = await createPledge({
        email: 'fulfill@example.com',
        items: [{ kind: 'REWARD', target_id: reward.id }],
      });

      const result = await processDonation({
        tiltifyId: `test-${crypto.randomUUID()}`,
        email: 'fulfill@example.com',
        donorName: 'Test',
        amountCents: 1000,
        pledgeToken: pledge_token,
      });

      expect((result as any).pledge).toBeTruthy();
      expect((result as any).pledge.totalSpent).toBe(500);
      expect((result as any).pledge.skipped).toBe(0);

      const donor = await prisma.donor.findUnique({ where: { email: 'fulfill@example.com' } });
      await prisma.donation.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor!.id } });
      await prisma.donor.delete({ where: { id: donor!.id } });
      await prisma.reward.delete({ where: { id: reward.id } });
    }, 10000);

    it('gracefully degrades when no pledge matches', async () => {
      const result = await processDonation({
        tiltifyId: `test-${crypto.randomUUID()}`,
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
      const tiltifyId = `test-dup-${crypto.randomUUID()}`;
      const result1 = await processDonation({
        tiltifyId,
        email: 'dup@example.com',
        donorName: 'Test',
        amountCents: 1000,
      });
      expect((result1 as any).duplicate).toBeFalsy();

      const result2 = await processDonation({
        tiltifyId,
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
