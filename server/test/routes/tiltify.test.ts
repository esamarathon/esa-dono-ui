import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import tiltifyRouter from '../../routes/tiltify.js';
import { buildTiltifyTotals } from '../../services/webhooks/tiltifyPayload.js';

/**
 * Contract tests for the Tiltify-compatible read API (PRD-0002 §R, #117).
 *
 * The assertions mirror what each consumer reads (kollekt@524f276 C# models,
 * esa-layouts-v2@1c8ea49 `util/tiltify.ts` + `fundraising.ts`):
 * - kollekt: `Guid` ids (non-null for incentives), `team_id` as a Guid string or
 *   null, amounts parsed with `decimal.Parse(value, InvariantCulture)`; the poll
 *   and incentive lists are bare arrays;
 * - layouts: `total_amount_raised.value`, polls with `active`, `amount_raised.value`,
 *   `id`, `name`, `options[]`; milestones and matches arrays.
 */

const prisma = new PrismaClient();
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** kollekt `decimal.Parse(..., InvariantCulture)` and layouts `parseFloat` both accept this. */
const DECIMAL = /^\d+\.\d{2}$/;

function createApp() {
  const app = express();
  app.use('/api/tiltify', tiltifyRouter);
  return app;
}
const get = (path: string) => request(createApp()).get(`/api/tiltify${path}`);

function expectAmount(amount: unknown, value?: string) {
  expect(amount).toEqual({
    currency: expect.stringMatching(/^[A-Z]{3}$/),
    value: expect.any(String),
  });
  const v = (amount as { value: string }).value;
  expect(v).toMatch(DECIMAL);
  if (value !== undefined) expect(v).toBe(value);
}

describe('Tiltify-compatible REST API (#117)', () => {
  let eventId = '';
  let eventSlug = '';
  let channelA = '';
  let channelB = '';
  let donorId = '';
  const ids = { rewards: [] as string[], goals: [] as string[], polls: [] as string[] };
  let sharedReward = '';
  let ownRewardA = '';
  let ownRewardB = '';
  let sharedPoll = '';
  let ownPollB = '';
  let approvedOption = '';

  beforeAll(async () => {
    eventSlug = `tapi-event-${rand()}`;
    const event = await prisma.event.create({
      data: { name: 'Tiltify API Event', slug: eventSlug, is_active: true },
    });
    eventId = event.id;
    const mk = (n: string) =>
      prisma.channel.create({
        data: { name: `TAPI ${n} ${rand()}`, slug: `tapi-${n}-${rand()}`, event_id: eventId },
      });
    channelA = (await mk('a')).id;
    channelB = (await mk('b')).id;
    await prisma.event.update({ where: { id: eventId }, data: { primary_channel_id: channelA } });

    const reward = async (title: string, channel_id: string | null, extra = {}) => {
      const r = await prisma.reward.create({
        data: { title, type: 'DIGITAL', cost_cents: 500, channel_id, ...extra },
      });
      ids.rewards.push(r.id);
      return r.id;
    };
    sharedReward = await reward('Shared shoutout', null, {
      quantity_total: 10,
      quantity_claimed: 3,
    });
    ownRewardA = await reward('A only', channelA, { is_active: false });
    ownRewardB = await reward('B only', channelB);

    const goal = await prisma.fundGoal.create({
      data: { title: 'Shared goal', target_cents: 100_000, current_cents: 2_550, channel_id: null },
    });
    ids.goals.push(goal.id);

    const poll = await prisma.poll.create({
      data: {
        title: 'Shared poll',
        channel_id: null,
        total_votes_cents: 1_500,
        options: {
          create: [
            { label: 'Approved', votes_cents: 1_000 },
            { label: 'Waiting', votes_cents: 500, status: 'PENDING_APPROVAL' },
            { label: 'Rejected', status: 'REJECTED' },
          ],
        },
      },
      include: { options: true },
    });
    sharedPoll = poll.id;
    approvedOption = poll.options.find((o) => o.label === 'Approved')!.id;
    ids.polls.push(poll.id);
    const ended = await prisma.poll.create({
      data: { title: 'B ended', channel_id: channelB, ends_at: new Date(Date.now() - 60_000) },
    });
    ownPollB = ended.id;
    ids.polls.push(ended.id);

    const donor = await prisma.donor.create({ data: { email: `tapi-${rand()}@example.com` } });
    donorId = donor.id;
    const donate = (channel_id: string | null, amount_cents: number, status = 'COMPLETED') =>
      prisma.donation.create({
        data: {
          external_id: `tapi-${rand()}`,
          donor_id: donorId,
          amount_cents,
          status,
          channel_id,
          event_id: channel_id ? eventId : null,
        },
      });
    await donate(channelA, 1_000);
    await donate(channelA, 250, 'REFUNDED'); // counts (wallet refund, §E7)
    await donate(channelA, 4_000, 'CHARGEBACK'); // does not count
    await donate(channelB, 1_234);
    await donate(null, 9_999); // unassigned: no Event total
  });

  afterAll(async () => {
    await prisma.donation.deleteMany({ where: { donor_id: donorId } });
    await prisma.donor.deleteMany({ where: { id: donorId } });
    await prisma.pollOption.deleteMany({ where: { poll_id: { in: ids.polls } } });
    await prisma.poll.deleteMany({ where: { id: { in: ids.polls } } });
    await prisma.fundGoal.deleteMany({ where: { id: { in: ids.goals } } });
    await prisma.reward.deleteMany({ where: { id: { in: ids.rewards } } });
    await prisma.event.update({ where: { id: eventId }, data: { primary_channel_id: null } });
    await prisma.channel.deleteMany({ where: { event_id: eventId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.$disconnect();
  });

  describe('campaigns/{id}', () => {
    it('a Channel is a campaign whose team_id is its Event (kollekt TiltifyFact)', async () => {
      const res = await get(`/campaigns/${channelA}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('data'); // bare, like the bridge
      expect(res.body).toMatchObject({ id: channelA, team_id: eventId, status: 'published' });
      expect(res.body.id).toMatch(UUID);
      expect(res.body.team_id).toMatch(UUID); // kollekt Guid.Parse(team_id)
      expect(res.body.slug).toMatch(/^tapi-a-/);
      // 10.00 completed + 2.50 refunded; the chargeback does not count.
      expectAmount(res.body.total_amount_raised, '12.50');
      expect(res.body.amount_raised).toEqual(res.body.total_amount_raised);
    });

    it('an Event is a team campaign with team_id null and the sum of its Channels', async () => {
      const res = await get(`/campaigns/${eventId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: eventId, slug: eventSlug, team_id: null });
      // 12.50 (A) + 12.34 (B); the unassigned 99.99 is not in any Event.
      expectAmount(res.body.total_amount_raised, '24.84');
    });

    it('matches the fact.updated message exactly (layouts re-reads it when a total drops, §E7)', async () => {
      const [channelFact, eventFact] = await buildTiltifyTotals(prisma, channelA);
      if (!channelFact || !eventFact) throw new Error('no totals');
      const [c, e] = await Promise.all([
        get(`/campaigns/${channelA}`),
        get(`/campaigns/${eventId}`),
      ]);
      expect(c.body.total_amount_raised).toEqual(channelFact.payload.total_amount_raised);
      expect(e.body.total_amount_raised).toEqual(eventFact.payload.total_amount_raised);
    });

    it('an inactive Channel still resolves, as retired (kollekt keeps old campaigns)', async () => {
      await prisma.channel.update({ where: { id: channelB }, data: { is_active: false } });
      try {
        const res = await get(`/campaigns/${channelB}`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('retired');
      } finally {
        await prisma.channel.update({ where: { id: channelB }, data: { is_active: true } });
      }
    });

    it('returns 404 for an unknown id (kollekt: "Unknown campaign"; layouts: skipped)', async () => {
      expect((await get(`/campaigns/${crypto.randomUUID()}`)).status).toBe(404);
      expect((await get('/campaigns/not-a-uuid')).status).toBe(404);
    });
  });

  describe('campaign/{id}/rewards', () => {
    it('a Channel lists its own rewards and the shared ones; inactive stay listed', async () => {
      const res = await get(`/campaign/${channelA}/rewards?limit=100`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const byId = new Map(res.body.map((r: { id: string }) => [r.id, r]));
      // Other test files leave shared incentives in the DB: check ours, not the exact list.
      expect(byId.has(sharedReward)).toBe(true);
      expect(byId.has(ownRewardA)).toBe(true);
      expect(byId.has(ownRewardB)).toBe(false); // another Channel's
      expect(byId.get(ownRewardA)).toMatchObject({ name: 'A only', active: false });
      const shared = byId.get(sharedReward) as Record<string, unknown>;
      expect(shared).toMatchObject({
        name: 'Shared shoutout',
        active: true,
        quantity: 10,
        quantity_remaining: 7,
      });
      expectAmount(shared.amount, '5.00');
      expect(shared.inserted_at).toEqual(expect.any(String)); // kollekt DateTime?
      for (const id of [sharedReward, ownRewardA]) expect(id).toMatch(UUID); // kollekt Guid
    });

    it('the shared reward is listed under every Channel of the Event (#117 Q2)', async () => {
      const res = await get(`/campaign/${channelB}/rewards`);
      const listed = res.body.map((r: { id: string }) => r.id);
      expect(listed).toEqual(expect.arrayContaining([sharedReward, ownRewardB]));
      expect(listed).not.toContain(ownRewardA);
      const unlimited = res.body.find((r: { id: string }) => r.id === ownRewardB);
      expect(unlimited).toMatchObject({ quantity: null, quantity_remaining: null });
    });

    it('an Event lists no incentives (layouts concatenates Event + Channel lists)', async () => {
      for (const kind of ['rewards', 'targets', 'polls']) {
        const res = await get(`/campaign/${eventId}/${kind}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      }
    });

    it('returns 404 for an unknown campaign', async () => {
      for (const kind of ['rewards', 'targets', 'polls', 'milestones', 'matches']) {
        expect((await get(`/campaign/${crypto.randomUUID()}/${kind}`)).status).toBe(404);
      }
    });
  });

  describe('campaign/{id}/targets', () => {
    it('lists FundGoals as targets with amount (goal) and amount_raised (kollekt TiltifyTarget)', async () => {
      const res = await get(`/campaign/${channelA}/targets?limit=100`);
      expect(res.status).toBe(200);
      const target = res.body.find((t: { id: string }) => t.id === ids.goals[0]);
      expect(target).toMatchObject({ name: 'Shared goal', active: true });
      expectAmount(target.amount, '1000.00');
      expectAmount(target.amount_raised, '25.50');
    });
  });

  describe('campaign/{id}/polls', () => {
    it('lists polls with only approved options (layouts + kollekt TiltifyPoll)', async () => {
      const res = await get(`/campaign/${channelA}/polls?limit=100`);
      expect(res.status).toBe(200);
      const listed = res.body.map((p: { id: string }) => p.id);
      expect(listed).toContain(sharedPoll);
      expect(listed).not.toContain(ownPollB); // another Channel's
      const poll = res.body.find((p: { id: string }) => p.id === sharedPoll);
      // layouts keeps a poll only when active && amount_raised.value && id && name && options.
      expect(poll).toMatchObject({ id: sharedPoll, name: 'Shared poll', active: true });
      expectAmount(poll.amount_raised, '15.00');
      expect(poll.options).toHaveLength(1);
      expect(poll.options[0]).toMatchObject({ id: approvedOption, name: 'Approved' });
      expectAmount(poll.options[0].amount_raised, '10.00');
    });

    it('a poll past ends_at is inactive', async () => {
      const res = await get(`/campaign/${channelB}/polls`);
      const ended = res.body.find((p: { id: string }) => p.id === ownPollB);
      expect(ended).toMatchObject({ active: false, options: [] });
    });

    it('polls/{poll_id} returns one poll listed under the campaign', async () => {
      const res = await get(`/campaign/${channelB}/polls/${sharedPoll}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: sharedPoll, name: 'Shared poll' });
      expect(res.body.options.map((o: { id: string }) => o.id)).toEqual([approvedOption]);
    });

    it('polls/{poll_id} is 404 when the poll belongs to another Channel, the Event, or nobody', async () => {
      expect((await get(`/campaign/${channelA}/polls/${ownPollB}`)).status).toBe(404);
      expect((await get(`/campaign/${eventId}/polls/${sharedPoll}`)).status).toBe(404);
      expect((await get(`/campaign/${channelA}/polls/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe('milestones and matches', () => {
    it('are empty arrays for a known Channel or Event', async () => {
      for (const id of [channelA, eventId]) {
        const m = await get(`/campaign/${id}/milestones?limit=100`);
        expect(m.status).toBe(200);
        expect(m.body).toEqual([]);
        const x = await get(`/campaign/${id}/matches?status=active&limit=100`);
        expect(x.status).toBe(200);
        expect(x.body).toEqual([]);
      }
    });
  });
});
