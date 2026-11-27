import crypto from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  assertNoRequestedPaymentRefundTx,
  categoryBudgetRemainingCents,
  hasRequestedPaymentRefundTx,
  liveClaimWhere,
  liveCreditBackedClaimWhere,
  liveDirectClaimWhere,
  liveRowWhere,
  walletCreditGrantCents,
} from '../../services/poolAccounting.js';

const donors: string[] = [],
  events: string[] = [],
  rewards: string[] = [],
  polls: string[] = [];
async function fixture() {
  const event = await prisma.event.create({
    data: { name: 'Liveness', slug: crypto.randomUUID() },
  });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { name: crypto.randomUUID(), slug: crypto.randomUUID(), event_id: event.id },
  });
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@marker.example` },
  });
  donors.push(donor.id);
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: 1000,
      pledge_amount_cents: 1000,
      channel_id: channel.id,
      event_id: event.id,
    },
  });
  const reward = await prisma.reward.create({
    data: { event_id: event.id, title: 'Prize', type: 'DIGITAL', cost_cents: 500 },
  });
  rewards.push(reward.id);
  return { event, channel, donor, donation, reward };
}
afterEach(async () => {
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.poolCreditRedemption.deleteMany({
    where: { credit: { donation: { donor_id: { in: donors } } } },
  });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  donors.length = events.length = rewards.length = polls.length = 0;
});
it('counts a claim while it is not reversed and still counting', async () => {
  const f = await fixture();
  const claim = (data: { status?: string; reversed_at?: Date }, label: string) =>
    prisma.rewardClaim.create({
      data: {
        donor_id: f.donor.id,
        donation_id: f.donation.id,
        reward_id: f.reward.id,
        amount_cents: 500,
        status: data.status ?? 'PENDING',
        reversed_at: data.reversed_at ?? null,
        claim_data: JSON.stringify({ label }),
      },
    });
  const pending = await claim({}, 'pending');
  const fulfilled = await claim({ status: 'FULFILLED' }, 'fulfilled');
  const cancelling = await claim({ status: 'CANCELLING' }, 'cancelling');
  await claim({ status: 'REVERSED' }, 'status-reversed');
  await claim({ reversed_at: new Date() }, 'reversed-at-set');
  const live = await prisma.rewardClaim.findMany({
    where: { donation_id: f.donation.id, ...liveClaimWhere() },
  });
  expect(live.map((row) => row.id).sort()).toEqual(
    [pending.id, fulfilled.id, cancelling.id].sort(),
  );
});
it('separates direct claims from Pool-credit-backed claims by funding donation', async () => {
  const f = await fixture();
  const direct = await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      reward_id: f.reward.id,
      amount_cents: 500,
    },
  });
  const backed = await prisma.rewardClaim.create({
    data: { donor_id: f.donor.id, reward_id: f.reward.id, amount_cents: 500 },
  });
  const other = await prisma.donation.create({
    data: {
      donor_id: f.donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: 0,
      pledge_amount_cents: 500,
      channel_id: f.channel.id,
      event_id: f.event.id,
    },
  });
  const batch = await prisma.poolCreditBatch.create({
    data: {
      donor_id: f.donor.id,
      event_id: f.event.id,
      idempotency_key: crypto.randomUUID(),
      request_data: '{}',
    },
  });
  const sourceClaim = await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      reward_id: f.reward.id,
      amount_cents: 500,
      status: 'REVERSED',
      reversed_at: new Date(),
    },
  });
  const credit = await prisma.poolCredit.create({
    data: {
      donation_id: f.donation.id,
      category: 'reward',
      amount_cents: 500,
      remaining_cents: 0,
      created_by: 'staff@example.com',
      source_claim_id: sourceClaim.id,
    },
  });
  await prisma.poolCreditRedemption.create({
    data: { credit_id: credit.id, batch_id: batch.id, amount_cents: 500, claim_id: backed.id },
  });
  const onlyDirect = await prisma.rewardClaim.findMany({
    where: { donor_id: f.donor.id, ...liveDirectClaimWhere() },
  });
  expect(onlyDirect.map((row) => row.id)).toEqual([direct.id]);
  const fundedBySource = await prisma.rewardClaim.findMany({
    where: { donor_id: f.donor.id, ...liveCreditBackedClaimWhere(f.donation.id) },
  });
  expect(fundedBySource.map((row) => row.id)).toEqual([backed.id]);
  const fundedByOther = await prisma.rewardClaim.findMany({
    where: { donor_id: f.donor.id, ...liveCreditBackedClaimWhere(other.id) },
  });
  expect(fundedByOther).toEqual([]);
});
it('counts a vote while it is not reversed', async () => {
  const f = await fixture();
  const poll = await prisma.poll.create({
    data: {
      event_id: f.event.id,
      title: 'Choice',
      channel_id: f.channel.id,
      options: { create: { label: 'A' } },
    },
    include: { options: true },
  });
  polls.push(poll.id);
  const option = poll.options[0]!;
  const vote = await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: poll.id,
      poll_option_id: option.id,
      amount_cents: 1000,
    },
  });
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: poll.id,
      poll_option_id: option.id,
      amount_cents: 1000,
      reversed_at: new Date(),
    },
  });
  const live = await prisma.pollVote.findMany({
    where: { donation_id: f.donation.id, ...liveRowWhere() },
  });
  expect(live.map((row) => row.id)).toEqual([vote.id]);
});
it('computes the Wallet credit a reversal grants', () => {
  const pooled = {
    pledge_amount_cents: 1000,
    wallet_applied_cents: 400,
    wallet_credit_granted_cents: 100,
    amount_cents: 1000,
  };
  // Pooled REFUNDED: D minus retained rows minus prior Wallet grants.
  expect(
    walletCreditGrantCents(pooled, 'REFUNDED', { retained_cents: 300, reversed_cents: 700 }),
  ).toBe(600);
  // Pooled CHARGEBACK: original Wallet funding minus prior grants.
  expect(
    walletCreditGrantCents(pooled, 'CHARGEBACK', { retained_cents: 300, reversed_cents: 700 }),
  ).toBe(300);
  // Legacy: the reversed money itself.
  expect(
    walletCreditGrantCents({ ...pooled, pledge_amount_cents: null }, 'REFUNDED', {
      retained_cents: 0,
      reversed_cents: 700,
    }),
  ).toBe(700);
  // Legacy chargeback claws back what the bank took.
  expect(
    walletCreditGrantCents({ ...pooled, pledge_amount_cents: null }, 'CHARGEBACK', {
      retained_cents: 0,
      reversed_cents: 700,
    }),
  ).toBe(-300);
});
it('computes what a category can still take', () => {
  // D=1000 with 100 failed-payment credit, 300 live and 200 reserved leaves 400.
  expect(
    categoryBudgetRemainingCents({ live_cents: 300, outstanding_credit_cents: 200 }, 1000, 100),
  ).toBe(400);
  // Live 950 + reserved 100 exceeds D=1000 minus 50 failed-payment credit.
  expect(
    categoryBudgetRemainingCents({ live_cents: 950, outstanding_credit_cents: 100 }, 1000, 50),
  ).toBe(-100);
});
it('freezes a donation while a Payment refund is requested', async () => {
  const f = await fixture();
  const claim = await prisma.rewardClaim.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      reward_id: f.reward.id,
      amount_cents: 500,
    },
  });
  expect(await prisma.$transaction((tx) => hasRequestedPaymentRefundTx(tx, f.donation.id))).toBe(
    false,
  );
  await prisma.$transaction((tx) => assertNoRequestedPaymentRefundTx(tx, f.donation.id));
  await prisma.$transaction((tx) => assertNoRequestedPaymentRefundTx(tx, null));
  await prisma.paymentRefund.create({
    data: {
      donation_id: f.donation.id,
      claim_id: claim.id,
      item_cents: 500,
      created_by: 'staff@example.com',
    },
  });
  expect(await prisma.$transaction((tx) => hasRequestedPaymentRefundTx(tx, f.donation.id))).toBe(
    true,
  );
  await expect(
    prisma.$transaction((tx) => assertNoRequestedPaymentRefundTx(tx, f.donation.id)),
  ).rejects.toMatchObject({ status: 409 });
});
