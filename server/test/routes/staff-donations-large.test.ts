import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import crypto from 'crypto';
import adminRouter from '../../routes/admin.js';
import moderatorRouter from '../../routes/moderator.js';
import { DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

beforeAll(async () => {
  await ensureDefaultEvent(prisma);
});

const prisma = createDatabaseClient();
const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };
// Prisma batches concurrent findUnique calls into one query. Past SQLite's 999
// bind variables the engine splits the IN list, and Prisma 5.22 then panics
// ("no entry found for key") when the select has an ordered to-many relation
// with rows, as readDonationAccountingTx does.
const MORE_THAN_SQLITE_VARIABLE_LIMIT = 1000;

describe('staff donation lists with more donations than SQLite bind variables', () => {
  let donorId: string;
  let goalId: string;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    const donor = await prisma.donor.create({
      data: { email: `many-donations-${crypto.randomUUID()}@example.com` },
    });
    donorId = donor.id;
    await prisma.donation.createMany({
      data: Array.from({ length: MORE_THAN_SQLITE_VARIABLE_LIMIT }, () => ({
        donor_id: donorId,
        external_id: `many-${crypto.randomUUID()}`,
        amount_cents: 500,
        status: 'COMPLETED',
      })),
    });
    const goal = await prisma.fundGoal.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Many donations goal', target_cents: 1_000_000 },
    });
    goalId = goal.id;
    const donations = await prisma.donation.findMany({
      where: { donor_id: donorId },
      select: { id: true },
    });
    await prisma.fundContribution.createMany({
      data: donations.map((donation) => ({
        goal_id: goalId,
        donor_id: donorId,
        donation_id: donation.id,
        amount_cents: 100,
      })),
    });
  });

  afterAll(async () => {
    await prisma.fundContribution.deleteMany({ where: { goal_id: goalId } });
    await prisma.fundGoal.delete({ where: { id: goalId } });
    await prisma.donation.deleteMany({ where: { donor_id: donorId } });
    await prisma.donor.delete({ where: { id: donorId } });
    await prisma.$disconnect();
  });

  it.each([
    ['/api/admin', adminRouter],
    ['/api/moderator', moderatorRouter],
  ])('GET %s/donations returns every donation with its allocations', async (base, router) => {
    const app = express();
    app.use(express.json());
    app.use(base, router);

    const res = await request(app).get(`${base}/donations`).set(AUTH);

    expect(res.status).toBe(200);
    const mine = res.body.filter((d: { donor_id: string }) => d.donor_id === donorId);
    expect(mine).toHaveLength(MORE_THAN_SQLITE_VARIABLE_LIMIT);
    expect(mine[0].allocations.goal).toHaveLength(1);
  });
});
