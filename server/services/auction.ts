import type { Prisma } from '@prisma/client';
import { MIN_SPEND_CENTS, minNextBidCents } from '@dono/shared';
import { AUCTION_OFFER_TTL_MS } from '../config.js';
import { createAuctionCheckoutSession } from './stripe.js';
import { sendAuctionOfferEmail } from './email.js';

type Tx = Prisma.TransactionClient;

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

/**
 * Place a non-binding bid on an OPEN auction. No wallet funds are deducted —
 * bids are commitments settled by the post-close Checkout cascade (see
 * closeAuctionTx / advanceCascadeTx below).
 *
 * Eligibility (deliberately strict, since bids carry no upfront cost):
 * the donor must have a verified email AND at least one completed
 * donation on record, must not be frozen, and cannot bid against
 * themselves while already the current high bidder.
 */
export async function placeBidTx(tx: Tx, donorId: string, auctionId: string, cents: number) {
  if (!Number.isInteger(cents) || cents < MIN_SPEND_CENTS) {
    throw httpError(`amount_cents (min ${MIN_SPEND_CENTS}) required`, 400);
  }

  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction || !auction.is_active) throw httpError('Auction not found', 404);
  if (auction.status !== 'OPEN') throw httpError('Auction is not open for bidding', 400);
  if (new Date() >= auction.ends_at) throw httpError('Auction has ended', 400);

  const donor = await tx.donor.findUnique({ where: { id: donorId } });
  if (!donor) throw httpError('Donor not found', 404);
  if (donor.is_frozen) throw httpError('Account frozen', 403);
  if (!donor.email_verified) {
    throw httpError('A verified email is required to bid on auctions', 403);
  }
  const donationCount = await tx.donation.count({ where: { donor_id: donorId } });
  if (donationCount === 0) {
    throw httpError('A prior completed donation is required to bid on auctions', 403);
  }
  if (auction.current_bidder_id === donorId) {
    throw httpError('You are already the highest bidder', 400);
  }

  const minNext = minNextBidCents(auction);
  if (cents < minNext) {
    throw httpError(`Bid must be at least ${minNext} cents`, 400);
  }

  if (auction.current_bidder_id) {
    await tx.bid.updateMany({
      where: { auction_id: auction.id, donor_id: auction.current_bidder_id, status: 'ACTIVE' },
      data: { status: 'OUTBID' },
    });
  }

  const bid = await tx.bid.create({
    data: { auction_id: auction.id, donor_id: donorId, amount_cents: cents, status: 'ACTIVE' },
  });

  await tx.auction.update({
    where: { id: auction.id },
    data: { current_bid_cents: cents, current_bidder_id: donorId },
  });

  return { bid };
}

/**
 * Collapse an auction's bids to one (highest) per donor, sorted
 * descending, tiebreaking on earliest created_at. Used once at close to
 * freeze the cascade order.
 */
function rankBids<T extends { donor_id: string; amount_cents: number; created_at: Date }>(
  bids: T[],
): T[] {
  const highestPerDonor = new Map<string, T>();
  for (const bid of bids) {
    const existing = highestPerDonor.get(bid.donor_id);
    if (
      !existing ||
      bid.amount_cents > existing.amount_cents ||
      (bid.amount_cents === existing.amount_cents && bid.created_at < existing.created_at)
    ) {
      highestPerDonor.set(bid.donor_id, bid);
    }
  }
  return [...highestPerDonor.values()].sort((a, b) => {
    if (b.amount_cents !== a.amount_cents) return b.amount_cents - a.amount_cents;
    return a.created_at.getTime() - b.created_at.getTime();
  });
}

/**
 * Create and send the next cascade offer for the given bid/rank. Generates a
 * Stripe Checkout Session (24h expiry) — which collects the shipping
 * address natively on Stripe's side for PHYSICAL items — and emails the
 * bidder. Sets the auction's current_offer_id pointer and status =
 * AWAITING_PAYMENT.
 *
 * Caller must guarantee no other offer is currently SENT for this auction.
 */
async function sendOfferTx(tx: Tx, auctionId: string, bidId: string, rank: number) {
  const auction = await tx.auction.findUniqueOrThrow({ where: { id: auctionId } });
  const bid = await tx.bid.findUniqueOrThrow({ where: { id: bidId } });
  const donor = await tx.donor.findUniqueOrThrow({ where: { id: bid.donor_id } });

  const expiresAt = new Date(Date.now() + AUCTION_OFFER_TTL_MS);
  const session = await createAuctionCheckoutSession({
    amountCents: bid.amount_cents,
    email: donor.email,
    requiresShipping: auction.type === 'PHYSICAL',
    expiresAt,
    metadata: { auction_id: auction.id },
  });

  const offer = await tx.auctionOffer.create({
    data: {
      auction_id: auction.id,
      donor_id: donor.id,
      bid_id: bid.id,
      rank,
      amount_cents: bid.amount_cents,
      checkout_session_id: session.id,
      checkout_url: session.url,
      status: 'SENT',
      expires_at: expiresAt,
      emailed_at: new Date(),
    },
  });

  await tx.bid.update({ where: { id: bid.id }, data: { status: 'OFFERED' } });
  await tx.auction.update({
    where: { id: auction.id },
    data: { status: 'AWAITING_PAYMENT', current_offer_id: offer.id },
  });

  // Fire-and-forget style, but awaited inside the tx for test determinism;
  // email failures should not roll back the offer (auction/pledge webhook
  // flows already log-and-degrade rather than throw on email issues).
  try {
    await sendAuctionOfferEmail({
      email: donor.email,
      auctionTitle: auction.title,
      amountCents: bid.amount_cents,
      checkoutUrl: session.url ?? '',
      expiresAt,
    });
  } catch (err) {
    console.error('Failed to send auction offer email:', err);
  }

  return offer;
}

/**
 * Close an OPEN auction (called by the scheduler once ends_at has passed,
 * or manually by an admin/moderator force-close). Freezes the bid ranking
 * and, if there is at least one bid, immediately sends the rank-1 offer.
 * With zero bids, the auction is marked UNSOLD.
 */
export async function closeAuctionTx(tx: Tx, auctionId: string) {
  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction) throw httpError('Auction not found', 404);
  if (auction.status !== 'OPEN') throw httpError('Auction is not open', 400);

  await tx.auction.update({ where: { id: auction.id }, data: { status: 'CLOSED' } });

  const bids = await tx.bid.findMany({
    where: { auction_id: auction.id },
    orderBy: { created_at: 'asc' },
  });
  const ranked = rankBids(bids);

  if (ranked.length === 0) {
    await tx.auction.update({ where: { id: auction.id }, data: { status: 'UNSOLD' } });
    return { status: 'UNSOLD' as const };
  }

  for (let i = 0; i < ranked.length; i++) {
    await tx.bid.update({ where: { id: ranked[i]!.id }, data: { rank: i + 1 } });
  }

  const offer = await sendOfferTx(tx, auction.id, ranked[0]!.id, 1);
  return { status: 'AWAITING_PAYMENT' as const, offer };
}

/**
 * Advance the cascade after the current offer's Checkout Session expires
 * unpaid. Idempotent: ignores the event if the given session id no longer
 * matches the auction's current SENT offer (stale/duplicate webhook, or an
 * offer that was already settled/skipped).
 */
export async function advanceCascadeTx(tx: Tx, auctionId: string, expiredSessionId: string) {
  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction || !auction.current_offer_id) return { advanced: false };

  const currentOffer = await tx.auctionOffer.findUnique({
    where: { id: auction.current_offer_id },
  });
  if (!currentOffer || currentOffer.status !== 'SENT') return { advanced: false };
  if (currentOffer.checkout_session_id !== expiredSessionId) return { advanced: false };

  await tx.auctionOffer.update({ where: { id: currentOffer.id }, data: { status: 'EXPIRED' } });
  await tx.bid.update({ where: { id: currentOffer.bid_id }, data: { status: 'PASSED' } });
  await tx.auction.update({ where: { id: auction.id }, data: { current_offer_id: null } });

  return advanceToNextRankTx(tx, auctionId, currentOffer.rank);
}

/**
 * Admin/moderator action: expire the current offer early (e.g. the
 * operator learned out-of-band that the winner declined) and immediately
 * advance to the next bidder, without waiting for the 24h Stripe expiry.
 */
export async function skipCurrentOfferTx(tx: Tx, auctionId: string) {
  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction || !auction.current_offer_id) {
    throw httpError('No active offer to skip', 400);
  }
  const currentOffer = await tx.auctionOffer.findUnique({
    where: { id: auction.current_offer_id },
  });
  if (!currentOffer || currentOffer.status !== 'SENT') {
    throw httpError('No active offer to skip', 400);
  }

  await tx.auctionOffer.update({ where: { id: currentOffer.id }, data: { status: 'SKIPPED' } });
  await tx.bid.update({ where: { id: currentOffer.bid_id }, data: { status: 'PASSED' } });
  await tx.auction.update({ where: { id: auction.id }, data: { current_offer_id: null } });

  return advanceToNextRankTx(tx, auctionId, currentOffer.rank);
}

async function advanceToNextRankTx(tx: Tx, auctionId: string, currentRank: number) {
  const bids = await tx.bid.findMany({
    where: { auction_id: auctionId, rank: { not: null } },
    orderBy: { rank: 'asc' },
  });
  const nextBid = bids.find((b) => b.rank === currentRank + 1);

  if (!nextBid) {
    await tx.auction.update({ where: { id: auctionId }, data: { status: 'UNSOLD' } });
    return { advanced: true, status: 'UNSOLD' as const };
  }

  const offer = await sendOfferTx(tx, auctionId, nextBid.id, currentRank + 1);
  return { advanced: true, status: 'AWAITING_PAYMENT' as const, offer };
}

/**
 * Resend the current offer's existing Checkout URL without advancing the
 * cascade — for a bidder who missed the original email.
 */
export async function resendCurrentOfferTx(tx: Tx, auctionId: string) {
  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction || !auction.current_offer_id) {
    throw httpError('No active offer to resend', 400);
  }
  const offer = await tx.auctionOffer.findUnique({ where: { id: auction.current_offer_id } });
  if (!offer || offer.status !== 'SENT' || !offer.checkout_url) {
    throw httpError('No active offer to resend', 400);
  }
  const donor = await tx.donor.findUniqueOrThrow({ where: { id: offer.donor_id } });

  try {
    await sendAuctionOfferEmail({
      email: donor.email,
      auctionTitle: auction.title,
      amountCents: offer.amount_cents,
      checkoutUrl: offer.checkout_url,
      expiresAt: offer.expires_at,
    });
  } catch (err) {
    console.error('Failed to resend auction offer email:', err);
  }

  return { offer };
}

/**
 * Settle a paid Checkout Session as the auction's winning payment. Called
 * from the webhook on checkout.session.completed for an auction-scoped
 * session.
 */
export async function settleWinTx(tx: Tx, auctionId: string, sessionId: string) {
  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction || !auction.current_offer_id) return { settled: false };

  const offer = await tx.auctionOffer.findUnique({ where: { id: auction.current_offer_id } });
  if (!offer || offer.status !== 'SENT' || offer.checkout_session_id !== sessionId) {
    return { settled: false };
  }

  await tx.auctionOffer.update({ where: { id: offer.id }, data: { status: 'PAID' } });
  await tx.bid.update({ where: { id: offer.bid_id }, data: { status: 'WON' } });
  await tx.auctionWin.create({
    data: {
      auction_id: auction.id,
      donor_id: offer.donor_id,
      winning_bid_cents: offer.amount_cents,
      checkout_session_id: sessionId,
      status: 'FULFILLED',
    },
  });
  await tx.auction.update({
    where: { id: auction.id },
    data: { status: 'SETTLED', current_offer_id: null },
  });

  return { settled: true };
}

/**
 * Cancel an auction before it has been paid out. Nothing has been charged
 * pre-payment under this model, so cancellation never needs to refund
 * anything — it simply stops the cascade.
 */
export async function cancelAuctionTx(tx: Tx, auctionId: string) {
  const auction = await tx.auction.findUnique({ where: { id: auctionId } });
  if (!auction) throw httpError('Auction not found', 404);
  if (auction.status === 'SETTLED') {
    throw httpError('Cannot cancel a settled auction', 400);
  }

  if (auction.current_offer_id) {
    await tx.auctionOffer.update({
      where: { id: auction.current_offer_id },
      data: { status: 'SKIPPED' },
    });
  }
  await tx.auction.update({
    where: { id: auction.id },
    data: { status: 'CANCELLED', current_offer_id: null },
  });

  return { status: 'CANCELLED' as const };
}
