import { Router } from 'express';
import crypto from 'crypto';
import { MIN_SPEND_CENTS } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { deleteUploadByUrl } from '../lib/uploads.js';
import { processDonation } from '../services/donation.js';
import { refundGoalContributions, refundPollOptionVotes } from '../services/refund.js';
import {
  closeAuctionTx,
  cancelAuctionTx,
  skipCurrentOfferTx,
  resendCurrentOfferTx,
} from '../services/auction.js';
import { TOKEN_TTL_MS } from '../config.js';
import {
  emitWebhookEvent,
  buildIncentiveCreatedPayload,
  buildIncentiveEnabledPayload,
  buildIncentiveDisabledPayload,
  buildIncentiveValueChangedPayload,
} from '../services/eventDelivery.js';

const router = Router();
router.use(adminAuth);

// Stats
router.get('/stats', async (req, res) => {
  const [donorCount, donationCount, claimCount, totalRaised, pledgeCount, channels] =
    await Promise.all([
      prisma.donor.count(),
      prisma.donation.count(),
      prisma.rewardClaim.count(),
      prisma.donation.aggregate({ _sum: { amount_cents: true } }),
      prisma.pendingPledge.count(),
      prisma.channel.findMany({ orderBy: { created_at: 'asc' } }),
    ]);

  const perChannel = await Promise.all(
    channels.map(async (channel) => {
      const [sum, count] = await Promise.all([
        prisma.donation.aggregate({
          where: { channel_id: channel.id },
          _sum: { amount_cents: true },
        }),
        prisma.donation.count({ where: { channel_id: channel.id } }),
      ]);
      return {
        id: channel.id,
        name: channel.name,
        raised_cents: sum._sum.amount_cents ?? 0,
        donations: count,
      };
    }),
  );

  res.json({
    donors: donorCount,
    donations: donationCount,
    claims: claimCount,
    pledges: pledgeCount,
    total_raised_cents: totalRaised._sum.amount_cents ?? 0,
    channels: perChannel,
  });
});

// Channels CRUD
router.get('/channels', async (req, res) => {
  res.json(await prisma.channel.findMany({ orderBy: { created_at: 'asc' } }));
});

router.post('/channels', async (req, res) => {
  const { name, is_active } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const channel = await prisma.channel.create({
      data: { name: String(name).trim(), is_active: is_active ?? true },
    });
    res.json(channel);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return res.status(409).json({ error: 'Channel name already exists' });
    }
    throw e;
  }
});

router.put('/channels/:id', async (req, res) => {
  const { name, is_active } = req.body;
  try {
    const channel = await prisma.channel.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(is_active !== undefined ? { is_active } : {}),
      },
    });
    res.json(channel);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return res.status(409).json({ error: 'Channel name already exists' });
    }
    throw e;
  }
});

// Soft-delete: channels may be referenced by incentives/donations/pledges, so
// deactivate instead of hard-deleting to preserve those references.
router.delete('/channels/:id', async (req, res) => {
  const channel = await prisma.channel.update({
    where: { id: req.params.id },
    data: { is_active: false },
  });
  res.json({ success: true, channel });
});

// Donations
router.get('/donations', async (req, res) => {
  const donations = await prisma.donation.findMany({
    include: { donor: { select: { email: true } }, channel: { select: { id: true, name: true } } },
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
  const {
    title,
    description,
    type,
    cost_cents,
    quantity_total,
    is_active,
    custom_type_label,
    image_url,
    channel_id,
  } = req.body;
  const reward = await prisma.reward.create({
    data: {
      title,
      description,
      type,
      cost_cents,
      quantity_total: quantity_total ?? null,
      is_active: is_active ?? true,
      custom_type_label,
      image_url: image_url || null,
      channel_id: channel_id || null,
    },
  });
  emitWebhookEvent(
    'incentive.created',
    buildIncentiveCreatedPayload({
      incentiveKind: 'REWARD',
      incentiveId: reward.id,
      title: reward.title,
      isActive: reward.is_active,
      costCents: reward.cost_cents,
    }),
  );
  res.json(reward);
});

router.put('/rewards/:id', async (req, res) => {
  const {
    title,
    description,
    type,
    cost_cents,
    quantity_total,
    is_active,
    custom_type_label,
    image_url,
    channel_id,
  } = req.body;
  const prior = await prisma.reward.findUnique({ where: { id: req.params.id } });
  if (!prior) return res.status(404).json({ error: 'Reward not found' });

  if (prior.image_url !== (image_url || null)) {
    await deleteUploadByUrl(prior.image_url);
  }
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
      image_url: image_url || null,
      channel_id: channel_id || null,
    },
  });

  if (!prior.is_active && reward.is_active) {
    emitWebhookEvent(
      'incentive.enabled',
      buildIncentiveEnabledPayload({
        incentiveKind: 'REWARD',
        incentiveId: reward.id,
        title: reward.title,
      }),
    );
  } else if (prior.is_active && !reward.is_active) {
    emitWebhookEvent(
      'incentive.disabled',
      buildIncentiveDisabledPayload({
        incentiveKind: 'REWARD',
        incentiveId: reward.id,
        title: reward.title,
      }),
    );
  }

  if (prior.cost_cents !== reward.cost_cents) {
    const changedFields = ['cost_cents'];
    emitWebhookEvent(
      'incentive.value_changed',
      buildIncentiveValueChangedPayload({
        incentiveKind: 'REWARD',
        incentiveId: reward.id,
        title: reward.title,
        changedFields,
        oldCostCents: prior.cost_cents,
        newCostCents: reward.cost_cents,
      }),
    );
  }

  res.json(reward);
});

router.delete('/rewards/:id', async (req, res) => {
  try {
    const claims = await prisma.rewardClaim.count({ where: { reward_id: req.params.id } });
    if (claims > 0) {
      return res.status(409).json({
        error: 'Cannot delete a reward with existing claims; deactivate it instead',
      });
    }
    const existing = await prisma.reward.findUnique({
      where: { id: req.params.id },
      select: { image_url: true },
    });
    await prisma.reward.delete({ where: { id: req.params.id } });
    await deleteUploadByUrl(existing?.image_url);
    res.json({ success: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return res.status(404).json({ error: 'Reward not found' });
    if (code === 'P2003') {
      return res.status(409).json({
        error: 'Cannot delete a reward with existing claims; deactivate it instead',
      });
    }
    throw err;
  }
});

// Simulate donation
router.post('/simulate-donation', async (req, res) => {
  try {
    const { email, donor_name, amount_cents, comment, pledge_token, channel_id } = req.body;
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
      channelId: channel_id || null,
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

router.post('/donors', async (req, res) => {
  const { email, role } = req.body;
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  if (role && !['USER', 'MODERATOR', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'role must be USER, MODERATOR, or ADMIN' });
  }
  try {
    const donor = await prisma.donor.create({
      data: { email: String(email).trim().toLowerCase(), role: role || 'USER' },
    });
    res.json(donor);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return res.status(409).json({ error: 'Donor with this email already exists' });
    }
    throw e;
  }
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
    channel_id,
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
      channel_id: channel_id || null,
      options: options?.length
        ? { create: options.map((o: { label: string }) => ({ label: o.label })) }
        : undefined,
    },
    include: { options: true },
  });
  emitWebhookEvent(
    'incentive.created',
    buildIncentiveCreatedPayload({
      incentiveKind: 'POLL',
      incentiveId: poll.id,
      title: poll.title,
      isActive: poll.is_active,
      endsAt: poll.ends_at,
    }),
  );
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
    channel_id,
  } = req.body;

  const prior = await prisma.poll.findUnique({ where: { id: req.params.id } });
  if (!prior) return res.status(404).json({ error: 'Poll not found' });

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
      channel_id: channel_id || null,
    },
    include: { options: true },
  });

  if (!prior.is_active && poll.is_active) {
    emitWebhookEvent(
      'incentive.enabled',
      buildIncentiveEnabledPayload({
        incentiveKind: 'POLL',
        incentiveId: poll.id,
        title: poll.title,
      }),
    );
  } else if (prior.is_active && !poll.is_active) {
    emitWebhookEvent(
      'incentive.disabled',
      buildIncentiveDisabledPayload({
        incentiveKind: 'POLL',
        incentiveId: poll.id,
        title: poll.title,
      }),
    );
  }

  const oldEndsAt = prior.ends_at ? new Date(prior.ends_at) : null;
  const newEndsAt = poll.ends_at ? new Date(poll.ends_at) : null;
  const oldEndsMs = oldEndsAt ? oldEndsAt.getTime() : null;
  const newEndsMs = newEndsAt ? newEndsAt.getTime() : null;
  if (oldEndsMs !== newEndsMs) {
    const changedFields = ['ends_at'];
    emitWebhookEvent(
      'incentive.value_changed',
      buildIncentiveValueChangedPayload({
        incentiveKind: 'POLL',
        incentiveId: poll.id,
        title: poll.title,
        changedFields,
        oldEndsAt,
        newEndsAt,
      }),
    );
  }

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

router.patch('/polls/options/:id', async (req, res) => {
  const { label } = req.body;
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  const option = await prisma.pollOption.update({
    where: { id: req.params.id },
    data: { label: String(label).trim() },
  });
  res.json(option);
});

router.delete('/polls/options/:id', async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const refund = await refundPollOptionVotes(tx, req.params.id);
      await tx.pollOption.update({
        where: { id: req.params.id },
        data: { status: 'REJECTED' },
      });
      return refund;
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/polls/options/:id/refund', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => refundPollOptionVotes(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
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
  const { title, description, target_cents, is_active, channel_id } = req.body;
  const goal = await prisma.fundGoal.create({
    data: {
      title,
      description,
      target_cents,
      is_active: is_active ?? true,
      channel_id: channel_id || null,
    },
  });
  emitWebhookEvent(
    'incentive.created',
    buildIncentiveCreatedPayload({
      incentiveKind: 'GOAL',
      incentiveId: goal.id,
      title: goal.title,
      isActive: goal.is_active,
      targetCents: goal.target_cents,
    }),
  );
  res.json(goal);
});

router.put('/goals/:id', async (req, res) => {
  const { title, description, target_cents, is_active, is_complete, channel_id } = req.body;

  const prior = await prisma.fundGoal.findUnique({ where: { id: req.params.id } });
  if (!prior) return res.status(404).json({ error: 'Goal not found' });

  const goal = await prisma.fundGoal.update({
    where: { id: req.params.id },
    data: {
      title,
      description,
      target_cents,
      is_active,
      is_complete,
      channel_id: channel_id || null,
    },
  });

  if (!prior.is_active && goal.is_active) {
    emitWebhookEvent(
      'incentive.enabled',
      buildIncentiveEnabledPayload({
        incentiveKind: 'GOAL',
        incentiveId: goal.id,
        title: goal.title,
      }),
    );
  } else if (prior.is_active && !goal.is_active) {
    emitWebhookEvent(
      'incentive.disabled',
      buildIncentiveDisabledPayload({
        incentiveKind: 'GOAL',
        incentiveId: goal.id,
        title: goal.title,
      }),
    );
  }

  if (prior.target_cents !== goal.target_cents) {
    const changedFields = ['target_cents'];
    emitWebhookEvent(
      'incentive.value_changed',
      buildIncentiveValueChangedPayload({
        incentiveKind: 'GOAL',
        incentiveId: goal.id,
        title: goal.title,
        changedFields,
        oldTargetCents: prior.target_cents,
        newTargetCents: goal.target_cents,
      }),
    );
  }

  res.json(goal);
});

router.delete('/goals/:id', async (req, res) => {
  try {
    const prior = await prisma.fundGoal.findUnique({ where: { id: req.params.id } });
    if (!prior) return res.status(404).json({ error: 'Goal not found' });

    const result = await prisma.$transaction(async (tx) => {
      const refund = await refundGoalContributions(tx, req.params.id);
      await tx.fundGoal.update({
        where: { id: req.params.id },
        data: { is_active: false },
      });
      return refund;
    });

    if (prior.is_active) {
      emitWebhookEvent(
        'incentive.disabled',
        buildIncentiveDisabledPayload({
          incentiveKind: 'GOAL',
          incentiveId: prior.id,
          title: prior.title,
        }),
      );
    }

    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/goals/:id/refund', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => refundGoalContributions(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// Auctions CRUD
router.get('/auctions', async (req, res) => {
  res.json(
    await prisma.auction.findMany({
      orderBy: { created_at: 'desc' },
      include: { current_offer: true },
    }),
  );
});

router.post('/auctions', async (req, res) => {
  const {
    title,
    description,
    type,
    custom_type_label,
    image_url,
    starting_price_cents,
    min_increment_cents,
    ends_at,
    is_active,
    channel_id,
  } = req.body;
  if (!title || !type || !starting_price_cents || !min_increment_cents || !ends_at) {
    return res.status(400).json({
      error: 'title, type, starting_price_cents, min_increment_cents, and ends_at are required',
    });
  }
  const auction = await prisma.auction.create({
    data: {
      title,
      description,
      type,
      custom_type_label,
      image_url: image_url || null,
      starting_price_cents,
      min_increment_cents,
      ends_at: new Date(ends_at),
      is_active: is_active ?? true,
      channel_id: channel_id || null,
    },
  });
  res.json(auction);
});

router.put('/auctions/:id', async (req, res) => {
  const {
    title,
    description,
    type,
    custom_type_label,
    image_url,
    starting_price_cents,
    min_increment_cents,
    ends_at,
    is_active,
    channel_id,
  } = req.body;
  const existing = await prisma.auction.findUnique({
    where: { id: req.params.id },
    select: { image_url: true, status: true },
  });
  if (!existing) return res.status(404).json({ error: 'Auction not found' });
  if (existing.image_url !== (image_url || null)) {
    await deleteUploadByUrl(existing.image_url);
  }
  const auction = await prisma.auction.update({
    where: { id: req.params.id },
    data: {
      title,
      description,
      type,
      custom_type_label,
      image_url: image_url || null,
      // Pricing/deadline are only safe to change while bidding is still open.
      ...(existing.status === 'OPEN'
        ? {
            starting_price_cents,
            min_increment_cents,
            ends_at: ends_at ? new Date(ends_at) : undefined,
          }
        : {}),
      is_active,
      channel_id: channel_id || null,
    },
  });
  res.json(auction);
});

router.delete('/auctions/:id', async (req, res) => {
  try {
    const bidCount = await prisma.bid.count({ where: { auction_id: req.params.id } });
    if (bidCount > 0) {
      return res.status(409).json({
        error: 'Cannot delete an auction with existing bids; cancel or deactivate it instead',
      });
    }
    const existing = await prisma.auction.findUnique({
      where: { id: req.params.id },
      select: { image_url: true },
    });
    await prisma.auction.delete({ where: { id: req.params.id } });
    await deleteUploadByUrl(existing?.image_url);
    res.json({ success: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return res.status(404).json({ error: 'Auction not found' });
    if (code === 'P2003') {
      return res.status(409).json({
        error: 'Cannot delete an auction with existing bids; cancel or deactivate it instead',
      });
    }
    throw err;
  }
});

router.get('/auctions/:id/offers', async (req, res) => {
  const offers = await prisma.auctionOffer.findMany({
    where: { auction_id: req.params.id },
    include: { donor: { select: { email: true, id: true } } },
    orderBy: { rank: 'asc' },
  });
  res.json(offers);
});

router.post('/auctions/:id/close', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => closeAuctionTx(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/auctions/:id/cancel', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => cancelAuctionTx(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/auctions/:id/skip-offer', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => skipCurrentOfferTx(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/auctions/:id/resend-offer', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => resendCurrentOfferTx(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.get('/auction-wins', async (req, res) => {
  res.json(
    await prisma.auctionWin.findMany({
      include: { auction: true, donor: { select: { email: true } } },
      orderBy: { created_at: 'desc' },
    }),
  );
});

// Webhook endpoints
const WEBHOOK_EVENT_TYPE_KEYS: string[] = [
  'donation.created',
  'donation.moderated',
  'incentive.created',
  'incentive.enabled',
  'incentive.disabled',
  'incentive.value_changed',
];

router.get('/destinations', async (req, res) => {
  const endpoints = await prisma.eventDestination.findMany({
    orderBy: { created_at: 'desc' },
  });
  res.json(
    endpoints.map((ep) => ({
      ...ep,
      event_types: JSON.parse(ep.event_types),
    })),
  );
});

router.post('/destinations', async (req, res) => {
  const {
    url,
    secret,
    event_types,
    verify_ssl,
    description,
    destination_type,
    amqp_url,
    amqp_exchange,
    amqp_routing_key,
  } = req.body;

  const destType = destination_type ?? 'HTTP';

  if (destType === 'HTTP') {
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required for HTTP endpoints' });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'url must be a valid URL' });
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ error: 'url must use http or https' });
    }
  } else if (destType === 'RABBITMQ') {
    if (!amqp_url || typeof amqp_url !== 'string') {
      return res.status(400).json({ error: 'amqp_url is required for RabbitMQ endpoints' });
    }
    if (!amqp_url.startsWith('amqp://') && !amqp_url.startsWith('amqps://')) {
      return res.status(400).json({ error: 'amqp_url must start with amqp:// or amqps://' });
    }
    if (!amqp_routing_key || typeof amqp_routing_key !== 'string') {
      return res.status(400).json({ error: 'amqp_routing_key is required for RabbitMQ endpoints' });
    }
  } else {
    return res.status(400).json({ error: 'destination_type must be HTTP or RABBITMQ' });
  }

  if (event_types && !Array.isArray(event_types)) {
    return res.status(400).json({ error: 'event_types must be an array' });
  }
  if (
    event_types &&
    !event_types.every((t: unknown) => WEBHOOK_EVENT_TYPE_KEYS.includes(t as string))
  ) {
    return res.status(400).json({ error: 'event_types contains invalid event type' });
  }

  const generatedSecret = secret || crypto.randomBytes(32).toString('hex');
  const destination = await prisma.eventDestination.create({
    data: {
      url: url ?? '',
      secret: generatedSecret,
      event_types: JSON.stringify(event_types ?? []),
      verify_ssl: verify_ssl ?? true,
      description: description ?? null,
      destination_type: destType,
      amqp_url: amqp_url ?? null,
      amqp_exchange: amqp_exchange ?? '',
      amqp_routing_key: amqp_routing_key ?? null,
    },
  });
  res.status(201).json({
    ...destination,
    event_types: JSON.parse(destination.event_types),
  });
});

router.put('/destinations/:id', async (req, res) => {
  const {
    url,
    event_types,
    verify_ssl,
    is_active,
    description,
    destination_type,
    amqp_url,
    amqp_exchange,
    amqp_routing_key,
  } = req.body;

  const destType = destination_type ?? 'HTTP';

  if (destType === 'HTTP') {
    if (url !== undefined) {
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'url must be a valid URL' });
      }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return res.status(400).json({ error: 'url must use http or https' });
      }
    }
  } else if (destType === 'RABBITMQ') {
    if (amqp_url !== undefined) {
      if (!amqp_url.startsWith('amqp://') && !amqp_url.startsWith('amqps://')) {
        return res.status(400).json({ error: 'amqp_url must start with amqp:// or amqps://' });
      }
    }
    if (amqp_routing_key !== undefined && typeof amqp_routing_key !== 'string') {
      return res.status(400).json({ error: 'amqp_routing_key must be a string' });
    }
  } else {
    return res.status(400).json({ error: 'destination_type must be HTTP or RABBITMQ' });
  }

  if (event_types !== undefined) {
    if (!Array.isArray(event_types)) {
      return res.status(400).json({ error: 'event_types must be an array' });
    }
    if (!event_types.every((t: unknown) => WEBHOOK_EVENT_TYPE_KEYS.includes(t as string))) {
      return res.status(400).json({ error: 'event_types contains invalid event type' });
    }
  }

  const endpoint = await prisma.eventDestination.update({
    where: { id: req.params.id },
    data: {
      ...(url !== undefined ? { url } : {}),
      ...(event_types !== undefined ? { event_types: JSON.stringify(event_types) } : {}),
      ...(verify_ssl !== undefined ? { verify_ssl } : {}),
      ...(is_active !== undefined ? { is_active } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(destination_type !== undefined ? { destination_type: destType } : {}),
      ...(amqp_url !== undefined ? { amqp_url } : {}),
      ...(amqp_exchange !== undefined ? { amqp_exchange } : {}),
      ...(amqp_routing_key !== undefined ? { amqp_routing_key } : {}),
    },
  });
  res.json({
    ...endpoint,
    event_types: JSON.parse(endpoint.event_types),
  });
});

router.post('/destinations/:id/rotate-secret', async (req, res) => {
  const newSecret = crypto.randomBytes(32).toString('hex');
  const destination = await prisma.eventDestination.update({
    where: { id: req.params.id },
    data: { secret: newSecret },
  });
  res.json({
    ...destination,
    event_types: JSON.parse(destination.event_types),
  });
});

router.delete('/destinations/:id', async (req, res) => {
  try {
    await prisma.eventDestination.delete({ where: { id: req.params.id } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }
    throw err;
  }
  res.json({ success: true });
});

router.get('/destinations/:id/deliveries', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const [deliveries, total] = await Promise.all([
    prisma.eventDelivery.findMany({
      where: { destination_id: req.params.id },
      orderBy: { seq: 'desc' },
      take: Number(limit),
      skip: Number(offset),
    }),
    prisma.eventDelivery.count({ where: { destination_id: req.params.id } }),
  ]);
  res.json({ deliveries, total });
});

router.post('/destinations/:id/test', async (req, res) => {
  const endpoint = await prisma.eventDestination.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Webhook endpoint not found' });

  const payload = {
    id: crypto.randomUUID(),
    type: 'ping',
    created_at: new Date().toISOString(),
    data: { message: 'test ping from donation platform' },
  };

  const seq = await prisma.$transaction(async (tx) => {
    const row = await tx.eventDestinationSeq.upsert({
      where: { destination_id: req.params.id },
      create: { destination_id: req.params.id, seq: 1 },
      update: { seq: { increment: 1 } },
    });
    await tx.eventDelivery.create({
      data: {
        destination_id: req.params.id,
        seq: row.seq,
        event_type: 'ping',
        payload: JSON.stringify(payload),
        status: 'PENDING',
        next_attempt_at: new Date(),
      },
    });
    return row.seq;
  });

  res.json({ success: true, seq });
});

export default router;
