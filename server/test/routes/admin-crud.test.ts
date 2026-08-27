import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import adminRouter from '../../routes/admin.js';

const prisma = new PrismaClient();
const AUTH = { Authorization: 'Bearer key_admin_test-admin-key' };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

describe('Admin CRUD routes', () => {
  const rewardIds: string[] = [];
  const pollIds: string[] = [];
  const goalIds: string[] = [];
  const destinationIds: string[] = [];
  const blockedWordIds: string[] = [];
  const donorIds: string[] = [];

  beforeAll(() => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterAll(async () => {
    await prisma.eventDelivery.deleteMany({ where: { destination_id: { in: destinationIds } } });
    await prisma.eventDestinationSeq.deleteMany({
      where: { destination_id: { in: destinationIds } },
    });
    await prisma.eventDestination.deleteMany({ where: { id: { in: destinationIds } } });
    await prisma.blockedWord.deleteMany({ where: { id: { in: blockedWordIds } } });
    await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.pollOption.deleteMany({ where: { poll_id: { in: pollIds } } });
    await prisma.poll.deleteMany({ where: { id: { in: pollIds } } });
    await prisma.reward.deleteMany({ where: { id: { in: rewardIds } } });
    await prisma.fundGoal.deleteMany({ where: { id: { in: goalIds } } });
    await prisma.$disconnect();
  });

  it('GET /stats returns aggregate counts', async () => {
    const res = await request(createApp()).get('/api/admin/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_raised_cents');
    expect(res.body).toHaveProperty('donors');
  });

  it('GET /pledges returns a list', async () => {
    const res = await request(createApp()).get('/api/admin/pledges').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /donations returns a list', async () => {
    const res = await request(createApp()).get('/api/admin/donations').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  describe('blocked words', () => {
    it('creates, lists, and deletes a blocked word', async () => {
      const createRes = await request(createApp())
        .post('/api/admin/blocked-words')
        .send({ word: 'spamword' })
        .set(AUTH);
      expect(createRes.status).toBe(200);
      blockedWordIds.push(createRes.body.id);

      const listRes = await request(createApp()).get('/api/admin/blocked-words').set(AUTH);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((w: any) => w.word === 'spamword')).toBe(true);

      const delRes = await request(createApp())
        .delete(`/api/admin/blocked-words/${createRes.body.id}`)
        .set(AUTH);
      expect(delRes.status).toBe(200);
    });
  });

  describe('rewards CRUD', () => {
    it('creates, lists, and updates a reward', async () => {
      const createRes = await request(createApp())
        .post('/api/admin/rewards')
        .send({ title: 'CRUD Reward', type: 'DIGITAL', cost_cents: 500 })
        .set(AUTH);
      expect(createRes.status).toBe(200);
      expect(createRes.body.is_active).toBe(true);
      rewardIds.push(createRes.body.id);

      const listRes = await request(createApp()).get('/api/admin/rewards').set(AUTH);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((r: any) => r.id === createRes.body.id)).toBe(true);

      const updateRes = await request(createApp())
        .put(`/api/admin/rewards/${createRes.body.id}`)
        .send({ title: 'Updated Reward', is_active: false })
        .set(AUTH);
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.title).toBe('Updated Reward');
      expect(updateRes.body.is_active).toBe(false);
    });
  });

  describe('polls CRUD', () => {
    it('creates a poll with options and lists it', async () => {
      const createRes = await request(createApp())
        .post('/api/admin/polls')
        .send({ title: 'CRUD Poll', options: [{ label: 'A' }, { label: 'B' }] })
        .set(AUTH);
      expect(createRes.status).toBe(200);
      expect(createRes.body.options).toHaveLength(2);
      pollIds.push(createRes.body.id);

      const listRes = await request(createApp()).get('/api/admin/polls').set(AUTH);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((p: any) => p.id === createRes.body.id)).toBe(true);
    });

    it('adds, renames, and removes a poll option', async () => {
      const poll = await prisma.poll.create({ data: { title: 'Option Poll' } });
      pollIds.push(poll.id);

      const addRes = await request(createApp())
        .post(`/api/admin/polls/${poll.id}/options`)
        .send({ label: 'First' })
        .set(AUTH);
      expect(addRes.status).toBe(200);

      const renameRes = await request(createApp())
        .patch(`/api/admin/polls/options/${addRes.body.id}`)
        .send({ label: 'Renamed' })
        .set(AUTH);
      expect(renameRes.status).toBe(200);
      expect(renameRes.body.label).toBe('Renamed');

      const delRes = await request(createApp())
        .delete(`/api/admin/polls/options/${addRes.body.id}`)
        .set(AUTH);
      expect(delRes.status).toBe(200);
    });
  });

  describe('goals CRUD', () => {
    it('creates and lists a goal', async () => {
      const createRes = await request(createApp())
        .post('/api/admin/goals')
        .send({ title: 'CRUD Goal', target_cents: 10000 })
        .set(AUTH);
      expect(createRes.status).toBe(200);
      goalIds.push(createRes.body.id);

      const listRes = await request(createApp()).get('/api/admin/goals').set(AUTH);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((g: any) => g.id === createRes.body.id)).toBe(true);
    });
  });

  describe('claims', () => {
    it('lists claims and patches a claim status', async () => {
      const donor = await prisma.donor.create({
        data: { email: `claim-${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(donor.id);
      const reward = await prisma.reward.create({
        data: { title: 'Claim Reward', type: 'DIGITAL', cost_cents: 100 },
      });
      rewardIds.push(reward.id);
      const claim = await prisma.rewardClaim.create({
        data: { donor_id: donor.id, reward_id: reward.id, status: 'PENDING' },
      });

      const listRes = await request(createApp()).get('/api/admin/claims').set(AUTH);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((c: any) => c.id === claim.id)).toBe(true);

      const patchRes = await request(createApp())
        .patch(`/api/admin/claims/${claim.id}`)
        .send({ status: 'FULFILLED' })
        .set(AUTH);
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.status).toBe('FULFILLED');
    });
  });

  describe('simulate donation', () => {
    it('creates a simulated donation', async () => {
      const email = `sim-${crypto.randomUUID()}@example.com`;
      const res = await request(createApp())
        .post('/api/admin/simulate-donation')
        .send({ email, amount_cents: 1000 })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.donor.email).toBe(email);

      const donor = await prisma.donor.findUnique({ where: { email } });
      donorIds.push(donor!.id);
    });

    it('rejects a missing email', async () => {
      const res = await request(createApp())
        .post('/api/admin/simulate-donation')
        .send({ amount_cents: 1000 })
        .set(AUTH);
      expect(res.status).toBe(400);
    });
  });

  describe('destinations CRUD', () => {
    it('creates, lists, updates, rotates, tests, and deletes an HTTP destination', async () => {
      const createRes = await request(createApp())
        .post('/api/admin/destinations')
        .send({
          destination_type: 'HTTP',
          url: 'https://example.com/webhook',
          event_types: ['donation.created'],
        })
        .set(AUTH);
      expect(createRes.status).toBe(201);
      expect(createRes.body.destination_type).toBe('HTTP');
      destinationIds.push(createRes.body.id);

      const listRes = await request(createApp()).get('/api/admin/destinations').set(AUTH);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((d: any) => d.id === createRes.body.id)).toBe(true);

      const updateRes = await request(createApp())
        .put(`/api/admin/destinations/${createRes.body.id}`)
        .send({ is_active: false, event_types: ['donation.created'], destination_type: 'HTTP' })
        .set(AUTH);
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.is_active).toBe(false);

      const rotateRes = await request(createApp())
        .post(`/api/admin/destinations/${createRes.body.id}/rotate-secret`)
        .set(AUTH);
      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.secret).not.toBe(createRes.body.secret);

      const deliveriesRes = await request(createApp())
        .get(`/api/admin/destinations/${createRes.body.id}/deliveries`)
        .set(AUTH);
      expect(deliveriesRes.status).toBe(200);
      expect(deliveriesRes.body).toHaveProperty('deliveries');

      const testRes = await request(createApp())
        .post(`/api/admin/destinations/${createRes.body.id}/test`)
        .set(AUTH);
      expect(testRes.status).toBe(200);
      expect(testRes.body.success).toBe(true);

      const delRes = await request(createApp())
        .delete(`/api/admin/destinations/${createRes.body.id}`)
        .set(AUTH);
      expect(delRes.status).toBe(200);
    });

    it('rejects an HTTP destination without a URL', async () => {
      const res = await request(createApp())
        .post('/api/admin/destinations')
        .send({ destination_type: 'HTTP', event_types: ['donation.created'] })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('rejects a RabbitMQ destination without amqp_url', async () => {
      const res = await request(createApp())
        .post('/api/admin/destinations')
        .send({
          destination_type: 'RABBITMQ',
          amqp_routing_key: 'q',
          event_types: ['donation.created'],
        })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('rejects an invalid event type', async () => {
      const res = await request(createApp())
        .post('/api/admin/destinations')
        .send({ url: 'https://example.com/hook', event_types: ['nope'] })
        .set(AUTH);
      expect(res.status).toBe(400);
    });
  });
});
