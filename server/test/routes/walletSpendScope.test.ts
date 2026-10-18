import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import rewardsRouter from '../../routes/rewards.js';
import pollsRouter from '../../routes/polls.js';
import goalsRouter from '../../routes/goals.js';
import { createTestChannel } from '../helpers/fixtures.js';

// ADR-0012: a direct Wallet spend targets one Channel and may fund only an
// incentive available on it, exactly like a pledge.
const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use('/api/rewards', rewardsRouter);
app.use('/api/polls', pollsRouter);
app.use('/api/goals', goalsRouter);

const rand = () => crypto.randomUUID().slice(0, 8);
let here: { id: string; event_id: string };
let sibling: { id: string };
let inactive: { id: string };
let otherEventId: string;

beforeAll(async () => {
  here = await createTestChannel(prisma);
  sibling = await createTestChannel(prisma);
  inactive = await createTestChannel(prisma, { is_active: false });
  otherEventId = (
    await prisma.event.create({ data: { name: 'Other Event', slug: `other-${rand()}` } })
  ).id;
});

afterAll(async () => {
  await prisma.channel.deleteMany({ where: { id: { in: [here.id, sibling.id, inactive.id] } } });
  await prisma.event.delete({ where: { id: otherEventId } });
  await prisma.$disconnect();
});

type Scope = { event_id: string; channel_id: string | null };

/** One Wallet spend endpoint: create its incentive, call it, and read its side effects. */
interface Endpoint {
  name: string;
  create(scope: Scope): Promise<{ id: string; path: string; body: Record<string, unknown> }>;
  effects(id: string, donorId: string): Promise<unknown>;
  cleanup(id: string, donorId: string): Promise<void>;
}

const endpoints: Endpoint[] = [
  {
    name: 'POST /api/rewards/:id/claim',
    async create(scope) {
      const reward = await prisma.reward.create({
        data: { ...scope, title: 'Scoped reward', type: 'DIGITAL', cost_cents: 500 },
      });
      return { id: reward.id, path: `/api/rewards/${reward.id}/claim`, body: { claim_data: {} } };
    },
    async effects(id, donorId) {
      return {
        claims: await prisma.rewardClaim.count({ where: { donor_id: donorId } }),
        stock: (await prisma.reward.findUniqueOrThrow({ where: { id } })).quantity_claimed,
      };
    },
    async cleanup(id, donorId) {
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donorId } });
      await prisma.reward.delete({ where: { id } });
    },
  },
  {
    name: 'POST /api/polls/:id/vote',
    async create(scope) {
      const poll = await prisma.poll.create({
        data: { ...scope, title: 'Scoped poll', options: { create: [{ label: 'A' }] } },
        include: { options: true },
      });
      return {
        id: poll.id,
        path: `/api/polls/${poll.id}/vote`,
        body: { poll_option_id: poll.options[0]!.id, amount_cents: 500 },
      };
    },
    async effects(id, donorId) {
      return {
        votes: await prisma.pollVote.count({ where: { donor_id: donorId } }),
        total: (await prisma.poll.findUniqueOrThrow({ where: { id } })).total_votes_cents,
      };
    },
    async cleanup(id, donorId) {
      await prisma.pollVote.deleteMany({ where: { donor_id: donorId } });
      await prisma.poll.delete({ where: { id } });
    },
  },
  {
    name: 'POST /api/polls/:id/custom-entry',
    async create(scope) {
      const poll = await prisma.poll.create({
        data: { ...scope, title: 'Scoped write-in poll', allow_custom_entries: true },
      });
      return {
        id: poll.id,
        path: `/api/polls/${poll.id}/custom-entry`,
        body: { label: 'My idea', amount_cents: 500 },
      };
    },
    async effects(id, donorId) {
      return {
        entries: await prisma.pollCustomEntry.count({ where: { donor_id: donorId } }),
        options: await prisma.pollOption.count({ where: { poll_id: id } }),
        votes: await prisma.pollVote.count({ where: { donor_id: donorId } }),
      };
    },
    async cleanup(id, donorId) {
      await prisma.pollVote.deleteMany({ where: { donor_id: donorId } });
      await prisma.pollOption.deleteMany({ where: { poll_id: id } });
      await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donorId } });
      await prisma.poll.delete({ where: { id } });
    },
  },
  {
    name: 'POST /api/goals/:id/contribute',
    async create(scope) {
      const goal = await prisma.fundGoal.create({
        data: { ...scope, title: 'Scoped goal', target_cents: 10000 },
      });
      return { id: goal.id, path: `/api/goals/${goal.id}/contribute`, body: { amount_cents: 500 } };
    },
    async effects(id, donorId) {
      return {
        contributions: await prisma.fundContribution.count({ where: { donor_id: donorId } }),
        current: (await prisma.fundGoal.findUniqueOrThrow({ where: { id } })).current_cents,
      };
    },
    async cleanup(id, donorId) {
      await prisma.fundContribution.deleteMany({ where: { donor_id: donorId } });
      await prisma.fundGoal.delete({ where: { id } });
    },
  },
];

async function spend(
  endpoint: Endpoint,
  scope: (channels: { here: string; sibling: string }) => Scope,
  channelId: (target: { here: string; inactive: string }) => string | undefined,
) {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `wallet-scope-${rand()}@example.com`,
      balance_remaining: 5000,
      total_donated: 5000,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  const target = await endpoint.create(scope({ here: here.id, sibling: sibling.id }));
  const before = await endpoint.effects(target.id, donor.id);
  const channel_id = channelId({ here: here.id, inactive: inactive.id });
  const res = await request(app)
    .post(target.path)
    .set('Authorization', `Bearer ${token}`)
    .send(channel_id === undefined ? target.body : { ...target.body, channel_id });
  const balance = (await prisma.donor.findUniqueOrThrow({ where: { id: donor.id } }))
    .balance_remaining;
  const after = await endpoint.effects(target.id, donor.id);
  await endpoint.cleanup(target.id, donor.id);
  await prisma.donor.delete({ where: { id: donor.id } });
  return { res, balance, unchanged: JSON.stringify(after) === JSON.stringify(before) };
}

describe.each(endpoints)('$name Channel scope', (endpoint) => {
  const shared = () => ({ event_id: here.event_id, channel_id: null });

  it('requires channel_id', async () => {
    const { res, balance, unchanged } = await spend(endpoint, shared, () => undefined);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('channel_id is required');
    expect({ balance, unchanged }).toEqual({ balance: 5000, unchanged: true });
  });

  it('rejects an unknown or inactive Channel with 404', async () => {
    for (const pick of [() => crypto.randomUUID(), (c: { inactive: string }) => c.inactive]) {
      const { res, balance, unchanged } = await spend(endpoint, shared, pick);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found or inactive');
      expect({ balance, unchanged }).toEqual({ balance: 5000, unchanged: true });
    }
  });

  it("rejects another Event's shared incentive without a debit or a write", async () => {
    const { res, balance, unchanged } = await spend(
      endpoint,
      () => ({ event_id: otherEventId, channel_id: null }),
      (c) => c.here,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available on this Channel/);
    expect({ balance, unchanged }).toEqual({ balance: 5000, unchanged: true });
  });

  it("rejects another Channel's incentive without a debit or a write", async () => {
    const { res, balance, unchanged } = await spend(
      endpoint,
      (c) => ({ event_id: here.event_id, channel_id: c.sibling }),
      (c) => c.here,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available on this Channel/);
    expect({ balance, unchanged }).toEqual({ balance: 5000, unchanged: true });
  });

  it("spends on the Channel's own incentive and on a shared incentive of its Event", async () => {
    for (const scope of [
      (c: { here: string }) => ({ event_id: here.event_id, channel_id: c.here }),
      shared,
    ]) {
      const { res, balance, unchanged } = await spend(endpoint, scope, (c) => c.here);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect({ balance, unchanged }).toEqual({ balance: 4500, unchanged: false });
    }
  });
});
