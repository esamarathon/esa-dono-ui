import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { proposeCustomEntryTx } from '../../services/spend.js';

const prisma = new PrismaClient();

describe('proposeCustomEntryTx', () => {
  beforeAll(async () => {
    process.env.APP_BASE_URL = 'http://localhost:5173';
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeDonor(balanceCents: number) {
    return prisma.donor.create({
      data: {
        email: `spend-${Date.now()}-${Math.random()}@example.com`,
        balance_remaining: balanceCents,
        total_donated: balanceCents,
      },
    });
  }

  async function cleanup(donorId: string, pollId: string) {
    await prisma.pollVote.deleteMany({ where: { donor_id: donorId } });
    await prisma.pollCustomEntry.deleteMany({ where: { donor_id: donorId } });
    await prisma.poll.delete({ where: { id: pollId } });
    await prisma.donor.delete({ where: { id: donorId } });
  }

  it('goes live immediately when auto_approve is true (default)', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Auto poll', is_active: true, allow_custom_entries: true },
    });

    const result = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, donor.id, poll.id, 'My idea', 500),
    );

    expect(result.status).toBe('ACTIVE');
    expect(result.option.votes_cents).toBe(500);

    const updatedDonor = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(updatedDonor!.balance_remaining).toBe(500);

    const updatedPoll = await prisma.poll.findUnique({ where: { id: poll.id } });
    expect(updatedPoll!.total_votes_cents).toBe(500);

    await cleanup(donor.id, poll.id);
  }, 10000);

  it('commits funds but excludes from tally when auto_approve is false', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: {
        title: 'Reviewed poll',
        is_active: true,
        allow_custom_entries: true,
        auto_approve: false,
      },
    });

    const result = await prisma.$transaction((tx) =>
      proposeCustomEntryTx(tx, donor.id, poll.id, 'My idea', 500),
    );

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.option.votes_cents).toBe(0);

    // Balance is spent immediately (Model B), even though pending
    const updatedDonor = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(updatedDonor!.balance_remaining).toBe(500);

    // Public tally is untouched until approved
    const updatedPoll = await prisma.poll.findUnique({ where: { id: poll.id } });
    expect(updatedPoll!.total_votes_cents).toBe(0);

    // The funding vote exists and is unreversed (it's the committed-funds record)
    const vote = await prisma.pollVote.findFirst({ where: { poll_option_id: result.option.id } });
    expect(vote).toBeTruthy();
    expect(vote!.amount_cents).toBe(500);
    expect(vote!.reversed_at).toBeNull();

    await cleanup(donor.id, poll.id);
  }, 10000);

  it('rejects insufficient balance', async () => {
    const donor = await makeDonor(100);
    const poll = await prisma.poll.create({
      data: { title: 'Poor poll', is_active: true, allow_custom_entries: true },
    });

    await expect(
      prisma.$transaction((tx) => proposeCustomEntryTx(tx, donor.id, poll.id, 'idea', 500)),
    ).rejects.toThrow('Insufficient balance');

    const unchangedDonor = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(unchangedDonor!.balance_remaining).toBe(100);

    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  }, 10000);

  it('rejects when poll does not allow custom entries', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Locked poll', is_active: true, allow_custom_entries: false },
    });

    await expect(
      prisma.$transaction((tx) => proposeCustomEntryTx(tx, donor.id, poll.id, 'idea', 500)),
    ).rejects.toThrow('does not allow custom entries');

    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  }, 10000);

  it('rejects entries exceeding max_entry_chars', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: {
        title: 'Short poll',
        is_active: true,
        allow_custom_entries: true,
        max_entry_chars: 5,
      },
    });

    await expect(
      prisma.$transaction((tx) => proposeCustomEntryTx(tx, donor.id, poll.id, 'way too long', 500)),
    ).rejects.toThrow('exceeds maximum');

    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  }, 10000);

  it('rejects blocked words', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Clean poll', is_active: true, allow_custom_entries: true },
    });
    const blocked = await prisma.blockedWord.create({ data: { word: 'badword' } });

    await expect(
      prisma.$transaction((tx) =>
        proposeCustomEntryTx(tx, donor.id, poll.id, 'this has a badword in it', 500),
      ),
    ).rejects.toThrow('blocked word');

    await prisma.blockedWord.delete({ where: { id: blocked.id } });
    await prisma.poll.delete({ where: { id: poll.id } });
    await prisma.donor.delete({ where: { id: donor.id } });
  }, 10000);
});
