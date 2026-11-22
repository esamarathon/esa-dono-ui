import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import {
  proposeCustomEntryTx,
  votePollTx,
  claimRewardTx,
  contributeGoalTx,
} from '../../services/spend.js';
import { DEFAULT_EVENT_ID, ensureDefaultEvent } from '../helpers/fixtures.js';

beforeAll(async () => {
  await ensureDefaultEvent(prisma);
});

const prisma = createDatabaseClient();

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
        event_id: DEFAULT_EVENT_ID,
        donor_id: donor.id,
        amount_cents: 1000,
        pledge_amount_cents: 1000,
      },
    });
    const reward = await prisma.reward.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Locked', type: 'PHYSICAL', cost_cents: 2000 },
    });
    const goal = await prisma.fundGoal.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Overshoot', target_cents: 100 },
    });
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Pool',
        options: { create: [{ label: 'Choice' }] },
      },
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
        event_id: DEFAULT_EVENT_ID,
        donor_id: donor.id,
        amount_cents: 1000,
        pledge_amount_cents: 1000,
        failed_payment_wallet_credit_cents: 100,
      },
    });
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Reserved',
        options: { create: [{ label: 'A' }] },
      },
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
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Rejected',
        options: { create: [{ label: 'No', status: 'REJECTED' }] },
      },
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
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Cash-funded only',
        type: 'PHYSICAL',
        cost_cents: 1000,
        quantity_total: 2,
      },
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
      data: { event_id: DEFAULT_EVENT_ID, title: 'Legacy price', type: 'DIGITAL', cost_cents: 50 },
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
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Auto poll',
        is_active: true,
        allow_custom_entries: true,
      },
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
        event_id: DEFAULT_EVENT_ID,
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
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Poor poll',
        is_active: true,
        allow_custom_entries: true,
      },
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
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Locked poll',
        is_active: true,
        allow_custom_entries: false,
      },
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
        event_id: DEFAULT_EVENT_ID,
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

  it('defaults to a 40-character cap when max_entry_chars is null (#76)', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Default cap poll',
        is_active: true,
        allow_custom_entries: true,
      },
    });

    try {
      const result = await prisma.$transaction((tx) =>
        proposeCustomEntryTx(tx, donor.id, poll.id, 'x'.repeat(40), 500),
      );
      expect(result.status).toBe('ACTIVE');

      await expect(
        prisma.$transaction((tx) =>
          proposeCustomEntryTx(tx, donor.id, poll.id, 'x'.repeat(41), 500),
        ),
      ).rejects.toThrow('Entry exceeds maximum of 40 characters');
    } finally {
      await cleanup(donor.id, poll.id);
    }
  }, 10000);

  it('lets an explicit max_entry_chars override the 40-character default (#76)', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Longer cap poll',
        is_active: true,
        allow_custom_entries: true,
        max_entry_chars: 50,
      },
    });

    try {
      const result = await prisma.$transaction((tx) =>
        proposeCustomEntryTx(tx, donor.id, poll.id, 'x'.repeat(45), 500),
      );
      expect(result.status).toBe('ACTIVE');

      await expect(
        prisma.$transaction((tx) =>
          proposeCustomEntryTx(tx, donor.id, poll.id, 'x'.repeat(51), 500),
        ),
      ).rejects.toThrow('Entry exceeds maximum of 50 characters');
    } finally {
      await cleanup(donor.id, poll.id);
    }
  }, 10000);

  it('rejects blocked words', async () => {
    const donor = await makeDonor(1000);
    const poll = await prisma.poll.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Clean poll',
        is_active: true,
        allow_custom_entries: true,
      },
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

  it('rejects a blank claim answer on a labeled CUSTOM reward with 400, without taking funds or stock (#78)', async () => {
    const donor = await makeDonor(5000);
    const reward = await prisma.reward.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Pick the Next Game',
        type: 'CUSTOM',
        custom_type_label: 'Your game pick',
        cost_cents: 1000,
        quantity_total: 2,
      },
    });
    try {
      for (const claimData of [undefined, null, {}, { data: '   ' }]) {
        await expect(
          prisma.$transaction((tx) => claimRewardTx(tx, donor.id, reward.id, claimData)),
        ).rejects.toMatchObject({ status: 400, message: 'answer is required' });
      }
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

  it('stores a supplied claim answer on a labeled CUSTOM claim (#78)', async () => {
    const donor = await makeDonor(5000);
    const reward = await prisma.reward.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Pick the Next Game',
        type: 'CUSTOM',
        custom_type_label: 'Your game pick',
        cost_cents: 1000,
      },
    });
    try {
      await prisma.$transaction((tx) =>
        claimRewardTx(tx, donor.id, reward.id, { data: 'Outer Wilds' }),
      );
      expect(await prisma.rewardClaim.findMany({ where: { donor_id: donor.id } })).toMatchObject([
        { claim_data: '{"data":"Outer Wilds"}', amount_cents: 1000 },
      ]);
    } finally {
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor.id } });
      await prisma.reward.delete({ where: { id: reward.id } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });

  it('accepts blank claim answers when the Custom Label is empty and for shoutout/digital/physical rewards (#78)', async () => {
    const donor = await makeDonor(5000);
    const custom = await prisma.reward.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Optional answer',
        type: 'CUSTOM',
        cost_cents: 500,
      },
    });
    const shoutout = await prisma.reward.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Shoutout', type: 'SHOUTOUT', cost_cents: 500 },
    });
    const digital = await prisma.reward.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Code', type: 'DIGITAL', cost_cents: 500 },
    });
    const physical = await prisma.reward.create({
      data: { event_id: DEFAULT_EVENT_ID, title: 'Shirt', type: 'PHYSICAL', cost_cents: 500 },
    });
    const donation = await prisma.donation.create({
      data: {
        external_id: `answer-${Math.random()}`,
        event_id: DEFAULT_EVENT_ID,
        donor_id: donor.id,
        amount_cents: 500,
        pledge_amount_cents: 500,
      },
    });
    try {
      await prisma.$transaction(async (tx) => {
        await claimRewardTx(tx, donor.id, custom.id, {});
        await claimRewardTx(tx, donor.id, shoutout.id, {});
        await claimRewardTx(tx, donor.id, digital.id, {});
        await claimRewardTx(tx, donor.id, physical.id, {}, 1, donation.id, {
          mode: 'pool',
          source: 'donor',
          unit_price_cents: 500,
          confirmed_reward_type: 'PHYSICAL',
        });
      });
      expect(await prisma.rewardClaim.count({ where: { donor_id: donor.id } })).toBe(4);
    } finally {
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor.id } });
      await prisma.donation.deleteMany({ where: { donor_id: donor.id } });
      await prisma.reward.deleteMany({
        where: { id: { in: [custom.id, shoutout.id, digital.id, physical.id] } },
      });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });

  it('caps claim answers at 200 characters, optional or required (#78)', async () => {
    const donor = await makeDonor(5000);
    const required = await prisma.reward.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Pick the Next Game',
        type: 'CUSTOM',
        custom_type_label: 'Your game pick',
        cost_cents: 1000,
      },
    });
    const optional = await prisma.reward.create({
      data: {
        event_id: DEFAULT_EVENT_ID,
        title: 'Optional answer',
        type: 'CUSTOM',
        cost_cents: 1000,
      },
    });
    try {
      await prisma.$transaction((tx) =>
        claimRewardTx(tx, donor.id, required.id, { data: 'x'.repeat(200) }),
      );
      for (const reward of [required, optional]) {
        await expect(
          prisma.$transaction((tx) =>
            claimRewardTx(tx, donor.id, reward.id, { data: 'x'.repeat(201) }),
          ),
        ).rejects.toMatchObject({
          status: 400,
          message: 'answer exceeds maximum of 200 characters',
        });
      }
    } finally {
      await prisma.rewardClaim.deleteMany({ where: { donor_id: donor.id } });
      await prisma.reward.deleteMany({ where: { id: { in: [required.id, optional.id] } } });
      await prisma.donor.delete({ where: { id: donor.id } });
    }
  });
});
