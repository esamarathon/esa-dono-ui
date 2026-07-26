import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { moderatorAuth } from '../middleware/moderatorAuth.js';

const router = Router();
router.use(moderatorAuth);

// Dashboard stats
router.get('/stats', async (req, res) => {
  const [pendingEntries, activePolls, totalRewards, totalGoals] = await Promise.all([
    prisma.pollCustomEntry.count({ where: { status: 'PENDING' } }),
    prisma.poll.count({ where: { is_active: true } }),
    prisma.reward.count({ where: { is_active: true } }),
    prisma.fundGoal.count({ where: { is_active: true } }),
  ]);
  res.json({
    pending_entries: pendingEntries,
    active_polls: activePolls,
    total_rewards: totalRewards,
    total_goals: totalGoals,
  });
});

// Polls CRUD
router.get('/polls', async (req, res) => {
  res.json(
    await prisma.poll.findMany({
      include: { options: true, custom_entries: true },
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

// Custom entries
router.get('/polls/:id/custom-entries', async (req, res) => {
  const entries = await prisma.pollCustomEntry.findMany({
    where: { poll_id: req.params.id },
    include: {
      donor: { select: { email: true } },
      option: { include: { votes: { orderBy: { created_at: 'desc' }, take: 1 } } },
    },
    orderBy: { created_at: 'desc' },
  });
  res.json(entries);
});

router.patch('/polls/custom-entries/:id', async (req, res) => {
  const { status } = req.body;
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'Status must be APPROVED or REJECTED' });
  }

  const entry = await prisma.pollCustomEntry.findUnique({ where: { id: req.params.id } });
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.status !== 'PENDING') {
    return res.status(400).json({ error: 'Only pending entries can be moderated' });
  }

  const option = await prisma.pollOption.findUnique({ where: { custom_entry_id: entry.id } });
  if (!option) return res.status(404).json({ error: 'Associated poll option not found' });

  const vote = await prisma.pollVote.findFirst({
    where: { poll_option_id: option.id, reversed_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (!vote) return res.status(404).json({ error: 'Associated funding vote not found' });

  const moderatorEmail = req.donor?.email || 'moderator';

  if (status === 'APPROVED') {
    await prisma.$transaction([
      prisma.pollOption.update({
        where: { id: option.id },
        data: { status: 'ACTIVE', votes_cents: { increment: vote.amount_cents } },
      }),
      prisma.poll.update({
        where: { id: entry.poll_id },
        data: { total_votes_cents: { increment: vote.amount_cents } },
      }),
      prisma.pollCustomEntry.update({
        where: { id: entry.id },
        data: { status: 'APPROVED' },
      }),
    ]);
  } else {
    const donor = await prisma.donor.findUnique({ where: { id: vote.donor_id } });
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    await prisma.$transaction([
      prisma.donor.update({
        where: { id: donor.id },
        data: { balance_remaining: { increment: vote.amount_cents } },
      }),
      prisma.pollVote.update({
        where: { id: vote.id },
        data: { reversed_at: new Date(), reversed_by: moderatorEmail },
      }),
      prisma.pollOption.update({
        where: { id: option.id },
        data: { status: 'REJECTED' },
      }),
      prisma.pollCustomEntry.update({
        where: { id: entry.id },
        data: { status: 'REJECTED' },
      }),
      prisma.balanceAdjustment.create({
        data: {
          donor_id: donor.id,
          amount_cents: vote.amount_cents,
          balance_after_cents: donor.balance_remaining + vote.amount_cents,
          type: 'REFUND',
          reason: 'Rejected custom poll entry',
          reference_id: vote.id,
          created_by: moderatorEmail,
        },
      }),
    ]);
  }

  const updated = await prisma.pollCustomEntry.findUnique({
    where: { id: req.params.id },
    include: { donor: { select: { email: true } } },
  });
  res.json(updated);
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
