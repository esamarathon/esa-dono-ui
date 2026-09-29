import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

vi.mock('../../services/stripe.js', () => ({
  createAuctionCheckoutSession: vi.fn().mockImplementation(async () => ({
    id: `cs_test_${Math.random().toString(36).slice(2)}`,
    url: 'https://checkout.stripe.com/test',
  })),
}));

vi.mock('../../services/email.js', () => ({
  sendAuctionOfferEmail: vi.fn().mockResolvedValue(undefined),
}));

import { createAuctionCheckoutSession } from '../../services/stripe.js';
import {
  placeBidTx,
  closeAuctionTx,
  advanceCascadeTx,
  skipCurrentOfferTx,
  resendCurrentOfferTx,
  settleWinTx,
  cancelAuctionTx,
  reopenAuctionTx,
} from '../../services/auction.js';

const prisma = new PrismaClient();

describe('auction service', () => {
  beforeAll(() => {
    process.env.APP_BASE_URL = 'http://localhost:5173';
    vi.setConfig({ testTimeout: 15000 });
  });

  afterEach(() => {
    vi.mocked(createAuctionCheckoutSession).mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let counter = 0;
  async function makeDonor(
    opts: {
      verified?: boolean;
      hasDonation?: boolean;
      frozen?: boolean;
    } = {},
  ) {
    counter++;
    const donor = await prisma.donor.create({
      data: {
        email: `auction-${Date.now()}-${counter}@example.com`,
        email_verified: opts.verified ?? true,
        is_frozen: opts.frozen ?? false,
      },
    });
    if (opts.hasDonation ?? true) {
      await prisma.donation.create({
        data: {
          external_id: `don-${donor.id}`,
          donor_id: donor.id,
          amount_cents: 5000,
        },
      });
    }
    return donor;
  }

  async function makeAuction(overrides: Partial<Record<string, unknown>> = {}) {
    return prisma.auction.create({
      data: {
        title: 'Signed Guitar',
        type: 'PHYSICAL',
        starting_price_cents: 1000,
        min_increment_cents: 100,
        ends_at: new Date(Date.now() + 60_000),
        ...overrides,
      },
    });
  }

  async function cleanupAuction(auctionId: string) {
    await prisma.auctionWin.deleteMany({ where: { auction_id: auctionId } });
    await prisma.auctionOffer.deleteMany({ where: { auction_id: auctionId } });
    await prisma.bid.deleteMany({ where: { auction_id: auctionId } });
    await prisma.auction.update({ where: { id: auctionId }, data: { current_offer_id: null } });
    await prisma.auction.delete({ where: { id: auctionId } });
  }

  async function cleanupDonor(donorId: string) {
    await prisma.donation.deleteMany({ where: { donor_id: donorId } });
    await prisma.donor.delete({ where: { id: donorId } });
  }

  describe('placeBidTx', () => {
    it('accepts a valid first bid at the starting price', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();

      await prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000));

      const updated = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(updated!.current_bid_cents).toBe(1000);
      expect(updated!.current_bidder_id).toBe(donor.id);

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('rejects a bid below the minimum next bid', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();

      await expect(
        prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 500)),
      ).rejects.toThrow('Bid must be at least');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('rejects an unverified donor', async () => {
      const donor = await makeDonor({ verified: false });
      const auction = await makeAuction();

      await expect(
        prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000)),
      ).rejects.toThrow('verified email');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('rejects a donor with no prior donation', async () => {
      const donor = await makeDonor({ hasDonation: false });
      const auction = await makeAuction();

      await expect(
        prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000)),
      ).rejects.toThrow('prior completed donation');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('rejects a frozen donor', async () => {
      const donor = await makeDonor({ frozen: true });
      const auction = await makeAuction();

      await expect(
        prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000)),
      ).rejects.toThrow('frozen');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('outbids the previous high bidder and marks their bid OUTBID', async () => {
      const donorA = await makeDonor();
      const donorB = await makeDonor();
      const auction = await makeAuction();

      await prisma.$transaction((tx) => placeBidTx(tx, donorA.id, auction.id, 1000));
      await prisma.$transaction((tx) => placeBidTx(tx, donorB.id, auction.id, 1100));

      const bidA = await prisma.bid.findFirst({
        where: { auction_id: auction.id, donor_id: donorA.id },
      });
      expect(bidA!.status).toBe('OUTBID');

      const updated = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(updated!.current_bid_cents).toBe(1100);
      expect(updated!.current_bidder_id).toBe(donorB.id);

      await cleanupAuction(auction.id);
      await cleanupDonor(donorA.id);
      await cleanupDonor(donorB.id);
    });

    it('rejects bidding against yourself while already the high bidder', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();

      await prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000));

      await expect(
        prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1200)),
      ).rejects.toThrow('already the highest bidder');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('rejects bids on a closed auction', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction({ status: 'CLOSED' });

      await expect(
        prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000)),
      ).rejects.toThrow('not open');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });
  });

  describe('closeAuctionTx', () => {
    it('marks a zero-bid auction UNSOLD', async () => {
      const auction = await makeAuction({ ends_at: new Date(Date.now() - 1000) });

      const result = await prisma.$transaction((tx) => closeAuctionTx(tx, auction.id));

      expect(result.status).toBe('UNSOLD');
      const updated = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(updated!.status).toBe('UNSOLD');

      await cleanupAuction(auction.id);
    });

    it('sends the rank-1 offer to the highest bidder', async () => {
      const donorA = await makeDonor();
      const donorB = await makeDonor();
      const auction = await makeAuction({ ends_at: new Date(Date.now() - 1000) });

      // Bid while still OPEN, then close.
      await prisma.auction.update({
        where: { id: auction.id },
        data: { ends_at: new Date(Date.now() + 60_000) },
      });
      await prisma.$transaction((tx) => placeBidTx(tx, donorA.id, auction.id, 1000));
      await prisma.$transaction((tx) => placeBidTx(tx, donorB.id, auction.id, 1500));
      await prisma.auction.update({
        where: { id: auction.id },
        data: { ends_at: new Date(Date.now() - 1000) },
      });

      const result = await prisma.$transaction((tx) => closeAuctionTx(tx, auction.id));

      expect(result.status).toBe('AWAITING_PAYMENT');
      expect(createAuctionCheckoutSession).toHaveBeenCalledTimes(1);
      expect(createAuctionCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 1500, email: donorB.email, requiresShipping: true }),
      );

      const updated = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(updated!.status).toBe('AWAITING_PAYMENT');
      expect(updated!.current_offer_id).toBeTruthy();

      const offer = await prisma.auctionOffer.findUnique({
        where: { id: updated!.current_offer_id! },
      });
      expect(offer!.donor_id).toBe(donorB.id);
      expect(offer!.rank).toBe(1);
      expect(offer!.amount_cents).toBe(1500);

      await cleanupAuction(auction.id);
      await cleanupDonor(donorA.id);
      await cleanupDonor(donorB.id);
    });
  });

  describe('cascade advance', () => {
    async function closedAuctionWithTwoBids() {
      const donorA = await makeDonor(); // will win eventually
      const donorB = await makeDonor(); // outbid A, offered first, expires
      const auction = await makeAuction();
      await prisma.$transaction((tx) => placeBidTx(tx, donorA.id, auction.id, 1000));
      await prisma.$transaction((tx) => placeBidTx(tx, donorB.id, auction.id, 1500));
      await prisma.auction.update({
        where: { id: auction.id },
        data: { ends_at: new Date(Date.now() - 1000) },
      });
      await prisma.$transaction((tx) => closeAuctionTx(tx, auction.id));
      return { donorA, donorB, auction };
    }

    it('advances to the next-ranked bidder when the current offer expires', async () => {
      const { donorA, donorB, auction } = await closedAuctionWithTwoBids();

      const before = await prisma.auction.findUnique({ where: { id: auction.id } });
      const firstOffer = await prisma.auctionOffer.findUnique({
        where: { id: before!.current_offer_id! },
      });
      expect(firstOffer!.donor_id).toBe(donorB.id);

      const result = await prisma.$transaction((tx) =>
        advanceCascadeTx(tx, auction.id, firstOffer!.checkout_session_id!),
      );
      expect(result.advanced).toBe(true);
      expect((result as { status: string }).status).toBe('AWAITING_PAYMENT');

      const after = await prisma.auction.findUnique({ where: { id: auction.id } });
      const secondOffer = await prisma.auctionOffer.findUnique({
        where: { id: after!.current_offer_id! },
      });
      expect(secondOffer!.donor_id).toBe(donorA.id);
      expect(secondOffer!.rank).toBe(2);
      expect(secondOffer!.amount_cents).toBe(1000);

      const expiredOffer = await prisma.auctionOffer.findUnique({ where: { id: firstOffer!.id } });
      expect(expiredOffer!.status).toBe('EXPIRED');

      await cleanupAuction(auction.id);
      await cleanupDonor(donorA.id);
      await cleanupDonor(donorB.id);
    });

    it('marks UNSOLD once the entire ranked list is exhausted', async () => {
      const { donorA, donorB, auction } = await closedAuctionWithTwoBids();

      const first = await prisma.auction.findUnique({ where: { id: auction.id } });
      const firstOffer = await prisma.auctionOffer.findUnique({
        where: { id: first!.current_offer_id! },
      });
      await prisma.$transaction((tx) =>
        advanceCascadeTx(tx, auction.id, firstOffer!.checkout_session_id!),
      );

      const second = await prisma.auction.findUnique({ where: { id: auction.id } });
      const secondOffer = await prisma.auctionOffer.findUnique({
        where: { id: second!.current_offer_id! },
      });
      const result = await prisma.$transaction((tx) =>
        advanceCascadeTx(tx, auction.id, secondOffer!.checkout_session_id!),
      );

      expect((result as { status: string }).status).toBe('UNSOLD');
      const final = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(final!.status).toBe('UNSOLD');
      expect(final!.current_offer_id).toBeNull();

      await cleanupAuction(auction.id);
      await cleanupDonor(donorA.id);
      await cleanupDonor(donorB.id);
    });

    it('ignores a stale/duplicate expired-session event (idempotent)', async () => {
      const { donorA, donorB, auction } = await closedAuctionWithTwoBids();

      const result = await prisma.$transaction((tx) =>
        advanceCascadeTx(tx, auction.id, 'cs_not_the_current_offer'),
      );

      expect(result.advanced).toBe(false);
      const unchanged = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(unchanged!.status).toBe('AWAITING_PAYMENT');

      await cleanupAuction(auction.id);
      await cleanupDonor(donorA.id);
      await cleanupDonor(donorB.id);
    });
  });

  describe('settleWinTx', () => {
    it('creates an AuctionWin and marks the auction SETTLED on payment', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();
      await prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000));
      await prisma.auction.update({
        where: { id: auction.id },
        data: { ends_at: new Date(Date.now() - 1000) },
      });
      await prisma.$transaction((tx) => closeAuctionTx(tx, auction.id));

      const beforePay = await prisma.auction.findUnique({ where: { id: auction.id } });
      const offer = await prisma.auctionOffer.findUnique({
        where: { id: beforePay!.current_offer_id! },
      });

      const result = await prisma.$transaction((tx) =>
        settleWinTx(tx, auction.id, offer!.checkout_session_id!),
      );
      expect(result.settled).toBe(true);

      const settled = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(settled!.status).toBe('SETTLED');

      const win = await prisma.auctionWin.findUnique({ where: { auction_id: auction.id } });
      expect(win).toBeTruthy();
      expect(win!.donor_id).toBe(donor.id);
      expect(win!.winning_bid_cents).toBe(1000);
      expect(win!.status).toBe('FULFILLED');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });
  });

  describe('admin actions', () => {
    it('skipCurrentOfferTx advances the cascade immediately', async () => {
      const donorA = await makeDonor();
      const donorB = await makeDonor();
      const auction = await makeAuction();
      await prisma.$transaction((tx) => placeBidTx(tx, donorA.id, auction.id, 1000));
      await prisma.$transaction((tx) => placeBidTx(tx, donorB.id, auction.id, 1500));
      await prisma.auction.update({
        where: { id: auction.id },
        data: { ends_at: new Date(Date.now() - 1000) },
      });
      await prisma.$transaction((tx) => closeAuctionTx(tx, auction.id));

      const result = await prisma.$transaction((tx) => skipCurrentOfferTx(tx, auction.id));
      expect(result.status).toBe('AWAITING_PAYMENT');

      const after = await prisma.auction.findUnique({ where: { id: auction.id } });
      const offer = await prisma.auctionOffer.findUnique({
        where: { id: after!.current_offer_id! },
      });
      expect(offer!.donor_id).toBe(donorA.id);

      await cleanupAuction(auction.id);
      await cleanupDonor(donorA.id);
      await cleanupDonor(donorB.id);
    });

    it('resendCurrentOfferTx does not advance the cascade', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();
      await prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000));
      await prisma.auction.update({
        where: { id: auction.id },
        data: { ends_at: new Date(Date.now() - 1000) },
      });
      await prisma.$transaction((tx) => closeAuctionTx(tx, auction.id));

      const before = await prisma.auction.findUnique({ where: { id: auction.id } });
      await prisma.$transaction((tx) => resendCurrentOfferTx(tx, auction.id));
      const after = await prisma.auction.findUnique({ where: { id: auction.id } });

      expect(after!.current_offer_id).toBe(before!.current_offer_id);
      expect(after!.status).toBe('AWAITING_PAYMENT');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('cancelAuctionTx stops the cascade without charging anyone', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();
      await prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000));

      const result = await prisma.$transaction((tx) => cancelAuctionTx(tx, auction.id));
      expect(result.status).toBe('CANCELLED');

      const updated = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(updated!.status).toBe('CANCELLED');

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('reopenAuctionTx returns a cancelled auction to OPEN, preserving the high bid', async () => {
      const donor = await makeDonor();
      const auction = await makeAuction();
      await prisma.$transaction((tx) => placeBidTx(tx, donor.id, auction.id, 1000));
      await prisma.$transaction((tx) => cancelAuctionTx(tx, auction.id));

      const result = await prisma.$transaction((tx) => reopenAuctionTx(tx, auction.id));
      expect(result.status).toBe('OPEN');

      const updated = await prisma.auction.findUnique({ where: { id: auction.id } });
      expect(updated!.status).toBe('OPEN');
      expect(updated!.current_bid_cents).toBe(1000);
      expect(updated!.current_bidder_id).toBe(donor.id);

      await cleanupAuction(auction.id);
      await cleanupDonor(donor.id);
    });

    it('reopenAuctionTx rejects reopening an auction that is not cancelled', async () => {
      const auction = await makeAuction({ status: 'UNSOLD' });

      await expect(prisma.$transaction((tx) => reopenAuctionTx(tx, auction.id))).rejects.toThrow(
        'Only a cancelled auction can be reopened',
      );

      await cleanupAuction(auction.id);
    });
  });
});
