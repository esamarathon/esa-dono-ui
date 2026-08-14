import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import moderatorRouter from '../../routes/moderator.js';
import { proposeCustomEntryTx } from '../../services/spend.js';

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
      email: `mod-${Date.now()}-${Math.random()}@example.com`,
      role: 'MODERATOR',
      magic_token: token,
      token_expires_at: new Date(Date.now() + 60_000),
    },
  });
  return { donor, token };
}

async function makeDonorWithBalance(balanceCents: number) {
  return prisma.donor.create({
    data: {
      email: `donor-${Date.now()}-${Math.random()}@example.com`,
      balance_remaining: balanceCents,
      total_donated: balanceCents,
    },
  });
}

describe('Moderator custom-entry approve/reject money movement', () => {
  beforeAll(async () => {
    process.env.APP_BASE_URL = 'http://localhost:5173';
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('APPROVED: credits votes_cents / total_votes_cents, does not touch balance', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const poll = await prisma.poll.create({
      data: {
        title: 'Approve me',
        is_active: true,
        allow_custom_entries: true,
        auto_approve: false,
      },
    });

    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, donor.id, poll.id, 'pending idea', 400),
    );
    expect(option.status).toBe('PENDING_APPROVAL');

    const res = await request(createApp())
      .patch(`/api/moderator/polls/custom-entries/${entry.id}`)
      .query({ token: modToken })
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const updatedOption = await prisma.pollOption.findUnique({ where: { id: option.id } });
    expect(updatedOption!.status).toBe('ACTIVE');
    expect(updatedOption!.votes_cents).toBe(400);

    const updatedPoll = await prisma.poll.findUnique({ where: { id: poll.id } });
    expect(updatedPoll!.total_votes_cents).toBe(400);

    // Balance stays spent — approval does not refund
    const updatedDonor = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(updatedDonor!.balance_remaining).toBe(600);

    await prisma.pollVote.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donor.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.deleteMany({ where: { magic_token: modToken } });
  }, 10000);

  it('REJECTED: refunds balance, reverses the vote, marks option REJECTED, writes a BalanceAdjustment', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const poll = await prisma.poll.create({
      data: {
        title: 'Reject me',
        is_active: true,
        allow_custom_entries: true,
        auto_approve: false,
      },
    });

    const { entry, option } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, donor.id, poll.id, 'bad idea', 400),
    );
    expect(option.status).toBe('PENDING_APPROVAL');
    // Funds already committed at proposal time
    const spentDonor = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(spentDonor!.balance_remaining).toBe(600);

    const res = await request(createApp())
      .patch(`/api/moderator/polls/custom-entries/${entry.id}`)
      .query({ token: modToken })
      .send({ status: 'REJECTED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');

    const updatedOption = await prisma.pollOption.findUnique({ where: { id: option.id } });
    expect(updatedOption!.status).toBe('REJECTED');
    expect(updatedOption!.votes_cents).toBe(0);

    const updatedPoll = await prisma.poll.findUnique({ where: { id: poll.id } });
    expect(updatedPoll!.total_votes_cents).toBe(0);

    // Refunded to full balance
    const refundedDonor = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(refundedDonor!.balance_remaining).toBe(1000);

    const vote = await prisma.pollVote.findFirst({ where: { poll_option_id: option.id } });
    expect(vote!.reversed_at).toBeTruthy();

    const adjustment = await prisma.balanceAdjustment.findFirst({
      where: { reference_id: vote!.id },
    });
    expect(adjustment).toBeTruthy();
    expect(adjustment!.amount_cents).toBe(400);
    expect(adjustment!.type).toBe('REFUND');

    await prisma.balanceAdjustment.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollVote.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donor.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.deleteMany({ where: { magic_token: modToken } });
  }, 10000);

  it('rejects moderating an already-decided entry', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Already done', is_active: true, allow_custom_entries: true },
    });

    const { entry } = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, donor.id, poll.id, 'auto approved idea', 200),
    );
    // auto_approve defaults true, so this entry is already APPROVED

    const res = await request(createApp())
      .patch(`/api/moderator/polls/custom-entries/${entry.id}`)
      .query({ token: modToken })
      .send({ status: 'REJECTED' });

    expect(res.status).toBe(400);

    await prisma.pollVote.deleteMany({ where: { donor_id: donor.id } });
    await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donor.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.deleteMany({ where: { magic_token: modToken } });
  }, 10000);
});

describe('Moderator access control', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects a plain USER donor', async () => {
    const token = crypto.randomBytes(16).toString('hex');
    const donor = await prisma.donor.create({
      data: {
        email: `user-${Date.now()}-${Math.random()}@example.com`,
        magic_token: token,
        token_expires_at: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(createApp()).get('/api/moderator/stats').query({ token });
    expect(res.status).toBe(403);

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('allows an ADMIN-role donor (admin implies moderator access)', async () => {
    const token = crypto.randomBytes(16).toString('hex');
    const donor = await prisma.donor.create({
      data: {
        email: `admin-donor-${Date.now()}-${Math.random()}@example.com`,
        role: 'ADMIN',
        magic_token: token,
        token_expires_at: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(createApp()).get('/api/moderator/stats').query({ token });
    expect(res.status).toBe(200);

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('allows access via X-Moderator-Key without a donor token', async () => {
    process.env.MODERATOR_API_KEY = 'test-moderator-key';
    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('X-Moderator-Key', 'test-moderator-key');
    expect(res.status).toBe(200);
    delete process.env.MODERATOR_API_KEY;
  });

  it('allows access via X-Admin-Key without a donor token', async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = 'test-admin-key-2';
    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('X-Admin-Key', 'test-admin-key-2');
    expect(res.status).toBe(200);
    process.env.ADMIN_API_KEY = original;
  });

  it('rejects a wrong X-Moderator-Key', async () => {
    process.env.MODERATOR_API_KEY = 'test-moderator-key';
    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('X-Moderator-Key', 'wrong-key');
    expect(res.status).toBe(401);
    delete process.env.MODERATOR_API_KEY;
  });
});

describe('Moderator donations', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeDonation(donorId: string) {
    return prisma.donation.create({
      data: {
        external_id: `ext-${Date.now()}-${Math.random()}`,
        donor_id: donorId,
        amount_cents: 500,
        donor_name: 'Test Donor',
      },
    });
  }

  it('lists all donations regardless of donor', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const donation = await makeDonation(donor.id);

    const res = await request(createApp())
      .get('/api/moderator/donations')
      .query({ token: modToken });

    expect(res.status).toBe(200);
    expect(res.body.some((d: { id: string }) => d.id === donation.id)).toBe(true);
    expect(res.body.find((d: { id: string }) => d.id === donation.id).donor.email).toBe(
      donor.email,
    );

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('marks a donation as moderated, recording who and when', async () => {
    const { donor: modDonor, token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const donation = await makeDonation(donor.id);

    const res = await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .query({ token: modToken })
      .send({ moderated: true });

    expect(res.status).toBe(200);
    expect(res.body.moderated).toBe(true);
    expect(res.body.moderated_by).toBe(modDonor.email);
    expect(res.body.moderated_at).toBeTruthy();

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
    await prisma.donor.delete({ where: { id: modDonor.id } });
  });

  it('unmarks a donation as moderated, clearing moderated_by/at', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const donation = await makeDonation(donor.id);

    await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .query({ token: modToken })
      .send({ moderated: true });

    const res = await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .query({ token: modToken })
      .send({ moderated: false });

    expect(res.status).toBe(200);
    expect(res.body.moderated).toBe(false);
    expect(res.body.moderated_by).toBeNull();
    expect(res.body.moderated_at).toBeNull();

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('rejects a non-boolean moderated value', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const donation = await makeDonation(donor.id);

    const res = await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .query({ token: modToken })
      .send({ moderated: 'yes' });

    expect(res.status).toBe(400);

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('records moderated_by as "moderator" when accessed via API key rather than a donor token', async () => {
    process.env.MODERATOR_API_KEY = 'test-moderator-key-donations';
    const donor = await makeDonorWithBalance(1000);
    const donation = await makeDonation(donor.id);

    const res = await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .set('X-Moderator-Key', 'test-moderator-key-donations')
      .send({ moderated: true });

    expect(res.status).toBe(200);
    expect(res.body.moderated_by).toBe('moderator');
    delete process.env.MODERATOR_API_KEY;

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });
});
