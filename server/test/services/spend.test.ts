import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  proposeCustomEntryTx,
  votePollTx,
  claimRewardTx,
  contributeGoalTx,
} from '../../services/spend.js';

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

  it('allows each source donation Pool once, without debiting Wallet credit, recording donor/auto rows and claim prices', async () => {
    const donor = await makeDonor(0);
    const donation = await prisma.donation.create({
      data: {
        external_id: `pool-${Math.random()}`,
        donor_id: donor.id,
        amount_cents: 1000,
        pledge_amount_cents: 1000,
      },
    });
    const reward = await prisma.reward.create({
      data: { title: 'Locked', type: 'PHYSICAL', cost_cents: 2000 },
    });
    const goal = await prisma.fundGoal.create({ data: { title: 'Overshoot', target_cents: 100 } });
    const poll = await prisma.poll.create({
      data: { title: 'Pool', options: { create: [{ label: 'Choice' }] } },
      include: { options: true },
    });
    try {
      await prisma.$transaction(async (tx) => {
        await claimRewardTx(tx, donor.id, reward.id, {}, 1, donation.id, {
          mode: 'pool',
          source: 'donor',
          unit_price_cents: 1000,
          confirmed_reward_type: 'PHYSICAL',
        });
        await votePollTx(tx, donor.id, poll.id, poll.options[0]!.id, 1000, donation.id, {
          mode: 'pool',
          source: 'donor',
          auto_cents: 900,
        });
        await contributeGoalTx(tx, donor.id, goal.id, 1000, donation.id, {
          mode: 'pool',
          source: 'auto',
        });
      });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 0,
      });
      expect(
        await prisma.rewardClaim.findMany({ where: { donation_id: donation.id } }),
      ).toMatchObject([{ amount_cents: 1000 }]);
      expect(
        await prisma.pollVote.findMany({
          where: { donation_id: donation.id },
          orderBy: { amount_cents: 'asc' },
        }),
      ).toMatchObject([
        { amount_cents: 100, source: 'donor' },
        { amount_cents: 900, source: 'auto' },
      ]);
      await expect(
        prisma.$transaction((tx) =>
          votePollTx(tx, donor.id, poll.id, poll.options[0]!.id, 1, donation.id, {
            mode: 'pool',
            source: 'auto',
          }),
        ),
      ).rejects.toThrow('Pool budget');
    } finally {
      await prisma.rewardClaim.deleteMany({ where: { donation_id: donation.id } });
      await prisma.pollVote.deleteMany({ where: { donation_id: donation.id } });
      await prisma.fundContribution.deleteMany({ where: { donation_id: donation.id } });
      await prisma.donation.delete({ where: { id: donation.id } });
      await prisma.reward.delete({ where: { id: reward.id } });
      await prisma.fundGoal.delete({ where: { id: goal.id } });
      await cleanup(donor.id, poll.id);
    }
  });

  it('respects reserved Pool credit and a failed-refund gap rather than drawing on a large Wallet', async () => {
    const donor = await makeDonor(5000);
    const donation = await prisma.donation.create({
      data: {
        external_id: `reserved-${Math.random()}`,
        donor_id: donor.id,
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        failed_payment_wallet_credit_cents: 100,
      },
    });
    const poll = await prisma.poll.create({
      data: { title: 'Reserved', options: { create: [{ label: 'A' }] } },
      include: { options: true },
    });
    const origin = await prisma.pollVote.create({
      data: {
        donor_id: donor.id,
        donation_id: donation.id,
        poll_id: poll.id,
        poll_option_id: poll.options[0]!.id,
        amount_cents: 800,
        reversed_at: new Date(),
      },
    });
    const credit = await prisma.poolCredit.create({
      data: {
        donation_id: donation.id,
        category: 'poll',
        amount_cents: 800,
        remaining_cents: 800,
        source_vote_id: origin.id,
        created_by: 'fixture',
      },
    });
    try {
      await expect(
        prisma.$transaction((tx) =>
          votePollTx(tx, donor.id, poll.id, poll.options[0]!.id, 101, donation.id, {
            mode: 'pool',
            source: 'auto',
          }),
        ),
      ).rejects.toThrow('Pool budget');
      await prisma.$transaction((tx) =>
        votePollTx(tx, donor.id, poll.id, poll.options[0]!.id, 100, donation.id, {
          mode: 'pool',
          source: 'auto',
        }),
      );
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 5000,
      });
    } finally {
      await prisma.poolCredit.delete({ where: { id: credit.id } });
      await prisma.pollVote.deleteMany({ where: { donation_id: donation.id } });
      await prisma.donation.delete({ where: { id: donation.id } });
      await cleanup(donor.id, poll.id);
    }
  });

  it('rejects REJECTED options, including direct legacy Wallet votes, without taking money', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: { title: 'Rejected', options: { create: [{ label: 'No', status: 'REJECTED' }] } },
      include: { options: true },
    });
    try {
      await expect(
        prisma.$transaction((tx) => votePollTx(tx, donor.id, poll.id, poll.options[0]!.id, 100)),
      ).rejects.toThrow('rejected');
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 1000,
      });
      expect(await prisma.pollVote.count({ where: { poll_id: poll.id } })).toBe(0);
    } finally {
      await cleanup(donor.id, poll.id);
    }
  });

  it('rejects direct physical reward claims even with enough Wallet credit, without changing funds or stock', async () => {
    const donor = await makeDonor(5000);
    const reward = await prisma.reward.create({
      data: { title: 'Cash-funded only', type: 'PHYSICAL', cost_cents: 1000, quantity_total: 2 },
    });
    try {
      await expect(
        prisma.$transaction((tx) => claimRewardTx(tx, donor.id, reward.id)),
      ).rejects.toMatchObject({
        status: 400,
        message: 'Physical rewards require a cash-funded pledge through Stripe checkout',
      });
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 5000,
      });
      expect(await prisma.rewardClaim.count({ where: { donor_id: donor.id } })).toBe(0);
      expect(await prisma.reward.findUnique({ where: { id: reward.id } })).toMatchObject({
        quantity_claimed: 0,
      });
    } finally {
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor.id } });
      await prisma.reward.delete({ where: { id: reward.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });

  it('preserves direct legacy reward prices below the new-pledge selection minimum', async () => {
    const donor = await makeDonor(50);
    const reward = await prisma.reward.create({
      data: { title: 'Legacy price', type: 'DIGITAL', cost_cents: 50 },
    });
    try {
      await prisma.$transaction((tx) => claimRewardTx(tx, donor.id, reward.id));
      expect(await prisma.donor.findUnique({ where: { id: donor.id } })).toMatchObject({
        balance_remaining: 0,
      });
      expect(await prisma.rewardClaim.findMany({ where: { donor_id: donor.id } })).toMatchObject([
        { amount_cents: 50 },
      ]);
    } finally {
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor.id } });
      await prisma.reward.delete({ where: { id: reward.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });

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
