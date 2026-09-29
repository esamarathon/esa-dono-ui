/**
 * Auction types shared between server and client. Bids are non-binding
 * commitments (no wallet deduction) — settlement happens via a Stripe
 * Checkout cascade at close. See docs/adr for the full design rationale.
 */

export type AuctionType = 'DIGITAL' | 'PHYSICAL' | 'SHOUTOUT' | 'CUSTOM';

export type AuctionStatus =
  'OPEN' | 'CLOSED' | 'AWAITING_PAYMENT' | 'SETTLED' | 'UNSOLD' | 'CANCELLED';

export type BidStatus = 'ACTIVE' | 'OUTBID' | 'OFFERED' | 'WON' | 'PASSED';

export type AuctionOfferStatus = 'SENT' | 'PAID' | 'EXPIRED' | 'SKIPPED';

export type AuctionWinStatus = 'FULFILLED' | 'REVERSED';

/**
 * Minimum next-bid computation, shared so client-side bid forms and
 * server-side validation agree without duplicating the arithmetic.
 */
export function minNextBidCents(auction: {
  current_bid_cents: number | null;
  starting_price_cents: number;
  min_increment_cents: number;
}): number {
  return auction.current_bid_cents !== null
    ? auction.current_bid_cents + auction.min_increment_cents
    : auction.starting_price_cents;
}
