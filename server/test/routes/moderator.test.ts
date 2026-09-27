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
      .set('Authorization', `Bearer ${modToken}`)
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
      .set('Authorization', `Bearer ${modToken}`)
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
      .set('Authorization', `Bearer ${modToken}`)
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

    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('Authorization', `Bearer ${token}`);
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

    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('allows access via X-Moderator-Key without a donor token', async () => {
    process.env.MODERATOR_API_KEY = 'test-moderator-key';
    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('Authorization', 'Bearer key_mod_test-moderator-key');
    expect(res.status).toBe(200);
    delete process.env.MODERATOR_API_KEY;
  });

  it('allows access via X-Admin-Key without a donor token', async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = 'test-admin-key-2';
    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('Authorization', 'Bearer key_admin_test-admin-key-2');
    expect(res.status).toBe(200);
    process.env.ADMIN_API_KEY = original;
  });

  it('rejects a wrong X-Moderator-Key', async () => {
    process.env.MODERATOR_API_KEY = 'test-moderator-key';
    const res = await request(createApp())
      .get('/api/moderator/stats')
      .set('Authorization', 'Bearer key_mod_wrong-key');
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
      .set('Authorization', `Bearer ${modToken}`);

    expect(res.status).toBe(200);
    expect(res.body.some((d: { id: string }) => d.id === donation.id)).toBe(true);
    const found = res.body.find((d: { id: string }) => d.id === donation.id);
    expect(found.donor_name).toBe('Test Donor');
    expect(found.donor).toBeUndefined();

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('surfaces human-readable pledge item labels, never a raw target_id (#58)', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);

    const reward = await prisma.reward.create({
      data: { title: 'Signed Poster', type: 'PHYSICAL', cost_cents: 500 },
    });
    const goal = await prisma.fundGoal.create({
      data: { title: 'New PC Fund', target_cents: 100000 },
    });
    const poll = await prisma.poll.create({
      data: { title: 'Best Runner', is_active: true, allow_custom_entries: true },
    });
    const option = await prisma.pollOption.create({
      data: { poll_id: poll.id, label: 'Runner A' },
    });

    const donation = await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 2000,
        donor_name: 'Test Donor',
      },
    });
    const pledge = await prisma.pendingPledge.create({
      data: {
        pledge_token: `tok-${crypto.randomUUID()}`,
        total_cents: 2000,
        top_up_cents: 500,
        expires_at: new Date(Date.now() + 60_000),
        status: 'FULFILLED',
        fulfilled_by_donation_id: donation.id,
        items: {
          create: [
            { kind: 'REWARD', target_id: reward.id, amount_cents: 500 },
            { kind: 'GOAL', target_id: goal.id, amount_cents: 300 },
            {
              kind: 'POLL_VOTE',
              target_id: option.id,
              poll_id: poll.id,
              amount_cents: 400,
            },
            {
              kind: 'POLL_CUSTOM',
              target_id: poll.id,
              poll_id: poll.id,
              amount_cents: 300,
              data: JSON.stringify({ label: 'Runner Z (write-in)' }),
            },
          ],
        },
      },
    });

    const res = await request(createApp())
      .get('/api/moderator/donations')
      .set('Authorization', `Bearer ${modToken}`);

    expect(res.status).toBe(200);
    const found = res.body.find((d: { id: string }) => d.id === donation.id);
    expect(found).toBeTruthy();
    expect(found.top_up_cents).toBe(500);

    const labels = found.pledge_items.map((i: { kind: string; label: string }) => ({
      kind: i.kind,
      label: i.label,
    }));
    expect(labels).toContainEqual({ kind: 'REWARD', label: 'Signed Poster' });
    expect(labels).toContainEqual({ kind: 'GOAL', label: 'New PC Fund' });
    expect(labels).toContainEqual({ kind: 'POLL_VOTE', label: 'Best Runner: Runner A' });
    expect(labels).toContainEqual({
      kind: 'POLL_CUSTOM',
      label: 'Best Runner: "Runner Z (write-in)"',
    });

    // Never a raw id anywhere in the response.
    const serialized = JSON.stringify(found);
    expect(serialized).not.toContain(reward.id);
    expect(serialized).not.toContain(goal.id);
    expect(serialized).not.toContain(option.id);

    await prisma.pendingPledge.delete({ where: { id: pledge.id } });
    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.pollOption.delete({ where: { id: option.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.fundGoal.delete({ where: { id: goal.id } });
    await prisma.reward.delete({ where: { id: reward.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('prefixes a REWARD label with quantity when quantity > 1 (#50)', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);

    const reward = await prisma.reward.create({
      data: { title: 'Sticker Pack', type: 'DIGITAL', cost_cents: 500 },
    });
    const donation = await prisma.donation.create({
      data: {
        external_id: `ext-${crypto.randomUUID()}`,
        donor_id: donor.id,
        amount_cents: 1500,
        donor_name: 'Test Donor',
      },
    });
    const pledge = await prisma.pendingPledge.create({
      data: {
        pledge_token: `tok-${crypto.randomUUID()}`,
        total_cents: 1500,
        expires_at: new Date(Date.now() + 60_000),
        status: 'FULFILLED',
        fulfilled_by_donation_id: donation.id,
        items: {
          create: [{ kind: 'REWARD', target_id: reward.id, amount_cents: 1500, quantity: 3 }],
        },
      },
    });

    const res = await request(createApp())
      .get('/api/moderator/donations')
      .set('Authorization', `Bearer ${modToken}`);

    const found = res.body.find((d: { id: string }) => d.id === donation.id);
    expect(found.pledge_items).toContainEqual(
      expect.objectContaining({ kind: 'REWARD', label: '3× Sticker Pack', quantity: 3 }),
    );

    await prisma.pendingPledge.delete({ where: { id: pledge.id } });
    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.reward.delete({ where: { id: reward.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('marks a donation as moderated, recording who and when', async () => {
    const { donor: modDonor, token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const donation = await makeDonation(donor.id);

    const res = await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .set('Authorization', `Bearer ${modToken}`)
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
      .set('Authorization', `Bearer ${modToken}`)
      .send({ moderated: true });

    const res = await request(createApp())
      .patch(`/api/moderator/donations/${donation.id}`)
      .set('Authorization', `Bearer ${modToken}`)
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
      .set('Authorization', `Bearer ${modToken}`)
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
      .set('Authorization', 'Bearer key_mod_test-moderator-key-donations')
      .send({ moderated: true });

    expect(res.status).toBe(200);
    expect(res.body.moderated_by).toBe('moderator');
    delete process.env.MODERATOR_API_KEY;

    await prisma.donation.delete({ where: { id: donation.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });
});

describe('Moderator reward deletion', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeReward() {
    return prisma.reward.create({
      data: {
        title: `Reward ${Date.now()}-${Math.random()}`,
        type: 'DIGITAL',
        cost_cents: 500,
      },
    });
  }

  it('DELETE /rewards/:id returns 409 when the reward has claims', async () => {
    const { token: modToken } = await makeModerator();
    const donor = await makeDonorWithBalance(1000);
    const reward = await makeReward();
    const claim = await prisma.rewardClaim.create({
      data: { reward_id: reward.id, donor_id: donor.id },
    });

    const res = await request(createApp())
      .delete(`/api/moderator/rewards/${reward.id}`)
      .set('Authorization', `Bearer ${modToken}`);

    expect(res.status).toBe(409);
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toBeTruthy();

    await prisma.rewardClaim.delete({ where: { id: claim.id } });
    await prisma.reward.delete({ where: { id: reward.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('DELETE /rewards/:id deletes an unclaimed reward', async () => {
    const { token: modToken } = await makeModerator();
    const reward = await makeReward();

    const res = await request(createApp())
      .delete(`/api/moderator/rewards/${reward.id}`)
      .set('Authorization', `Bearer ${modToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toBeNull();
  });
});
