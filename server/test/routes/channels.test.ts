import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import channelsRouter from '../../routes/channels.js';
import adminRouter from '../../routes/admin.js';
import moderatorRouter from '../../routes/moderator.js';

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

  beforeAll(() => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterAll(async () => {
    await prisma.donation.deleteMany({ where: { donor_id: { in: createdDonorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: createdDonorIds } } });
    await prisma.channel.deleteMany({ where: { id: { in: createdChannelIds } } });
    await prisma.$disconnect();
  });

  describe('GET /api/channels (public)', () => {
    it('returns only active channels', async () => {
      const active = await prisma.channel.create({
        data: { name: `Public Active ${crypto.randomUUID()}` },
      });
      const inactive = await prisma.channel.create({
        data: { name: `Public Inactive ${crypto.randomUUID()}`, is_active: false },
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

    it('rejects duplicate event names', async () => {
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
      const channel = await prisma.channel.create({
        data: { name: `Stats Event ${crypto.randomUUID()}` },
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
});
