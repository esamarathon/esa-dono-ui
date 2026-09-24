import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
    await prisma.broadcast.deleteMany();
    await prisma.eventDelivery.deleteMany({ where: { destination_id: { in: destinationIds } } });
    await prisma.eventDestinationSeq.deleteMany({
      where: { destination_id: { in: destinationIds } },
    });
    await prisma.eventDestination.deleteMany({ where: { id: { in: destinationIds } } });
    await prisma.blockedWord.deleteMany({ where: { id: { in: blockedWordIds } } });
    await prisma.rewardClaim.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.pollVote.deleteMany({ where: { donor_id: { in: donorIds } } });
    await prisma.balanceAdjustment.deleteMany({ where: { donor_id: { in: donorIds } } });
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

  it('GET /stats includes unallocated_credits_cents summed across all donors (#59)', async () => {
    const a = await prisma.donor.create({
      data: { email: `stats-a-${crypto.randomUUID()}@example.com`, balance_remaining: 1500 },
    });
    const b = await prisma.donor.create({
      data: { email: `stats-b-${crypto.randomUUID()}@example.com`, balance_remaining: 2500 },
    });
    donorIds.push(a.id, b.id);

    const before = await request(createApp()).get('/api/admin/stats').set(AUTH);
    const after = await prisma.donor.aggregate({ _sum: { balance_remaining: true } });

    expect(before.body.unallocated_credits_cents).toBe(after._sum.balance_remaining);
    expect(before.body.unallocated_credits_cents).toBeGreaterThanOrEqual(4000);
  });

  it('POST /donors/sweep-credits previews without writing when confirm is omitted (#60)', async () => {
    const donor = await prisma.donor.create({
      data: { email: `sweep-preview-${crypto.randomUUID()}@example.com`, balance_remaining: 750 },
    });
    donorIds.push(donor.id);
    await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 750,
        donor_name: 'Jane Donor',
      },
    });

    const res = await request(createApp()).post('/api/admin/donors/sweep-credits').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.success).toBeUndefined();
    const sampleEntry = res.body.sample.find((s: { id: string }) => s.id === donor.id);
    expect(sampleEntry).toMatchObject({ balance_remaining: 750, donor_name: 'Jane Donor' });

    // Nothing written — balance untouched.
    const stillThere = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(stillThere!.balance_remaining).toBe(750);
  });

  it('POST /donors/sweep-credits zeros matching balances and records a labeled adjustment when confirmed (#60)', async () => {
    const donor = await prisma.donor.create({
      data: { email: `sweep-confirm-${crypto.randomUUID()}@example.com`, balance_remaining: 900 },
    });
    donorIds.push(donor.id);
    await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 900,
        donor_name: 'Sweep Target',
      },
    });

    const res = await request(createApp())
      .post('/api/admin/donors/sweep-credits')
      .set(AUTH)
      .send({ confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.donor_count).toBeGreaterThanOrEqual(1);

    const swept = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(swept!.balance_remaining).toBe(0);

    const adjustment = await prisma.balanceAdjustment.findFirst({
      where: { donor_id: donor.id },
      orderBy: { created_at: 'desc' },
    });
    expect(adjustment).toMatchObject({
      type: 'FREEZE_ZERO',
      amount_cents: -900,
      balance_after_cents: 0,
    });
    expect(adjustment!.reason).toContain('Sweep Target');
  });

  it('POST /donors/sweep-credits respects min/max_balance_cents filters (#60)', async () => {
    const small = await prisma.donor.create({
      data: { email: `sweep-small-${crypto.randomUUID()}@example.com`, balance_remaining: 50 },
    });
    const large = await prisma.donor.create({
      data: { email: `sweep-large-${crypto.randomUUID()}@example.com`, balance_remaining: 5000 },
    });
    donorIds.push(small.id, large.id);

    const res = await request(createApp())
      .post('/api/admin/donors/sweep-credits')
      .set(AUTH)
      .send({ max_balance_cents: 100 });

    expect(res.status).toBe(200);
    const ids = res.body.sample.map((s: { id: string }) => s.id);
    expect(ids).toContain(small.id);
    expect(ids).not.toContain(large.id);
  });

  it('POST /donors/sweep-credits rejects an invalid filter', async () => {
    const res = await request(createApp())
      .post('/api/admin/donors/sweep-credits')
      .set(AUTH)
      .send({ min_balance_cents: -1 });
    expect(res.status).toBe(400);
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

  describe('donation status (#63)', () => {
    it('defaults new donations to COMPLETED', async () => {
      const donor = await prisma.donor.create({
        data: { email: `status-default-${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 1000,
        },
      });
      expect(donation.status).toBe('COMPLETED');
      expect(donation.refund_id).toBeNull();
    });

    it('GET /donations filters by status', async () => {
      const donor = await prisma.donor.create({
        data: { email: `status-filter-${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 1000,
          status: 'PENDING',
        },
      });

      const res = await request(createApp())
        .get('/api/admin/donations')
        .query({ status: 'PENDING' })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.some((d: any) => d.id === donation.id)).toBe(true);
      expect(res.body.every((d: any) => d.status === 'PENDING')).toBe(true);
    });

    it('GET /donations rejects an invalid status filter', async () => {
      const res = await request(createApp())
        .get('/api/admin/donations')
        .query({ status: 'BOGUS' })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('PATCH /donations/:id/status refunds and claws back unspent balance, linking the adjustment', async () => {
      const donor = await prisma.donor.create({
        data: {
          email: `status-refund-${crypto.randomUUID()}@example.com`,
          balance_remaining: 1000,
        },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 1000,
        },
      });

      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/status`)
        .set(AUTH)
        .send({ status: 'REFUNDED' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('REFUNDED');
      expect(res.body.refund_id).toBeTruthy();

      const donorAfter = await prisma.donor.findUnique({ where: { id: donor.id } });
      expect(donorAfter!.balance_remaining).toBe(0);

      const adjustment = await prisma.balanceAdjustment.findUnique({
        where: { id: res.body.refund_id },
      });
      expect(adjustment).toMatchObject({
        type: 'REFUND',
        amount_cents: -1000,
        balance_after_cents: 0,
        reference_id: donation.id,
      });
    });

    it("PATCH /donations/:id/status caps the clawback at the donor's remaining balance", async () => {
      const donor = await prisma.donor.create({
        data: {
          email: `status-partial-${crypto.randomUUID()}@example.com`,
          balance_remaining: 300,
        },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 1000,
        },
      });

      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/status`)
        .set(AUTH)
        .send({ status: 'CHARGEBACK' });

      expect(res.status).toBe(200);
      const donorAfter = await prisma.donor.findUnique({ where: { id: donor.id } });
      expect(donorAfter!.balance_remaining).toBe(0);

      const adjustment = await prisma.balanceAdjustment.findUnique({
        where: { id: res.body.refund_id },
      });
      expect(adjustment).toMatchObject({ type: 'CHARGEBACK', amount_cents: -300 });
    });

    it('PATCH /donations/:id/status rejects further changes once refunded (terminal)', async () => {
      const donor = await prisma.donor.create({
        data: { email: `status-terminal-${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 500,
          status: 'REFUNDED',
          refund_id: (
            await prisma.balanceAdjustment.create({
              data: {
                donor_id: donor.id,
                amount_cents: -500,
                balance_after_cents: 0,
                type: 'REFUND',
                created_by: 'admin',
              },
            })
          ).id,
        },
      });

      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/status`)
        .set(AUTH)
        .send({ status: 'COMPLETED' });
      expect(res.status).toBe(400);
    });

    it('PATCH /donations/:id/status rejects an invalid status', async () => {
      const donor = await prisma.donor.create({
        data: { email: `status-invalid-${crypto.randomUUID()}@example.com` },
      });
      donorIds.push(donor.id);
      const donation = await prisma.donation.create({
        data: {
          external_id: `ext-${crypto.randomUUID()}`,
          donor_id: donor.id,
          amount_cents: 500,
        },
      });

      const res = await request(createApp())
        .patch(`/api/admin/donations/${donation.id}/status`)
        .set(AUTH)
        .send({ status: 'BOGUS' });
      expect(res.status).toBe(400);
    });
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

    it('records a real donation received externally with a caller-supplied external_id and backdate (#62)', async () => {
      const email = `manual-${crypto.randomUUID()}@example.com`;
      const externalRef = `hekathon-${crypto.randomUUID()}`;
      const occurredAt = '2026-01-15T12:00:00.000Z';

      const res = await request(createApp())
        .post('/api/admin/simulate-donation')
        .send({
          email,
          amount_cents: 2500,
          external_id: externalRef,
          occurred_at: occurredAt,
          donor_name: 'HEKATHON Donor',
        })
        .set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const donor = await prisma.donor.findUnique({ where: { email } });
      donorIds.push(donor!.id);
      const donation = await prisma.donation.findUnique({ where: { external_id: externalRef } });
      expect(donation).toBeTruthy();
      expect(donation!.amount_cents).toBe(2500);
      expect(donation!.created_at.toISOString()).toBe(occurredAt);
    });

    it('rejects a duplicate external_id with 409', async () => {
      const email = `dup-${crypto.randomUUID()}@example.com`;
      const externalRef = `hekathon-${crypto.randomUUID()}`;

      const first = await request(createApp())
        .post('/api/admin/simulate-donation')
        .send({ email, amount_cents: 1000, external_id: externalRef })
        .set(AUTH);
      expect(first.status).toBe(200);
      const donor = await prisma.donor.findUnique({ where: { email } });
      donorIds.push(donor!.id);

      const second = await request(createApp())
        .post('/api/admin/simulate-donation')
        .send({ email, amount_cents: 1000, external_id: externalRef })
        .set(AUTH);
      expect(second.status).toBe(409);
    });

    it('rejects an invalid occurred_at', async () => {
      const res = await request(createApp())
        .post('/api/admin/simulate-donation')
        .send({
          email: `bad-date-${crypto.randomUUID()}@example.com`,
          amount_cents: 1000,
          occurred_at: 'not-a-date',
        })
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

  describe('broadcast banner (#68 level)', () => {
    afterEach(async () => {
      await prisma.broadcast.deleteMany();
    });

    it('returns an inactive default with a null level when none set', async () => {
      const res = await request(createApp()).get('/api/admin/broadcast').set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: null, message: '', level: null, is_active: false });
    });

    it('creates a broadcast with a null level (backward-compatible default)', async () => {
      const res = await request(createApp())
        .put('/api/admin/broadcast')
        .send({ message: 'hello world' })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('hello world');
      expect(res.body.level).toBeNull();
      expect(res.body.is_active).toBe(true);
    });

    it('creates a broadcast with a WARNING level', async () => {
      const res = await request(createApp())
        .put('/api/admin/broadcast')
        .send({ message: 'careful now', level: 'WARNING' })
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.level).toBe('WARNING');
    });

    it('rejects an unrecognized level', async () => {
      const res = await request(createApp())
        .put('/api/admin/broadcast')
        .send({ message: 'bad level', level: 'URGENT' })
        .set(AUTH);
      expect(res.status).toBe(400);
    });

    it('clears the level along with the message on delete', async () => {
      await request(createApp())
        .put('/api/admin/broadcast')
        .send({ message: 'to clear', level: 'CRITICAL' })
        .set(AUTH);
      const delRes = await request(createApp()).delete('/api/admin/broadcast').set(AUTH);
      expect(delRes.status).toBe(200);
      const getRes = await request(createApp()).get('/api/admin/broadcast').set(AUTH);
      expect(getRes.body).toMatchObject({ id: null, message: '', level: null, is_active: false });
    });
  });
});
