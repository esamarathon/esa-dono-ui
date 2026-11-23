import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import {
  COUNTED_DONATION_STATUSES,
  channelTotalCents,
  countsTowardTotals,
  eventTotalCents,
} from '../../lib/donationTotals.js';
import { createTestChannel, DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

beforeAll(async () => {
  await ensureDefaultEvent(prisma);
});
afterAll(() => prisma.$disconnect());

/**
 * The money-counting rule (AGENTS.md invariant): totals count COMPLETED and
 * REFUNDED donations through lib/donationTotals.ts; PENDING and CHARGEBACK do
 * not count. REFUNDED counts because a Wallet refund keeps the money. This
 * used to be asserted only through the retired `GET /api/campaign` route
 * (#148) — the rule itself is unchanged and still feeds the overlay totals.
 */
describe('lib/donationTotals counting rule', () => {
  const donorIds: string[] = [];
  const channelIds: string[] = [];
  afterAll(async () => {
    await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
    donorIds.length = 0;
    channelIds.length = 0;
  });

  it('counts COMPLETED and REFUNDED (wallet refunds), not CHARGEBACK or PENDING', async () => {
    expect(COUNTED_DONATION_STATUSES).toEqual(['COMPLETED', 'REFUNDED']);
    expect(countsTowardTotals('COMPLETED')).toBe(true);
    expect(countsTowardTotals('REFUNDED')).toBe(true);
    expect(countsTowardTotals('PENDING')).toBe(false);
    expect(countsTowardTotals('CHARGEBACK')).toBe(false);
    expect(countsTowardTotals('FAILED')).toBe(false);

    const channel = await createTestChannel(prisma);
    channelIds.push(channel.id);
    const donor = await prisma.donor.create({
      data: { email: `donation-totals-${crypto.randomUUID()}@example.com` },
    });
    donorIds.push(donor.id);

    for (const [status, cents] of [
      ['COMPLETED', 1000],
      ['REFUNDED', 2000],
      ['CHARGEBACK', 3000],
      ['PENDING', 4000],
    ] as const) {
      await prisma.donation.create({
        data: {
          external_id: `totals-${crypto.randomUUID()}`,
          donor_id: donor.id,
          channel_id: channel.id,
          event_id: DEFAULT_EVENT_ID,
          amount_cents: cents,
          status,
        },
      });
    }

    // COMPLETED 1000 + REFUNDED 2000: a Wallet refund keeps the money, so the
    // charity still raised it. Chargebacks and pending payments do not count.
    expect(await channelTotalCents(prisma, channel.id)).toBe(3000);
    expect(await eventTotalCents(prisma, DEFAULT_EVENT_ID)).toBeGreaterThanOrEqual(3000);
  });
});
