import type { Prisma } from '@prisma/client';

/**
 * Donation statuses that count toward money totals (campaign total, admin stats,
 * `dono_donated_cents_*`). PRD-0002 §E7, as decided for #115:
 *
 * - COMPLETED counts.
 * - REFUNDED counts: ESA never refunds to the original payment method, only to
 *   the donor's wallet, so the charity still has the money.
 * - CHARGEBACK does not count: the bank took the money back.
 * - PENDING does not count: not paid yet.
 *
 * Hidden donations count; hiding is a display decision.
 */
export const COUNTED_DONATION_STATUSES = ['COMPLETED', 'REFUNDED'];

/** Prisma `where` fragment selecting donations that count toward totals. */
export const countedDonation = { status: { in: COUNTED_DONATION_STATUSES } };

/** Whether a donation with this status counts toward money totals. */
export function countsTowardTotals(status: string): boolean {
  return COUNTED_DONATION_STATUSES.includes(status);
}

/** Money raised on a Channel (the rule above). */
export async function channelTotalCents(
  tx: Prisma.TransactionClient,
  channelId: string,
): Promise<number> {
  const sum = await tx.donation.aggregate({
    where: { channel_id: channelId, ...countedDonation },
    _sum: { amount_cents: true },
  });
  return sum._sum.amount_cents ?? 0;
}

/** Money raised on an Event: its assigned donations (an unassigned one has no Event). */
export async function eventTotalCents(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<number> {
  const sum = await tx.donation.aggregate({
    where: { event_id: eventId, ...countedDonation },
    _sum: { amount_cents: true },
  });
  return sum._sum.amount_cents ?? 0;
}
