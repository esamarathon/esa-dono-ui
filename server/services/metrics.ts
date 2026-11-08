import client from 'prom-client';
import prisma from '../lib/prisma.js';
import { readAccountingStatsTx } from './accountingStats.js';
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
  help: 'Total amount donated (completed and wallet-refunded donations; chargebacks excluded), in cents',
  registers: [register],
});

const donationsTotal = new client.Gauge({
  name: 'dono_donations_total',
  help: 'Total number of donations processed',
  registers: [register],
});

/**
 * Donations with no Channel and no Event yet (PRD-0002 §E6): they wait for an
 * admin to assign one with PATCH /admin/donations/:id/channel. Alert on > 0.
 */
const donationsUnassigned = new client.Gauge({
  name: 'dono_donations_unassigned',
  help: 'Donations waiting to be assigned to a Channel',
  registers: [register],
});

// Per-Event and per-Channel breakdowns (PRD-0002 §M3) are separate labelled
// gauges, never labels added to the unlabelled globals above: a gauge carrying
// both an unlabelled total and labelled parts double-counts under PromQL sum().
// Labels hold slug values; '' means unassigned or shared.
const BY_CHANNEL_LABELS = ['event', 'channel'] as const;

const donatedCentsByChannel = new client.Gauge({
  name: 'dono_donated_cents_by_channel',
  help: 'Donation amount in cents, by Event and Channel slug',
  labelNames: BY_CHANNEL_LABELS,
  registers: [register],
});

const donationsByChannel = new client.Gauge({
  name: 'dono_donations_by_channel',
  help: 'Number of donations, by Event and Channel slug',
  labelNames: BY_CHANNEL_LABELS,
  registers: [register],
});

const rewardClaimsByChannel = new client.Gauge({
  name: 'dono_reward_claims_by_channel',
  help: "Live reward claims, by the slug of the reward's Event and Channel",
  labelNames: BY_CHANNEL_LABELS,
  registers: [register],
});

const pollVotesByChannel = new client.Gauge({
  name: 'dono_poll_votes_by_channel',
  help: "Poll votes, by the slug of the poll's Event and Channel",
  labelNames: BY_CHANNEL_LABELS,
  registers: [register],
});

const pledgesOpen = new client.Gauge({
  name: 'dono_pledges_open',
  help: 'Number of pending pledges currently open',
  registers: [register],
});

const eventsActive = new client.Gauge({
  name: 'dono_events_active',
  help: 'Number of active Events (charity events)',
  registers: [register],
});

// Before #115 dono_events_active counted active Channels (the concept was once
// named "Event"); that count now has its own, correctly named gauge.
const channelsActive = new client.Gauge({
  name: 'dono_channels_active',
  help: 'Number of active Channels',
  registers: [register],
});

const rewardClaimsTotal = new client.Gauge({
  name: 'dono_reward_claims_total',
  help: 'Number of live reward claims (including CANCELLING)',
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

const webhookQueueDepth = new client.Gauge({
  name: 'dono_webhook_queue_depth',
  help: 'PENDING webhook deliveries per destination',
  labelNames: ['destination_id', 'destination_type'] as const,
  registers: [register],
});

const webhookQueueOldestPendingAgeSeconds = new client.Gauge({
  name: 'dono_webhook_queue_oldest_pending_age_seconds',
  help: 'Age in seconds of the oldest PENDING webhook delivery per destination (0 if none)',
  labelNames: ['destination_id', 'destination_type'] as const,
  registers: [register],
});

const webhookQueueFailed = new client.Gauge({
  name: 'dono_webhook_queue_failed',
  help: 'FAILED webhook deliveries still retained, per destination',
  labelNames: ['destination_id', 'destination_type'] as const,
  registers: [register],
});

const webhookDestinationActive = new client.Gauge({
  name: 'dono_webhook_destination_active',
  help: '1 if the webhook destination is active, 0 if paused (lets stall alerts ignore paused destinations)',
  labelNames: ['destination_id', 'destination_type'] as const,
  registers: [register],
});

const webhookDestinationLastSuccessTimestampSeconds = new client.Gauge({
  name: 'dono_webhook_destination_last_success_timestamp_seconds',
  help: 'Unix time of the most recent retained SUCCESS webhook delivery per destination (0 if none)',
  labelNames: ['destination_id', 'destination_type'] as const,
  registers: [register],
});

const incentiveAllocatedCents = new client.Gauge({
  name: 'dono_incentive_allocated_cents_by_channel',
  help: 'Live incentive allocation cents, not money, scoped to the incentive',
  labelNames: ['event', 'channel', 'category', 'source'] as const,
  registers: [register],
});
const poolUnusedCents = new client.Gauge({
  name: 'dono_pool_unused_cents_by_channel',
  help: 'Unused poll/goal Pool cents, not money, scoped to the donation',
  labelNames: ['event', 'channel', 'category'] as const,
  registers: [register],
});
const poolCreditCents = new client.Gauge({
  name: 'dono_pool_credit_cents_by_channel',
  help: 'Effective category Pool credit obligation cents, not additional money, scoped to the donation',
  labelNames: ['event', 'channel', 'category'] as const,
  registers: [register],
});
const walletCreditCents = new client.Gauge({
  name: 'dono_wallet_credit_cents',
  help: 'Wallet credit cents by available or held state',
  labelNames: ['state'] as const,
  registers: [register],
});
const pledgesOverdue = new client.Gauge({
  name: 'dono_pledges_overdue',
  help: 'OPEN pledges past their deadline whose Checkout Session is not complete',
  registers: [register],
});
const paymentRefunds = new client.Gauge({
  name: 'dono_payment_refunds',
  help: 'Payment refund record counts by status, including rejected attempts as resolved',
  labelNames: ['status'] as const,
  registers: [register],
});
const paymentRefundsOldestRequestedAge = new client.Gauge({
  name: 'dono_payment_refunds_oldest_requested_age_seconds',
  help: 'Age in seconds of the oldest REQUESTED Payment refund, zero if none',
  registers: [register],
});

const ADJUSTMENT_TYPES = [
  'REFUND',
  'FREEZE_ZERO',
  'MANUAL',
  'CHARGEBACK',
  'WALLET_REFUND',
  'FAILED_PAYMENT_REFUND',
] as const;

/**
 * Refreshes the bulk accounting snapshot and existing operational aggregates.
 * A query failure is logged without throwing or replacing the previous cache;
 * the success timestamp stays unchanged so operators can detect staleness.
 */
export async function refreshBusinessMetrics(): Promise<void> {
  try {
    const [
      stats,
      adjustmentCounts,
      openAuctions,
      awaitingPaymentAuctions,
      activeBids,
      settledWins,
      unsoldAuctions,
      webhookDestinations,
      webhookDeliveryGroups,
    ] = await Promise.all([
      prisma.$transaction((tx) => readAccountingStatsTx(tx)),
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
      prisma.webhookDestination.findMany({
        select: { id: true, destination_type: true, is_active: true },
      }),
      prisma.webhookDelivery.groupBy({
        by: ['destination_id', 'status'],
        _count: { _all: true },
        _min: { created_at: true },
        _max: { updated_at: true },
      }),
    ]);

    donorsTotal.set(stats.admin.donors);
    donatedCentsTotal.set(stats.admin.total_raised_cents);
    donationsTotal.set(stats.admin.donations);
    pledgesOpen.set(stats.admin.pledges.open);
    pledgesOverdue.set(stats.admin.pledges.overdue);
    eventsActive.set(stats.active_events);
    channelsActive.set(stats.active_channels);
    rewardClaimsTotal.set(stats.admin.claims);
    pollVotesTotal.set(stats.poll_votes);
    donationsUnassigned.set(stats.unassigned_donations);
    walletCreditCents.set({ state: 'available' }, stats.admin.wallet_credit_cents.available);
    walletCreditCents.set({ state: 'held' }, stats.admin.wallet_credit_cents.held);
    for (const [status, count] of Object.entries(stats.payment_refunds))
      paymentRefunds.set({ status }, count);
    paymentRefundsOldestRequestedAge.set(stats.oldest_requested_age_seconds);

    donatedCentsByChannel.reset();
    donationsByChannel.reset();
    poolUnusedCents.reset();
    poolCreditCents.reset();
    for (const row of stats.donation_channels) {
      const labels = { event: row.event, channel: row.channel };
      donatedCentsByChannel.set(labels, row.money_cents);
      donationsByChannel.set(labels, row.donations);
      for (const category of ['poll', 'goal'] as const)
        poolUnusedCents.set({ ...labels, category }, row.unused_cents[category]);
      for (const category of ['reward', 'poll', 'goal'] as const)
        poolCreditCents.set({ ...labels, category }, row.credit_cents[category]);
    }
    incentiveAllocatedCents.reset();
    for (const { cents, ...labels } of stats.allocations)
      incentiveAllocatedCents.set(labels, cents);
    rewardClaimsByChannel.reset();
    for (const { count, ...labels } of stats.claim_channels)
      rewardClaimsByChannel.set(labels, count);
    pollVotesByChannel.reset();
    for (const { count, ...labels } of stats.vote_channels) pollVotesByChannel.set(labels, count);
    for (const { type, count } of adjustmentCounts) {
      balanceAdjustmentsTotal.set({ type }, count);
    }
    auctionsOpen.set(openAuctions);
    auctionsAwaitingPayment.set(awaitingPaymentAuctions);
    auctionBidsActive.set(activeBids);
    auctionWinsTotal.set(settledWins);
    auctionsUnsold.set(unsoldAuctions);
    webhookQueueDepth.reset();
    webhookQueueOldestPendingAgeSeconds.reset();
    webhookQueueFailed.reset();
    webhookDestinationActive.reset();
    webhookDestinationLastSuccessTimestampSeconds.reset();
    const group = new Map(webhookDeliveryGroups.map((g) => [`${g.destination_id}:${g.status}`, g]));
    for (const d of webhookDestinations) {
      const labels = { destination_id: d.id, destination_type: d.destination_type };
      const pending = group.get(`${d.id}:PENDING`);
      const oldestPending = pending?._min.created_at;
      const lastSuccess = group.get(`${d.id}:SUCCESS`)?._max.updated_at;
      webhookQueueDepth.set(labels, pending?._count._all ?? 0);
      webhookQueueOldestPendingAgeSeconds.set(
        labels,
        oldestPending ? Math.max(0, (Date.now() - oldestPending.getTime()) / 1000) : 0,
      );
      webhookQueueFailed.set(labels, group.get(`${d.id}:FAILED`)?._count._all ?? 0);
      webhookDestinationActive.set(labels, d.is_active ? 1 : 0);
      webhookDestinationLastSuccessTimestampSeconds.set(
        labels,
        lastSuccess ? lastSuccess.getTime() / 1000 : 0,
      );
    }
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
