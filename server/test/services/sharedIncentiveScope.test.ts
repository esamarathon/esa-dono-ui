import crypto from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { planPledge } from '@dono/shared';
import prisma from '../../lib/prisma.js';
import { createPledge } from '../../services/pledge.js';
import { defaultGoal } from '../../services/defaultGoal.js';
import { updateChannel } from '../../services/channels.js';
import { unusedTargetsTx } from '../../services/unusedPool.js';
import { readPoolCreditEventTx } from '../../services/poolCredit.js';
import { createGoal, updateGoal } from '../../services/incentiveLifecycle.js';

// ADR-0012: a shared incentive belongs to one Event and is available only there.
const events: string[] = [];
const donors: string[] = [];
const drafts: string[] = [];

async function twoEvents() {
  const slug = () => `scope-${crypto.randomUUID()}`;
  const here = await prisma.event.create({ data: { name: 'Here', slug: slug() } });
  const there = await prisma.event.create({ data: { name: 'There', slug: slug() } });
  events.push(here.id, there.id);
  const channel = await prisma.channel.create({
    data: { name: slug(), slug: slug(), event_id: here.id },
  });
  const otherChannel = await prisma.channel.create({
    data: { name: slug(), slug: slug(), event_id: there.id },
  });
  // Same target and progress: only the Event decides which one is eligible.
  const goal = (title: string, event_id: string) =>
    prisma.fundGoal.create({ data: { title, target_cents: 5000, event_id } });
  const sharedHere = await goal('Shared here', here.id);
  const sharedThere = await goal('Shared there', there.id);
  return { here, there, channel, otherChannel, sharedHere, sharedThere };
}

afterEach(async () => {
  await prisma.pendingPledge.deleteMany({ where: { draft_id: { in: drafts } } });
  await prisma.donation.deleteMany({ where: { donor_id: { in: donors } } });
  await prisma.donor.deleteMany({ where: { id: { in: donors } } });
  await prisma.channelDefaultGoal.deleteMany({ where: { channel: { event_id: { in: events } } } });
  await prisma.fundGoal.deleteMany({ where: { event_id: { in: events } } });
  await prisma.channel.deleteMany({ where: { event_id: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  events.length = donors.length = drafts.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('shared incentive Event scope', () => {
  it('removes another Event shared goal from a pledge review and keeps this Event one', async () => {
    const f = await twoEvents();
    const draft_id = crypto.randomUUID();
    drafts.push(draft_id);
    const items = [
      { kind: 'GOAL' as const, target_id: f.sharedThere.id, amount_cents: 300 },
      { kind: 'GOAL' as const, target_id: f.sharedHere.id, amount_cents: 200 },
    ];
    const input = {
      draft_id,
      pledge_amount_cents: 1000,
      channel_id: f.channel.id,
      items,
      plan: planPledge({
        pledge_amount_cents: 1000,
        available_wallet_cents: null,
        selections: items.map((item, insertion_order) => ({ ...item, insertion_order })),
      }),
    };
    await expect(createPledge(input)).rejects.toMatchObject({
      status: 409,
      items: [{ kind: 'GOAL', target_id: f.sharedHere.id, amount_cents: 200 }],
    });
  });

  it('never resolves a Default goal or fallback to another Event shared goal', async () => {
    const f = await twoEvents();
    await expect(
      updateChannel(f.channel.id, { default_goals: [f.sharedThere.id] }),
    ).rejects.toMatchObject({ status: 400 });
    // No list: the fallback picks this Event's shared goal, not the other one.
    expect(await prisma.$transaction((tx) => defaultGoal(tx, f.channel.id))).toBe(f.sharedHere.id);
    await prisma.fundGoal.update({ where: { id: f.sharedHere.id }, data: { is_active: false } });
    expect(await prisma.$transaction((tx) => defaultGoal(tx, f.channel.id))).toBeNull();
  });

  it('offers only this Event shared goals as Unused pool and Pool credit targets', async () => {
    const f = await twoEvents();
    const donor = await prisma.donor.create({
      data: { email: `${crypto.randomUUID()}@scope.example` },
    });
    donors.push(donor.id);
    const donation = await prisma.donation.create({
      data: {
        donor_id: donor.id,
        external_id: crypto.randomUUID(),
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        channel_id: f.channel.id,
        event_id: f.here.id,
      },
    });
    const unused = await prisma.$transaction((tx) => unusedTargetsTx(tx, donation.id, 'goal'));
    expect(unused.targets.map((t) => t.id)).toEqual([f.sharedHere.id]);
    const credit = await prisma.$transaction((tx) =>
      readPoolCreditEventTx(tx, donor.id, f.here.id),
    );
    expect(credit.catalog.goals.map((g: { id: string }) => g.id)).toEqual([f.sharedHere.id]);
  });
});

describe('incentive Event ownership', () => {
  it('takes the Channel Event, rejects a different one, and accepts an explicit shared Event', async () => {
    const f = await twoEvents();
    const own = await createGoal({ title: 'Own', target_cents: 100, channel_id: f.channel.id });
    expect(own.event_id).toBe(f.here.id);
    await expect(
      createGoal({
        title: 'Mismatch',
        target_cents: 100,
        channel_id: f.channel.id,
        event_id: f.there.id,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'event_id must be the Event of channel_id' });
    const shared = await createGoal({ title: 'Shared', target_cents: 100, event_id: f.there.id });
    expect(shared).toMatchObject({ channel_id: null, event_id: f.there.id });
  });

  it('keeps an incentive in its Event on update', async () => {
    const f = await twoEvents();
    const moved = 'An incentive cannot move to another Event. Copy it instead.';
    await expect(updateGoal(f.sharedHere.id, { event_id: f.there.id })).rejects.toMatchObject({
      status: 400,
      message: moved,
    });
    await expect(
      updateGoal(f.sharedHere.id, { channel_id: f.otherChannel.id }),
    ).rejects.toMatchObject({ status: 400, message: moved });
    await expect(updateGoal(f.sharedHere.id, { channel_id: f.channel.id })).resolves.toMatchObject({
      channel_id: f.channel.id,
      event_id: f.here.id,
    });
  });

  it('refuses to move a Channel that owns incentives to another Event', async () => {
    const f = await twoEvents();
    await expect(updateChannel(f.otherChannel.id, { event_id: f.here.id })).resolves.toMatchObject({
      event_id: f.here.id,
    });
    await prisma.fundGoal.update({
      where: { id: f.sharedHere.id },
      data: { channel_id: f.channel.id },
    });
    await expect(updateChannel(f.channel.id, { event_id: f.there.id })).rejects.toMatchObject({
      status: 409,
    });
  });
});
