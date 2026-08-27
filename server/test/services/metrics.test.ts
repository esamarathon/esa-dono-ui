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
  });

  it('starts and stops the refresh loop', () => {
    startMetricsRefresh(100_000); // long interval — does not actually tick in test
    startMetricsRefresh(100_000); // second call is a no-op (idempotent)
    stopMetricsRefresh();
    stopMetricsRefresh(); // second stop is a no-op
  });
});
