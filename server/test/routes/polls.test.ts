import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pollsRouter from '../../routes/polls.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/polls', pollsRouter);
  return app;
}

async function makeDonor(balanceCents: number) {
  const token = crypto.randomBytes(16).toString('hex');
  const donor = await prisma.donor.create({
    data: {
      email: `poll-${crypto.randomUUID()}@example.com`,
      balance_remaining: balanceCents,
      total_donated: balanceCents,
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

describe('Polls routes', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET / returns only active polls', async () => {
    const active = await prisma.poll.create({ data: { title: 'Active Poll', is_active: true } });
    const inactive = await prisma.poll.create({
      data: { title: 'Inactive Poll', is_active: false },
    });

    const res = await request(createApp()).get('/api/polls');

    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);

    await prisma.poll.deleteMany({ where: { id: { in: [active.id, inactive.id] } } });
  });

  it('POST /:id/vote votes on an option', async () => {
    const { donor, token } = await makeDonor(5000);
    const poll = await prisma.poll.create({ data: { title: 'Vote Poll', is_active: true } });
    const option = await prisma.pollOption.create({
      data: { poll_id: poll.id, label: 'Runner A', status: 'ACTIVE' },
    });

    const res = await request(createApp())
      .post(`/api/polls/${poll.id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ poll_option_id: option.id, amount_cents: 100 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await prisma.pollVote.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollOption.deleteMany({ where: { poll_id: poll.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('POST /:id/vote returns 400 on insufficient balance', async () => {
    const { donor, token } = await makeDonor(0);
    const poll = await prisma.poll.create({ data: { title: 'Poor Poll', is_active: true } });
    const option = await prisma.pollOption.create({
      data: { poll_id: poll.id, label: 'Runner A', status: 'ACTIVE' },
    });

    const res = await request(createApp())
      .post(`/api/polls/${poll.id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ poll_option_id: option.id, amount_cents: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Insufficient balance');

    await prisma.pollOption.deleteMany({ where: { poll_id: poll.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('POST /:id/custom-entry proposes a funded write-in', async () => {
    const { donor, token } = await makeDonor(5000);
    const poll = await prisma.poll.create({
      data: { title: 'Writein Poll', is_active: true, allow_custom_entries: true },
    });

    const res = await request(createApp())
      .post(`/api/polls/${poll.id}/custom-entry`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'My idea', amount_cents: 100 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.entry.label).toBe('My idea');
    expect(res.body.pending_approval).toBe(false);

    await prisma.pollVote.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollOption.deleteMany({ where: { poll_id: poll.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('POST /:id/custom-entry rejects a blocked word', async () => {
    const { donor, token } = await makeDonor(5000);
    const poll = await prisma.poll.create({
      data: { title: 'Blocked Poll', is_active: true, allow_custom_entries: true },
    });
    const blocked = await prisma.blockedWord.create({ data: { word: 'spamword' } });

    const res = await request(createApp())
      .post(`/api/polls/${poll.id}/custom-entry`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'spamword', amount_cents: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('blocked word');

    await prisma.blockedWord.delete({ where: { id: blocked.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });
});
