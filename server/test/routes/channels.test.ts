import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import channelsRouter from '../../routes/channels.js';
import adminRouter from '../../routes/admin.js';
import moderatorRouter from '../../routes/moderator.js';
import { createTestChannel, DEFAULT_EVENT_ID } from '../helpers/fixtures.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', channelsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/moderator', moderatorRouter);
  return app;
}

async function makeModerator() {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `mod-events-${Date.now()}-${Math.random()}@example.com`,
      role: 'MODERATOR',
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

describe('Channels', () => {
  const createdChannelIds: string[] = [];
  const createdDonorIds: string[] = [];
  const createdEventIds: string[] = [];

  beforeAll(() => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterAll(async () => {
    await prisma.donation.deleteMany({ where: { donor_id: { in: createdDonorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: createdDonorIds } } });
    // Events may point at a channel we created (FK), so clear those first.
    await prisma.event.updateMany({
      where: { primary_channel_id: { in: createdChannelIds } },
      data: { primary_channel_id: null },
    });
    await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    await prisma.$disconnect();
  });

  describe('GET /api/channels (public)', () => {
    it('returns only active channels', async () => {
      const active = await createTestChannel(prisma, {
        name: `Public Active ${crypto.randomUUID()}`,
      });
      const inactive = await createTestChannel(prisma, {
        name: `Public Inactive ${crypto.randomUUID()}`,
        is_active: false,
      });
      createdChannelIds.push(active.id, inactive.id);

      const res = await request(createApp()).get('/api/channels');

      expect(res.status).toBe(200);
      const ids = res.body.map((s: any) => s.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(inactive.id);
    });
  });

  describe('Admin channels CRUD', () => {
    const auth = { Authorization: 'Bearer key_admin_test-admin-key' };

    it('rejects non-admin requests', async () => {
      const res = await request(createApp()).get('/api/admin/channels');
      expect(res.status).toBe(401);
    });

    it('creates, updates, and deactivates a channel', async () => {
      const createRes = await request(createApp())
        .post('/api/admin/channels')
        .send({ name: `Admin Event ${crypto.randomUUID()}` })
        .set(auth);
      expect(createRes.status).toBe(200);
      expect(createRes.body.is_active).toBe(true);
      createdChannelIds.push(createRes.body.id);

      const updateRes = await request(createApp())
        .put(`/api/admin/channels/${createRes.body.id}`)
        .send({ name: 'Renamed Event' })
        .set(auth);
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.name).toBe('Renamed Event');

      const deleteRes = await request(createApp())
        .delete(`/api/admin/channels/${createRes.body.id}`)
        .set(auth);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.channel.is_active).toBe(false);

      // Soft-deleted, not removed — still fetchable via admin list.
      const listRes = await request(createApp()).get('/api/admin/channels').set(auth);
      expect(listRes.body.some((s: any) => s.id === createRes.body.id)).toBe(true);
    });

    it('rejects duplicate channel names', async () => {
      const name = `Dup Event ${crypto.randomUUID()}`;
      const first = await request(createApp()).post('/api/admin/channels').send({ name }).set(auth);
      createdChannelIds.push(first.body.id);

      const second = await request(createApp())
        .post('/api/admin/channels')
        .send({ name })
        .set(auth);
      expect(second.status).toBe(409);
    });

    it('includes per-channel raised totals in /admin/stats', async () => {
      const channel = await createTestChannel(prisma, {
        name: `Stats Channel ${crypto.randomUUID()}`,
      });
      createdChannelIds.push(channel.id);

      const donor = await prisma.donor.create({
        data: {
          email: `stats-${crypto.randomUUID()}@example.com`,
          total_donated: 1000,
          balance_remaining: 1000,
        },
      });
      createdDonorIds.push(donor.id);

      await prisma.donation.create({
        data: {
          external_id: `stats-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 1000,
          channel_id: channel.id,
        },
      });

      const res = await request(createApp()).get('/api/admin/stats').set(auth);
      expect(res.status).toBe(200);
      const entry = res.body.channels.find((s: any) => s.id === channel.id);
      expect(entry).toBeTruthy();
      expect(entry.raised_cents).toBe(1000);
      expect(entry.donations).toBe(1);
    });
  });

  describe('Moderator channels CRUD', () => {
    it('rejects non-moderator requests', async () => {
      const res = await request(createApp()).get('/api/moderator/channels');
      expect(res.status).toBe(401);
    });

    it('creates and updates a channel', async () => {
      const { token } = await makeModerator();

      const createRes = await request(createApp())
        .post('/api/moderator/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Moderator Event ${crypto.randomUUID()}` });
      expect(createRes.status).toBe(200);
      createdChannelIds.push(createRes.body.id);

      const updateRes = await request(createApp())
        .put(`/api/moderator/channels/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ is_active: false });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.is_active).toBe(false);
    });
  });

  describe('channel identity rules', () => {
    const auth = { Authorization: 'Bearer key_admin_test-admin-key' };
    const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

    async function makeEvent(name: string, slug = `qa-${rand()}`) {
      const event = await prisma.event.create({ data: { name, slug } });
      createdEventIds.push(event.id);
      return event;
    }

    it('derives a slug from the name and uses the given event_id', async () => {
      const suffix = rand();
      const res = await request(createApp())
        .post('/api/admin/channels')
        .send({ name: `QA Stream ${suffix}`, event_id: DEFAULT_EVENT_ID })
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(`qa-stream-${suffix}`);
      expect(res.body.event_id).toBe(DEFAULT_EVENT_ID);
      createdChannelIds.push(res.body.id);
    });

    it('uses the only event when event_id is omitted, and requires it when there are several', async () => {
      // Other test files may leave extra Events behind, so assert whichever rule
      // applies to the Events that exist right now; both branches are real checks.
      const suffix = rand();
      const events = await prisma.event.count();
      const res = await request(createApp())
        .post('/api/admin/channels')
        .send({ name: `QA Fallback ${suffix}` })
        .set(auth);
      if (events === 1) {
        expect(res.status).toBe(200);
        expect(res.body.slug).toBe(`qa-fallback-${suffix}`);
        expect(res.body.event_id).toBe(DEFAULT_EVENT_ID);
        createdChannelIds.push(res.body.id);
      } else {
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/event_id is required/);
      }
    });

    it('rejects a non-boolean is_active with 400 (it must not bypass the primary-channel rule)', async () => {
      const event = await makeEvent(`Bool Guard ${rand()}`);
      const channel = await createTestChannel(prisma, {
        name: `Bool ${rand()}`,
        event_id: event.id,
      });
      createdChannelIds.push(channel.id);
      await prisma.event.update({
        where: { id: event.id },
        data: { primary_channel_id: channel.id, is_active: true },
      });

      for (const value of ['false', 0, null]) {
        const res = await request(createApp())
          .put(`/api/admin/channels/${channel.id}`)
          .send({ is_active: value })
          .set(auth);
        expect(res.status).toBe(400);
      }
      expect((await prisma.channel.findUnique({ where: { id: channel.id } }))!.is_active).toBe(
        true,
      );
    });

    it('rejects an invalid slug with 400', async () => {
      const res = await request(createApp())
        .post('/api/admin/channels')
        .send({ name: `Bad Slug ${rand()}`, slug: 'Bad.Slug', event_id: DEFAULT_EVENT_ID })
        .set(auth);
      expect(res.status).toBe(400);
    });

    it('rejects a slug already used by an Event with 409', async () => {
      const slug = `qa-taken-${rand()}`;
      await makeEvent(`Taken ${rand()}`, slug);

      const res = await request(createApp())
        .post('/api/admin/channels')
        .send({ name: `Taken Slug ${rand()}`, slug, event_id: DEFAULT_EVENT_ID })
        .set(auth);
      expect(res.status).toBe(409);
    });

    it('rejects an unknown event_id with 400', async () => {
      const res = await request(createApp())
        .post('/api/admin/channels')
        .send({ name: `Unknown Event ${rand()}`, event_id: 'does-not-exist' })
        .set(auth);
      expect(res.status).toBe(400);
    });

    it('rejects a slug change on an active channel with 409', async () => {
      const channel = await createTestChannel(prisma, { name: `Active Slug ${rand()}` });
      createdChannelIds.push(channel.id);

      const res = await request(createApp())
        .put(`/api/admin/channels/${channel.id}`)
        .send({ slug: `qa-new-${rand()}` })
        .set(auth);
      expect(res.status).toBe(409);
    });

    it('allows a slug change on an inactive channel', async () => {
      const channel = await createTestChannel(prisma, {
        name: `Inactive Slug ${rand()}`,
        is_active: false,
      });
      createdChannelIds.push(channel.id);
      const newSlug = `qa-inactive-${rand()}`;

      const res = await request(createApp())
        .put(`/api/admin/channels/${channel.id}`)
        .send({ slug: newSlug })
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(newSlug);
    });

    it('protects the primary channel of an active event from deactivation/deletion', async () => {
      const event = await makeEvent(`Primary Guard ${rand()}`);
      const channel = await createTestChannel(prisma, {
        name: `Primary ${rand()}`,
        event_id: event.id,
      });
      createdChannelIds.push(channel.id);
      await prisma.event.update({
        where: { id: event.id },
        data: { primary_channel_id: channel.id, is_active: true },
      });

      const deactivateRes = await request(createApp())
        .put(`/api/admin/channels/${channel.id}`)
        .send({ is_active: false })
        .set(auth);
      expect(deactivateRes.status).toBe(409);

      const deleteRes = await request(createApp())
        .delete(`/api/admin/channels/${channel.id}`)
        .set(auth);
      expect(deleteRes.status).toBe(409);

      // Once the event is no longer active, the channel may be deactivated.
      await prisma.event.update({ where: { id: event.id }, data: { is_active: false } });

      const retryRes = await request(createApp())
        .delete(`/api/admin/channels/${channel.id}`)
        .set(auth);
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.channel.is_active).toBe(false);
    });

    it('rejects moving the primary channel of an active event to another event with 409', async () => {
      const event = await makeEvent(`Move Guard ${rand()}`);
      const otherEvent = await makeEvent(`Move Target ${rand()}`);
      const channel = await createTestChannel(prisma, {
        name: `Move Primary ${rand()}`,
        event_id: event.id,
      });
      createdChannelIds.push(channel.id);
      await prisma.event.update({
        where: { id: event.id },
        data: { primary_channel_id: channel.id, is_active: true },
      });

      const res = await request(createApp())
        .put(`/api/admin/channels/${channel.id}`)
        .send({ event_id: otherEvent.id })
        .set(auth);
      expect(res.status).toBe(409);
    });

    it('applies the slug rule through /api/moderator/channels too', async () => {
      const { token } = await makeModerator();
      const channel = await createTestChannel(prisma, { name: `Mod Slug ${rand()}` });
      createdChannelIds.push(channel.id);

      const res = await request(createApp())
        .put(`/api/moderator/channels/${channel.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ slug: `qa-mod-${rand()}` });
      expect(res.status).toBe(409);
    });
  });
});
