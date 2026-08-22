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
      voteCount,
      adjustmentCounts,
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
    ]);

    donorsTotal.set(donorCount);
    donatedCentsTotal.set(donationAgg._sum.amount_cents ?? 0);
    donationsTotal.set(donationCount);
    pledgesOpen.set(pledgeCount);
    eventsActive.set(activeEventCount);
    rewardClaimsTotal.set(claimCount);
    pollVotesTotal.set(voteCount);
    for (const { type, count } of adjustmentCounts) {
      balanceAdjustmentsTotal.set({ type }, count);
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
