import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import auctionsRouter from '../../routes/auctions.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auctions', auctionsRouter);
  return app;
}

async function makeDonor(opts: { verified?: boolean; hasDonation?: boolean } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `auction-route-${crypto.randomUUID()}@example.com`,
      email_verified: opts.verified ?? true,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  if (opts.hasDonation ?? true) {
    await prisma.donation.create({
      data: { external_id: `don-${donor.id}`, donor_id: donor.id, amount_cents: 5000 },
    });
  }
  return { donor, token };
}

async function makeAuction(overrides: Record<string, unknown> = {}) {
  return prisma.auction.create({
    data: {
      title: 'Signed Guitar',
      type: 'DIGITAL',
      starting_price_cents: 1000,
      min_increment_cents: 100,
      ends_at: new Date(Date.now() + 60_000),
      ...overrides,
    },
  });
}

async function cleanupAuction(auctionId: string) {
  await prisma.bid.deleteMany({ where: { auction_id: auctionId } });
  await prisma.auction.delete({ where: { id: auctionId } });
}

async function cleanupDonor(donorId: string) {
  await prisma.donation.deleteMany({ where: { donor_id: donorId } });
  await prisma.donor.delete({ where: { id: donorId } });
}

describe('Auctions routes', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET / returns only active auctions with a computed min_next_bid_cents', async () => {
    const active = await makeAuction({ is_active: true });
    const inactive = await makeAuction({ is_active: false });

    const res = await request(createApp()).get('/api/auctions');

    expect(res.status).toBe(200);
    const ids = res.body.map((a: { id: string }) => a.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);
    const found = res.body.find((a: { id: string }) => a.id === active.id);
    expect(found.min_next_bid_cents).toBe(1000);

    await cleanupAuction(active.id);
    await cleanupAuction(inactive.id);
  });

  it('GET /:id returns auction detail with bid history', async () => {
    const auction = await makeAuction();

    const res = await request(createApp()).get(`/api/auctions/${auction.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(auction.id);
    expect(res.body.bids).toEqual([]);

    await cleanupAuction(auction.id);
  });

  it('GET /:id returns 404 for an unknown auction', async () => {
    const res = await request(createApp()).get('/api/auctions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /:id/bid places a valid bid', async () => {
    const { donor, token } = await makeDonor();
    const auction = await makeAuction();

    const res = await request(createApp())
      .post(`/api/auctions/${auction.id}/bid`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_cents: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await cleanupAuction(auction.id);
    await cleanupDonor(donor.id);
  });

  it('POST /:id/bid rejects a donor without a prior donation', async () => {
    const { donor, token } = await makeDonor({ hasDonation: false });
    const auction = await makeAuction();

    const res = await request(createApp())
      .post(`/api/auctions/${auction.id}/bid`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_cents: 1000 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/prior completed donation/);

    await cleanupAuction(auction.id);
    await cleanupDonor(donor.id);
  });

  it('POST /:id/bid returns 401 without a donor token', async () => {
    const auction = await makeAuction();

    const res = await request(createApp())
      .post(`/api/auctions/${auction.id}/bid`)
      .send({ amount_cents: 1000 });

    expect(res.status).toBe(401);

    await cleanupAuction(auction.id);
  });
});
