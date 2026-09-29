import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    donor: { count: vi.fn() },
    donation: { aggregate: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    pendingPledge: { count: vi.fn() },
    channel: { count: vi.fn(), findMany: vi.fn() },
    rewardClaim: { count: vi.fn(), groupBy: vi.fn() },
    reward: { findMany: vi.fn() },
    pollVote: { count: vi.fn(), groupBy: vi.fn() },
    poll: { findMany: vi.fn() },
    event: { findMany: vi.fn(), count: vi.fn() },
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
    // Total count differs from the unassigned count on purpose, so a bug that
    // wires one query into the other's gauge is caught.
    vi.mocked(prisma.donation.count).mockImplementation(((args: {
      where?: { channel_id?: string | null };
    }) => Promise.resolve(args?.where?.channel_id === null ? 2 : 7)) as any);
    vi.mocked(prisma.donation.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.pendingPledge.count).mockResolvedValue(2);
    vi.mocked(prisma.channel.count).mockResolvedValue(3);
    vi.mocked(prisma.event.count).mockResolvedValue(1);
    vi.mocked(prisma.rewardClaim.count).mockResolvedValue(4);
    vi.mocked(prisma.rewardClaim.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.reward.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.pollVote.count).mockResolvedValue(9);
    vi.mocked(prisma.pollVote.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.poll.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.event.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.channel.findMany).mockResolvedValue([] as any);
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
    expect(metrics).toContain('dono_channels_active 3');
    expect(metrics).toContain('dono_reward_claims_total 4');
    expect(metrics).toContain('dono_poll_votes_total 9');
    // Unassigned donations (channel_id and event_id both null) — distinct from the
    // unlabelled dono_donations_total above.
    expect(metrics).toContain('dono_donations_unassigned 2');
  });

  it('sets per-Event/Channel breakdown gauges with slug labels', async () => {
    // Two groupBy calls: counts over every donation, cents over COMPLETED only
    // (PRD-0002 §E7). ch1 has 3 donations, one of them refunded (900 cents).
    vi.mocked(prisma.donation.groupBy).mockImplementation((async (args: any) =>
      args.where?.status === 'COMPLETED'
        ? [
            { event_id: 'ev1', channel_id: 'ch1', _sum: { amount_cents: 5000 } },
            { event_id: 'gone', channel_id: null, _sum: { amount_cents: 700 } },
            { event_id: null, channel_id: null, _sum: { amount_cents: 100 } },
          ]
        : [
            // Assigned to a known channel+event.
            { event_id: 'ev1', channel_id: 'ch1', _count: { _all: 3 } },
            // Explicit event but no channel, and event unknown to the lookup.
            { event_id: 'gone', channel_id: null, _count: { _all: 1 } },
            // Unassigned: both null.
            { event_id: null, channel_id: null, _count: { _all: 1 } },
          ]) as any);
    vi.mocked(prisma.reward.findMany).mockResolvedValue([
      { id: 'r1', channel_id: 'ch1' },
      { id: 'r2', channel_id: null },
    ] as any);
    vi.mocked(prisma.rewardClaim.groupBy).mockResolvedValue([
      { reward_id: 'r1', _count: { _all: 4 } },
      { reward_id: 'r2', _count: { _all: 2 } },
    ] as any);
    vi.mocked(prisma.poll.findMany).mockResolvedValue([
      { id: 'p1', channel_id: 'ch1' },
      { id: 'p2', channel_id: 'missing-channel' },
    ] as any);
    vi.mocked(prisma.pollVote.groupBy).mockResolvedValue([
      { poll_id: 'p1', _count: { _all: 6 } },
      { poll_id: 'p2', _count: { _all: 1 } },
    ] as any);
    vi.mocked(prisma.event.findMany).mockResolvedValue([{ id: 'ev1', slug: 'event-one' }] as any);
    vi.mocked(prisma.channel.findMany).mockResolvedValue([
      { id: 'ch1', slug: 'channel-one', event_id: 'ev1' },
    ] as any);

    await refreshBusinessMetrics();

    const metrics = await register.getMetricsAsJSON();
    const value = (name: string, labels: Record<string, string>) => {
      const gauge = metrics.find((m) => m.name === name);
      const sample = gauge?.values.find((v) => {
        const l = v.labels as Record<string, string>;
        return Object.entries(labels).every(([k, val]) => l[k] === val);
      });
      return sample?.value as number | undefined;
    };

    // COMPLETED cents only (the refunded 900 is excluded), but all 3 donations counted.
    expect(
      value('dono_donated_cents_by_channel', { event: 'event-one', channel: 'channel-one' }),
    ).toBe(5000);
    expect(prisma.donation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'COMPLETED' } }),
    );
    expect(prisma.donation.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'COMPLETED' } }),
    );
    expect(value('dono_donations_by_channel', { event: 'event-one', channel: 'channel-one' })).toBe(
      3,
    );
    // Unknown/absent ids collapse to empty labels rather than a fabricated slug;
    // the unknown-Event row and the fully-unassigned row share that label pair,
    // so their amounts are summed (700 + 100).
    expect(value('dono_donated_cents_by_channel', { event: '', channel: '' })).toBe(800);
    expect(value('dono_donations_by_channel', { event: '', channel: '' })).toBe(2);
    expect(value('dono_donations_unassigned', {})).toBe(2);
    // Claims: r1 belongs to ch1 -> event-one/channel-one; r2 is shared -> ""/"".
    expect(
      value('dono_reward_claims_by_channel', { event: 'event-one', channel: 'channel-one' }),
    ).toBe(4);
    expect(value('dono_reward_claims_by_channel', { event: '', channel: '' })).toBe(2);
    // Votes: p1 on ch1; p2 names a channel that no longer exists -> ""/"".
    expect(
      value('dono_poll_votes_by_channel', { event: 'event-one', channel: 'channel-one' }),
    ).toBe(6);
    expect(value('dono_poll_votes_by_channel', { event: '', channel: '' })).toBe(1);

    // The unlabelled globals must not have gained labels (they would double-count
    // the breakdowns under PromQL sum()).
    for (const name of ['dono_donated_cents_total', 'dono_donations_total']) {
      const gauge = metrics.find((m) => m.name === name);
      expect(gauge?.values).toHaveLength(1);
      expect(Object.keys((gauge?.values[0]?.labels ?? {}) as object)).toHaveLength(0);
    }
  });

  it('drops a labelled series when its channel disappears between refreshes', async () => {
    vi.mocked(prisma.donation.groupBy).mockResolvedValueOnce([
      { event_id: 'ev1', channel_id: 'ch1', _sum: { amount_cents: 5000 }, _count: { _all: 1 } },
    ] as any);
    vi.mocked(prisma.event.findMany).mockResolvedValueOnce([
      { id: 'ev1', slug: 'event-one' },
    ] as any);
    vi.mocked(prisma.channel.findMany).mockResolvedValueOnce([
      { id: 'ch1', slug: 'channel-one', event_id: 'ev1' },
    ] as any);
    await refreshBusinessMetrics();

    vi.mocked(prisma.donation.groupBy).mockResolvedValueOnce([]);
    vi.mocked(prisma.event.findMany).mockResolvedValueOnce([
      { id: 'ev1', slug: 'event-one' },
    ] as any);
    vi.mocked(prisma.channel.findMany).mockResolvedValueOnce([] as any);
    await refreshBusinessMetrics();

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'dono_donated_cents_by_channel');
    const stale = gauge?.values.find(
      (v) => (v.labels as Record<string, string>).channel === 'channel-one',
    );
    expect(stale).toBeUndefined();
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
      { id: 'd1', destination_type: 'HTTP', is_active: true },
      { id: 'd2', destination_type: 'RABBITMQ', is_active: false },
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
    expect(value('dono_webhook_destination_active', 'd1')).toBe(1);
    expect(value('dono_webhook_destination_active', 'd2')).toBe(0);
  });

  it('drops series for a destination that disappears between refreshes', async () => {
    vi.mocked(prisma.webhookDestination.findMany).mockResolvedValueOnce([
      { id: 'd1', destination_type: 'HTTP', is_active: true },
      { id: 'd2', destination_type: 'RABBITMQ', is_active: false },
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
      { id: 'd1', destination_type: 'HTTP', is_active: true },
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
    vi.mocked(prisma.donation.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.pendingPledge.count).mockResolvedValue(0);
    vi.mocked(prisma.channel.count).mockResolvedValue(0);
    vi.mocked(prisma.event.count).mockResolvedValue(0);
    vi.mocked(prisma.rewardClaim.count).mockResolvedValue(0);
    vi.mocked(prisma.rewardClaim.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.reward.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.pollVote.count).mockResolvedValue(0);
    vi.mocked(prisma.pollVote.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.poll.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.event.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.channel.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.balanceAdjustment.count).mockResolvedValue(0);
    vi.mocked(prisma.auction.count).mockResolvedValue(0);
    vi.mocked(prisma.bid.count).mockResolvedValue(0);
    vi.mocked(prisma.auctionWin.count).mockResolvedValue(0);
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
