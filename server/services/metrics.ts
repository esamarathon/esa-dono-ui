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
  help: "Reward claims, by the slug of the reward's Event and Channel",
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
  help: 'Number of active Channels (streams)',
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
      activeChannelCount,
      claimCount,
      pollVoteCount,
      adjustmentCounts,
      openAuctions,
      awaitingPaymentAuctions,
      activeBids,
      settledWins,
      unsoldAuctions,
      webhookDestinations,
      webhookDeliveryGroups,
      unassignedDonationCount,
      donationByChannel,
      claimGroups,
      rewards,
      voteGroups,
      polls,
      eventRows,
      channelRows,
    ] = await Promise.all([
      prisma.donor.count(),
      prisma.donation.aggregate({ _sum: { amount_cents: true } }),
      prisma.donation.count(),
      prisma.pendingPledge.count({ where: { status: 'OPEN' } }),
      prisma.event.count({ where: { is_active: true } }),
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
      prisma.webhookDestination.findMany({
        select: { id: true, destination_type: true, is_active: true },
      }),
      prisma.webhookDelivery.groupBy({
        by: ['destination_id', 'status'],
        _count: { _all: true },
        _min: { created_at: true },
        _max: { updated_at: true },
      }),
      prisma.donation.count({ where: { channel_id: null, event_id: null } }),
      prisma.donation.groupBy({
        by: ['event_id', 'channel_id'],
        _sum: { amount_cents: true },
        _count: { _all: true },
      }),
      prisma.rewardClaim.groupBy({ by: ['reward_id'], _count: { _all: true } }),
      prisma.reward.findMany({ select: { id: true, channel_id: true } }),
      prisma.pollVote.groupBy({
        by: ['poll_id'],
        where: { reversed_at: null },
        _count: { _all: true },
      }),
      prisma.poll.findMany({ select: { id: true, channel_id: true } }),
      prisma.event.findMany({ select: { id: true, slug: true } }),
      prisma.channel.findMany({ select: { id: true, slug: true, event_id: true } }),
    ]);

    donorsTotal.set(donorCount);
    donatedCentsTotal.set(donationAgg._sum.amount_cents ?? 0);
    donationsTotal.set(donationCount);
    pledgesOpen.set(pledgeCount);
    eventsActive.set(activeEventCount);
    channelsActive.set(activeChannelCount);
    rewardClaimsTotal.set(claimCount);
    pollVotesTotal.set(pollVoteCount);
    donationsUnassigned.set(unassignedDonationCount);

    // Slug lookups for the labelled breakdowns: one query each, then resolve in
    // memory. Unknown or null ids fall back to '' so a stale reference never
    // creates a bogus slug series.
    const eventSlug = new Map(eventRows.map((e) => [e.id, e.slug]));
    const channelSlug = new Map(channelRows.map((c) => [c.id, c.slug]));
    const channelEvent = new Map(channelRows.map((c) => [c.id, c.event_id]));
    const labelsFor = (eventId: string | null, channelId: string | null) => ({
      event: (eventId && eventSlug.get(eventId)) || '',
      channel: (channelId && channelSlug.get(channelId)) || '',
    });

    donatedCentsByChannel.reset();
    donationsByChannel.reset();
    // Several rows can resolve to the same label pair (an unknown Event id and a
    // null one both give ''), so accumulate per pair instead of letting the last
    // .set() win.
    const donationTotals = new Map<
      string,
      { event: string; channel: string; cents: number; count: number }
    >();
    for (const g of donationByChannel) {
      const labels = labelsFor(g.event_id, g.channel_id);
      const key = `${labels.event}\u0000${labels.channel}`;
      const entry = donationTotals.get(key) ?? { ...labels, cents: 0, count: 0 };
      entry.cents += g._sum.amount_cents ?? 0;
      entry.count += g._count._all;
      donationTotals.set(key, entry);
    }
    for (const { event, channel, cents, count } of donationTotals.values()) {
      donatedCentsByChannel.set({ event, channel }, cents);
      donationsByChannel.set({ event, channel }, count);
    }

    const labelKey = (labels: { event: string; channel: string }) =>
      `${labels.event}\u0000${labels.channel}`;

    // Claims and votes are grouped by their incentive's Channel, then rolled up
    // per slug pair — several incentives may share one Channel.
    const rewardChannel = new Map(rewards.map((r) => [r.id, r.channel_id]));
    const claimTotals = new Map<string, { event: string; channel: string; count: number }>();
    for (const g of claimGroups) {
      const channelId = rewardChannel.get(g.reward_id) ?? null;
      const labels = labelsFor(channelId ? (channelEvent.get(channelId) ?? null) : null, channelId);
      const key = labelKey(labels);
      const entry = claimTotals.get(key) ?? { ...labels, count: 0 };
      entry.count += g._count._all;
      claimTotals.set(key, entry);
    }
    rewardClaimsByChannel.reset();
    for (const { event, channel, count } of claimTotals.values()) {
      rewardClaimsByChannel.set({ event, channel }, count);
    }

    const pollChannel = new Map(polls.map((p) => [p.id, p.channel_id]));
    const voteTotals = new Map<string, { event: string; channel: string; count: number }>();
    for (const g of voteGroups) {
      const channelId = pollChannel.get(g.poll_id) ?? null;
      const labels = labelsFor(channelId ? (channelEvent.get(channelId) ?? null) : null, channelId);
      const key = labelKey(labels);
      const entry = voteTotals.get(key) ?? { ...labels, count: 0 };
      entry.count += g._count._all;
      voteTotals.set(key, entry);
    }
    pollVotesByChannel.reset();
    for (const { event, channel, count } of voteTotals.values()) {
      pollVotesByChannel.set({ event, channel }, count);
    }
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
