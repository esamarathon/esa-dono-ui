import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import campaignRouter from '../../routes/campaign.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use('/api/campaign', campaignRouter);
  return app;
}

describe('GET /api/campaign totals against the real database', () => {
  const donorIds: string[] = [];

  afterAll(async () => {
    await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.$disconnect();
  });

  it('counts COMPLETED and REFUNDED (wallet refunds), not CHARGEBACK or PENDING', async () => {
    const before = await request(createApp()).get('/api/campaign');
    expect(before.status).toBe(200);
    const beforeRaised = Number(before.body.amount_raised.value);

    const donor = await prisma.donor.create({
      data: { email: `campaign-totals-${crypto.randomUUID()}@example.com` },
    });
    donorIds.push(donor.id);

    for (const [status, cents] of [
      ['COMPLETED', 1000],
      ['REFUNDED', 2000],
      ['CHARGEBACK', 3000],
      ['PENDING', 4000],
    ] as const) {
      await prisma.donation.create({
        data: {
          external_id: `campaign-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: cents,
          status,
        },
      });
    }

    const after = await request(createApp()).get('/api/campaign');
    expect(after.status).toBe(200);
    const afterRaised = Number(after.body.amount_raised.value);

    // COMPLETED 1000 + REFUNDED 2000: refunds go to the donor's wallet, so the
    // charity keeps the money. Chargebacks and pending payments do not count.
    expect(afterRaised - beforeRaised).toBeCloseTo(30, 2);
  });
});
