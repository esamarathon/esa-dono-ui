import { describe, it, expect, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import donorRouter from '../../routes/donor.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/donor', donorRouter);
  return app;
}

async function makeDonor(email: string, verified = false) {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
      email_verified: verified,
    },
  });
  return { donor, token };
}

describe('GET /api/donor', () => {
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
    delete process.env.MODERATOR_EMAILS;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reports the persisted USER role for a donor on no allowlist', async () => {
    const email = `user-${Date.now()}-${Math.random()}@example.com`;
    const { token, donor } = await makeDonor(email);

    const res = await request(createApp())
      .get('/api/donor')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('USER');

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('reports the effective ADMIN_EMAILS-resolved role, not the stale persisted role', async () => {
    const email = `admin-${Date.now()}-${Math.random()}@example.com`;
    const { token, donor } = await makeDonor(email, true);
    process.env.ADMIN_EMAILS = email;

    const res = await request(createApp())
      .get('/api/donor')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Persisted role in the DB is still USER — this is the regression this
    // guards: the route must not silently overwrite req.donor's resolved
    // role with the raw DB row's role when it re-fetches for includes.
    const raw = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(raw!.role).toBe('USER');
    expect(res.body.role).toBe('ADMIN');

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('reports the effective MODERATOR_EMAILS-resolved role', async () => {
    const email = `mod-${Date.now()}-${Math.random()}@example.com`;
    const { token, donor } = await makeDonor(email, true);
    process.env.MODERATOR_EMAILS = email;

    const res = await request(createApp())
      .get('/api/donor')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('MODERATOR');

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it("includes each donation's channel (#53)", async () => {
    const email = `chan-${Date.now()}-${Math.random()}@example.com`;
    const { token, donor } = await makeDonor(email);
    const channel = await prisma.channel.create({
      data: { name: `Main Marathon ${crypto.randomUUID()}` },
    });
    const channeled = await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 1000,
        channel_id: channel.id,
      },
    });
    const shared = await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 500,
      },
    });

    const res = await request(createApp())
      .get('/api/donor')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const channeledDonation = res.body.donations.find((d: { id: string }) => d.id === channeled.id);
    expect(channeledDonation.channel).toMatchObject({ id: channel.id, name: channel.name });

    const sharedDonation = res.body.donations.find((d: { id: string }) => d.id === shared.id);
    expect(sharedDonation.channel).toBeNull();

    await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
    await prisma.channel.delete({ where: { id: channel.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });
});
