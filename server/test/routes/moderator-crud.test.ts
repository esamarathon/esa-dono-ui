import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import moderatorRouter from '../../routes/moderator.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/moderator', moderatorRouter);
  return app;
}

async function makeModerator() {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `mod-${crypto.randomUUID()}@example.com`,
      role: 'MODERATOR',
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

describe('Moderator CRUD routes', () => {
  const pollIds: string[] = [];
  const rewardIds: string[] = [];
  const goalIds: string[] = [];
  const donorIds: string[] = [];

  afterAll(async () => {
    await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donation.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.donor.deleteMany({ where: { id: { in: donorIds } } });
    await prisma.pollOption.deleteMany({ where: { poll_id: { in: pollIds } } });
    await prisma.pollCustomEntry.deleteMany({ where: { poll_id: { in: pollIds } } });
    await prisma.poll.deleteMany({ where: { id: { in: pollIds } } });
    await prisma.reward.deleteMany({ where: { id: { in: rewardIds } } });
    await prisma.fundGoal.deleteMany({ where: { id: { in: goalIds } } });
    await prisma.$disconnect();
  });

  it('rejects a non-moderator request', async () => {
    const res = await request(createApp()).get('/api/moderator/polls');
    expect(res.status).toBe(401);
  });

  describe('polls CRUD', () => {
    it('creates, lists, updates, and deletes a poll', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);

      const createRes = await request(createApp())
        .post('/api/moderator/polls')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Mod Poll', options: [{ label: 'A' }] });
      expect(createRes.status).toBe(200);
      expect(createRes.body.options).toHaveLength(1);
      pollIds.push(createRes.body.id);

      const listRes = await request(createApp())
        .get('/api/moderator/polls')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(200);

      const updateRes = await request(createApp())
        .put(`/api/moderator/polls/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Renamed Poll', is_active: false });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.title).toBe('Renamed Poll');

      const delRes = await request(createApp())
        .delete(`/api/moderator/polls/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(delRes.status).toBe(200);
    });

    it('adds, renames, and removes a poll option', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);
      const poll = await prisma.poll.create({ data: { title: 'Opt Poll' } });
      pollIds.push(poll.id);

      const addRes = await request(createApp())
        .post(`/api/moderator/polls/${poll.id}/options`)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: 'First' });
      expect(addRes.status).toBe(200);

      const renameRes = await request(createApp())
        .patch(`/api/moderator/polls/options/${addRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: 'Renamed' });
      expect(renameRes.status).toBe(200);
      expect(renameRes.body.label).toBe('Renamed');

      const delRes = await request(createApp())
        .delete(`/api/moderator/polls/options/${addRes.body.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(delRes.status).toBe(200);
    });

    it('lists custom entries for a poll', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);
      const poll = await prisma.poll.create({
        data: { title: 'Entries Poll', allow_custom_entries: true },
      });
      pollIds.push(poll.id);

      const res = await request(createApp())
        .get(`/api/moderator/polls/${poll.id}/custom-entries`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('rewards CRUD', () => {
    it('creates, lists, updates, and deletes a reward', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);

      const createRes = await request(createApp())
        .post('/api/moderator/rewards')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Mod Reward', type: 'DIGITAL', cost_cents: 200 });
      expect(createRes.status).toBe(200);
      rewardIds.push(createRes.body.id);

      const listRes = await request(createApp())
        .get('/api/moderator/rewards')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(200);

      const updateRes = await request(createApp())
        .put(`/api/moderator/rewards/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Renamed Reward' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.title).toBe('Renamed Reward');

      const delRes = await request(createApp())
        .delete(`/api/moderator/rewards/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(delRes.status).toBe(200);
    });
  });

  describe('goals CRUD', () => {
    it('creates, lists, updates, and deletes a goal', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);

      const createRes = await request(createApp())
        .post('/api/moderator/goals')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Mod Goal', target_cents: 5000 });
      expect(createRes.status).toBe(200);
      goalIds.push(createRes.body.id);

      const listRes = await request(createApp())
        .get('/api/moderator/goals')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(200);

      const updateRes = await request(createApp())
        .put(`/api/moderator/goals/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Renamed Goal' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.title).toBe('Renamed Goal');

      const delRes = await request(createApp())
        .delete(`/api/moderator/goals/${createRes.body.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(delRes.status).toBe(200);
    });
  });

  describe('claims', () => {
    it('lists claims with a human-readable donor_name (never email/id) alongside the reward (#57)', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);
      const reward = await prisma.reward.create({
        data: { title: 'Mod Claim Reward', type: 'DIGITAL', cost_cents: 100 },
      });
      rewardIds.push(reward.id);
      // donor_name lives on Donation (self-reported at checkout), not on
      // Donor — the claims list joins to the donor's most recent donation.
      await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 500,
          donor_name: 'Jane Donor',
        },
      });
      const claim = await prisma.rewardClaim.create({
        data: { donor_id: donor.id, reward_id: reward.id, status: 'PENDING' },
      });

      const listRes = await request(createApp())
        .get('/api/moderator/claims')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(200);
      const found = listRes.body.find((c: { id: string }) => c.id === claim.id);
      expect(found).toBeTruthy();
      expect(found.donor_name).toBe('Jane Donor');
      expect(found.reward.title).toBe('Mod Claim Reward');
      // Never expose the donor object itself (id/email) — only the flat,
      // human-readable donor_name field.
      expect(found.donor).toBeUndefined();

      // The moderator status-toggle endpoint was removed — fulfillment is not
      // moderator-managed. The admin side retains its own PATCH /claims/:id
      // (unaffected, different router).
      const patchRes = await request(createApp())
        .patch(`/api/moderator/claims/${claim.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'FULFILLED' });
      expect(patchRes.status).toBe(404);
    });

    it('falls back to null donor_name (never a raw donor id) when the donor has no donation on record', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);
      const reward = await prisma.reward.create({
        data: { title: 'No-donation Claim Reward', type: 'DIGITAL', cost_cents: 100 },
      });
      rewardIds.push(reward.id);
      const claim = await prisma.rewardClaim.create({
        data: { donor_id: donor.id, reward_id: reward.id, status: 'PENDING' },
      });

      const listRes = await request(createApp())
        .get('/api/moderator/claims')
        .set('Authorization', `Bearer ${token}`);
      const found = listRes.body.find((c: { id: string }) => c.id === claim.id);
      expect(found.donor_name).toBeNull();
      // No nested donor object (id/email) is ever exposed — just the flat,
      // human-readable (here, absent) donor_name field.
      expect(found.donor).toBeUndefined();
    });
  });

  describe('uploads', () => {
    it('rejects a request with no file', async () => {
      const { token, donor } = await makeModerator();
      donorIds.push(donor.id);

      const res = await request(createApp())
        .post('/api/moderator/uploads')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });
  });
});
