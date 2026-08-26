import prisma from '../lib/prisma.js';
import { closeAuctionTx } from './auction.js';
import { AUCTION_CLOSE_INTERVAL_MS } from '../config.js';

/**
 * Background job that closes OPEN auctions whose ends_at has passed.
 * Mirrors the cached-refresh pattern in services/metrics.ts, but instead of
 * refreshing a read cache it performs a real state transition — so each
 * auction is closed inside its own transaction and a failure on one auction
 * doesn't block the others in the same tick.
 */
export async function runAuctionCloseSweep(): Promise<void> {
  const dueAuctions = await prisma.auction.findMany({
    where: { status: 'OPEN', is_active: true, ends_at: { lte: new Date() } },
    select: { id: true },
  });

  for (const { id } of dueAuctions) {
    try {
      await prisma.$transaction((tx) => closeAuctionTx(tx, id));
    } catch (err) {
      console.error(`Failed to close auction ${id}:`, err);
    }
  }
}

let schedulerTimer: NodeJS.Timeout | undefined;
let sweeping = false;

/** Starts the background auction-closing loop (idempotent). Call once at startup. */
export function startAuctionScheduler(intervalMs: number = AUCTION_CLOSE_INTERVAL_MS): void {
  if (schedulerTimer) return;
  const tick = () => {
    if (sweeping) return; // guard against overlapping runs if a sweep is slow
    sweeping = true;
    void runAuctionCloseSweep().finally(() => {
      sweeping = false;
    });
  };
  tick();
  schedulerTimer = setInterval(tick, intervalMs);
  schedulerTimer.unref?.();
}

/** Stops the background auction-closing loop. Used by tests to avoid leaking timers. */
export function stopAuctionScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
  }
}
