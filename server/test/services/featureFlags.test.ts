import { afterAll, expect, it } from 'vitest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { DEFAULT_FEATURE_FLAGS, ensureDefaultFeatureFlags } from '../../services/featureFlags.js';

afterAll(async () => {
  await prisma.featureFlag.deleteMany({ where: { name: { in: [NAME_A, NAME_B] } } });
  await prisma.$disconnect();
});

// Unique names: the shared test database has suites that toggle the real
// `feedback`/`auctions` rows, so this test must not touch them.
const NAME_A = `flag-a-${crypto.randomUUID()}`;
const NAME_B = `flag-b-${crypto.randomUUID()}`;
const flags = [
  { name: NAME_A, description: 'Flag A description' },
  { name: NAME_B, description: 'Flag B description' },
];

it('creates missing default flags disabled, with their descriptions', async () => {
  await ensureDefaultFeatureFlags(flags);
  const rows = await prisma.featureFlag.findMany({
    where: { name: { in: [NAME_A, NAME_B] } },
    orderBy: { name: 'asc' },
  });
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.is_enabled).toBe(false);
    expect(row.description).toBe(flags.find((f) => f.name === row.name)!.description);
  }
});

it('re-seeding preserves an operator toggle and only refreshes the description', async () => {
  await prisma.featureFlag.update({ where: { name: NAME_A }, data: { is_enabled: true } });
  await ensureDefaultFeatureFlags(
    flags.map((f) => ({ ...f, description: 'Refreshed description' })),
  );
  const a = await prisma.featureFlag.findUniqueOrThrow({ where: { name: NAME_A } });
  const b = await prisma.featureFlag.findUniqueOrThrow({ where: { name: NAME_B } });
  expect(a.is_enabled).toBe(true);
  expect(a.description).toBe('Refreshed description');
  expect(b.is_enabled).toBe(false);
  expect(b.description).toBe('Refreshed description');
});

it('covers every flag the code checks (feedback, auctions, donation-acknowledgements)', () => {
  expect(DEFAULT_FEATURE_FLAGS.map((f) => f.name).sort()).toEqual([
    'auctions',
    'donation-acknowledgements',
    'feedback',
  ]);
});
