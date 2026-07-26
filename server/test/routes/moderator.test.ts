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
      is_moderator: true,
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
