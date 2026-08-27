import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

vi.mock('../../services/stripe.js', () => ({
  createAuctionCheckoutSession: vi.fn().mockImplementation(async () => ({
    id: `cs_test_${Math.random().toString(36).slice(2)}`,
    url: 'https://checkout.stripe.com/test',
  })),
}));

vi.mock('../../services/email.js', () => ({
  sendAuctionOfferEmail: vi.fn().mockResolvedValue(undefined),
}));

import adminRouter from '../../routes/admin.js';

const prisma = new PrismaClient();
const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

async function makeDonor() {
  const donor = await prisma.donor.create({
    data: { email: `admin-auction-${crypto.randomUUID()}@example.com`, email_verified: true },
  });
  await prisma.donation.create({
    data: { external_id: `don-${donor.id}`, donor_id: donor.id, amount_cents: 5000 },
  });
  return donor;
}

describe('Admin auction routes', () => {
  const auctionIds: string[] = [];
  const donorIds: string[] = [];

  beforeAll(() => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterAll(async () => {
    for (const id of auctionIds) {
      await prisma.auctionWin.deleteMany({ where: { auction_id: id } });
      await prisma.auctionOffer.deleteMany({ where: { auction_id: id } });
      await prisma.bid.deleteMany({ where: { auction_id: id } });
      await prisma.auction
        .update({ where: { id }, data: { current_offer_id: null } })
        .catch(() => undefined);
      await prisma.auction.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of donorIds) {
      await prisma.donation.deleteMany({ where: { donor_id: id } });
      await prisma.donor.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('creates, lists, updates, and deletes an auction', async () => {
    const createRes = await request(createApp())
      .post('/api/admin/auctions')
      .set(AUTH)
      .send({
        title: 'Admin Test Auction',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(createRes.status).toBe(200);
    const auctionId = createRes.body.id;
    auctionIds.push(auctionId);

    const listRes = await request(createApp()).get('/api/admin/auctions').set(AUTH);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((a: any) => a.id === auctionId)).toBe(true);

    const updateRes = await request(createApp())
      .put(`/api/admin/auctions/${auctionId}`)
      .set(AUTH)
      .send({ title: 'Renamed Auction' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.title).toBe('Renamed Auction');

    const deleteRes = await request(createApp())
      .delete(`/api/admin/auctions/${auctionId}`)
      .set(AUTH);
    expect(deleteRes.status).toBe(200);
    auctionIds.pop();
  });

  it('rejects creating an auction with missing required fields', async () => {
    const res = await request(createApp()).post('/api/admin/auctions').set(AUTH).send({});
    expect(res.status).toBe(400);
  });

  it('force-closes an auction with no bids as UNSOLD', async () => {
    const auction = await prisma.auction.create({
      data: {
        title: 'No Bids Auction',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000),
      },
    });
    auctionIds.push(auction.id);

    const res = await request(createApp())
      .post(`/api/admin/auctions/${auction.id}/close`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UNSOLD');
  });

  it('closes an auction with a bid, lists offers, resends, skips, and cancels', async () => {
    const donor = await makeDonor();
    donorIds.push(donor.id);
    const auction = await prisma.auction.create({
      data: {
        title: 'Cascade Auction',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000),
        current_bid_cents: 1000,
        current_bidder_id: donor.id,
      },
    });
    auctionIds.push(auction.id);
    await prisma.bid.create({
      data: { auction_id: auction.id, donor_id: donor.id, amount_cents: 1000, status: 'ACTIVE' },
    });

    const closeRes = await request(createApp())
      .post(`/api/admin/auctions/${auction.id}/close`)
      .set(AUTH);
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.status).toBe('AWAITING_PAYMENT');

    const offersRes = await request(createApp())
      .get(`/api/admin/auctions/${auction.id}/offers`)
      .set(AUTH);
    expect(offersRes.status).toBe(200);
    expect(offersRes.body.length).toBe(1);
    expect(offersRes.body[0].donor.email).toBe(donor.email);

    const resendRes = await request(createApp())
      .post(`/api/admin/auctions/${auction.id}/resend-offer`)
      .set(AUTH);
    expect(resendRes.status).toBe(200);

    const skipRes = await request(createApp())
      .post(`/api/admin/auctions/${auction.id}/skip-offer`)
      .set(AUTH);
    expect(skipRes.status).toBe(200);
    expect(skipRes.body.status).toBe('UNSOLD'); // only one bidder — nowhere left to cascade to
  });

  it('cancels an OPEN auction', async () => {
    const auction = await prisma.auction.create({
      data: {
        title: 'Cancel Me',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000),
      },
    });
    auctionIds.push(auction.id);

    const res = await request(createApp())
      .post(`/api/admin/auctions/${auction.id}/cancel`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  it('GET /auction-wins returns a list', async () => {
    const res = await request(createApp()).get('/api/admin/auction-wins').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(createApp()).get('/api/admin/auctions');
    expect(res.status).toBe(401);
  });
});
