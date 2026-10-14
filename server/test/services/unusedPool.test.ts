import crypto from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { withWebhooks } from '../../services/webhooks/outbox.js';
import {
  assignUnusedTx,
  listUnusedTx,
  unusedTargetsTx,
  undoUnusedTx,
} from '../../services/unusedPool.js';

vi.mock('../../services/webhooks/dispatcher.js', () => ({ wakeDispatcher: vi.fn() }));
const donors: string[] = [],
  events: string[] = [],
  polls: string[] = [],
  goals: string[] = [],
  destinations: string[] = [];
async function fixture(cents = 37) {
  const event = await prisma.event.create({ data: { name: 'Unused', slug: crypto.randomUUID() } });
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
      amount_cents: cents,
      pledge_amount_cents: cents,
      channel_id: channel.id,
      event_id: event.id,
      comment: 'runner choice',
    },
  });
  const poll = await prisma.poll.create({
    data: { title: 'Choice', channel_id: channel.id, options: { create: { label: 'A' } } },
    include: { options: true },
  });
  polls.push(poll.id);
  const goal = await prisma.fundGoal.create({
    data: { title: 'Goal', target_cents: 10, channel_id: channel.id },
  });
  goals.push(goal.id);
  return { event, channel, donor, donation, poll, goal };
}
function assign(id: string, category: 'poll' | 'goal', target: string, cents: number) {
  return withWebhooks((tx, _emit, publisher) =>
    assignUnusedTx(tx, id, category, target, cents, 'staff@example.com', publisher),
  );
}
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_unused');
  await prisma.poolCredit.deleteMany({ where: { donation: { donor_id: { in: donors } } } });
  await prisma.pollVote.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.pollOption.deleteMany({ where: { poll_id: { in: polls } } });
  await prisma.poll.deleteMany({ where: { id: { in: polls } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.eventEndAudit.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinations } } });
  await prisma.webhookDestinationSeq.deleteMany({
    where: { destination_id: { in: destinations } },
  });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: destinations } } });
  donors.length = events.length = polls.length = goals.length = destinations.length = 0;
});
afterAll(() => prisma.$disconnect());

it.each([
  { status: 'COMPLETED', pledge: null },
  { status: 'REFUNDED', pledge: 37 },
  { status: 'CHARGEBACK', pledge: 37 },
  { status: 'PENDING', pledge: 37 },
])('legacy and $status non-live sources have no assignable Unused', async ({ status, pledge }) => {
  const f = await fixture();
  await prisma.donation.update({
    where: { id: f.donation.id },
    data: { status, pledge_amount_cents: pledge },
  });
  expect(
    (await prisma.$transaction((tx) => listUnusedTx(tx, {}))).some((d) => d.id === f.donation.id),
  ).toBe(false);
  await expect(assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37)).rejects.toMatchObject({
    status: 409,
  });
});
it('reserves live rows, raw credit and the failed Payment refund gap; defaults comments on', async () => {
  const f = await fixture(1000);
  const old = await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 200,
      reversed_at: new Date(),
    },
  });
  await prisma.poolCredit.create({
    data: {
      donation_id: f.donation.id,
      category: 'poll',
      amount_cents: 200,
      remaining_cents: 200,
      source_vote_id: old.id,
      created_by: 'admin',
    },
  });
  await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 300,
    },
  });
  await prisma.donation.update({
    where: { id: f.donation.id },
    data: { failed_payment_wallet_credit_cents: 100, comment: ' ' },
  });
  expect(
    (await prisma.$transaction((tx) => listUnusedTx(tx, {}))).some((d) => d.id === f.donation.id),
  ).toBe(false);
  const rows = await prisma.$transaction((tx) => listUnusedTx(tx, { comments_only: false }));
  expect(rows.find((d) => d.id === f.donation.id)?.unused_cents).toEqual({ poll: 400, goal: 900 });
  await assign(f.donation.id, 'poll', f.poll.options[0]!.id, 400);
});
it('allows old donations and shared targets but excludes pending, ended, inactive and other-Channel targets', async () => {
  const f = await fixture();
  const other = await fixture();
  await prisma.donation.update({
    where: { id: f.donation.id },
    data: { created_at: new Date('2000-01-01') },
  });
  await prisma.poll.update({ where: { id: f.poll.id }, data: { channel_id: null } });
  let picker = await prisma.$transaction((tx) => unusedTargetsTx(tx, f.donation.id, 'poll'));
  expect(picker.targets.map((t) => t.id)).toContain(f.poll.options[0]!.id);
  expect(picker.targets.map((t) => t.id)).not.toContain(other.poll.options[0]!.id);
  await assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37);
  for (const data of [{ is_active: false }, { is_active: true, ends_at: new Date('2000-01-01') }]) {
    await prisma.poll.update({ where: { id: f.poll.id }, data });
    picker = await prisma.$transaction((tx) => unusedTargetsTx(tx, f.donation.id, 'poll'));
    expect(picker.targets.map((t) => t.id)).not.toContain(f.poll.options[0]!.id);
  }
  await prisma.poll.update({ where: { id: f.poll.id }, data: { ends_at: null } });
  await prisma.pollOption.update({
    where: { id: f.poll.options[0]!.id },
    data: { status: 'PENDING_APPROVAL' },
  });
  expect(
    (await prisma.$transaction((tx) => unusedTargetsTx(tx, f.donation.id, 'poll'))).targets.map(
      (t) => t.id,
    ),
  ).not.toContain(f.poll.options[0]!.id);
});
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid expected cents %s',
  async (cents) => {
    const f = await fixture();
    await expect(assign(f.donation.id, 'poll', f.poll.options[0]!.id, cents)).rejects.toMatchObject(
      { status: 400 },
    );
  },
);
it('undoes an open goal assignment back to derived Unused without a grant', async () => {
  const f = await fixture();
  await prisma.fundGoal.update({ where: { id: f.goal.id }, data: { target_cents: 1000 } });
  const row = await assign(f.donation.id, 'goal', f.goal.id, 37);
  await withWebhooks((tx, _emit, publisher) =>
    undoUnusedTx(tx, 'goal', row.id, 'staff', publisher),
  );
  expect(
    (await prisma.$transaction((tx) => listUnusedTx(tx, {}))).find((d) => d.id === f.donation.id),
  ).toMatchObject({ unused_cents: { goal: 37 }, assignments: [] });
  expect(await prisma.poolCredit.count({ where: { donation_id: f.donation.id } })).toBe(0);
  expect(
    (await prisma.fundGoal.findUniqueOrThrow({ where: { id: f.goal.id } })).current_cents,
  ).toBe(0);
});

it('blocks unassigned sources and refuses Undo once a goal closes after overshoot', async () => {
  const f = await fixture();
  const row = await assign(f.donation.id, 'goal', f.goal.id, 37);
  await expect(
    withWebhooks((tx, _emit, publisher) => undoUnusedTx(tx, 'goal', row.id, 'staff', publisher)),
  ).rejects.toMatchObject({ status: 409 });
  await prisma.donation.update({ where: { id: f.donation.id }, data: { channel_id: null } });
  await expect(assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37)).rejects.toMatchObject({
    status: 409,
  });
});
it.each(['tally', 'outbox'])(
  'rolls back row, totals and outbox after a late %s failure, then publishes once per assignment/undo',
  async (failure) => {
    const f = await fixture();
    const destination = await prisma.webhookDestination.create({
      data: { url: 'http://127.0.0.1:1', secret: 's', event_types: '["donation.updated"]' },
    });
    destinations.push(destination.id);
    await prisma.$executeRawUnsafe(
      failure === 'tally'
        ? `CREATE TRIGGER fail_unused BEFORE UPDATE ON Poll WHEN NEW.id = '${f.poll.id}' BEGIN SELECT RAISE(ABORT, 'late tally failure'); END`
        : `CREATE TRIGGER fail_unused BEFORE INSERT ON WebhookDelivery WHEN NEW.destination_id = '${destination.id}' BEGIN SELECT RAISE(ABORT, 'late outbox failure'); END`,
    );
    await expect(assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37)).rejects.toThrow();
    expect(
      (await prisma.$transaction((tx) => listUnusedTx(tx, {}))).find((d) => d.id === f.donation.id),
    ).toMatchObject({ unused_cents: { poll: 37 }, assignments: [] });
    expect(
      (await prisma.poll.findUniqueOrThrow({ where: { id: f.poll.id } })).total_votes_cents,
    ).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { destination_id: destination.id } })).toBe(
      0,
    );
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_unused');
    const row = await assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER fail_unused BEFORE INSERT ON WebhookDelivery WHEN NEW.destination_id = '${destination.id}' BEGIN SELECT RAISE(ABORT, 'late undo outbox failure'); END`,
    );
    await expect(
      withWebhooks((tx, _emit, publisher) => undoUnusedTx(tx, 'poll', row.id, 'staff', publisher)),
    ).rejects.toThrow();
    expect(
      (await prisma.$transaction((tx) => listUnusedTx(tx, {}))).find((d) => d.id === f.donation.id),
    ).toMatchObject({ unused_cents: { poll: 0 }, assignments: [{ id: row.id }] });
    expect(
      (await prisma.poll.findUniqueOrThrow({ where: { id: f.poll.id } })).total_votes_cents,
    ).toBe(37);
    expect(await prisma.webhookDelivery.count({ where: { destination_id: destination.id } })).toBe(
      1,
    );
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_unused');
    await withWebhooks((tx, _emit, publisher) =>
      undoUnusedTx(tx, 'poll', row.id, 'staff', publisher),
    );
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { destination_id: destination.id },
      orderBy: { seq: 'asc' },
    });
    expect(deliveries.map((d) => d.message_type)).toEqual(['donation.updated', 'donation.updated']);
    expect(JSON.parse(deliveries[0]!.payload).data.allocations.poll).toHaveLength(1);
    expect(JSON.parse(deliveries[1]!.payload).data.allocations.poll).toEqual([]);
    expect(JSON.stringify(deliveries)).not.toContain(f.donor.email);
  },
);

it('assigns ALL positive sub-dollar unused, previews overshoot and undoes without donor credit', async () => {
  const f = await fixture();
  const targets = await prisma.$transaction((tx) => unusedTargetsTx(tx, f.donation.id, 'goal'));
  expect(targets).toMatchObject({
    amount_cents: 37,
    targets: [{ id: f.goal.id, before_cents: 0, after_cents: 37, target_cents: 10 }],
  });
  const row = await assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37);
  expect(row).toMatchObject({
    source: 'moderator',
    allocated_by: 'staff@example.com',
    allocated_at: expect.any(Date),
    amount_cents: 37,
  });
  expect(JSON.stringify(await prisma.$transaction((tx) => listUnusedTx(tx, {})))).not.toContain(
    f.donor.email,
  );
  await withWebhooks((tx, _emit, publisher) =>
    undoUnusedTx(tx, 'poll', row.id, 'staff', publisher),
  );
  const listed = await prisma.$transaction((tx) => listUnusedTx(tx, {}));
  expect(listed.find((d) => d.id === f.donation.id)).toMatchObject({
    unused_cents: { poll: 37, goal: 37 },
  });
  expect(await prisma.poolCredit.count({ where: { donation_id: f.donation.id } })).toBe(0);
  expect(
    (await prisma.donor.findUniqueOrThrow({ where: { id: f.donor.id } })).balance_remaining,
  ).toBe(0);
});

it('rejects stale/concurrent assignments without overspending and filters eligible scope', async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(assign(f.donation.id, 'poll', other.poll.options[0]!.id, 37)).rejects.toMatchObject({
    status: 409,
  });
  await expect(assign(f.donation.id, 'poll', f.poll.options[0]!.id, 36)).rejects.toMatchObject({
    status: 409,
  });
  const results = await Promise.allSettled([
    assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37),
    assign(f.donation.id, 'poll', f.poll.options[0]!.id, 37),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  expect(
    (await prisma.poll.findUniqueOrThrow({ where: { id: f.poll.id } })).total_votes_cents,
  ).toBe(37);
});

it('assigns converted credit after end exactly once even though raw grants survive', async () => {
  const f = await fixture(100);
  const prior = await prisma.pollVote.create({
    data: {
      donor_id: f.donor.id,
      donation_id: f.donation.id,
      poll_id: f.poll.id,
      poll_option_id: f.poll.options[0]!.id,
      amount_cents: 70,
      reversed_at: new Date(),
    },
  });
  await prisma.poolCredit.create({
    data: {
      donation_id: f.donation.id,
      category: 'poll',
      amount_cents: 70,
      remaining_cents: 70,
      source_vote_id: prior.id,
      created_by: 'admin',
    },
  });
  await prisma.event.update({ where: { id: f.event.id }, data: { ended_at: new Date() } });
  await assign(f.donation.id, 'poll', f.poll.options[0]!.id, 100);
  const listed = await prisma.$transaction((tx) => listUnusedTx(tx, { show_ended: true }));
  expect(listed.find((d) => d.id === f.donation.id)?.unused_cents.poll).toBe(0);
  await expect(assign(f.donation.id, 'poll', f.poll.options[0]!.id, 70)).rejects.toMatchObject({
    status: 409,
  });
});
