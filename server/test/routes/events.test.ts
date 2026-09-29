import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import adminRouter from '../../routes/admin.js';
import moderatorRouter from '../../routes/moderator.js';
import eventsRouter from '../../routes/events.js';
import { createTestChannel, ensureDefaultEvent } from '../helpers/fixtures.js';

const prisma = new PrismaClient();

const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/events', eventsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/moderator', moderatorRouter);
  return app;
}

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

describe('Events', () => {
  const createdChannelIds: string[] = [];
  const createdEventIds: string[] = [];
  const previousModeratorKey = process.env.MODERATOR_API_KEY;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.MODERATOR_API_KEY = 'test-moderator-key';
    await ensureDefaultEvent(prisma);
  });

  afterAll(async () => {
    // Channels reference their Event (Restrict); clear any primary pointers first.
    await prisma.event.updateMany({
      where: { id: { in: createdEventIds } },
      data: { primary_channel_id: null },
    });
    await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    if (previousModeratorKey === undefined) delete process.env.MODERATOR_API_KEY;
    else process.env.MODERATOR_API_KEY = previousModeratorKey;
    await prisma.$disconnect();
  });

  /** A raw Event row, tracked for cleanup. */
  async function makeEvent(name: string, data: Record<string, unknown> = {}) {
    const event = await prisma.event.create({
      data: { name, slug: `${slugify(name)}-${rand()}`, ...data },
    });
    createdEventIds.push(event.id);
    return event;
  }

  const slugify = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'event';

  /** A Channel of `event`, tracked for cleanup. */
  async function makeChannel(eventId: string, is_active = true) {
    const channel = await createTestChannel(prisma, { event_id: eventId, is_active });
    createdChannelIds.push(channel.id);
    return channel;
  }

  /** An Event with an active primary Channel (its own), tracked for cleanup. */
  async function makeActiveEvent(name: string) {
    const event = await makeEvent(name);
    const channel = await makeChannel(event.id, true);
    await prisma.event.update({
      where: { id: event.id },
      data: { primary_channel_id: channel.id, is_active: true },
    });
    return { event: { ...event, is_active: true, primary_channel_id: channel.id }, channel };
  }

  describe('Admin create', () => {
    it('derives a slug from the name', async () => {
      const suffix = rand();
      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ name: `QA Marathon ${suffix}` })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(`qa-marathon-${suffix}`);
      expect(res.body.is_active).toBe(false);
      createdEventIds.push(res.body.id);
    });

    it('uses an explicit slug', async () => {
      const slug = `qa-explicit-${rand()}`;
      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ name: `Explicit ${rand()}`, slug })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(slug);
      createdEventIds.push(res.body.id);
    });

    it('rejects an invalid slug with 400', async () => {
      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ name: `Bad ${rand()}`, slug: 'Bad.Slug' })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('rejects a slug already used by a Channel with 409', async () => {
      const slug = `qa-taken-${rand()}`;
      const channel = await createTestChannel(prisma, { slug });
      createdChannelIds.push(channel.id);

      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ name: `Taken ${rand()}`, slug })
        .set(AUTH);
      expect(res.status).toBe(409);
    });

    it('rejects is_active: true with 409 (an event starts with no primary channel)', async () => {
      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ name: `Active ${rand()}`, is_active: true })
        .set(AUTH);
      expect(res.status).toBe(409);
    });

    it('rejects a non-boolean is_active with 400', async () => {
      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ name: `Bool ${rand()}`, is_active: 'yes' })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('rejects a missing name with 400', async () => {
      const res = await request(createApp())
        .post('/api/admin/events')
        .send({ slug: `qa-noname-${rand()}` })
        .set(AUTH);
      expect(res.status).toBe(400);
    });
  });

  describe('Admin update', () => {
    it('renames an event', async () => {
      const event = await makeEvent(`Rename ${rand()}`);
      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ name: 'Renamed Event' })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed Event');
    });

    it('allows a slug change while inactive', async () => {
      const event = await makeEvent(`Inactive Slug ${rand()}`);
      const newSlug = `qa-inactive-${rand()}`;
      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ slug: newSlug })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(newSlug);
    });

    it('rejects a slug change while active with 409', async () => {
      const { event } = await makeActiveEvent(`Active Slug ${rand()}`);
      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ slug: `qa-active-${rand()}` })
        .set(AUTH);
      expect(res.status).toBe(409);
    });

    it('rejects a primary channel from another event with 400', async () => {
      const event = await makeEvent(`Primary Wrong ${rand()}`);
      const other = await makeEvent(`Primary Other ${rand()}`);
      const foreignChannel = await makeChannel(other.id, true);

      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ primary_channel_id: foreignChannel.id })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('rejects activation without a primary channel with 409', async () => {
      const event = await makeEvent(`No Primary ${rand()}`);
      await makeChannel(event.id, true);

      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ is_active: true })
        .set(AUTH);
      expect(res.status).toBe(409);
    });

    it('activates with an active primary channel', async () => {
      const event = await makeEvent(`Activate ${rand()}`);
      const channel = await makeChannel(event.id, true);

      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ primary_channel_id: channel.id, is_active: true })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.is_active).toBe(true);
      expect(res.body.primary_channel_id).toBe(channel.id);
    });

    it('rejects clearing the primary channel of an active event with 409', async () => {
      const { event } = await makeActiveEvent(`Keep Primary ${rand()}`);
      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ primary_channel_id: null })
        .set(AUTH);
      expect(res.status).toBe(409);
      const row = await prisma.event.findUnique({ where: { id: event.id } });
      expect(row!.primary_channel_id).toBe(event.primary_channel_id);
    });

    it('rejects activation when the primary channel is inactive with 409', async () => {
      const event = await makeEvent(`Inactive Primary ${rand()}`);
      const channel = await makeChannel(event.id, false);

      const res = await request(createApp())
        .put(`/api/admin/events/${event.id}`)
        .send({ primary_channel_id: channel.id, is_active: true })
        .set(AUTH);
      expect(res.status).toBe(409);
      const row = await prisma.event.findUnique({ where: { id: event.id } });
      expect(row!.is_active).toBe(false);
    });

    it('rejects an unknown event id with 404', async () => {
      const res = await request(createApp())
        .put('/api/admin/events/does-not-exist')
        .send({ name: 'Nope' })
        .set(AUTH);
      expect(res.status).toBe(404);
    });
  });

  describe('Admin delete', () => {
    it('deactivates the event and keeps the row', async () => {
      const { event } = await makeActiveEvent(`Delete ${rand()}`);
      const res = await request(createApp()).delete(`/api/admin/events/${event.id}`).set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.event.is_active).toBe(false);

      const row = await prisma.event.findUnique({ where: { id: event.id } });
      expect(row).not.toBeNull();
      expect(row!.is_active).toBe(false);
    });
  });

  describe('Moderator parity', () => {
    const modAuth = { Authorization: 'Bearer key_mod_test-moderator-key' };

    it('creates an event with the moderator key', async () => {
      const suffix = rand();
      const res = await request(createApp())
        .post('/api/moderator/events')
        .send({ name: `Moderator Marathon ${suffix}` })
        .set(modAuth);
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(`moderator-marathon-${suffix}`);
      createdEventIds.push(res.body.id);
    });

    it('rejects activation without a primary channel with 409', async () => {
      const event = await makeEvent(`Moderator No Primary ${rand()}`);
      await makeChannel(event.id, true);

      const res = await request(createApp())
        .put(`/api/moderator/events/${event.id}`)
        .send({ is_active: true })
        .set(modAuth);
      expect(res.status).toBe(409);
      const row = await prisma.event.findUnique({ where: { id: event.id } });
      expect(row!.is_active).toBe(false);
    });

    it('activates an event through the moderator route', async () => {
      const event = await makeEvent(`Moderator Activate ${rand()}`);
      const channel = await makeChannel(event.id, true);

      const res = await request(createApp())
        .put(`/api/moderator/events/${event.id}`)
        .send({ primary_channel_id: channel.id, is_active: true })
        .set(modAuth);
      expect(res.status).toBe(200);
      expect(res.body.is_active).toBe(true);
    });
  });

  describe('Public events', () => {
    it('lists active events with only their active channels, and no timestamps', async () => {
      const event = await makeEvent(`Public ${rand()}`);
      const active = await makeChannel(event.id, true);
      const inactive = await makeChannel(event.id, false);
      await prisma.event.update({
        where: { id: event.id },
        data: { primary_channel_id: active.id, is_active: true },
      });

      const res = await request(createApp()).get('/api/events');
      expect(res.status).toBe(200);

      const listed = res.body.find((e: any) => e.id === event.id);
      expect(listed).toBeTruthy();
      const channelIds = listed.channels.map((c: any) => c.id);
      expect(channelIds).toContain(active.id);
      expect(channelIds).not.toContain(inactive.id);

      expect(listed.created_at).toBeUndefined();
      expect(listed.updated_at).toBeUndefined();
      for (const channel of listed.channels) {
        expect(channel.created_at).toBeUndefined();
        expect(channel.updated_at).toBeUndefined();
      }
    });

    it('returns an active event by slug', async () => {
      const { event } = await makeActiveEvent(`By Slug ${rand()}`);
      const res = await request(createApp()).get(`/api/events/${event.slug}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(event.id);
    });

    it('returns 404 for an inactive event slug', async () => {
      const event = await makeEvent(`Inactive Public ${rand()}`);
      const res = await request(createApp()).get(`/api/events/${event.slug}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for an unknown event slug', async () => {
      const res = await request(createApp()).get(`/api/events/nope-${rand()}`);
      expect(res.status).toBe(404);
    });
  });
});
