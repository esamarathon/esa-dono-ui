import client from 'prom-client';
import prisma from '../lib/prisma.js';
import { register } from '../lib/metrics.js';
import { METRICS_REFRESH_MS } from '../config.js';

/**
 * Business/custom metrics, sourced from the database rather than in-memory
 * counters. This is what makes them survive restarts and stay consistent
 * across load-balanced replicas — the DB is the single source of truth, the
 * gauges below are just a cached view of it.
 *
 * Values are refreshed on a background interval (see startMetricsRefresh)
 * and `/api/metrics` only ever reads the cached gauge value, so Prometheus
 * scrape frequency never adds DB load.
 */

const donorsTotal = new client.Gauge({
  name: 'dono_donors_total',
  help: 'Total number of donors',
  registers: [register],
});

const donatedCentsTotal = new client.Gauge({
  name: 'dono_donated_cents_total',
  help: 'Total amount donated across all donations, in cents',
  registers: [register],
});

const donationsTotal = new client.Gauge({
  name: 'dono_donations_total',
  help: 'Total number of donations processed',
  registers: [register],
});

const pledgesOpen = new client.Gauge({
  name: 'dono_pledges_open',
  help: 'Number of pending pledges currently open',
  registers: [register],
});

const eventsActive = new client.Gauge({
  name: 'dono_events_active',
  help: 'Number of active events',
  registers: [register],
});

const rewardClaimsTotal = new client.Gauge({
  name: 'dono_reward_claims_total',
  help: 'Total number of reward claims',
  registers: [register],
});

const pollVotesTotal = new client.Gauge({
  name: 'dono_poll_votes_total',
  help: 'Total number of poll votes cast',
  registers: [register],
});

const balanceAdjustmentsTotal = new client.Gauge({
  name: 'dono_balance_adjustments_total',
  help: 'Total number of balance adjustments, by type',
  labelNames: ['type'] as const,
  registers: [register],
});

const auctionsOpen = new client.Gauge({
  name: 'dono_auctions_open',
  help: 'Number of auctions currently open for bidding',
  registers: [register],
});

const auctionsAwaitingPayment = new client.Gauge({
  name: 'dono_auctions_awaiting_payment',
  help: 'Number of auctions currently mid-cascade awaiting payment from an offer-holder',
  registers: [register],
});

const auctionBidsActive = new client.Gauge({
  name: 'dono_auction_bids_active',
  help: 'Number of active (non-outbid/passed) auction bids',
  registers: [register],
});

const auctionWinsTotal = new client.Gauge({
  name: 'dono_auction_wins_total',
  help: 'Total number of settled (paid) auction wins',
  registers: [register],
});

const auctionsUnsold = new client.Gauge({
  name: 'dono_auctions_unsold',
  help: 'Number of auctions that closed with no bidder completing payment',
  registers: [register],
});

const metricsRefreshErrorsTotal = new client.Counter({
  name: 'dono_metrics_refresh_errors_total',
  help: 'Number of times the DB-derived metrics refresh failed',
  registers: [register],
});

const metricsLastRefreshTimestamp = new client.Gauge({
  name: 'dono_metrics_last_refresh_timestamp_seconds',
  help: 'Unix timestamp of the last successful business metrics refresh',
  registers: [register],
});

const ADJUSTMENT_TYPES = ['REFUND', 'FREEZE_ZERO', 'MANUAL', 'CHARGEBACK'] as const;

/**
 * Runs the bounded set of aggregate queries backing the business/custom
 * gauges and updates them in place. Individual query failures are logged and
 * skipped rather than throwing, so one bad query doesn't blank out the whole
 * metrics snapshot.
 */
export async function refreshBusinessMetrics(): Promise<void> {
  try {
    const [
      donorCount,
      donationAgg,
      donationCount,
      pledgeCount,
      activeEventCount,
      claimCount,
      pollVoteCount,
      adjustmentCounts,
      openAuctions,
      awaitingPaymentAuctions,
      activeBids,
      settledWins,
      unsoldAuctions,
    ] = await Promise.all([
      prisma.donor.count(),
      prisma.donation.aggregate({ _sum: { amount_cents: true } }),
      prisma.donation.count(),
      prisma.pendingPledge.count({ where: { status: 'OPEN' } }),
      prisma.channel.count({ where: { is_active: true } }),
      prisma.rewardClaim.count(),
      prisma.pollVote.count({ where: { reversed_at: null } }),
      Promise.all(
        ADJUSTMENT_TYPES.map((type) =>
          prisma.balanceAdjustment
            .count({ where: { type } })
            .then((count: number) => ({ type, count })),
        ),
      ),
      prisma.auction.count({ where: { status: 'OPEN' } }),
      prisma.auction.count({ where: { status: 'AWAITING_PAYMENT' } }),
      prisma.bid.count({ where: { status: 'ACTIVE' } }),
      prisma.auctionWin.count({ where: { status: 'FULFILLED' } }),
      prisma.auction.count({ where: { status: 'UNSOLD' } }),
    ]);

    donorsTotal.set(donorCount);
    donatedCentsTotal.set(donationAgg._sum.amount_cents ?? 0);
    donationsTotal.set(donationCount);
    pledgesOpen.set(pledgeCount);
    eventsActive.set(activeEventCount);
    rewardClaimsTotal.set(claimCount);
    pollVotesTotal.set(pollVoteCount);
    for (const { type, count } of adjustmentCounts) {
      balanceAdjustmentsTotal.set({ type }, count);
    }
    auctionsOpen.set(openAuctions);
    auctionsAwaitingPayment.set(awaitingPaymentAuctions);
    auctionBidsActive.set(activeBids);
    auctionWinsTotal.set(settledWins);
    auctionsUnsold.set(unsoldAuctions);
    metricsLastRefreshTimestamp.set(Date.now() / 1000);
  } catch (err) {
    metricsRefreshErrorsTotal.inc();
    console.error('Failed to refresh business metrics:', err);
  }
}

let refreshTimer: NodeJS.Timeout | undefined;

/** Starts the background refresh loop (idempotent). Call once at startup. */
export function startMetricsRefresh(intervalMs: number = METRICS_REFRESH_MS): void {
  if (refreshTimer) return;
  void refreshBusinessMetrics();
  refreshTimer = setInterval(() => void refreshBusinessMetrics(), intervalMs);
  refreshTimer.unref?.();
}

/** Stops the background refresh loop. Used by tests to avoid leaking timers. */
export function stopMetricsRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
