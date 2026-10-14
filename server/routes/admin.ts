import { Router } from 'express';
import crypto from 'crypto';
import { MIN_SPEND_CENTS } from '@dono/shared';
import prisma from '../lib/prisma.js';
import { countedDonation } from '../lib/donationTotals.js';
import { mountIdentityRoutes } from './identityRoutes.js';
import { assignDonationChannel } from '../services/routing.js';
import { sendError } from '../lib/httpError.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { deleteUploadByUrl } from '../lib/uploads.js';
import { processDonation } from '../services/donation.js';
import {
  createReward,
  updateReward,
  createPoll,
  updatePoll,
  createPollOption,
  updatePollOption,
  createGoal,
  updateGoal,
  removeIncentive,
  reverseAndDeactivate,
} from '../services/incentiveLifecycle.js';
import {
  adjustWalletCreditTx,
  refundGoalContributions,
  refundPollOptionVotes,
  reverseSpendTx,
  setDonationStatusTx,
  sweepWalletCreditsTx,
} from '../services/reversal.js';
import {
  closeAuctionTx,
  cancelAuctionTx,
  reopenAuctionTx,
  skipCurrentOfferTx,
  resendCurrentOfferTx,
} from '../services/auction.js';
import { invalidateFlagCache } from '../services/featureFlags.js';
import { TOKEN_TTL_MS } from '../config.js';
import { withWebhooks } from '../services/webhooks/outbox.js';
import { wakeDispatcher } from '../services/webhooks/dispatcher.js';
import {
  isWebhookMessageType,
  PAYLOAD_FORMATS,
  TILTIFY_DEFAULT_EXCHANGE,
} from '../services/webhooks/delivery.js';

const router = Router();
router.use(adminAuth);

// Stats
router.get('/stats', async (req, res) => {
  const [
    donorCount,
    donationCount,
    claimCount,
    totalRaised,
    pledgeCount,
    channels,
    unallocatedCredits,
  ] = await Promise.all([
    prisma.donor.count(),
    prisma.donation.count(),
    prisma.rewardClaim.count(),
    // Money totals: completed and wallet-refunded, not chargebacks (lib/donationTotals.ts).
    prisma.donation.aggregate({ where: countedDonation, _sum: { amount_cents: true } }),
    prisma.pendingPledge.count(),
    prisma.channel.findMany({ orderBy: { created_at: 'asc' } }),
    // Aggregate of Donor.balance_remaining (#59): credited but not yet spent
    // on a reward/poll/goal — i.e. the platform's total outstanding
    // liability to donors, not visible anywhere except by summing every
    // donor individually.
    prisma.donor.aggregate({ _sum: { balance_remaining: true } }),
  ]);

  const perChannel = await Promise.all(
    channels.map(async (channel) => {
      const [sum, count] = await Promise.all([
        prisma.donation.aggregate({
          where: { channel_id: channel.id, ...countedDonation },
          _sum: { amount_cents: true },
        }),
        prisma.donation.count({ where: { channel_id: channel.id } }),
      ]);
      return {
        id: channel.id,
        name: channel.name,
        slug: channel.slug,
        event_id: channel.event_id,
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
    unallocated_credits_cents: unallocatedCredits._sum.balance_remaining ?? 0,
    channels: perChannel,
  });
});

// Channels and Events (routes/identityRoutes.ts)
mountIdentityRoutes(router);

// Donations
const DONATION_STATUSES = ['PENDING', 'COMPLETED', 'REFUNDED', 'CHARGEBACK'];

router.get('/donations', async (req, res) => {
  const { status } = req.query;
  const statuses = typeof status === 'string' ? status.split(',').filter(Boolean) : [];
  if (statuses.some((s) => !DONATION_STATUSES.includes(s))) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }
  const donations = await prisma.donation.findMany({
    where: statuses.length > 0 ? { status: { in: statuses } } : undefined,
    include: {
      donor: { select: { email: true } },
      channel: { select: { id: true, name: true, slug: true, event_id: true } },
    },
    orderBy: { created_at: 'desc' },
  });
  res.json(donations);
});

/**
 * PATCH /admin/donations/:id/channel (PRD-0002 §E6)
 * Assign an unassigned donation to a Channel (and so its Event), then publish it.
 */
router.patch('/donations/:id/channel', async (req, res) => {
  try {
    res.json(await assignDonationChannel(req.params.id, req.body?.channel_id));
  } catch (e) {
    sendError(res, e, '[donations]');
  }
});

/**
 * PATCH /admin/donations/:id/status (#63)
 * Sets a donation's lifecycle status. Moving into REFUNDED/CHARGEBACK claws
 * back whatever of the donation's amount is still sitting in the donor's
 * unspent balance_remaining (capped there — already-spent credit is not
 * cascaded through claims/votes/goals; use reverse-spend for that), records
 * a linked BalanceAdjustment, and stamps Donation.refund_id. Once a donation
 * has a refund_id it is terminal: no further status changes are allowed.
 */

router.patch('/donations/:id/status', async (req, res) => {
  const { status, reason } = req.body;
  if (!DONATION_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const updated = await withWebhooks((tx, _emit, publisher) =>
      setDonationStatusTx(tx, req.params.id, status, reason, 'admin', publisher),
    );
    res.json(updated);
  } catch (e) {
    sendError(res, e, '[admin/donations/status]');
  }
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
  const reward = await createReward({
    title,
    description,
    type,
    cost_cents,
    quantity_total: quantity_total ?? null,
    is_active: is_active ?? true,
    custom_type_label,
    image_url: image_url || null,
    channel_id: channel_id || null,
  });
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
  const reward = await updateReward(req.params.id, {
    title,
    description,
    type,
    cost_cents,
    quantity_total: quantity_total ?? null,
    is_active,
    custom_type_label,
    image_url: image_url || null,
    channel_id: channel_id || null,
  });
  res.json(reward);
});

router.delete('/rewards/:id', async (req, res) => {
  try {
    await removeIncentive('REWARD', req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, '[admin/rewards]');
  }
});

// Add donation (manual entry for real donations received externally, e.g.
// HEKATHON — #62; also doubles as the dev/test "simulate donation" tool).
router.post('/simulate-donation', async (req, res) => {
  try {
    const {
      email,
      donor_name,
      amount_cents,
      comment,
      pledge_token,
      channel_id,
      event_id,
      external_id,
      occurred_at,
    } = req.body;
    const cents = Number(amount_cents);
    if (!email || !Number.isInteger(cents) || cents < MIN_SPEND_CENTS) {
      return res
        .status(400)
        .json({ error: `email and amount_cents (min ${MIN_SPEND_CENTS}) required` });
    }

    let occurredAt: Date | null = null;
    if (occurred_at) {
      const parsed = new Date(occurred_at);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'occurred_at must be a valid date' });
      }
      occurredAt = parsed;
    }

    // A caller-supplied external_id lets an admin record a real donation
    // received on another platform using that platform's own reference (for
    // dedup/traceability) instead of an opaque auto-generated id. Falls back
    // to a fresh sim-<uuid> for plain dev/test simulations, matching prior
    // behavior.
    let externalId: string;
    if (external_id != null) {
      externalId = String(external_id).trim();
      if (!externalId) {
        return res.status(400).json({ error: 'external_id must not be empty when provided' });
      }
    } else {
      externalId = `sim-${crypto.randomUUID()}`;
    }

    const result = await processDonation({
      externalId,
      email,
      donorName: donor_name || 'Anonymous',
      amountCents: cents,
      comment: comment || null,
      pledgeToken: pledge_token || null,
      channelId: channel_id || null,
      eventId: event_id || null,
      occurredAt,
    });
    if ('duplicate' in result) {
      return res
        .status(409)
        .json({ error: `A donation with external_id "${externalId}" already exists` });
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
      donation: {
        id: result.donation.id,
        channel_id: result.donation.channel_id,
        event_id: result.donation.event_id,
      },
    });
  } catch (err) {
    sendError(res, err, '[simulate-donation]');
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
  try {
    const result = await prisma.$transaction((tx) =>
      adjustWalletCreditTx(tx, req.params.id, cents, type, reason, 'admin'),
    );
    res.json(result);
  } catch (e) {
    sendError(res, e, '[admin/adjust-balance]');
  }
});

/**
 * POST /admin/donors/sweep-credits
 * Bulk credit sweep-out (#60): zeros balance_remaining for every donor
 * matching an optional balance-range filter. Two-step confirmation:
 *   - confirm omitted/false → dry-run PREVIEW only (donor_count, total_cents,
 *     and a small sample) — nothing is written.
 *   - confirm: true → actually performs the sweep.
 * This mirrors the client's own "are you sure?" dialog with a
 * server-enforced confirmation, so a bulk zero-out can never happen from a
 * single accidental request.
 *
 * Each swept donor gets a FREEZE_ZERO BalanceAdjustment. Donor has no name
 * field (see #57) — reason references the donor's most recent donation's
 * self-reported donor_name (or "Anonymous") so the audit trail is
 * human-readable instead of just a bare donor id.
 */
router.post('/donors/sweep-credits', async (req, res) => {
  const { min_balance_cents, max_balance_cents, confirm } = req.body;

  const where: {
    balance_remaining: { gt: number; gte?: number; lte?: number };
  } = { balance_remaining: { gt: 0 } };
  if (min_balance_cents != null) {
    const min = Number(min_balance_cents);
    if (!Number.isInteger(min) || min < 0) {
      return res.status(400).json({ error: 'min_balance_cents must be a non-negative integer' });
    }
    where.balance_remaining.gte = min;
  }
  if (max_balance_cents != null) {
    const max = Number(max_balance_cents);
    if (!Number.isInteger(max) || max < 0) {
      return res.status(400).json({ error: 'max_balance_cents must be a non-negative integer' });
    }
    where.balance_remaining.lte = max;
  }

  try {
    const result = await prisma.$transaction((tx) =>
      sweepWalletCreditsTx(tx, where, confirm === true, 'admin'),
    );
    res.json(result);
  } catch (e) {
    sendError(res, e, '[admin/sweep-credits]');
  }
});

router.post('/donors/:id/reverse-spend', async (req, res) => {
  const { spend_type, spend_id } = req.body;
  if (!spend_type || !spend_id) {
    return res.status(400).json({ error: 'spend_type and spend_id required' });
  }
  try {
    await prisma.$transaction((tx) =>
      reverseSpendTx(tx, req.params.id, spend_type, spend_id, 'admin'),
    );
    res.json({ success: true });
  } catch (e) {
    sendError(res, e, '[admin/reverse-spend]');
  }
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
  const poll = await createPoll({
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
    channel_id,
  } = req.body;

  const poll = await updatePoll(req.params.id, {
    title,
    description,
    is_active,
    ends_at: ends_at ? new Date(ends_at) : null,
    allow_custom_entries: allow_custom_entries ?? false,
    max_entry_chars: max_entry_chars ?? null,
    auto_approve: auto_approve ?? true,
    channel_id: channel_id || null,
  });
  res.json(poll);
});

router.delete('/polls/:id', async (req, res) => {
  try {
    await removeIncentive('POLL', req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, '[admin/polls]');
  }
});

router.post('/polls/:id/options', async (req, res) => {
  const option = await createPollOption(req.params.id, req.body.label);
  res.json(option);
});

router.patch('/polls/options/:id', async (req, res) => {
  const { label } = req.body;
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  const option = await updatePollOption(req.params.id, String(label).trim());
  res.json(option);
});

router.delete('/polls/options/:id', async (req, res) => {
  try {
    const result = await reverseAndDeactivate('POLL_OPTION', req.params.id, 'admin');
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/polls/options/:id/refund', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) =>
      refundPollOptionVotes(tx, req.params.id, 'admin'),
    );
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
  const goal = await createGoal({
    title,
    description,
    target_cents,
    is_active: is_active ?? true,
    channel_id: channel_id || null,
  });
  res.json(goal);
});

router.put('/goals/:id', async (req, res) => {
  const { title, description, target_cents, is_active, is_complete, channel_id } = req.body;

  const goal = await updateGoal(req.params.id, {
    title,
    description,
    target_cents,
    is_active,
    is_complete,
    channel_id: channel_id || null,
  });
  res.json(goal);
});

router.delete('/goals/:id', async (req, res) => {
  try {
    const result = await reverseAndDeactivate('GOAL', req.params.id, 'admin');

    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/goals/:id/refund', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) =>
      refundGoalContributions(tx, req.params.id, 'admin'),
    );
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

router.get('/auctions/:id/bids', async (req, res) => {
  const bids = await prisma.bid.findMany({
    where: { auction_id: req.params.id },
    include: { donor: { select: { email: true, id: true } } },
    orderBy: { created_at: 'desc' },
  });
  res.json(bids);
});

router.post('/auctions/:id/reopen', async (req, res) => {
  try {
    const result = await prisma.$transaction((tx) => reopenAuctionTx(tx, req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
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
router.get('/destinations', async (req, res) => {
  const endpoints = await prisma.webhookDestination.findMany({
    orderBy: { created_at: 'desc' },
  });
  res.json(
    endpoints.map((ep) => ({
      ...ep,
      event_types: JSON.parse(ep.event_types),
    })),
  );
});

/**
 * PRD-0002 §T1: the Tiltify format is RabbitMQ-only (no consumer reads a bare
 * Tiltify body over HTTP). Returns an error message, or null when valid.
 */
function payloadFormatError(destType: string, format: unknown): string | null {
  if (!(PAYLOAD_FORMATS as readonly unknown[]).includes(format)) {
    return 'payload_format must be NATIVE or TILTIFY';
  }
  if (format === 'TILTIFY' && destType !== 'RABBITMQ') {
    return 'payload_format TILTIFY requires destination_type RABBITMQ';
  }
  return null;
}

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
    payload_format,
  } = req.body;

  const destType = destination_type ?? 'HTTP';
  const format = payload_format ?? 'NATIVE';
  const formatError = payloadFormatError(destType, format);
  if (formatError) return res.status(400).json({ error: formatError });

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
    // A TILTIFY Destination computes the routing key per message (§T3).
    if (format === 'NATIVE' && (!amqp_routing_key || typeof amqp_routing_key !== 'string')) {
      return res.status(400).json({ error: 'amqp_routing_key is required for RabbitMQ endpoints' });
    }
  } else {
    return res.status(400).json({ error: 'destination_type must be HTTP or RABBITMQ' });
  }

  if (event_types && !Array.isArray(event_types)) {
    return res.status(400).json({ error: 'event_types must be an array' });
  }
  if (event_types && !event_types.every(isWebhookMessageType)) {
    return res.status(400).json({ error: 'event_types contains invalid event type' });
  }

  const generatedSecret = secret || crypto.randomBytes(32).toString('hex');
  const destination = await prisma.webhookDestination.create({
    data: {
      url: url ?? '',
      secret: generatedSecret,
      event_types: JSON.stringify(event_types ?? []),
      verify_ssl: verify_ssl ?? true,
      description: description ?? null,
      destination_type: destType,
      amqp_url: amqp_url ?? null,
      amqp_exchange: amqp_exchange ?? (format === 'TILTIFY' ? TILTIFY_DEFAULT_EXCHANGE : ''),
      amqp_routing_key: amqp_routing_key ?? null,
      payload_format: format,
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
    payload_format,
  } = req.body;

  const current = await prisma.webhookDestination.findUnique({
    where: { id: req.params.id },
    select: { destination_type: true, payload_format: true, amqp_routing_key: true },
  });
  if (!current) return res.status(404).json({ error: 'Destination not found' });
  // Validate the Destination as it will be after the update, not the request alone.
  const destType = destination_type ?? current.destination_type;
  const format = payload_format ?? current.payload_format;
  const formatError = payloadFormatError(destType, format);
  if (formatError) return res.status(400).json({ error: formatError });
  const routingKey = amqp_routing_key !== undefined ? amqp_routing_key : current.amqp_routing_key;
  if (destType === 'RABBITMQ' && format === 'NATIVE' && !routingKey) {
    // Without one, every NATIVE message would stall the queue as an endpoint failure.
    return res.status(400).json({ error: 'amqp_routing_key is required for RabbitMQ endpoints' });
  }

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
    if (!event_types.every(isWebhookMessageType)) {
      return res.status(400).json({ error: 'event_types contains invalid event type' });
    }
  }

  const endpoint = await prisma.webhookDestination.update({
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
      ...(payload_format !== undefined ? { payload_format } : {}),
    },
  });
  // Reactivated (or reconfigured): its waiting messages resume now, not on the next tick.
  if (endpoint.is_active) wakeDispatcher(endpoint.id);
  res.json({
    ...endpoint,
    event_types: JSON.parse(endpoint.event_types),
  });
});

router.post('/destinations/:id/rotate-secret', async (req, res) => {
  const newSecret = crypto.randomBytes(32).toString('hex');
  const destination = await prisma.webhookDestination.update({
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
    await prisma.webhookDestination.delete({ where: { id: req.params.id } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }
    throw err;
  }
  res.json({ success: true });
});

/** Wire shape of a delivery row: the Prisma field `message_type` is sent as `event_type` (ADR-0006). */
function toDeliveryResponse<T extends { message_type: string }>({ message_type, ...rest }: T) {
  return { ...rest, event_type: message_type };
}

/** Fields reset when a FAILED delivery is requeued; `seq` and `message_id` are kept. */
function requeueData() {
  return {
    status: 'PENDING',
    attempts: 0,
    next_attempt_at: new Date(),
    last_error: null,
    last_status_code: null,
  };
}

router.get('/destinations/:id/deliveries', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { destination_id: req.params.id },
      orderBy: { seq: 'desc' },
      take: Number(limit),
      skip: Number(offset),
    }),
    prisma.webhookDelivery.count({ where: { destination_id: req.params.id } }),
  ]);
  res.json({
    deliveries: deliveries.map(toDeliveryResponse),
    total,
  });
});

router.post('/destinations/:id/test', async (req, res) => {
  const endpoint = await prisma.webhookDestination.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Webhook endpoint not found' });

  const payload = {
    id: crypto.randomUUID(),
    type: 'ping',
    created_at: new Date().toISOString(),
    data: { message: 'test ping from donation platform' },
  };

  const seq = await prisma.$transaction(async (tx) => {
    const row = await tx.webhookDestinationSeq.upsert({
      where: { destination_id: req.params.id },
      create: { destination_id: req.params.id, seq: 1 },
      update: { seq: { increment: 1 } },
    });
    await tx.webhookDelivery.create({
      data: {
        destination_id: req.params.id,
        seq: row.seq,
        message_id: payload.id,
        message_type: 'ping',
        payload: JSON.stringify(payload),
        status: 'PENDING',
        next_attempt_at: new Date(),
      },
    });
    return row.seq;
  });
  wakeDispatcher(req.params.id);

  res.json({ success: true, seq });
});

router.post('/destinations/:id/deliveries/:deliveryId/requeue', async (req, res) => {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: req.params.deliveryId, destination_id: req.params.id },
  });
  if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
  if (delivery.status !== 'FAILED') {
    return res.status(409).json({ error: 'Only FAILED deliveries can be requeued' });
  }
  if (delivery.payload === '') {
    return res.status(409).json({ error: 'This delivery was never built and cannot be resent' });
  }

  const updated = await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: requeueData(),
  });
  wakeDispatcher(req.params.id);

  res.json(toDeliveryResponse(updated));
});

router.post('/destinations/:id/requeue-failed', async (req, res) => {
  const destination = await prisma.webhookDestination.findUnique({
    where: { id: req.params.id },
  });
  if (!destination) return res.status(404).json({ error: 'Destination not found' });

  const { count } = await prisma.webhookDelivery.updateMany({
    where: { destination_id: req.params.id, status: 'FAILED', payload: { not: '' } },
    data: requeueData(),
  });
  // Rows whose payload was never built cannot be resent; report them so the
  // operator knows some FAILED rows remain.
  const unbuilt = await prisma.webhookDelivery.count({
    where: { destination_id: req.params.id, status: 'FAILED', payload: '' },
  });
  wakeDispatcher(req.params.id);

  res.json({ requeued: count, skipped_unbuilt: unbuilt });
});

// Feature Flags CRUD
router.get('/feature-flags', async (req, res) => {
  const flags = await prisma.featureFlag.findMany({
    orderBy: { name: 'asc' },
  });
  res.json(flags);
});

router.get('/feature-flags/:name', async (req, res) => {
  const flag = await prisma.featureFlag.findUnique({
    where: { name: req.params.name },
  });
  if (!flag) return res.status(404).json({ error: 'Feature flag not found' });
  res.json(flag);
});

router.post('/feature-flags', async (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const flag = await prisma.featureFlag.create({
      data: {
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        is_enabled: false,
      },
    });
    invalidateFlagCache();
    res.json(flag);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return res.status(409).json({ error: 'Feature flag name already exists' });
    }
    throw e;
  }
});

router.patch('/feature-flags/:name', async (req, res) => {
  const { is_enabled, description } = req.body;
  const updates: Record<string, unknown> = {};
  if (is_enabled !== undefined) updates.is_enabled = Boolean(is_enabled);
  if (description !== undefined)
    updates.description = description ? String(description).trim() : null;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const flag = await prisma.featureFlag.update({
    where: { name: req.params.name },
    data: updates,
  });
  invalidateFlagCache();
  res.json(flag);
});

router.delete('/feature-flags/:name', async (req, res) => {
  try {
    await prisma.featureFlag.delete({
      where: { name: req.params.name },
    });
    invalidateFlagCache();
    res.json({ success: true });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2025') {
      return res.status(404).json({ error: 'Feature flag not found' });
    }
    throw e;
  }
});

// Broadcast Banner CRUD
router.get('/broadcast', async (req, res) => {
  const broadcast = await prisma.broadcast.findFirst();
  res.json(broadcast || { id: null, message: '', level: null, is_active: false });
});

const BROADCAST_LEVELS = ['INFO', 'WARNING', 'CRITICAL'];

router.put('/broadcast', async (req, res) => {
  const { message, level } = req.body;
  if (typeof message !== 'string') {
    return res.status(400).json({ error: 'message must be a string' });
  }
  if (level !== undefined && level !== null && !BROADCAST_LEVELS.includes(level)) {
    return res.status(400).json({ error: 'level must be one of INFO, WARNING, CRITICAL, or null' });
  }
  const normalizedLevel = level ?? null;
  const trimmed = message.trim();
  if (!trimmed) {
    // Clear the broadcast
    await prisma.broadcast.deleteMany();
    return res.json({ id: null, message: '', level: null, is_active: false });
  }
  // Upsert: update if exists, create if not
  const existing = await prisma.broadcast.findFirst();
  const broadcast = await prisma.broadcast.upsert({
    where: { id: existing?.id || 'default' },
    create: { id: 'default', message: trimmed, level: normalizedLevel, is_active: true },
    update: { message: trimmed, level: normalizedLevel, is_active: true, updated_at: new Date() },
  });
  res.json(broadcast);
});

router.delete('/broadcast', async (req, res) => {
  await prisma.broadcast.deleteMany();
  res.json({ success: true });
});

export default router;
