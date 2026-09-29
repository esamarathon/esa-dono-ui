import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import webhookRouter from '../../routes/webhook.js';
import adminRouter from '../../routes/admin.js';
import { createTestChannel } from '../helpers/fixtures.js';
import { createPledge } from '../../services/pledge.js';

const prisma = new PrismaClient();

const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };

function createApp() {
  const app = express();
  // Mirrors index.ts: the webhook router needs the raw body before express.json().
  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRouter);
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

describe('Donation routing (resolveDonationRoute via HTTP)', () => {
  const channelIds: string[] = [];
  const eventIds: string[] = [];
  const donorIds: string[] = [];
  const donationIds: string[] = [];
  const externalIds: string[] = [];
  const pledgeIds: string[] = [];
  const destinationIds: string[] = [];

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { destination_id: { in: destinationIds } } });
    await prisma.webhookDestinationSeq.deleteMany({
      where: { destination_id: { in: destinationIds } },
    });
    await prisma.webhookDestination.deleteMany({ where: { id: { in: destinationIds } } });
    // Pledges hold an FK to their fulfilling Donation, so drop them first.
    await prisma.pledgeItem.deleteMany({ where: { pledge_id: { in: pledgeIds } } });
    await prisma.pendingPledge.deleteMany({ where: { id: { in: pledgeIds } } });
    await prisma.donation.deleteMany({
      where: {
        OR: [
          { external_id: { in: externalIds } },
          { donor_id: { in: donorIds } },
          { id: { in: donationIds } },
        ],
      },
    });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.event.updateMany({
      where: { id: { in: eventIds } },
      data: { primary_channel_id: null },
    });
    await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
  });

  /** A raw Event row, tracked for cleanup. */
  async function makeEvent(name: string) {
    const event = await prisma.event.create({
      data: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rand()}` },
    });
    eventIds.push(event.id);
    return event;
  }

  /** A Channel of `event`, tracked for cleanup. */
  async function makeChannel(eventId: string, is_active = true) {
    const channel = await createTestChannel(prisma, { event_id: eventId, is_active });
    channelIds.push(channel.id);
    return channel;
  }

  /**
   * Set the world so exactly `targetIds` are active, then restore every Event's
   * previous is_active flag in `finally`. Direct `event.update` bypasses
   * assertCanActivateEvent, which the test state needs; the restore makes it exact.
   */
  async function withActiveEvents(targetIds: string[], fn: () => Promise<void>) {
    const before = await prisma.event.findMany({ select: { id: true, is_active: true } });
    try {
      await prisma.event.updateMany({ where: {}, data: { is_active: false } });
      if (targetIds.length > 0) {
        await prisma.event.updateMany({
          where: { id: { in: targetIds } },
          data: { is_active: true },
        });
      }
      await fn();
    } finally {
      await prisma.event.updateMany({ where: {}, data: { is_active: false } });
      const wasActive = before.filter((e) => e.is_active).map((e) => e.id);
      if (wasActive.length > 0) {
        await prisma.event.updateMany({
          where: { id: { in: wasActive } },
          data: { is_active: true },
        });
      }
    }
  }

  async function donate(body: Record<string, unknown>) {
    const externalId = (body.external_id as string | undefined) ?? `route-${crypto.randomUUID()}`;
    externalIds.push(externalId);
    const res = await request(createApp())
      .post('/api/admin/simulate-donation')
      .set(AUTH)
      .send({ amount_cents: 500, ...body, external_id: externalId });
    if (res.body?.donor?.id) donorIds.push(res.body.donor.id);
    if (res.body?.donation?.id) donationIds.push(res.body.donation.id);
    return res;
  }

  it('rule 1: an explicit channel_id routes to that channel and its event', async () => {
    const event = await makeEvent(`Rule One ${rand()}`);
    const channel = await makeChannel(event.id, true);

    const res = await donate({ email: `rule1-${rand()}@example.com`, channel_id: channel.id });

    expect(res.status).toBe(200);
    expect(res.body.donation.channel_id).toBe(channel.id);
    expect(res.body.donation.event_id).toBe(event.id);

    const row = await prisma.donation.findUnique({ where: { id: res.body.donation.id } });
    expect(row!.channel_id).toBe(channel.id);
    expect(row!.event_id).toBe(event.id);
  });

  it('rule 2: an explicit event_id routes to its primary channel', async () => {
    const event = await makeEvent(`Rule Two ${rand()}`);
    const primary = await makeChannel(event.id, true);
    await prisma.event.update({
      where: { id: event.id },
      data: { primary_channel_id: primary.id },
    });

    const res = await donate({ email: `rule2-${rand()}@example.com`, event_id: event.id });

    expect(res.status).toBe(200);
    expect(res.body.donation.channel_id).toBe(primary.id);
    expect(res.body.donation.event_id).toBe(event.id);

    const row = await prisma.donation.findUnique({ where: { id: res.body.donation.id } });
    expect(row!.channel_id).toBe(primary.id);
    expect(row!.event_id).toBe(event.id);
  });

  it('rule 3: exactly one active event routes to its primary channel', async () => {
    const event = await makeEvent(`Rule Three ${rand()}`);
    const primary = await makeChannel(event.id, true);
    await prisma.event.update({
      where: { id: event.id },
      data: { primary_channel_id: primary.id },
    });

    await withActiveEvents([event.id], async () => {
      const res = await donate({ email: `rule3-${rand()}@example.com` });

      expect(res.status).toBe(200);
      expect(res.body.donation.channel_id).toBe(primary.id);
      expect(res.body.donation.event_id).toBe(event.id);

      const row = await prisma.donation.findUnique({ where: { id: res.body.donation.id } });
      expect(row!.channel_id).toBe(primary.id);
      expect(row!.event_id).toBe(event.id);
    });
  });

  it('rule 4: with zero active events the donation is unassigned and nothing is published', async () => {
    const destination = await prisma.webhookDestination.create({
      data: {
        url: 'http://127.0.0.1:1/hook',
        secret: 's',
        event_types: JSON.stringify(['donation.created']),
      },
    });
    destinationIds.push(destination.id);

    await withActiveEvents([], async () => {
      const res = await donate({ email: `rule4-${rand()}@example.com` });

      expect(res.status).toBe(200);
      expect(res.body.donation.channel_id).toBeNull();
      expect(res.body.donation.event_id).toBeNull();

      const row = await prisma.donation.findUnique({ where: { id: res.body.donation.id } });
      expect(row!.channel_id).toBeNull();
      expect(row!.event_id).toBeNull();

      const deliveries = await prisma.webhookDelivery.count({
        where: { destination_id: destination.id },
      });
      expect(deliveries).toBe(0);
    });
  });

  it('an event_id whose event has no primary channel leaves the donation unassigned (assignable)', async () => {
    const event = await makeEvent(`No Primary ${rand()}`);
    const channel = await makeChannel(event.id, true);

    const res = await donate({ email: `noprimary-${rand()}@example.com`, event_id: event.id });

    expect(res.status).toBe(200);
    // Not half-routed (event set, channel null): that could never be assigned.
    expect(res.body.donation).toMatchObject({ channel_id: null, event_id: null });
    const assign = await request(createApp())
      .patch(`/api/admin/donations/${res.body.donation.id}/channel`)
      .set(AUTH)
      .send({ channel_id: channel.id });
    expect(assign.status).toBe(200);
    expect(assign.body).toMatchObject({ channel_id: channel.id, event_id: event.id });
  });

  it('rejects an unknown channel_id with 400', async () => {
    const res = await donate({
      email: `badch-${rand()}@example.com`,
      channel_id: 'does-not-exist',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown event_id with 400', async () => {
    const res = await donate({ email: `badev-${rand()}@example.com`, event_id: 'does-not-exist' });
    expect(res.status).toBe(400);
  });

  it('routes a pledge donation to the pledge channel, ignoring a different event_id', async () => {
    const pledgeEvent = await makeEvent(`Pledge Event ${rand()}`);
    const pledgeChannel = await makeChannel(pledgeEvent.id, true);
    const otherEvent = await makeEvent(`Other Event ${rand()}`);
    const otherPrimary = await makeChannel(otherEvent.id, true);
    await prisma.event.update({
      where: { id: otherEvent.id },
      data: { primary_channel_id: otherPrimary.id },
    });

    const pledge = await createPledge({
      items: [],
      top_up_cents: 500,
      channel_id: pledgeChannel.id,
    });
    pledgeIds.push(
      (
        await prisma.pendingPledge.findUniqueOrThrow({
          where: { pledge_token: pledge.pledge_token },
        })
      ).id,
    );

    // All Events inactive: if the code preferred the explicit event_id, it would
    // route to otherPrimary; the pledge's channel must win.
    await withActiveEvents([], async () => {
      const res = await donate({
        email: `pledge-${rand()}@example.com`,
        pledge_token: pledge.pledge_token,
        event_id: otherEvent.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.donation.channel_id).toBe(pledgeChannel.id);
      expect(res.body.donation.event_id).toBe(pledgeEvent.id);

      const row = await prisma.donation.findUnique({ where: { id: res.body.donation.id } });
      expect(row!.channel_id).toBe(pledgeChannel.id);
      expect(row!.event_id).toBe(pledgeEvent.id);
    });
  });

  it('routes a Stripe webhook donation to the single active event primary channel', async () => {
    const event = await makeEvent(`Stripe Event ${rand()}`);
    const primary = await makeChannel(event.id, true);
    await prisma.event.update({
      where: { id: event.id },
      data: { primary_channel_id: primary.id },
    });

    const sessionId = `cs_route_${crypto.randomUUID()}`;
    externalIds.push(sessionId);

    await withActiveEvents([event.id], async () => {
      const payload = JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: sessionId,
            amount_total: 1500,
            customer_details: { email: `stripe-${rand()}@example.com`, name: 'Stripe Donor' },
          },
        },
      });

      const res = await request(createApp())
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      const row = await prisma.donation.findUnique({ where: { external_id: sessionId } });
      expect(row).not.toBeNull();
      expect(row!.channel_id).toBe(primary.id);
      expect(row!.event_id).toBe(event.id);
      donorIds.push(row!.donor_id);
    });
  });

  describe('PATCH /api/admin/donations/:id/channel', () => {
    async function makeUnassignedDonation() {
      const donor = await prisma.donor.create({
        data: { email: `assign-${rand()}@example.com` },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `assign-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 500,
        },
      });
      donationIds.push(donation.id);
      return donation;
    }

    it('assigns an unassigned donation and publishes exactly one donation.created', async () => {
      const event = await makeEvent(`Assign Event ${rand()}`);
      const channel = await makeChannel(event.id, true);
      const donation = await makeUnassignedDonation();

      const destination = await prisma.webhookDestination.create({
        data: {
          url: 'http://127.0.0.1:1/hook',
          secret: 's',
          event_types: JSON.stringify(['donation.created']),
        },
      });
      destinationIds.push(destination.id);

      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/channel`)
        .set(AUTH)
        .send({ channel_id: channel.id });

      expect(res.status).toBe(200);
      const row = await prisma.donation.findUnique({ where: { id: donation.id } });
      expect(row!.channel_id).toBe(channel.id);
      expect(row!.event_id).toBe(event.id);

      const deliveries = await prisma.webhookDelivery.findMany({
        where: { destination_id: destination.id, message_type: 'donation.created' },
      });
      expect(deliveries).toHaveLength(1);
      expect(JSON.parse(deliveries[0]!.payload).data.donation_id).toBe(donation.id);
    });

    it('rejects a second assignment with 409', async () => {
      const event = await makeEvent(`Assign Twice ${rand()}`);
      const channel = await makeChannel(event.id, true);
      const donation = await makeUnassignedDonation();

      const first = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/channel`)
        .set(AUTH)
        .send({ channel_id: channel.id });
      expect(first.status).toBe(200);

      const second = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/channel`)
        .set(AUTH)
        .send({ channel_id: channel.id });
      expect(second.status).toBe(409);
    });

    it('returns 404 for an unknown donation', async () => {
      const event = await makeEvent(`Assign Unknown ${rand()}`);
      const channel = await makeChannel(event.id, true);

      const res = await request(createApp())
        .patch('/api/admin/donations/does-not-exist/channel')
        .set(AUTH)
        .send({ channel_id: channel.id });
      expect(res.status).toBe(404);
    });

    it('rejects a missing channel_id with 400', async () => {
      const donation = await makeUnassignedDonation();
      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/channel`)
        .set(AUTH)
        .send({});
      expect(res.status).toBe(400);
    });

    it('rejects an unknown channel_id with 400', async () => {
      const donation = await makeUnassignedDonation();
      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/channel`)
        .set(AUTH)
        .send({ channel_id: 'does-not-exist' });
      expect(res.status).toBe(400);
    });
  });
});
