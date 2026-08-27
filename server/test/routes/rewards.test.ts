import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import rewardsRouter from '../../routes/rewards.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rewards', rewardsRouter);
  return app;
}

async function makeDonor(balanceCents: number) {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `reward-${crypto.randomUUID()}@example.com`,
      balance_remaining: balanceCents,
      total_donated: balanceCents,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

describe('Rewards routes', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET / returns only active rewards', async () => {
    const active = await prisma.reward.create({
      data: { title: 'Active Reward', type: 'DIGITAL', cost_cents: 100, is_active: true },
    });
    const inactive = await prisma.reward.create({
      data: { title: 'Inactive Reward', type: 'DIGITAL', cost_cents: 100, is_active: false },
    });

    const res = await request(createApp()).get('/api/rewards');

    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);

    await prisma.reward.deleteMany({ where: { id: { in: [active.id, inactive.id] } } });
  });

  it('POST /:id/claim claims a reward', async () => {
    const { donor, token } = await makeDonor(5000);
    const reward = await prisma.reward.create({
      data: { title: 'Claim Reward', type: 'DIGITAL', cost_cents: 500 },
    });

    const res = await request(createApp())
      .post(`/api/rewards/${reward.id}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send({ claim_data: { name: 'Alice' } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await prisma.rewardClaim.deleteMany({ where: { donor_id: donor.id } });
    await prisma.reward.delete({ where: { id: reward.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('POST /:id/claim returns 400 on insufficient balance', async () => {
    const { donor, token } = await makeDonor(0);
    const reward = await prisma.reward.create({
      data: { title: 'Expensive Reward', type: 'DIGITAL', cost_cents: 500 },
    });

    const res = await request(createApp())
      .post(`/api/rewards/${reward.id}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Insufficient balance');

    await prisma.reward.delete({ where: { id: reward.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });
});
