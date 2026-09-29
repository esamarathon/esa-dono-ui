import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import adminRouter from '../../../routes/admin.js';
import { createPledge } from '../../../services/pledge.js';

/**
 * Golden contract tests for the Tiltify format (PRD-0002 §T, #116). The shapes here
 * are what kollekt (esamarathon/kollekt@524f276) and esa-layouts-v2
 * (esamarathon/esa-layouts-v2@1c8ea49) parse; a change that breaks one of these
 * assertions breaks a consumer.
 */

const prisma = new PrismaClient();
const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

type Msg = { message_type: string; routing_key: string | null; body: Record<string, any> };

describe('Tiltify messages (PRD-0002 §T)', () => {
  const ids = {
    destinations: [] as string[],
    donors: [] as string[],
    donations: [] as string[],
    pledges: [] as string[],
    rewards: [] as string[],
    polls: [] as string[],
    goals: [] as string[],
  };
  let eventId = '';
  let channelId = '';
  let eventSlug = '';
  let channelSlug = '';
  let tiltifyDest = '';
  let nativeDest = '';

  beforeAll(async () => {
    const event = await prisma.event.create({
      data: { name: 'Tiltify Contract', slug: `tiltify-event-${rand()}` },
    });
    eventId = event.id;
    eventSlug = event.slug;
    const channel = await prisma.channel.create({
      data: { name: 'Contract Channel', slug: `tiltify-chan-${rand()}`, event_id: eventId },
    });
    channelId = channel.id;
    channelSlug = channel.slug;

    const make = async (body: Record<string, unknown>) => {
      const res = await request(createApp()).post('/api/admin/destinations').set(AUTH).send(body);
      expect(res.status).toBe(201);
      ids.destinations.push(res.body.id);
      return res.body.id as string;
    };
    tiltifyDest = await make({
      destination_type: 'RABBITMQ',
      amqp_url: 'amqp://127.0.0.1:1',
      payload_format: 'TILTIFY',
    });
    nativeDest = await make({
      destination_type: 'RABBITMQ',
      amqp_url: 'amqp://127.0.0.1:1',
      amqp_routing_key: 'native',
      event_types: [
        'donation.created',
        'donation.moderated',
        'donation.hidden',
        'donation.unhidden',
      ],
    });
    // The broker is unreachable on purpose: rows stay PENDING for inspection.
    await prisma.webhookDestination.updateMany({
      where: { id: { in: ids.destinations } },
      data: { is_active: true },
    });
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({
      where: { destination_id: { in: ids.destinations } },
    });
    await prisma.webhookDestinationSeq.deleteMany({
      where: { destination_id: { in: ids.destinations } },
    });
    await prisma.webhookDestination.deleteMany({ where: { id: { in: ids.destinations } } });
    await prisma.rewardClaim.deleteMany({ where: { reward_id: { in: ids.rewards } } });
    await prisma.pollVote.deleteMany({ where: { poll_id: { in: ids.polls } } });
    await prisma.fundContribution.deleteMany({ where: { goal_id: { in: ids.goals } } });
    await prisma.pledgeItem.deleteMany({ where: { pledge_id: { in: ids.pledges } } });
    await prisma.pendingPledge.deleteMany({ where: { id: { in: ids.pledges } } });
    await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: ids.donors } } });
    await prisma.donation.deleteMany({ where: { donor_id: { in: ids.donors } } });
    await prisma.donor.deleteMany({ where: { id: { in: ids.donors } } });
    await prisma.reward.deleteMany({ where: { id: { in: ids.rewards } } });
    await prisma.pollOption.deleteMany({ where: { poll_id: { in: ids.polls } } });
    await prisma.poll.deleteMany({ where: { id: { in: ids.polls } } });
    await prisma.fundGoal.deleteMany({ where: { id: { in: ids.goals } } });
    await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
    await prisma.$disconnect();
  });

  /** Messages queued for a Destination after `afterSeq`, in queue order. */
  async function messages(destinationId: string, afterSeq = 0): Promise<Msg[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { destination_id: destinationId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      message_type: r.message_type,
      routing_key: r.routing_key,
      body: JSON.parse(r.payload),
    }));
  }

  async function lastSeq(destinationId: string) {
    const row = await prisma.webhookDestinationSeq.findUnique({
      where: { destination_id: destinationId },
    });
    return row?.seq ?? 0;
  }

  async function donate(body: Record<string, unknown>) {
    const res = await request(createApp())
      .post('/api/admin/simulate-donation')
      .set(AUTH)
      .send({ external_id: `tiltify-${crypto.randomUUID()}`, ...body });
    expect(res.status).toBe(200);
    ids.donors.push(res.body.donor.id);
    ids.donations.push(res.body.donation.id);
    return res.body.donation.id as string;
  }

  /** A donation paying a pledge with 2 reward units, a poll vote and a goal contribution. */
  async function donateWithIncentives() {
    const reward = await prisma.reward.create({
      data: { title: 'Shoutout', type: 'DIGITAL', cost_cents: 300, quantity_total: 10 },
    });
    ids.rewards.push(reward.id);
    const poll = await prisma.poll.create({
      data: {
        title: 'Pick',
        is_active: true,
        options: { create: [{ label: 'A' }, { label: 'B' }] },
      },
      include: { options: true },
    });
    ids.polls.push(poll.id);
    const goal = await prisma.fundGoal.create({ data: { title: 'Goal', target_cents: 10000 } });
    ids.goals.push(goal.id);

    const email = `tiltify-${rand()}@example.com`;
    const pledge = await createPledge({
      email,
      display_name: 'Contract Donor',
      comment: 'Hello stream',
      channel_id: channelId,
      items: [
        { kind: 'REWARD', target_id: reward.id, quantity: 2 },
        { kind: 'POLL_VOTE', poll_id: poll.id, target_id: poll.options[1].id, amount_cents: 200 },
        { kind: 'GOAL', target_id: goal.id, amount_cents: 150 },
      ],
    });
    ids.pledges.push(
      (
        await prisma.pendingPledge.findUniqueOrThrow({
          where: { pledge_token: pledge.pledge_token },
        })
      ).id,
    );
    const donationId = await donate({
      email,
      amount_cents: pledge.total_cents,
      pledge_token: pledge.pledge_token,
    });
    return { donationId, reward, poll, goal, total: pledge.total_cents };
  }

  it('rejects TILTIFY on an HTTP Destination (§T1)', async () => {
    const res = await request(createApp())
      .post('/api/admin/destinations')
      .set(AUTH)
      .send({
        destination_type: 'HTTP',
        url: 'https://example.com/hook',
        payload_format: 'TILTIFY',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/TILTIFY requires destination_type RABBITMQ/);

    const put = await request(createApp())
      .put(`/api/admin/destinations/${tiltifyDest}`)
      .set(AUTH)
      .send({ destination_type: 'HTTP' });
    expect(put.status).toBe(400);
  });

  it('a donation publishes the bare donation and both totals, in that order (§T4, §T7)', async () => {
    const before = await lastSeq(tiltifyDest);
    const { donationId, reward, poll, goal, total } = await donateWithIncentives();
    const msgs = await messages(tiltifyDest, before);

    expect(msgs.map((m) => m.routing_key)).toEqual([
      `${channelSlug}.donation`,
      `${channelSlug}.fact.updated`,
      `${eventSlug}.fact.updated`,
    ]);

    const d = msgs[0].body;
    // Top level IS the donation: no envelope.
    expect(d).not.toHaveProperty('meta');
    expect(d).not.toHaveProperty('data');
    expect(d.id).toBe(donationId);
    for (const id of [
      d.id,
      d.campaign_id,
      d.team_event_id,
      d.reward_id,
      d.poll_id,
      d.poll_option_id,
      d.target_id,
    ]) {
      expect(id).toMatch(UUID);
    }
    expect(d.campaign_id).toBe(channelId);
    expect(d.team_event_id).toBe(eventId);
    expect(d.amount).toEqual({
      currency: 'USD',
      value: (total / 100).toFixed(2),
      value_cents: total,
    });
    expect(typeof d.amount.value).toBe('string');
    expect(d.amount.value).toMatch(/^\d+\.\d{2}$/);
    expect(d.donor_name).toBe('Contract Donor');
    expect(d.donor_comment).toBe('Hello stream');
    expect(d.completed_at).toBe(d.created_at);
    expect(new Date(d.completed_at).toISOString()).toBe(d.completed_at);

    // Scalars carry the first item; arrays the full set (§T4).
    expect(d.reward_id).toBe(reward.id);
    expect(d.reward_claims).toHaveLength(2);
    for (const c of d.reward_claims) {
      expect(c.id).toMatch(UUID);
      expect(c).toMatchObject({ reward_id: reward.id, quantity: 1 });
    }
    expect(d.poll_id).toBe(poll.id);
    expect(d.poll_option_id).toBe(poll.options[1].id);
    expect(d.poll_votes).toEqual([{ poll_id: poll.id, poll_option_id: poll.options[1].id }]);
    expect(d.target_id).toBe(goal.id);
    expect(d.target_contributions).toEqual([
      { target_id: goal.id, amount: { currency: 'USD', value: '1.50' } },
    ]);
    for (const k of ['cause_id', 'fundraising_event_id', 'legacy_id', 'sustained', 'email']) {
      expect(d).not.toHaveProperty(k);
    }

    const [channelTotal, eventTotal] = [msgs[1].body, msgs[2].body];
    expect(channelTotal).toMatchObject({
      id: channelId,
      slug: channelSlug,
      name: 'Contract Channel',
    });
    expect(eventTotal).toMatchObject({ id: eventId, slug: eventSlug, name: 'Tiltify Contract' });
    expect(channelTotal.total_amount_raised.currency).toBe('USD');
    expect(channelTotal.total_amount_raised.value).toMatch(/^\d+\.\d{2}$/);

    // The NATIVE Destination gets the envelope, with the public display data.
    const native = (await messages(nativeDest)).find(
      (m) => m.body.data?.donation_id === donationId,
    )!;
    expect(native.message_type).toBe('donation.created');
    expect(native.routing_key).toBeNull();
    expect(native.body.data).toMatchObject({
      event_id: eventId,
      channel_id: channelId,
      donor_name: 'Contract Donor',
      donor_comment: 'Hello stream',
      hidden_from_overlay: false,
    });
  });

  it('a donation without a display name is "Anonymous", never empty (§T9)', async () => {
    const before = await lastSeq(tiltifyDest);
    await donate({ email: `anon-${rand()}@example.com`, amount_cents: 700, channel_id: channelId });
    const [d] = await messages(tiltifyDest, before);
    expect(d.body.donor_name).toBe('Anonymous');
    expect(d.body.donor_comment).toBeNull();
    expect(d.body.reward_claims).toEqual([]);
    expect(d.body.reward_id).toBeNull();
  });

  it('hide republishes as Anonymous without completed_at; un-hide republishes in full (§T5, §T6)', async () => {
    const { donationId } = await donateWithIncentives();
    const { default: moderatorRouter } = await import('../../../routes/moderator.js');
    const app = express();
    app.use(express.json());
    app.use('/api/moderator', moderatorRouter);
    const MOD = { Authorization: 'Bearer key_admin_test-admin-key' };

    let before = await lastSeq(tiltifyDest);
    let nativeBefore = await lastSeq(nativeDest);
    const hide = await request(app)
      .patch(`/api/moderator/donations/${donationId}`)
      .set(MOD)
      .send({ hidden_from_overlay: true });
    expect(hide.status).toBe(200);
    let msgs = await messages(tiltifyDest, before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].routing_key).toBe(`${channelSlug}.donation`);
    expect(msgs[0].body).toMatchObject({
      id: donationId,
      donor_name: 'Anonymous',
      donor_comment: null,
    });
    expect(msgs[0].body).not.toHaveProperty('completed_at');
    let native = await messages(nativeDest, nativeBefore);
    expect(native.map((m) => m.message_type)).toEqual(['donation.hidden']);
    expect(native[0].body.data).toMatchObject({ donor_name: null, donor_comment: null });

    // Hiding again changes nothing and publishes nothing.
    before = await lastSeq(tiltifyDest);
    await request(app)
      .patch(`/api/moderator/donations/${donationId}`)
      .set(MOD)
      .send({ hidden_from_overlay: true });
    expect(await messages(tiltifyDest, before)).toHaveLength(0);

    nativeBefore = await lastSeq(nativeDest);
    const show = await request(app)
      .patch(`/api/moderator/donations/${donationId}`)
      .set(MOD)
      .send({ hidden_from_overlay: false });
    expect(show.status).toBe(200);
    msgs = await messages(tiltifyDest, before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toMatchObject({
      donor_name: 'Contract Donor',
      donor_comment: 'Hello stream',
    });
    expect(msgs[0].body.completed_at).toBeTruthy();
    native = await messages(nativeDest, nativeBefore);
    expect(native.map((m) => m.message_type)).toEqual(['donation.unhidden']);
    expect(native[0].body.data.donor_name).toBe('Contract Donor');
  });

  it('the moderated toggle publishes only the native message, never TILTIFY (§T8)', async () => {
    const donationId = await donate({
      email: `mod-${rand()}@example.com`,
      amount_cents: 400,
      channel_id: channelId,
    });
    const { default: moderatorRouter } = await import('../../../routes/moderator.js');
    const app = express();
    app.use(express.json());
    app.use('/api/moderator', moderatorRouter);

    const before = await lastSeq(tiltifyDest);
    const nativeBefore = await lastSeq(nativeDest);
    const res = await request(app)
      .patch(`/api/moderator/donations/${donationId}`)
      .set({ Authorization: 'Bearer key_admin_test-admin-key' })
      .send({ moderated: true });
    expect(res.status).toBe(200);
    expect(await messages(tiltifyDest, before)).toHaveLength(0);
    expect((await messages(nativeDest, nativeBefore)).map((m) => m.message_type)).toEqual([
      'donation.moderated',
    ]);
  });

  it('a refund keeps the totals; a chargeback lowers them (§T7, lib/donationTotals.ts)', async () => {
    const totalOf = async (afterSeq: number) => {
      const msgs = await messages(tiltifyDest, afterSeq);
      expect(msgs.map((m) => m.routing_key)).toEqual([
        `${channelSlug}.fact.updated`,
        `${eventSlug}.fact.updated`,
      ]);
      return Number(msgs[0].body.total_amount_raised.value);
    };
    const refunded = await donate({
      email: `ref-${rand()}@example.com`,
      amount_cents: 1000,
      channel_id: channelId,
    });
    const charged = await donate({
      email: `cb-${rand()}@example.com`,
      amount_cents: 2500,
      channel_id: channelId,
    });

    let before = await lastSeq(tiltifyDest);
    await request(createApp())
      .patch(`/api/admin/donations/${refunded}/status`)
      .set(AUTH)
      .send({ status: 'REFUNDED' })
      .expect(200);
    const afterRefund = await totalOf(before);

    before = await lastSeq(tiltifyDest);
    await request(createApp())
      .patch(`/api/admin/donations/${charged}/status`)
      .set(AUTH)
      .send({ status: 'CHARGEBACK' })
      .expect(200);
    const afterChargeback = await totalOf(before);

    expect(afterRefund - afterChargeback).toBeCloseTo(25, 2);
  });

  it('an unassigned donation publishes nothing until it is assigned (§E6)', async () => {
    const before = await lastSeq(tiltifyDest);
    // No channel and no active event: route it into an Event without a primary.
    const orphanEvent = await prisma.event.create({
      data: { name: 'No Primary', slug: `no-primary-${rand()}` },
    });
    try {
      const donationId = await donate({
        email: `un-${rand()}@example.com`,
        amount_cents: 300,
        event_id: orphanEvent.id,
      });
      expect(await messages(tiltifyDest, before)).toHaveLength(0);

      const res = await request(createApp())
        .patch(`/api/admin/donations/${donationId}/channel`)
        .set(AUTH)
        .send({ channel_id: channelId });
      expect(res.status).toBe(200);
      expect((await messages(tiltifyDest, before)).map((m) => m.routing_key)).toEqual([
        `${channelSlug}.donation`,
        `${channelSlug}.fact.updated`,
        `${eventSlug}.fact.updated`,
      ]);
    } finally {
      await prisma.event.delete({ where: { id: orphanEvent.id } });
    }
  });
});
