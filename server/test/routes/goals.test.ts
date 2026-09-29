import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import goalsRouter from '../../routes/goals.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/goals', goalsRouter);
  return app;
}

async function makeDonor(balanceCents: number) {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `goal-${crypto.randomUUID()}@example.com`,
      balance_remaining: balanceCents,
      total_donated: balanceCents,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

describe('Goals routes', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET / returns only active goals', async () => {
    const active = await prisma.fundGoal.create({
      data: { title: 'Active Goal', target_cents: 1000, is_active: true },
    });
    const inactive = await prisma.fundGoal.create({
      data: { title: 'Inactive Goal', target_cents: 1000, is_active: false },
    });

    const res = await request(createApp()).get('/api/goals');

    expect(res.status).toBe(200);
    const ids = res.body.map((g: any) => g.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);

    await prisma.fundGoal.deleteMany({ where: { id: { in: [active.id, inactive.id] } } });
  });

  it('POST /:id/contribute contributes toward a goal', async () => {
    const { donor, token } = await makeDonor(5000);
    const goal = await prisma.fundGoal.create({
      data: { title: 'Contribute Goal', target_cents: 1000 },
    });

    const res = await request(createApp())
      .post(`/api/goals/${goal.id}/contribute`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_cents: 100 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await prisma.fundContribution.deleteMany({ where: { donor_id: donor.id } });
    await prisma.fundGoal.delete({ where: { id: goal.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('POST /:id/contribute returns 400 on insufficient balance', async () => {
    const { donor, token } = await makeDonor(0);
    const goal = await prisma.fundGoal.create({
      data: { title: 'Expensive Goal', target_cents: 1000 },
    });

    const res = await request(createApp())
      .post(`/api/goals/${goal.id}/contribute`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_cents: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Insufficient balance');

    await prisma.fundGoal.delete({ where: { id: goal.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });
});
