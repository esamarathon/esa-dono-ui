import { afterAll, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { DEFAULT_FEATURE_FLAGS, ensureDefaultFeatureFlags } from '../../services/featureFlags.js';

const envName = (name: string) => `SEED_FLAG_${name.replaceAll('-', '_').toUpperCase()}`;

afterAll(async () => {
  await prisma.featureFlag.deleteMany({
    where: { name: { in: [NAME_A, NAME_B, NAME_C, NAME_D] } },
  });
  await prisma.$disconnect();
});

// Unique names: the shared test database has suites that toggle the real
// `feedback`/`auctions` rows, so this test must not touch them.
const NAME_A = `flag-a-${crypto.randomUUID()}`;
const NAME_B = `flag-b-${crypto.randomUUID()}`;
const NAME_C = `flag-c-${crypto.randomUUID()}`;
const NAME_D = `flag-d-${crypto.randomUUID()}`;
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

const freshFlags = [
  { name: NAME_C, description: 'Flag C description' },
  { name: NAME_D, description: 'Flag D description' },
];

it('a fresh flag installs with its SEED_FLAG_* initial state (unset reads off)', async () => {
  process.env[envName(NAME_C)] = 'on';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await ensureDefaultFeatureFlags(freshFlags);
    const c = await prisma.featureFlag.findUniqueOrThrow({ where: { name: NAME_C } });
    const d = await prisma.featureFlag.findUniqueOrThrow({ where: { name: NAME_D } });
    expect(c.is_enabled).toBe(true);
    expect(d.is_enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    delete process.env[envName(NAME_C)];
    warn.mockRestore();
  }
});

it('an invalid SEED_FLAG_* value warns and installs disabled', async () => {
  process.env[envName(NAME_D)] = 'maybe';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await prisma.featureFlag.deleteMany({ where: { name: NAME_D } });
    await ensureDefaultFeatureFlags([{ name: NAME_D, description: 'Flag D description' }]);
    const d = await prisma.featureFlag.findUniqueOrThrow({ where: { name: NAME_D } });
    expect(d.is_enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env[envName(NAME_D)];
    warn.mockRestore();
  }
});

it('an existing toggle survives re-seeding even when SEED_FLAG_* says otherwise', async () => {
  process.env[envName(NAME_C)] = 'off';
  try {
    await prisma.featureFlag.update({ where: { name: NAME_C }, data: { is_enabled: true } });
    await ensureDefaultFeatureFlags(freshFlags);
    const c = await prisma.featureFlag.findUniqueOrThrow({ where: { name: NAME_C } });
    expect(c.is_enabled).toBe(true);
  } finally {
    delete process.env[envName(NAME_C)];
  }
});
