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
