import crypto from 'node:crypto';
import { afterAll, afterEach, expect, it } from 'vitest';
import prisma from '../../lib/prisma.js';
import { contributeGoalSplitTx, contributeGoalTx } from '../../services/spend.js';
import { planGoalContinuation, type GoalAsk } from '@dono/shared';
import { fulfillGoalMoneyTx } from '../../services/goalAllocation.js';
import { createTestChannel, DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

const donors: string[] = [],
  donations: string[] = [],
  events: string[] = [],
  channels: string[] = [],
  goals: string[] = [];

async function walletDonor(balance: number) {
  const donor = await prisma.donor.create({
    data: { email: `${crypto.randomUUID()}@example.com`, balance_remaining: balance },
  });
  donors.push(donor.id);
  return donor;
}

async function goal(target: number, current = 0, channelId: string | null = null) {
  const row = await prisma.fundGoal.create({
    data: {
      event_id: DEFAULT_EVENT_ID,
      title: `Goal ${crypto.randomUUID()}`,
      target_cents: target,
      current_cents: current,
      channel_id: channelId,
    },
  });
  goals.push(row.id);
  return row;
}

function ask(goalId: string, donor: number, auto: number, order: number): GoalAsk {
  return { goal_id: goalId, donor_cents: donor, auto_cents: auto, order };
}

afterEach(async () => {
  await prisma.fundContribution.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donation.deleteMany({ where: { id: { in: donations } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channelDefaultGoal.deleteMany({ where: { channel_id: { in: channels } } });
  await prisma.fundGoal.deleteMany({ where: { id: { in: goals } } });
  await prisma.channel.deleteMany({ where: { id: { in: channels } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  donors.length = donations.length = events.length = channels.length = goals.length = 0;
});
afterAll(() => prisma.$disconnect());

it('leaves a below-cap selection untouched', () => {
  const plan = planGoalContinuation([ask('a', 800, 200, 0)], { a: 1000 });
  expect(plan).toEqual({
    placements: [{ goal_id: 'a', donor_cents: 800, auto_cents: 200 }],
    unplaced_cents: 0,
  });
});

it('places an exactly-at-cap selection and continues an above-cap one in proportion', () => {
  expect(planGoalContinuation([ask('a', 100, 0, 0)], { a: 100 })).toEqual({
    placements: [{ goal_id: 'a', donor_cents: 100, auto_cents: 0 }],
    unplaced_cents: 0,
  });
  const plan = planGoalContinuation([ask('a', 600, 0, 0), ask('b', 400, 0, 1)], {
    a: 300,
    b: 1000,
  });
  expect(plan.placements).toEqual([
    { goal_id: 'a', donor_cents: 300, auto_cents: 0 },
    { goal_id: 'b', donor_cents: 400, auto_cents: 300 },
  ]);
  expect(plan.unplaced_cents).toBe(0);
});

it('sends money no selection can take to the Default goal list', () => {
  const plan = planGoalContinuation([ask('a', 1000, 0, 0)], { a: 250 });
  expect(plan.placements).toEqual([{ goal_id: 'a', donor_cents: 250, auto_cents: 0 }]);
  expect(plan.unplaced_cents).toBe(750);
});

it('repeats the proportional pass until every selected goal is full', () => {
  // A $900 selection capped at $100 frees $800 for B and C; B takes $200 and
  // the fixed point sends the rest to C, not a single-pass split that overshoots.
  const plan = planGoalContinuation([ask('a', 900, 0, 0), ask('b', 50, 0, 1), ask('c', 50, 0, 2)], {
    a: 100,
    b: 200,
    c: 1000,
  });
  expect(plan.placements).toEqual([
    { goal_id: 'a', donor_cents: 100, auto_cents: 0 },
    { goal_id: 'b', donor_cents: 50, auto_cents: 150 },
    { goal_id: 'c', donor_cents: 50, auto_cents: 650 },
  ]);
  expect(plan.unplaced_cents).toBe(0);
});

it('skips a goal whose remaining need is zero and keeps proportional ties in insertion order', () => {
  const plan = planGoalContinuation(
    [ask('full', 100, 0, 0), ask('b', 400, 0, 1), ask('c', 400, 0, 2)],
    { full: 0, b: 500, c: 500 },
  );
  // A full goal contributes nothing; its $100 excess splits evenly.
  expect(plan.placements).toEqual([
    { goal_id: 'full', donor_cents: 0, auto_cents: 0 },
    { goal_id: 'b', donor_cents: 400, auto_cents: 50 },
    { goal_id: 'c', donor_cents: 400, auto_cents: 50 },
  ]);
  const odd = planGoalContinuation(
    [ask('a', 701, 0, 0), ask('b', 150, 0, 1), ask('c', 150, 0, 2)],
    { a: 600, b: 1000, c: 1000 },
  );
  // $101 excess over equal weights: the largest-remainder cent follows order.
  expect(odd.placements).toEqual([
    { goal_id: 'a', donor_cents: 600, auto_cents: 0 },
    { goal_id: 'b', donor_cents: 150, auto_cents: 51 },
    { goal_id: 'c', donor_cents: 150, auto_cents: 50 },
  ]);
});

it.each([700, 100, 900])(
  'a %i-cent contribution never takes a goal past its target',
  async (cents) => {
    await ensureDefaultEvent(prisma);
    const donor = await walletDonor(1000);
    const row = await goal(1000, 900);
    const result = await prisma.$transaction((tx) => contributeGoalTx(tx, donor.id, row.id, cents));
    const placed = Math.min(cents, 100);
    expect(result.cost).toBe(placed);
    expect(await prisma.fundGoal.findUnique({ where: { id: row.id } })).toMatchObject({
      current_cents: 900 + placed,
      is_complete: true,
    });
    expect(await prisma.fundContribution.findMany({ where: { goal_id: row.id } })).toMatchObject([
      { amount_cents: placed, source: 'donor' },
    ]);
    expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
      balance_remaining: 1000 - placed,
    });
  },
);

it('drops the automatic part first when a combined write is capped', async () => {
  await ensureDefaultEvent(prisma);
  const donor = await walletDonor(1000);
  const row = await goal(1000, 500);
  const result = await prisma.$transaction((tx) =>
    contributeGoalSplitTx(tx, donor.id, row.id, { donor: 700, auto: 300 }),
  );
  expect(result.cost).toBe(500);
  expect(await prisma.fundContribution.findMany({ where: { goal_id: row.id } })).toMatchObject([
    { amount_cents: 500, source: 'donor' },
  ]);
  expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
    balance_remaining: 500,
  });
});

it('continues goal-Pool money through the Default goal list and leaves the rest Unused', async () => {
  await ensureDefaultEvent(prisma);
  const channel = await createTestChannel(prisma);
  channels.push(channel.id);
  const donor = await walletDonor(0);
  const donation = await prisma.donation.create({
    data: {
      donor_id: donor.id,
      external_id: crypto.randomUUID(),
      amount_cents: 1000,
      pledge_amount_cents: 1000,
      channel_id: channel.id,
      event_id: DEFAULT_EVENT_ID,
    },
  });
  donations.push(donation.id);
  const selected = await goal(100, 0, channel.id);
  const listed = await goal(200, 0, channel.id);
  const closest = await goal(100, 0, channel.id);
  await prisma.channelDefaultGoal.create({
    data: { channel_id: channel.id, goal_id: listed.id, position: 0 },
  });
  const outcome = await prisma.$transaction((tx) =>
    fulfillGoalMoneyTx(tx, {
      donorId: donor.id,
      donationId: donation.id,
      channelId: channel.id,
      asks: [ask(selected.id, 500, 0, 0)],
    }),
  );
  // $100 capped selection, $200 at the listed goal, $100 at the closest goal;
  // the last $100 has no eligible goal and stays Unused pool money.
  expect(outcome.placedCents).toBe(400);
  expect(outcome.unplacedCents).toBe(100);
  expect(await prisma.fundGoal.findUnique({ where: { id: selected.id } })).toMatchObject({
    current_cents: 100,
    is_complete: true,
  });
  expect(await prisma.fundGoal.findUnique({ where: { id: listed.id } })).toMatchObject({
    current_cents: 200,
    is_complete: true,
  });
  expect(await prisma.fundGoal.findUnique({ where: { id: closest.id } })).toMatchObject({
    current_cents: 100,
    is_complete: true,
  });
  const rows = await prisma.fundContribution.findMany({ where: { donation_id: donation.id } });
  expect(rows).toHaveLength(3);
  const byGoal = new Map(rows.map((row) => [row.goal_id, row]));
  // Only the donor's original cents keep the donor mark; the chain is auto.
  expect(byGoal.get(selected.id)).toMatchObject({ amount_cents: 100, source: 'donor' });
  expect(byGoal.get(listed.id)).toMatchObject({ amount_cents: 200, source: 'auto' });
  expect(byGoal.get(closest.id)).toMatchObject({ amount_cents: 100, source: 'auto' });
  expect(rows.reduce((sum, row) => sum + row.amount_cents, 0)).toBe(500 - 100);
});
