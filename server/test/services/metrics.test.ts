import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    donor: { count: vi.fn() },
    donation: { aggregate: vi.fn(), count: vi.fn() },
    pendingPledge: { count: vi.fn() },
    channel: { count: vi.fn() },
    rewardClaim: { count: vi.fn() },
    pollVote: { count: vi.fn() },
    balanceAdjustment: { count: vi.fn() },
    auction: { count: vi.fn() },
    bid: { count: vi.fn() },
    auctionWin: { count: vi.fn() },
    webhookDestination: { findMany: vi.fn() },
    webhookDelivery: { groupBy: vi.fn() },
  },
}));

import prisma from '../../lib/prisma.js';
import { register } from '../../lib/metrics.js';
import {
  refreshBusinessMetrics,
  stopMetricsRefresh,
  startMetricsRefresh,
} from '../../services/metrics.js';

describe('refreshBusinessMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    register.resetMetrics();
    stopMetricsRefresh();
    vi.mocked(prisma.donor.count).mockResolvedValue(3);
    vi.mocked(prisma.donation.aggregate).mockResolvedValue({
      _sum: { amount_cents: 12345 },
    } as any);
    vi.mocked(prisma.donation.count).mockResolvedValue(7);
    vi.mocked(prisma.pendingPledge.count).mockResolvedValue(2);
    vi.mocked(prisma.channel.count).mockResolvedValue(1);
    vi.mocked(prisma.rewardClaim.count).mockResolvedValue(4);
    vi.mocked(prisma.pollVote.count).mockResolvedValue(9);
    vi.mocked(prisma.balanceAdjustment.count).mockResolvedValue(0);
    vi.mocked(prisma.auction.count).mockResolvedValue(0);
    vi.mocked(prisma.bid.count).mockResolvedValue(0);
    vi.mocked(prisma.auctionWin.count).mockResolvedValue(0);
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([]);
    vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValue([]);
  });

  it('populates gauges from aggregate DB queries', async () => {
    await refreshBusinessMetrics();

    const metrics = await register.metrics();
    expect(metrics).toContain('dono_donors_total 3');
    expect(metrics).toContain('dono_donated_cents_total 12345');
    expect(metrics).toContain('dono_donations_total 7');
    expect(metrics).toContain('dono_pledges_open 2');
    expect(metrics).toContain('dono_events_active 1');
    expect(metrics).toContain('dono_reward_claims_total 4');
    expect(metrics).toContain('dono_poll_votes_total 9');
  });

  it('a scrape after refresh does not touch the database (cache served)', async () => {
    await refreshBusinessMetrics();
    vi.clearAllMocks();

    await register.metrics();

    expect(prisma.donor.count).not.toHaveBeenCalled();
    expect(prisma.donation.aggregate).not.toHaveBeenCalled();
  });

  it('increments the error counter and does not throw when a query fails', async () => {
    vi.mocked(prisma.donor.count).mockRejectedValue(new Error('db down'));

    await expect(refreshBusinessMetrics()).resolves.toBeUndefined();

    const metrics = await register.metrics();
    expect(metrics).toContain('dono_metrics_refresh_errors_total 1');
  });

  it('sets per-destination webhook queue gauges', async () => {
    const now = Date.now();
    const pendingCreatedAt = new Date(now - 120_000);
    const lastSuccessAt = new Date('2026-01-01T00:00:00.000Z');
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([
      { id: 'd1', destination_type: 'HTTP' },
      { id: 'd2', destination_type: 'RABBITMQ' },
    ] as any);
    vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValue([
      {
        destination_id: 'd1',
        status: 'PENDING',
        _count: { _all: 3 },
        _min: { created_at: pendingCreatedAt },
        _max: { updated_at: pendingCreatedAt },
      },
      {
        destination_id: 'd1',
        status: 'FAILED',
        _count: { _all: 1 },
        _min: { created_at: pendingCreatedAt },
        _max: { updated_at: lastSuccessAt },
      },
      {
        destination_id: 'd1',
        status: 'SUCCESS',
        _count: { _all: 5 },
        _min: { created_at: lastSuccessAt },
        _max: { updated_at: lastSuccessAt },
      },
    ] as any);

    await refreshBusinessMetrics();

    const metrics = await register.getMetricsAsJSON();
    const value = (name: string, destination_id: string) => {
      const gauge = metrics.find((m) => m.name === name);
      const sample = gauge?.values.find(
        (v) => (v.labels as Record<string, unknown>).destination_id === destination_id,
      );
      return sample?.value as number | undefined;
    };

    expect(value('dono_webhook_queue_depth', 'd1')).toBe(3);
    const oldestAge = value('dono_webhook_queue_oldest_pending_age_seconds', 'd1')!;
    expect(oldestAge).toBeGreaterThanOrEqual(115);
    expect(oldestAge).toBeLessThanOrEqual(125);
    expect(value('dono_webhook_queue_failed', 'd1')).toBe(1);
    expect(value('dono_webhook_destination_last_success_timestamp_seconds', 'd1')).toBe(
      lastSuccessAt.getTime() / 1000,
    );

    expect(value('dono_webhook_queue_depth', 'd2')).toBe(0);
    expect(value('dono_webhook_queue_oldest_pending_age_seconds', 'd2')).toBe(0);
    expect(value('dono_webhook_queue_failed', 'd2')).toBe(0);
    expect(value('dono_webhook_destination_last_success_timestamp_seconds', 'd2')).toBe(0);
  });

  it('drops series for a destination that disappears between refreshes', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValueOnce([
      { id: 'd1', destination_type: 'HTTP' },
      { id: 'd2', destination_type: 'RABBITMQ' },
    ] as any);
    vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValueOnce([
      {
        destination_id: 'd2',
        status: 'PENDING',
        _count: { _all: 4 },
        _min: { created_at: new Date() },
        _max: { updated_at: new Date() },
      },
    ] as any);
    await refreshBusinessMetrics();

    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValueOnce([
      { id: 'd1', destination_type: 'HTTP' },
    ] as any);
    vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValueOnce([]);
    await refreshBusinessMetrics();

    const metrics = await register.getMetricsAsJSON();
    const depth = metrics.find((m) => m.name === 'dono_webhook_queue_depth');
    const d2Sample = depth?.values.find(
      (v) => (v.labels as Record<string, unknown>).destination_id === 'd2',
    );
    expect(d2Sample).toBeUndefined();
    const d1Sample = depth?.values.find(
      (v) => (v.labels as Record<string, unknown>).destination_id === 'd1',
    );
    expect(d1Sample?.value).toBe(0);
  });
});

describe('startMetricsRefresh / stopMetricsRefresh', () => {
  beforeEach(() => {
    stopMetricsRefresh();
    vi.mocked(prisma.donor.count).mockResolvedValue(0);
    vi.mocked(prisma.donation.aggregate).mockResolvedValue({ _sum: { amount_cents: 0 } } as any);
    vi.mocked(prisma.donation.count).mockResolvedValue(0);
    vi.mocked(prisma.pendingPledge.count).mockResolvedValue(0);
    vi.mocked(prisma.channel.count).mockResolvedValue(0);
    vi.mocked(prisma.rewardClaim.count).mockResolvedValue(0);
    vi.mocked(prisma.pollVote.count).mockResolvedValue(0);
    vi.mocked(prisma.balanceAdjustment.count).mockResolvedValue(0);
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValue([]);
    vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValue([]);
  });

  it('starts and stops the refresh loop', () => {
    startMetricsRefresh(100_000); // long interval — does not actually tick in test
    startMetricsRefresh(100_000); // second call is a no-op (idempotent)
    stopMetricsRefresh();
    stopMetricsRefresh(); // second stop is a no-op
  });
});
