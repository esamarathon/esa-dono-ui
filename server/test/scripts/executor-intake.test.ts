import { afterAll, expect, it, vi } from 'vitest';
import express from 'express';
import prisma from '../../lib/prisma.js';
import adminRouter from '../../routes/admin.js';
import donorRouter from '../../routes/donor.js';
import pledgeRouter from '../../routes/pledge.js';
import { Executor } from '../../scripts/simulator/executor.js';
import type { Catalog } from '../../scripts/simulator/types.js';
import { createTestChannel, DEFAULT_EVENT_ID } from '../helpers/fixtures.js';

vi.mock('../../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));
afterAll(() => prisma.$disconnect());

it('pays a pledge that needs new money through the real admin intake', async () => {
  const channel = await createTestChannel(prisma);
  const goal = await prisma.fundGoal.create({
    data: {
      event_id: DEFAULT_EVENT_ID,
      channel_id: channel.id,
      title: 'Simulator goal',
      target_cents: 100000,
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/donor', donorRouter);
  app.use('/api/pledge', pledgeRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const catalog: Catalog = {
    channels: ['c'],
    rewards: [],
    pledgeableRewards: [],
    rewardCostCents: {},
    polls: [],
    goals: ['g'],
    auctions: [],
    channelOf: { g: 'c' },
    resolve: { c: channel.id, g: goal.id },
  };
  const executor = new Executor({
    baseUrl: `http://127.0.0.1:${address.port}`,
    adminKey: 'test-admin-key',
    runId: `intake-${goal.id}`,
    catalog,
  });
  try {
    const funded = await executor.execute({
      seq: 0,
      delayMs: 0,
      actor: { donorRef: 'd1' },
      action: 'DONATE',
      params: { amountCents: 500, channelRef: 'c' },
    });
    expect(funded.accepted).toBe(true);

    // $20 for the goal against a $5 Wallet: the pledge needs $15 of new money.
    const outcome = await executor.execute({
      seq: 1,
      delayMs: 0,
      actor: { donorRef: 'd1' },
      action: 'PLEDGE_CHECKOUT',
      params: { pledgeAmountCents: 2000 },
      targetRef: { channelRef: 'c' },
      items: [{ kind: 'GOAL', goalRef: 'g', amountCents: 2000 }],
    });
    expect(outcome).toMatchObject({ accepted: true });

    const pledge = await prisma.pendingPledge.findFirstOrThrow({
      where: { channel_id: channel.id },
    });
    expect(pledge).toMatchObject({ status: 'FULFILLED', new_money_cents: 1500 });
    const paid = await prisma.donation.findUniqueOrThrow({
      where: { id: pledge.fulfilled_by_donation_id! },
    });
    expect(paid).toMatchObject({ amount_cents: 1500, channel_id: channel.id });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const donors = await prisma.donor.findMany({
      where: { email: { contains: `intake-${goal.id}` } },
      select: { id: true },
    });
    const donorIds = donors.map((d) => d.id);
    await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pendingPledge.deleteMany({ where: { channel_id: channel.id } });
    await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.fundGoal.delete({ where: { id: goal.id } });
    await prisma.channel.delete({ where: { id: channel.id } });
  }
});
