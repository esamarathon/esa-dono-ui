import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import prisma from '../lib/prisma.js';
import { moderatorAuth } from '../middleware/moderatorAuth.js';
import { upload, processAndStore, publicUrlFor, deleteUploadByUrl } from '../lib/uploads.js';
import {
  closeAuctionTx,
  cancelAuctionTx,
  reopenAuctionTx,
  skipCurrentOfferTx,
  resendCurrentOfferTx,
} from '../services/auction.js';

// INVARIANT: no handler in this file may select/include `donor.email` (or
// return it via any other path) in a JSON response. Moderators can see
// donor_name, spend amounts, claim/entry content, and moderation metadata,
// but never the donor's email address — only ADMIN routes (server/routes/
// admin.ts, gated by X-Admin-Key) are allowed to expose it.
//
// This has regressed once already (fixed in 87ad5e4, then again for the
// donations endpoints): the pattern `donor: { select: { email: ... } } }` was
// removed from some handlers here but missed identical occurrences a few
// lines away in others, and shipped clean because no test asserted the
// negative case. `test/routes/moderator-donor-email.test.ts` statically
// greps this file for that pattern so a reintroduction fails CI immediately,
// regardless of which endpoint it's added to or whether that endpoint has
// its own behavioral test. Do not weaken or delete that test to make a
// change pass — if a moderator surface genuinely needs donor identity, use
// donor_name (already a plain column, no join needed) instead of email.
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
  await prisma.pollOption.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Custom entries
router.get('/polls/:id/custom-entries', async (req, res) => {
  const entries = await prisma.pollCustomEntry.findMany({
    where: { poll_id: req.params.id },
    include: {
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
  });
  res.json(updated);
});

// Rewards CRUD

// Image upload — returns { url } for storing in reward.image_url.
// Accepts jpeg/png/webp/gif up to 8 MB; resizes to ≤800 px wide and
// re-encodes to webp (~80 quality) before writing to disk.
router.post('/uploads', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const filename = await processAndStore(req.file.buffer);
    res.json({ url: publicUrlFor(filename) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Multer error handler (file-type rejection, size exceeded, etc.)
router.use('/uploads', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError || err instanceof Error) {
    return res.status(400).json({ error: err.message });
  }
  _next(err);
});

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
  // Best-effort cleanup of old upload if the image is being replaced/removed
  const existing = await prisma.reward.findUnique({
    where: { id: req.params.id },
    select: { image_url: true },
  });
  if (existing && existing.image_url !== (image_url || null)) {
    await deleteUploadByUrl(existing.image_url);
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

// Claims
// Read-only from the moderator side: fulfillment status is not
// displayed/tracked here (admin retains its own status toggle at
// admin.ts's PATCH /claims/:id, which is unrelated and untouched).
router.get('/claims', async (req, res) => {
  const claims = await prisma.rewardClaim.findMany({
    include: {
      reward: true,
      // Human-readable donor identity without ever touching email (#57):
      // donor_name is a plain column on Donation (self-reported at checkout),
      // not on Donor — join to the donor's most recent donation for it.
      donor: {
        select: {
          donations: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { donor_name: true },
          },
        },
      },
    },
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
      const { donor, ...rest } = c;
      return {
        ...rest,
        claim_data: parsed,
        donor_name: donor?.donations[0]?.donor_name ?? null,
      };
    }),
  );
});

// Donations — read-only list + moderation flag. Downstream tools (exports,
// leaderboards, Discord role sync, etc.) key off `moderated` to know which
// donations a human has reviewed, so moderators need full read access here
// regardless of who the donor is. `donor_name` is a plain column on
// Donation — do not add `include: { donor: { select: { email: true } } }`
// (see file-level invariant above; caught by moderator-donor-email.test.ts).
router.get('/donations', async (req, res) => {
  const donations = await prisma.donation.findMany({
    include: {
      channel: { select: { id: true, name: true } },
      pledge: { include: { items: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  // Batch-resolve each pledge item's target into a human-readable label
  // (#58) — e.g. "Best Runner: Runner A" or "T-shirt", never a raw
  // target_id/uuid — so a moderator can see at a glance what a donor
  // selected/pledged toward. target_id is polymorphic by kind (reward_id |
  // poll_option_id | goal_id | poll_id for a POLL_CUSTOM write-in), so there's
  // no direct Prisma relation to include — resolve it via a few batched
  // lookups instead of one query per item.
  const allItems = donations.flatMap((d) => d.pledge?.items ?? []);
  const rewardIds = [
    ...new Set(allItems.filter((i) => i.kind === 'REWARD').map((i) => i.target_id)),
  ];
  const goalIds = [...new Set(allItems.filter((i) => i.kind === 'GOAL').map((i) => i.target_id))];
  const optionIds = [
    ...new Set(allItems.filter((i) => i.kind === 'POLL_VOTE').map((i) => i.target_id)),
  ];
  const pollIds = [
    ...new Set(
      allItems
        .filter((i) => i.kind === 'POLL_VOTE' || i.kind === 'POLL_CUSTOM')
        .map((i) => i.poll_id)
        .filter((id): id is string => !!id),
    ),
  ];

  const [rewards, goals, options, polls] = await Promise.all([
    rewardIds.length
      ? prisma.reward.findMany({
          where: { id: { in: rewardIds } },
          select: { id: true, title: true },
        })
      : [],
    goalIds.length
      ? prisma.fundGoal.findMany({
          where: { id: { in: goalIds } },
          select: { id: true, title: true },
        })
      : [],
    optionIds.length
      ? prisma.pollOption.findMany({
          where: { id: { in: optionIds } },
          select: { id: true, label: true },
        })
      : [],
    pollIds.length
      ? prisma.poll.findMany({ where: { id: { in: pollIds } }, select: { id: true, title: true } })
      : [],
  ]);

  const rewardMap = new Map(rewards.map((r) => [r.id, r.title]));
  const goalMap = new Map(goals.map((g) => [g.id, g.title]));
  const optionMap = new Map(options.map((o) => [o.id, o.label]));
  const pollMap = new Map(polls.map((p) => [p.id, p.title]));

  const labelForItem = (item: {
    kind: string;
    target_id: string;
    poll_id: string | null;
    data: string | null;
    quantity: number;
  }) => {
    if (item.kind === 'REWARD') {
      const title = rewardMap.get(item.target_id) ?? 'Unknown reward';
      return item.quantity > 1 ? `${item.quantity}× ${title}` : title;
    }
    if (item.kind === 'GOAL') return goalMap.get(item.target_id) ?? 'Unknown goal';
    if (item.kind === 'POLL_VOTE') {
      const pollTitle = item.poll_id ? pollMap.get(item.poll_id) : undefined;
      const optionLabel = optionMap.get(item.target_id) ?? 'Unknown option';
      return pollTitle ? `${pollTitle}: ${optionLabel}` : optionLabel;
    }
    if (item.kind === 'POLL_CUSTOM') {
      const pollTitle = item.poll_id ? pollMap.get(item.poll_id) : undefined;
      let writeInLabel = 'write-in';
      try {
        const parsed = item.data ? JSON.parse(item.data) : null;
        if (parsed?.label) writeInLabel = parsed.label;
      } catch {
        /* ignore */
      }
      return pollTitle ? `${pollTitle}: "${writeInLabel}"` : `"${writeInLabel}"`;
    }
    return 'Unknown item';
  };

  res.json(
    donations.map((d) => {
      const { pledge, ...rest } = d;
      return {
        ...rest,
        pledge_items: (pledge?.items ?? []).map((i) => ({
          kind: i.kind,
          label: labelForItem(i),
          amount_cents: i.amount_cents,
          quantity: i.quantity,
        })),
        top_up_cents: pledge?.top_up_cents ?? null,
      };
    }),
  );
});

router.patch('/donations/:id', async (req, res) => {
  const { moderated } = req.body;
  if (typeof moderated !== 'boolean') {
    return res.status(400).json({ error: 'moderated must be a boolean' });
  }
  const moderatorEmail = req.donor?.email || 'moderator';

  const donation = await prisma.donation.update({
    where: { id: req.params.id },
    data: moderated
      ? { moderated: true, moderated_at: new Date(), moderated_by: moderatorEmail }
      : { moderated: false, moderated_at: null, moderated_by: null },
    include: { donor: { select: { id: true } } },
  });

  const { emitWebhookEvent, buildDonationModeratedPayload } =
    await import('../services/eventDelivery.js');
  emitWebhookEvent(
    'donation.moderated',
    buildDonationModeratedPayload({
      donationId: donation.id,
      externalId: donation.external_id,
      donorRef: donation.donor.id,
      moderated,
      moderatedAt: donation.moderated_at,
    }),
  );

  res.json(donation);
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
  res.json(goal);
});

router.put('/goals/:id', async (req, res) => {
  const { title, description, target_cents, is_active, is_complete, channel_id } = req.body;
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
  res.json(goal);
});

router.delete('/goals/:id', async (req, res) => {
  await prisma.fundGoal.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Auctions CRUD — same shape as admin, but offer/cascade views never expose
// donor.email (see file-level invariant above); donor_id is fine since it's
// an opaque identifier, not personal data.
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

router.get('/auctions/:id/offers', async (req, res) => {
  const offers = await prisma.auctionOffer.findMany({
    where: { auction_id: req.params.id },
    orderBy: { rank: 'asc' },
  });
  res.json(offers);
});

// All bids for an auction, newest first. Exposes only the opaque donor_id
// (never donor.email — see file-level invariant), same as the offers view.
router.get('/auctions/:id/bids', async (req, res) => {
  const bids = await prisma.bid.findMany({
    where: { auction_id: req.params.id },
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

export default router;
