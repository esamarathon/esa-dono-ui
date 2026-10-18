import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import yaml from 'js-yaml';
import { planPledge } from '@dono/shared';
import prisma from '../lib/prisma.js';
import adminRouter from '../routes/admin.js';
import moderatorRouter from '../routes/moderator.js';
import tiltifyRouter from '../routes/tiltify.js';
import rewardsRouter from '../routes/rewards.js';
import pollsRouter from '../routes/polls.js';
import goalsRouter from '../routes/goals.js';
import { createPledge } from '../services/pledge.js';
import { WEBHOOK_MESSAGE_TYPES } from '../services/webhooks/delivery.js';

// Documented samples must keep the shape of what consumers really receive: the same
// field names at every level, and the same JSON type for every non-null value.
vi.mock('../services/email.js', () => ({ sendMagicLink: vi.fn().mockResolvedValue(undefined) }));

const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };
const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/moderator', moderatorRouter);
app.use('/api/tiltify', tiltifyRouter);
app.use('/api/rewards', rewardsRouter);
app.use('/api/polls', pollsRouter);
app.use('/api/goals', goalsRouter);
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// Images exclude docs/ (.dockerignore); the checkout-based CI test job runs this file.
const docsPresent = existsSync(new URL('../../docs/outbound-events.md', import.meta.url));

/** `json sample=<key>` blocks in a Markdown document. */
function samples(markdown: string) {
  const found = new Map<string, unknown>();
  for (const m of markdown.matchAll(/```json sample=(\S+)\n([\s\S]*?)\n```/g))
    found.set(m[1]!, JSON.parse(m[2]!));
  return found;
}

/** Differences in field names and non-null value types, by path. */
function shapeDiff(sample: unknown, real: unknown, path = '$'): string[] {
  if (sample === null || real === null) return [];
  if (Array.isArray(sample) || Array.isArray(real)) {
    if (!Array.isArray(sample) || !Array.isArray(real)) return [`${path}: array vs not`];
    return sample[0] === undefined || real[0] === undefined
      ? []
      : shapeDiff(sample[0], real[0], `${path}[0]`);
  }
  if (typeof sample !== typeof real) return [`${path}: ${typeof sample} vs ${typeof real}`];
  if (typeof sample !== 'object') return [];
  const a = sample as Record<string, unknown>;
  const b = real as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) =>
    !(key in a)
      ? [`${path}.${key}: missing from the sample`]
      : !(key in b)
        ? [`${path}.${key}: not in the real payload`]
        : shapeDiff(a[key], b[key], `${path}.${key}`),
  );
}

const created = {
  destinations: [] as string[],
  donors: [] as string[],
  eventId: '',
  channelId: '',
  pledgeToken: '',
};
const real = new Map<string, unknown>();
const publicRows: Record<'Reward' | 'Poll' | 'FundGoal', unknown> = {
  Reward: null,
  Poll: null,
  FundGoal: null,
};

beforeAll(async () => {
  if (!docsPresent) return;
  const tag = crypto.randomUUID().slice(0, 8);
  const event = await prisma.event.create({
    data: { name: 'Samples', slug: `samples-${tag}`, is_active: false },
  });
  const channel = await prisma.channel.create({
    data: { name: `Samples ${tag}`, slug: `samples-stream-${tag}`, event_id: event.id },
  });
  created.eventId = event.id;
  created.channelId = channel.id;
  const destination = async (body: Record<string, unknown>) => {
    const res = await request(app).post('/api/admin/destinations').set(AUTH).send(body);
    expect(res.status).toBe(201);
    created.destinations.push(res.body.id);
    return res.body.id as string;
  };
  const tiltify = await destination({
    destination_type: 'RABBITMQ',
    amqp_url: 'amqp://127.0.0.1:1',
    payload_format: 'TILTIFY',
  });
  const native = await destination({
    destination_type: 'RABBITMQ',
    amqp_url: 'amqp://127.0.0.1:1',
    amqp_routing_key: 'native',
    event_types: [...WEBHOOK_MESSAGE_TYPES],
  });
  // The broker is unreachable on purpose: rows stay queued for inspection.
  await prisma.webhookDestination.updateMany({
    where: { id: { in: created.destinations } },
    data: { is_active: true },
  });

  const post = async (path: string, body: object) =>
    (await request(app).post(path).set(AUTH).send(body).expect(200)).body;
  const put = (path: string, body: object) =>
    request(app).put(path).set(AUTH).send(body).expect(200);
  const reward = await post('/api/admin/rewards', {
    title: 'Signed poster',
    type: 'DIGITAL',
    cost_cents: 1000,
    channel_id: channel.id,
  });
  const poll = await post('/api/admin/polls', {
    title: 'Next bonus game',
    options: [{ label: 'Celeste' }],
    event_id: event.id,
  });
  const goal = await post('/api/admin/goals', {
    title: 'Blindfolded run',
    target_cents: 50000,
    event_id: event.id,
  });
  await put(`/api/admin/goals/${goal.id}`, { target_cents: 60000, event_id: event.id });
  const rewardBody = { title: 'Signed poster', type: 'DIGITAL', cost_cents: 1000 };
  await put(`/api/admin/rewards/${reward.id}`, {
    ...rewardBody,
    channel_id: channel.id,
    is_active: false,
  });
  await put(`/api/admin/rewards/${reward.id}`, {
    ...rewardBody,
    channel_id: channel.id,
    is_active: true,
  });

  const items = [
    {
      kind: 'REWARD' as const,
      target_id: reward.id,
      unit_price_cents: 1000,
      reward_type: 'DIGITAL',
      amount_cents: 1000,
      insertion_order: 0,
    },
    {
      kind: 'POLL_VOTE' as const,
      target_id: poll.options[0].id,
      poll_id: poll.id,
      amount_cents: 600,
      insertion_order: 1,
    },
    { kind: 'GOAL' as const, target_id: goal.id, amount_cents: 400, insertion_order: 2 },
  ];
  const pledge = await createPledge({
    draft_id: crypto.randomUUID(),
    pledge_amount_cents: 1500,
    channel_id: channel.id,
    items,
    display_name: 'Speedy',
    comment: 'Good luck runners!',
    plan: planPledge({
      pledge_amount_cents: 1500,
      selections: items,
      available_wallet_cents: null,
    }),
  });
  created.pledgeToken = pledge.pledge_token;
  const donation = await post('/api/admin/simulate-donation', {
    email: `samples-${tag}@example.com`,
    donor_name: 'Speedy',
    amount_cents: 1500,
    comment: 'Good luck runners!',
    pledge_token: pledge.pledge_token,
    channel_id: channel.id,
    external_id: `cs_test_${tag}`,
  });
  created.donors.push(donation.donor.id);
  const patch = (body: object) =>
    request(app)
      .patch(`/api/moderator/donations/${donation.donation.id}`)
      .set(AUTH)
      .send(body)
      .expect(200);
  await patch({ moderated: true });
  await patch({ hidden_from_overlay: true });
  await patch({ hidden_from_overlay: false });

  // The first message of each kind, as consumers received it.
  const rows = await prisma.webhookDelivery.findMany({
    where: { destination_id: { in: [native, tiltify] } },
    orderBy: { seq: 'asc' },
  });
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { data?: { incentive_kind?: string } };
    const key =
      row.destination_id === tiltify
        ? row.message_type.replace(/^tiltify\./, 'tiltify:')
        : row.message_type === 'incentive.created'
          ? `native:${row.message_type}:${payload.data!.incentive_kind}`
          : `native:${row.message_type}`;
    if (!real.has(key)) real.set(key, payload);
  }
  real.set(
    'lookup:targets',
    (await request(app).get(`/api/tiltify/campaign/${channel.id}/lookup/targets/${goal.id}`)).body,
  );
  const row = async (path: string, id: string) =>
    (await request(app).get(path)).body.find((r: { id: string }) => r.id === id);
  publicRows.Reward = await row('/api/rewards', reward.id);
  publicRows.Poll = await row('/api/polls', poll.id);
  publicRows.FundGoal = await row('/api/goals', goal.id);
});

afterAll(async () => {
  if (!docsPresent) return prisma.$disconnect();
  const where = { destination_id: { in: created.destinations } };
  await prisma.webhookDelivery.deleteMany({ where });
  await prisma.webhookDestinationSeq.deleteMany({ where });
  await prisma.webhookDestination.deleteMany({ where: { id: { in: created.destinations } } });
  const byDonor = { donor_id: { in: created.donors } };
  await prisma.rewardClaim.deleteMany({ where: byDonor });
  await prisma.pollVote.deleteMany({ where: byDonor });
  await prisma.fundContribution.deleteMany({ where: byDonor });
  await prisma.pledgeItem.deleteMany({ where: { pledge: { pledge_token: created.pledgeToken } } });
  await prisma.pendingPledge.deleteMany({ where: { pledge_token: created.pledgeToken } });
  await prisma.donation.deleteMany({ where: byDonor });
  await prisma.donor.deleteMany({ where: { id: { in: created.donors } } });
  const byEvent = { event_id: created.eventId };
  await prisma.reward.deleteMany({ where: byEvent });
  await prisma.pollOption.deleteMany({ where: { poll: byEvent } });
  await prisma.poll.deleteMany({ where: byEvent });
  await prisma.fundGoal.deleteMany({ where: byEvent });
  await prisma.channel.deleteMany({ where: byEvent });
  await prisma.event.deleteMany({ where: { id: created.eventId } });
  await prisma.$disconnect();
});

describe.skipIf(!docsPresent)('documented samples', () => {
  const documented = docsPresent
    ? new Map([
        ...samples(read('docs/outbound-events.md')),
        ...samples(read('docs/api-consumers.md')),
      ])
    : new Map<string, unknown>();

  it('documents every message type, the Tiltify messages and the owner lookup', () => {
    // incentive.enabled and donation.unhidden share data with a documented twin (below).
    const native = WEBHOOK_MESSAGE_TYPES.filter(
      (type) => !['incentive.enabled', 'donation.unhidden', 'incentive.created'].includes(type),
    ).map((type) => `native:${type}`);
    expect([...documented.keys()].sort()).toEqual(
      [
        ...native,
        'native:incentive.created:REWARD',
        'native:incentive.created:GOAL',
        'tiltify:donation',
        'tiltify:fact.updated',
        'lookup:targets',
      ].sort(),
    );
  });

  it('every sample has the shape of the real payload', () => {
    for (const [key, sample] of documented) {
      expect(real.has(key), key).toBe(true);
      expect(shapeDiff(sample, real.get(key)), key).toEqual([]);
    }
  });

  it('documented twins share their sample data shape', () => {
    const data = (key: string) => (real.get(key) as { data: unknown }).data;
    const sampleData = (key: string) => (documented.get(key) as { data: unknown }).data;
    expect(
      shapeDiff(sampleData('native:incentive.disabled'), data('native:incentive.enabled')),
    ).toEqual([]);
    expect(
      shapeDiff(sampleData('native:donation.hidden'), data('native:donation.unhidden')),
    ).toEqual([]);
  });

  it('OpenAPI incentive examples have the shape of the public list rows', () => {
    const spec = yaml.load(read('server/openapi.yaml')) as {
      components: { schemas: Record<string, { example: unknown }> };
    };
    for (const name of ['Reward', 'Poll', 'FundGoal'] as const) {
      expect(publicRows[name], name).toBeTruthy();
      expect(shapeDiff(spec.components.schemas[name]!.example, publicRows[name]), name).toEqual([]);
    }
  });
});
