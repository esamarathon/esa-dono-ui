import crypto from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { previewEventEndTx, endEventTx, undoEventEndTx } from '../../services/eventEnd.js';
import { assertCanActivateEvent, updateEvent } from '../../services/events.js';
import { assignUnusedTx } from '../../services/unusedPool.js';
import { readDonationAccountingTx } from '../../services/poolAccounting.js';
import { reverseSpendTx } from '../../services/reversal.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
const events: string[] = [],
  donors: string[] = [],
  polls: string[] = [],
  rewards: string[] = [];
async function fixture({ pledge, pollCredit }: Readonly<{ pledge: number; pollCredit: number }>) {
  const event = await prisma.event.create({
    data: { name: 'End test', slug: crypto.randomUUID() },
  });
  events.push(event.id);
  const channel = await prisma.channel.create({
    data: { event_id: event.id, name: crypto.randomUUID(), slug: crypto.randomUUID() },
  });
  await prisma.event.update({ where: { id: event.id }, data: { primary_channel_id: channel.id } });
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@marker.example` },
  });
  donors.push(donor.id);
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: pledge,
      pledge_amount_cents: pledge,
      channel_id: channel.id,
      event_id: event.id,
      comment: 'choice',
    },
  });
  const poll = await prisma.poll.create({
    data: { title: 'Open', options: { create: { label: 'A' } } },
    include: { options: true },
  });
  polls.push(poll.id);
  const old = await prisma.pollVote.create({
    data: {
      donor_id: donor.id,
      donation_id: donation.id,
      poll_id: poll.id,
      poll_option_id: poll.options[0]!.id,
      amount_cents: pollCredit,
      reversed_at: new Date(),
    },
  });
  await prisma.poolCredit.create({
    data: {
      donation_id: donation.id,
      category: 'poll',
      amount_cents: pollCredit,
      remaining_cents: pollCredit,
      source_vote_id: old.id,
      created_by: 'admin',
    },
  });
  return { event, channel, donor, donation, poll };
}
const preview = (id: string, undo = false) =>
  prisma.$transaction((tx) => previewEventEndTx(tx, id, undo));
const end = (id: string, slug: string) =>
  prisma.$transaction((tx) => endEventTx(tx, id, slug, 'admin@example.com'));
const undo = (id: string, slug: string) =>
  prisma.$transaction((tx) => undoEventEndTx(tx, id, slug, 'undo@example.com'));
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_end_audit');
  await prisma.pendingPledge.deleteMany({ where: { channel: { event_id: { in: events } } } });
  await prisma.paymentRefund.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.poolCreditRedemption.deleteMany({ where: { batch: { donor_id: { in: donors } } } });
  await prisma.poolCreditBatch.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.reward.deleteMany({ where: { id: { in: rewards } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.event.updateMany({
    where: { id: { in: events } },
    data: { primary_channel_id: null },
  });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.eventEndAudit.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  events.length = donors.length = polls.length = rewards.length = 0;
});
afterAll(() => prisma.$disconnect());

it('previews confirmed physical types, CANCELLING claims, distinct donation count and OPEN pledges; REQUESTED blocks End', async () => {
  const f = await fixture({ pledge: 100, pollCredit: 60 });
  const reward = await prisma.reward.create({
    data: { title: 'Confirmed physical, now digital', cost_cents: 99999, type: 'DIGITAL' },
  });
  rewards.push(reward.id);
  const claim = await prisma.rewardClaim.create({
    data: {
      reward_id: reward.id,
      donation_id: f.donation.id,
      donor_id: f.donor.id,
      amount_cents: 25,
      status: 'CANCELLING',
    },
  });
  await prisma.rewardClaim.create({
    data: {
      reward_id: reward.id,
      donation_id: f.donation.id,
      donor_id: f.donor.id,
      amount_cents: 25,
      status: 'PENDING',
    },
  });
  await prisma.pendingPledge.create({
    data: {
      pledge_token: crypto.randomUUID(),
      format: 'POOLED',
      draft_id: crypto.randomUUID(),
      confirmed_plan: '{}',
      pledge_amount_cents: 100,
      new_money_cents: 100,
      channel_id: f.channel.id,
      fulfilled_by_donation_id: f.donation.id,
      status: 'FULFILLED',
      expires_at: new Date(),
      items: {
        create: {
          kind: 'REWARD',
          target_id: reward.id,
          amount_cents: 50,
          quantity: 2,
          confirmed_reward_type: 'PHYSICAL',
          unit_price_cents: 25,
        },
      },
    },
  });
  await prisma.pendingPledge.create({
    data: { pledge_token: crypto.randomUUID(), channel_id: f.channel.id, expires_at: new Date() },
  });
  expect(await preview(f.event.id)).toMatchObject({
    unshipped_physical_donations: 1,
    open_pledges: 1,
    can_apply: true,
  });
  await prisma.paymentRefund.create({
    data: { donation_id: f.donation.id, claim_id: claim.id, item_cents: 25, created_by: 'admin' },
  });
  expect(await preview(f.event.id)).toMatchObject({
    can_apply: false,
    requested_payment_refunds: 1,
  });
  await expect(end(f.event.id, f.event.slug)).rejects.toMatchObject({ status: 409 });
  await prisma.paymentRefund.updateMany({
    where: { donation_id: f.donation.id },
    data: { status: 'RESOLVED' },
  });
  await end(f.event.id, f.event.slug);
});
it('deactivation alone preserves credit, including reward credit; End and Undo expire/restore it without transfers', async () => {
  const f = await fixture({ pledge: 100, pollCredit: 60 });
  const reward = await prisma.reward.create({
    data: { title: 'Reward', cost_cents: 999, type: 'DIGITAL' },
  });
  rewards.push(reward.id);
  const claim = await prisma.rewardClaim.create({
    data: {
      reward_id: reward.id,
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      amount_cents: 80,
      status: 'REVERSED',
      reversed_at: new Date(),
    },
  });
  await prisma.poolCredit.create({
    data: {
      donation_id: f.donation.id,
      category: 'reward',
      amount_cents: 80,
      remaining_cents: 80,
      source_claim_id: claim.id,
      created_by: 'admin',
    },
  });
  await updateEvent(f.event.id, { is_active: true });
  await updateEvent(f.event.id, { is_active: false });
  expect(
    (await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id))).pools.reward
      .pool_credit_cents,
  ).toBe(80);
  expect(await preview(f.event.id)).toMatchObject({ pool_credit_cents: { reward: 80 } });
  await end(f.event.id, f.event.slug);
  expect(
    (await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id))).pools.reward,
  ).toMatchObject({
    pool_credit_cents: 0,
    outstanding_credit_cents: 80,
    used_cents: 80,
    unused_cents: 0,
  });
  await undo(f.event.id, f.event.slug);
  expect(
    (await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id))).pools.reward
      .pool_credit_cents,
  ).toBe(80);
  expect(await prisma.poolCredit.count({ where: { donation_id: f.donation.id } })).toBe(2);
});
it('does not classify a later credit-funded claim by the original physical pledge item', async () => {
  const f = await fixture({ pledge: 100, pollCredit: 60 });
  const reward = await prisma.reward.create({
    data: { title: 'Now digital', cost_cents: 100, type: 'DIGITAL' },
  });
  rewards.push(reward.id);
  const old = await prisma.rewardClaim.create({
    data: {
      reward_id: reward.id,
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      amount_cents: 100,
      status: 'REVERSED',
      reversed_at: new Date(),
    },
  });
  await prisma.pendingPledge.create({
    data: {
      pledge_token: crypto.randomUUID(),
      format: 'POOLED',
      draft_id: crypto.randomUUID(),
      confirmed_plan: '{}',
      pledge_amount_cents: 100,
      new_money_cents: 100,
      channel_id: f.channel.id,
      fulfilled_by_donation_id: f.donation.id,
      status: 'FULFILLED',
      expires_at: new Date(),
      items: {
        create: {
          kind: 'REWARD',
          target_id: reward.id,
          amount_cents: 100,
          confirmed_reward_type: 'PHYSICAL',
          unit_price_cents: 100,
        },
      },
    },
  });
  const credit = await prisma.poolCredit.create({
    data: {
      donation_id: f.donation.id,
      category: 'reward',
      amount_cents: 100,
      remaining_cents: 0,
      source_claim_id: old.id,
      created_by: 'admin',
    },
  });
  const replacement = await prisma.rewardClaim.create({
    data: {
      reward_id: reward.id,
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      amount_cents: 100,
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
  await prisma.poolCreditRedemption.create({
    data: { credit_id: credit.id, batch_id: batch.id, claim_id: replacement.id, amount_cents: 100 },
  });
  expect(await preview(f.event.id)).toMatchObject({ unshipped_physical_donations: 0 });
});

it('rolls back end state if audit persistence fails', async () => {
  const f = await fixture({ pledge: 100, pollCredit: 60 });
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER fail_end_audit BEFORE INSERT ON EventEndAudit WHEN NEW.event_id = '${f.event.id}' BEGIN SELECT RAISE(ABORT, 'late audit failure'); END`,
  );
  await expect(end(f.event.id, f.event.slug)).rejects.toThrow();
  expect(await preview(f.event.id)).toMatchObject({
    action: 'END',
    can_apply: true,
    pool_credit_cents: { poll: 60 },
  });
});

it('blocks Undo only while live post-end assignments consume converted credit, not original unused', async () => {
  const f = await fixture({ pledge: 100, pollCredit: 60 });
  // Spend only the original 40 cents before end; after end an assignment is
  // affordable without converted credit if the raw grant subsequently clears.
  await end(f.event.id, f.event.slug);
  const row = await withWebhooks((tx, _emit, publisher) =>
    assignUnusedTx(tx, f.donation.id, 'poll', f.poll.options[0]!.id, 100, 'moderator', publisher),
  );
  expect(await preview(f.event.id, true)).toMatchObject({
    can_apply: false,
    consuming_assignments: [
      { donation_id: f.donation.id, category: 'poll', assignment_ids: [row.id] },
    ],
  });
  await expect(undo(f.event.id, f.event.slug)).rejects.toMatchObject({ status: 409 });
  await withWebhooks((tx, _emit, publisher) =>
    reverseSpendTx(tx, f.donor.id, 'vote', row.id, 'admin', publisher),
  );
  expect(await preview(f.event.id, true)).toMatchObject({
    can_apply: true,
    consuming_assignments: [],
  });
  // A real post-end moderator row wholly funded by original Unused is not a
  // consuming row, even when the Event still has credit in this category.
  await prisma.pollVote.create({
    data: {
      donation_id: f.donation.id,
      donor_id: f.donor.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 40,
      source: 'moderator',
      allocated_by: 'moderator',
      allocated_at: new Date(),
    },
  });
  expect(await preview(f.event.id, true)).toMatchObject({
    can_apply: true,
    consuming_assignments: [],
  });
  await undo(f.event.id, f.event.slug);
});

it('explicit end derives conversion, guards reactivation and undo restores credit while inactive with repeated audit', async () => {
  const f = await fixture({ pledge: 100, pollCredit: 60 });
  await updateEvent(f.event.id, { is_active: true });
  await expect(end(f.event.id, f.event.slug)).rejects.toMatchObject({ status: 409 });
  await updateEvent(f.event.id, { is_active: false });
  expect((await preview(f.event.id)).pool_credit_cents).toEqual({ poll: 60, goal: 0, reward: 0 });
  await expect(end(f.event.id, 'wrong')).rejects.toMatchObject({ status: 400 });
  await end(f.event.id, f.event.slug);
  const state = await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id));
  expect(state.pools.poll).toMatchObject({
    pool_credit_cents: 0,
    unused_cents: 100,
    used_cents: 100,
  });
  await expect(updateEvent(f.event.id, { is_active: true })).rejects.toMatchObject({ status: 409 });
  await expect(assertCanActivateEvent(prisma, f.event.id)).rejects.toMatchObject({ status: 409 });
  expect(await preview(f.event.id, true)).toMatchObject({
    can_apply: true,
    pool_credit_cents: { poll: 60 },
  });
  await undo(f.event.id, f.event.slug);
  expect(await prisma.event.findUniqueOrThrow({ where: { id: f.event.id } })).toMatchObject({
    is_active: false,
    ended_at: null,
    end_undone_by: 'undo@example.com',
    end_undone_at: expect.any(Date),
  });
  expect(
    (await prisma.$transaction((tx) => readDonationAccountingTx(tx, f.donation.id))).pools.poll,
  ).toMatchObject({ pool_credit_cents: 60, unused_cents: 40 });
  await end(f.event.id, f.event.slug);
  await undo(f.event.id, f.event.slug);
  expect(
    (
      await prisma.eventEndAudit.findMany({
        where: { event_id: f.event.id },
        orderBy: { created_at: 'asc' },
      })
    ).map((row) => [row.action, row.created_by]),
  ).toEqual([
    ['END', 'admin@example.com'],
    ['UNDO_END', 'undo@example.com'],
    ['END', 'admin@example.com'],
    ['UNDO_END', 'undo@example.com'],
  ]);
});
