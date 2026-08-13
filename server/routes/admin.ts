import { Router } from 'express';
import crypto from 'crypto';
import { MIN_SPEND_CENTS } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { processDonation } from '../services/donation.js';
import { TOKEN_TTL_MS } from '../config.js';

const router = Router();
router.use(adminAuth);

// Stats
router.get('/stats', async (req, res) => {
  const [donorCount, donationCount, claimCount, totalRaised, pledgeCount] = await Promise.all([
    prisma.donor.count(),
    prisma.donation.count(),
    prisma.rewardClaim.count(),
    prisma.donation.aggregate({ _sum: { amount_cents: true } }),
    prisma.pendingPledge.count(),
  ]);
  res.json({
    donors: donorCount,
    donations: donationCount,
    claims: claimCount,
    pledges: pledgeCount,
    total_raised_cents: totalRaised._sum.amount_cents ?? 0,
  });
});

// Donations
router.get('/donations', async (req, res) => {
  const donations = await prisma.donation.findMany({
    include: { donor: { select: { email: true } } },
    orderBy: { created_at: 'desc' },
  });
  res.json(donations);
});

// Claims
router.get('/claims', async (req, res) => {
  const claims = await prisma.rewardClaim.findMany({
    include: { reward: true, donor: { select: { email: true } } },
    orderBy: { created_at: 'desc' },
  });
  res.json(
    claims.map((c) => {
      let parsed = null;
      try {
        parsed = c.claim_data ? JSON.parse(c.claim_data) : null;
      } catch {
        /* ignore */
      }
      return { ...c, claim_data: parsed };
    }),
  );
});

router.patch('/claims/:id', async (req, res) => {
  const { status } = req.body;
  if (!['PENDING', 'FULFILLED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const claim = await prisma.rewardClaim.update({
    where: { id: req.params.id },
    data: { status },
    include: { reward: true, donor: { select: { email: true } } },
  });
  res.json(claim);
});

// Rewards CRUD
router.get('/rewards', async (req, res) => {
  res.json(await prisma.reward.findMany({ orderBy: { created_at: 'desc' } }));
});

router.post('/rewards', async (req, res) => {
  const { title, description, type, cost_cents, quantity_total, is_active, custom_type_label } =
    req.body;
  const reward = await prisma.reward.create({
    data: {
      title,
      description,
      type,
      cost_cents,
      quantity_total: quantity_total ?? null,
      is_active: is_active ?? true,
      custom_type_label,
    },
  });
  res.json(reward);
});

router.put('/rewards/:id', async (req, res) => {
  const { title, description, type, cost_cents, quantity_total, is_active, custom_type_label } =
    req.body;
  const reward = await prisma.reward.update({
    where: { id: req.params.id },
    data: {
      title,
      description,
      type,
      cost_cents,
      quantity_total: quantity_total ?? null,
      is_active,
      custom_type_label,
    },
  });
  res.json(reward);
});

router.delete('/rewards/:id', async (req, res) => {
  await prisma.reward.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Simulate donation
router.post('/simulate-donation', async (req, res) => {
  try {
    const { email, donor_name, amount_cents, comment, pledge_token } = req.body;
    const cents = Number(amount_cents);
    if (!email || !Number.isInteger(cents) || cents < MIN_SPEND_CENTS) {
      return res
        .status(400)
        .json({ error: `email and amount_cents (min ${MIN_SPEND_CENTS}) required` });
    }
    const externalId = `sim-${crypto.randomUUID()}`;
    const result = await processDonation({
      externalId,
      email,
      donorName: donor_name || 'Anonymous',
      amountCents: cents,
      comment: comment || null,
      pledgeToken: pledge_token || null,
    });
    if ('duplicate' in result) {
      // sim always uses a fresh externalId, so this branch is unreachable;
      // narrow the union for TypeScript without altering behavior.
      throw new Error('Duplicate donation');
    }
    res.json({
      success: true,
      token: result.token,
      donor: {
        id: result.donor.id,
        email: result.donor.email,
        balance_remaining: result.donor.balance_remaining,
      },
      pledge: result.pledge || null,
    });
  } catch (err) {
    console.error('Simulate donation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Donor management
router.get('/donors', async (req, res) => {
  const { q, offset } = req.query;
  const where = typeof q === 'string' ? { email: { contains: q } } : {};
  const [donors, total] = await Promise.all([
    prisma.donor.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 50,
      skip: Number(offset) || 0,
    }),
    prisma.donor.count({ where }),
  ]);
  res.json({ donors, total });
});

router.get('/donors/:id', async (req, res) => {
  const donor = await prisma.donor.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      email: true,
      total_donated: true,
      balance_remaining: true,
      role: true,
      is_frozen: true,
      created_at: true,
      updated_at: true,
      donations: { orderBy: { created_at: 'desc' }, take: 50 },
      reward_claims: { orderBy: { created_at: 'desc' }, take: 50, include: { reward: true } },
      poll_votes: { orderBy: { created_at: 'desc' }, take: 50 },
      fund_contributions: { orderBy: { created_at: 'desc' }, take: 50, include: { goal: true } },
      balance_adjustments: { orderBy: { created_at: 'desc' }, take: 50 },
    },
  });
  if (!donor) return res.status(404).json({ error: 'Donor not found' });
  res.json(donor);
});

router.patch('/donors/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!['USER', 'MODERATOR', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'role must be USER, MODERATOR, or ADMIN' });
  }
  const donor = await prisma.donor.update({
    where: { id: req.params.id },
    data: { role },
  });
  res.json({ success: true, email: donor.email, role: donor.role });
});

router.post('/donors/:id/revoke-token', async (req, res) => {
  const donor = await prisma.donor.update({
    where: { id: req.params.id },
    data: { magic_token: null, token_expires_at: null },
  });
  res.json({ success: true, email: donor.email });
});

router.post('/donors/:id/regenerate-token', async (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const donor = await prisma.donor.update({
    where: { id: req.params.id },
    data: { magic_token: token, token_expires_at: tokenExpiresAt },
  });
  res.json({ success: true, email: donor.email, magic_token: donor.magic_token });
});

router.post('/donors/:id/freeze', async (req, res) => {
  const { frozen } = req.body;
  if (typeof frozen !== 'boolean') return res.status(400).json({ error: 'frozen must be boolean' });
  const donor = await prisma.donor.update({
    where: { id: req.params.id },
    data: { is_frozen: frozen },
  });
  res.json({ success: true, email: donor.email, is_frozen: donor.is_frozen });
});

router.post('/donors/:id/adjust-balance', async (req, res) => {
  const { amount_cents, reason, type } = req.body;
  const cents = Number(amount_cents);
  if (!Number.isInteger(cents) || cents === 0) {
    return res.status(400).json({ error: 'amount_cents must be a non-zero integer' });
  }
  if (!['REFUND', 'FREEZE_ZERO', 'MANUAL', 'CHARGEBACK'].includes(type)) {
    return res.status(400).json({ error: 'Invalid adjustment type' });
  }
  const donor = await prisma.donor.findUnique({ where: { id: req.params.id } });
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  const balanceAfter = donor.balance_remaining + cents;
  if (balanceAfter < 0) {
    return res.status(400).json({ error: 'Adjustment would result in negative balance' });
  }

  await prisma.$transaction([
    prisma.donor.update({
      where: { id: donor.id },
      data: { balance_remaining: { increment: cents } },
    }),
    prisma.balanceAdjustment.create({
      data: {
        donor_id: donor.id,
        amount_cents: cents,
        balance_after_cents: balanceAfter,
        type,
        reason: reason || null,
        created_by: 'admin',
      },
    }),
  ]);

  res.json({
    success: true,
    email: donor.email,
    balance_before: donor.balance_remaining,
    balance_after: balanceAfter,
    adjustment: cents,
  });
});

router.post('/donors/:id/reverse-spend', async (req, res) => {
  const { spend_type, spend_id } = req.body;
  if (!spend_type || !spend_id) {
    return res.status(400).json({ error: 'spend_type and spend_id required' });
  }

  const donor = await prisma.donor.findUnique({ where: { id: req.params.id } });
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  if (spend_type === 'claim') {
    const claim = await prisma.rewardClaim.findUnique({
      where: { id: spend_id },
      include: { reward: true },
    });
    if (!claim || claim.donor_id !== donor.id)
      return res.status(404).json({ error: 'Claim not found' });
    if (claim.status === 'REVERSED')
      return res.status(400).json({ error: 'Claim already reversed' });
    if (claim.status === 'FULFILLED')
      return res
        .status(400)
        .json({ error: 'Cannot reverse fulfilled claim; mark it as PENDING first' });

    const refundCents = claim.reward.cost_cents;

    await prisma.$transaction([
      prisma.donor.update({
        where: { id: donor.id },
        data: { balance_remaining: { increment: refundCents } },
      }),
      prisma.rewardClaim.update({
        where: { id: claim.id },
        data: { status: 'REVERSED', reversed_at: new Date(), reversed_by: 'admin' },
      }),
      prisma.reward.update({
        where: { id: claim.reward_id },
        data: { quantity_claimed: { decrement: 1 } },
      }),
      prisma.balanceAdjustment.create({
        data: {
          donor_id: donor.id,
          amount_cents: refundCents,
          balance_after_cents: donor.balance_remaining + refundCents,
          type: 'REFUND',
          reason: 'Reversed reward claim',
          reference_id: claim.id,
          created_by: 'admin',
        },
      }),
    ]);
  } else if (spend_type === 'vote') {
    const vote = await prisma.pollVote.findUnique({ where: { id: spend_id } });
    if (!vote || vote.donor_id !== donor.id)
      return res.status(404).json({ error: 'Vote not found' });
    if (vote.reversed_at) return res.status(400).json({ error: 'Vote already reversed' });

    const option = await prisma.pollOption.findUnique({ where: { id: vote.poll_option_id } });
    // Only decrement the public tally if the option was actually credited
    // (ACTIVE). A vote funding a still-PENDING_APPROVAL custom entry has
    // votes_cents === 0 on the option, so skip the decrement to avoid going
    // negative; mark the option REJECTED instead so it stays excluded.
    const wasActive = option?.status === 'ACTIVE';

    await prisma.$transaction([
      prisma.donor.update({
        where: { id: donor.id },
        data: { balance_remaining: { increment: vote.amount_cents } },
      }),
      prisma.pollVote.update({
        where: { id: vote.id },
        data: { reversed_at: new Date(), reversed_by: 'admin' },
      }),
      ...(option
        ? [
            wasActive
              ? prisma.pollOption.update({
                  where: { id: option.id },
                  data: { votes_cents: { decrement: vote.amount_cents } },
                })
              : prisma.pollOption.update({
                  where: { id: option.id },
                  data: { status: 'REJECTED' },
                }),
          ]
        : []),
      ...(wasActive
        ? [
            prisma.poll.update({
              where: { id: vote.poll_id },
              data: { total_votes_cents: { decrement: vote.amount_cents } },
            }),
          ]
        : []),
      prisma.balanceAdjustment.create({
        data: {
          donor_id: donor.id,
          amount_cents: vote.amount_cents,
          balance_after_cents: donor.balance_remaining + vote.amount_cents,
          type: 'REFUND',
          reason: 'Reversed poll vote',
          reference_id: vote.id,
          created_by: 'admin',
        },
      }),
    ]);
  } else if (spend_type === 'contribution') {
    const contrib = await prisma.fundContribution.findUnique({ where: { id: spend_id } });
    if (!contrib || contrib.donor_id !== donor.id)
      return res.status(404).json({ error: 'Contribution not found' });
    if (contrib.reversed_at)
      return res.status(400).json({ error: 'Contribution already reversed' });

    const goal = await prisma.fundGoal.findUnique({ where: { id: contrib.goal_id } });
    const newTotal = goal ? goal.current_cents - contrib.amount_cents : 0;

    await prisma.$transaction([
      prisma.donor.update({
        where: { id: donor.id },
        data: { balance_remaining: { increment: contrib.amount_cents } },
      }),
      prisma.fundContribution.update({
        where: { id: contrib.id },
        data: { reversed_at: new Date(), reversed_by: 'admin' },
      }),
      ...(goal
        ? [
            prisma.fundGoal.update({
              where: { id: goal.id },
              data: {
                current_cents: { decrement: contrib.amount_cents },
                is_complete: newTotal <= 0 ? false : undefined,
              },
            }),
          ]
        : []),
      prisma.balanceAdjustment.create({
        data: {
          donor_id: donor.id,
          amount_cents: contrib.amount_cents,
          balance_after_cents: donor.balance_remaining + contrib.amount_cents,
          type: 'REFUND',
          reason: 'Reversed fund contribution',
          reference_id: contrib.id,
          created_by: 'admin',
        },
      }),
    ]);
  } else {
    return res
      .status(400)
      .json({ error: 'Invalid spend_type. Must be claim, vote, or contribution' });
  }

  res.json({ success: true });
});

// Polls CRUD
router.get('/polls', async (req, res) => {
  res.json(
    await prisma.poll.findMany({
      include: { options: true },
      orderBy: { created_at: 'desc' },
    }),
  );
});

router.post('/polls', async (req, res) => {
  const {
    title,
    description,
    is_active,
    ends_at,
    options,
    allow_custom_entries,
    max_entry_chars,
    auto_approve,
  } = req.body;
  const poll = await prisma.poll.create({
    data: {
      title,
      description,
      is_active: is_active ?? true,
      ends_at: ends_at ? new Date(ends_at) : null,
      allow_custom_entries: allow_custom_entries ?? false,
      max_entry_chars: max_entry_chars ?? null,
      auto_approve: auto_approve ?? true,
      options: options?.length
        ? { create: options.map((o: { label: string }) => ({ label: o.label })) }
        : undefined,
    },
    include: { options: true },
  });
  res.json(poll);
});

router.put('/polls/:id', async (req, res) => {
  const {
    title,
    description,
    is_active,
    ends_at,
    allow_custom_entries,
    max_entry_chars,
    auto_approve,
  } = req.body;
  const poll = await prisma.poll.update({
    where: { id: req.params.id },
    data: {
      title,
      description,
      is_active,
      ends_at: ends_at ? new Date(ends_at) : null,
      allow_custom_entries: allow_custom_entries ?? false,
      max_entry_chars: max_entry_chars ?? null,
      auto_approve: auto_approve ?? true,
    },
    include: { options: true },
  });
  res.json(poll);
});

router.delete('/polls/:id', async (req, res) => {
  await prisma.poll.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

router.post('/polls/:id/options', async (req, res) => {
  const option = await prisma.pollOption.create({
    data: { poll_id: req.params.id, label: req.body.label },
  });
  res.json(option);
});

router.delete('/polls/options/:id', async (req, res) => {
  await prisma.pollOption.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Pledges
router.get('/pledges', async (req, res) => {
  const pledges = await prisma.pendingPledge.findMany({
    include: {
      items: true,
      fulfilled_by: {
        include: { donor: { select: { email: true } } },
      },
    },
    orderBy: { created_at: 'desc' },
    take: 100,
  });
  res.json(pledges);
});
router.get('/blocked-words', async (req, res) => {
  const words = await prisma.blockedWord.findMany({ orderBy: { word: 'asc' } });
  res.json(words);
});

router.post('/blocked-words', async (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: 'word required' });
  try {
    const blocked = await prisma.blockedWord.create({ data: { word: word.trim().toLowerCase() } });
    res.json(blocked);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002')
      return res.status(409).json({ error: 'Word already exists' });
    throw e;
  }
});

router.delete('/blocked-words/:id', async (req, res) => {
  await prisma.blockedWord.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Goals CRUD
router.get('/goals', async (req, res) => {
  res.json(await prisma.fundGoal.findMany({ orderBy: { created_at: 'desc' } }));
});

router.post('/goals', async (req, res) => {
  const { title, description, target_cents, is_active } = req.body;
  const goal = await prisma.fundGoal.create({
    data: { title, description, target_cents, is_active: is_active ?? true },
  });
  res.json(goal);
});

router.put('/goals/:id', async (req, res) => {
  const { title, description, target_cents, is_active, is_complete } = req.body;
  const goal = await prisma.fundGoal.update({
    where: { id: req.params.id },
    data: { title, description, target_cents, is_active, is_complete },
  });
  res.json(goal);
});

router.delete('/goals/:id', async (req, res) => {
  await prisma.fundGoal.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

export default router;
