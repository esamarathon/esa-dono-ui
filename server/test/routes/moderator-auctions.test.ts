import { describe, it, expect, vi, afterAll } from 'vitest';
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

import moderatorRouter from '../../routes/moderator.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/moderator', moderatorRouter);
  return app;
}

async function makeModerator() {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `mod-auction-${crypto.randomUUID()}@example.com`,
      role: 'MODERATOR',
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

async function makeBidder() {
  const donor = await prisma.donor.create({
    data: { email: `bidder-${crypto.randomUUID()}@example.com`, email_verified: true },
  });
  await prisma.donation.create({
    data: { external_id: `don-${donor.id}`, donor_id: donor.id, amount_cents: 5000 },
  });
  return donor;
}

describe('Moderator auction routes', () => {
  const auctionIds: string[] = [];
  const donorIds: string[] = [];

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

  it('rejects a non-moderator request', async () => {
    const res = await request(createApp()).get('/api/moderator/auctions');
    expect(res.status).toBe(401);
  });

  it('creates, lists, and updates an auction', async () => {
    const { donor, token } = await makeModerator();
    donorIds.push(donor.id);

    const createRes = await request(createApp())
      .post('/api/moderator/auctions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Moderator Test Auction',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(createRes.status).toBe(200);
    auctionIds.push(createRes.body.id);

    const listRes = await request(createApp())
      .get('/api/moderator/auctions')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((a: any) => a.id === createRes.body.id)).toBe(true);

    const updateRes = await request(createApp())
      .put(`/api/moderator/auctions/${createRes.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Renamed' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.title).toBe('Renamed');
  });

  it('closes an auction, views the cascade, and skips/resends without exposing donor email', async () => {
    const { donor: moderator, token } = await makeModerator();
    donorIds.push(moderator.id);
    const bidder = await makeBidder();
    donorIds.push(bidder.id);

    const auction = await prisma.auction.create({
      data: {
        title: 'Mod Cascade Auction',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000),
        current_bid_cents: 1000,
        current_bidder_id: bidder.id,
      },
    });
    auctionIds.push(auction.id);
    await prisma.bid.create({
      data: { auction_id: auction.id, donor_id: bidder.id, amount_cents: 1000, status: 'ACTIVE' },
    });

    const closeRes = await request(createApp())
      .post(`/api/moderator/auctions/${auction.id}/close`)
      .set('Authorization', `Bearer ${token}`);
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.status).toBe('AWAITING_PAYMENT');

    const offersRes = await request(createApp())
      .get(`/api/moderator/auctions/${auction.id}/offers`)
      .set('Authorization', `Bearer ${token}`);
    expect(offersRes.status).toBe(200);
    expect(offersRes.body.length).toBe(1);
    expect(JSON.stringify(offersRes.body)).not.toContain(bidder.email);

    const resendRes = await request(createApp())
      .post(`/api/moderator/auctions/${auction.id}/resend-offer`)
      .set('Authorization', `Bearer ${token}`);
    expect(resendRes.status).toBe(200);

    const skipRes = await request(createApp())
      .post(`/api/moderator/auctions/${auction.id}/skip-offer`)
      .set('Authorization', `Bearer ${token}`);
    expect(skipRes.status).toBe(200);
    expect(skipRes.body.status).toBe('UNSOLD');
  });

  it('cancels an OPEN auction', async () => {
    const { donor, token } = await makeModerator();
    donorIds.push(donor.id);
    const auction = await prisma.auction.create({
      data: {
        title: 'Mod Cancel Me',
        type: 'DIGITAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 3_600_000),
      },
    });
    auctionIds.push(auction.id);

    const res = await request(createApp())
      .post(`/api/moderator/auctions/${auction.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });
});
