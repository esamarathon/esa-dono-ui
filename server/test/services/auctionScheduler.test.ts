import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    auction: { findMany: vi.fn() },
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({})),
  },
}));

vi.mock('../../services/auction.js', () => ({
  closeAuctionTx: vi.fn(),
}));

import prisma from '../../lib/prisma.js';
import { closeAuctionTx } from '../../services/auction.js';
import {
  runAuctionCloseSweep,
  startAuctionScheduler,
  stopAuctionScheduler,
} from '../../services/auctionScheduler.js';

describe('auction scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopAuctionScheduler();
  });

  afterEach(() => {
    stopAuctionScheduler();
  });

  describe('runAuctionCloseSweep', () => {
    it('closes each due auction in its own transaction', async () => {
      vi.mocked(prisma.auction.findMany).mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as any);
      vi.mocked(closeAuctionTx).mockResolvedValue({ status: 'UNSOLD' } as any);

      await runAuctionCloseSweep();

      expect(prisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'OPEN', is_active: true }),
        }),
      );
      expect(closeAuctionTx).toHaveBeenCalledTimes(2);
      expect(closeAuctionTx).toHaveBeenCalledWith({}, 'a1');
      expect(closeAuctionTx).toHaveBeenCalledWith({}, 'a2');
    });

    it('does nothing when no auctions are due', async () => {
      vi.mocked(prisma.auction.findMany).mockResolvedValue([] as any);

      await runAuctionCloseSweep();

      expect(closeAuctionTx).not.toHaveBeenCalled();
    });

    it('logs and continues when closing one auction fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(prisma.auction.findMany).mockResolvedValue([{ id: 'a1' }, { id: 'a2' }] as any);
      vi.mocked(closeAuctionTx)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ status: 'UNSOLD' } as any);

      await expect(runAuctionCloseSweep()).resolves.toBeUndefined();

      expect(closeAuctionTx).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to close auction a1'),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('startAuctionScheduler / stopAuctionScheduler', () => {
    it('runs an immediate sweep and is idempotent when started twice', () => {
      vi.mocked(prisma.auction.findMany).mockResolvedValue([] as any);

      startAuctionScheduler(100_000); // long interval — does not actually tick in test
      startAuctionScheduler(100_000); // second call is a no-op (idempotent)

      expect(prisma.auction.findMany).toHaveBeenCalledTimes(1);

      stopAuctionScheduler();
      stopAuctionScheduler(); // second stop is a no-op
    });

    it('ticks on the configured interval and skips overlapping sweeps', async () => {
      vi.useFakeTimers();
      let resolveSweep: (() => void) | undefined;
      vi.mocked(prisma.auction.findMany).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSweep = () => resolve([]);
          }) as any,
      );

      startAuctionScheduler(1000);
      expect(prisma.auction.findMany).toHaveBeenCalledTimes(1);

      // A tick while the first sweep is still in flight must be skipped.
      await vi.advanceTimersByTimeAsync(1000);
      expect(prisma.auction.findMany).toHaveBeenCalledTimes(1);

      resolveSweep?.();
      await vi.runOnlyPendingTimersAsync();

      stopAuctionScheduler();
      vi.useRealTimers();
    });
  });
});
