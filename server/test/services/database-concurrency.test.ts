import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import { claimRewardTx, contributeGoalTx } from '../../services/spend.js';

// Separate clients matter: a process-local queue cannot protect PostgreSQL's
// connection pool or another backend's financial transaction.
const first = createDatabaseClient();
const second = createDatabaseClient();
afterAll(async () => {
  await Promise.all([first.$disconnect(), second.$disconnect()]);
});

describe('database transaction serialization', () => {
  it('allows only one of two independent clients to spend the same Wallet money', async () => {
    const event = await first.event.create({ data: { name: 'Wallet race', slug: randomUUID() } });
    const donor = await first.donor.create({
      data: { email: `${randomUUID()}@example.com`, balance_remaining: 1000 },
    });
    const goal = await first.fundGoal.create({
      data: { event_id: event.id, title: 'Wallet race', target_cents: 10000 },
    });
    try {
      const results = await Promise.allSettled([
        first.$transaction((tx) => contributeGoalTx(tx, donor.id, goal.id, 700)),
        second.$transaction((tx) => contributeGoalTx(tx, donor.id, goal.id, 700)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.message).toContain(
        'Insufficient balance',
      );
      expect(await first.donor.findUniqueOrThrow({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 300,
      });
      expect(await first.fundGoal.findUniqueOrThrow({ where: { id: goal.id } })).toMatchObject({
        current_cents: 700,
      });
      expect(await first.fundContribution.count({ where: { goal_id: goal.id } })).toBe(1);
    } finally {
      await first.fundContribution.deleteMany({ where: { goal_id: goal.id } });
      await first.fundGoal.delete({ where: { id: goal.id } });
      await first.donor.delete({ where: { id: donor.id } });
      await first.event.delete({ where: { id: event.id } });
    }
  });

  it('does not oversell the last reward across independent clients', async () => {
    const event = await first.event.create({ data: { name: 'Stock race', slug: randomUUID() } });
    const donors = await Promise.all(
      [0, 1].map(() =>
        first.donor.create({
          data: { email: `${randomUUID()}@example.com`, balance_remaining: 1000 },
        }),
      ),
    );
    const reward = await first.reward.create({
      data: {
        event_id: event.id,
        title: 'Last unit',
        type: 'DIGITAL',
        cost_cents: 500,
        quantity_total: 1,
      },
    });
    try {
      const results = await Promise.allSettled([
        first.$transaction((tx) => claimRewardTx(tx, donors[0]!.id, reward.id)),
        second.$transaction((tx) => claimRewardTx(tx, donors[1]!.id, reward.id)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.message).toContain('sold out');
      expect(await first.reward.findUniqueOrThrow({ where: { id: reward.id } })).toMatchObject({
        quantity_claimed: 1,
      });
      expect(await first.rewardClaim.count({ where: { reward_id: reward.id } })).toBe(1);
      const balances = await first.donor.findMany({
        where: { id: { in: donors.map((d) => d.id) } },
      });
      expect(balances.map((d) => d.balance_remaining).sort((a, b) => a - b)).toEqual([500, 1000]);
    } finally {
      await first.rewardClaim.deleteMany({ where: { reward_id: reward.id } });
      await first.reward.delete({ where: { id: reward.id } });
      await first.donor.deleteMany({ where: { id: { in: donors.map((d) => d.id) } } });
      await first.event.delete({ where: { id: event.id } });
    }
  });

  it('rolls back array transactions and releases the transaction lock', async () => {
    const email = `${randomUUID()}@example.com`;
    await expect(
      first.$transaction([
        first.donor.create({ data: { email, balance_remaining: 1000 } }),
        first.donor.create({ data: { email, balance_remaining: 2000 } }),
      ]),
    ).rejects.toThrow();
    expect(await second.donor.count({ where: { email } })).toBe(0);
    await second.$transaction(async (tx) => {
      expect(await tx.donor.count({ where: { email } })).toBe(0);
    });
  });
});
