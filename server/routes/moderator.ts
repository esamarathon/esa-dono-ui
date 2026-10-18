import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import prisma from '../lib/prisma.js';
import { readAccountingStatsTx } from '../services/accountingStats.js';
import {
  readStaffDonationTx,
  readStaffClaimsTx,
  incentiveAllocationTx,
} from '../services/staffRead.js';
import { handle, httpError, sendError } from '../lib/httpError.js';
import {
  assignUnusedTx,
  listUnusedTx,
  unusedCategory,
  unusedTargetsTx,
  undoUnusedTx,
} from '../services/unusedPool.js';
import { moderateCustomEntryTx } from '../services/reversal.js';
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
  incentiveEventId,
  keepEvent,
} from '../services/incentiveLifecycle.js';
import { withWebhooks } from '../services/webhooks/outbox.js';
import { mountIdentityRoutes } from './identityRoutes.js';
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
// admin.ts, gated by the admin key or an ADMIN session) are allowed to expose it.
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
router.get('/stats', async (_req, res) => {
  const stats = await prisma.$transaction((tx) => readAccountingStatsTx(tx));
  res.json(stats.moderator);
});

// Channels and Events (routes/identityRoutes.ts)
mountIdentityRoutes(router);

router.get(
  '/unused-pool-money',
  handle('[moderator/unused]', async (req, res) => {
    res.json(
      await prisma.$transaction((tx) =>
        listUnusedTx(tx, {
          comments_only: req.query.comments_only !== 'false',
          show_ended: req.query.show_ended === 'true',
          channel_id: typeof req.query.channel_id === 'string' ? req.query.channel_id : undefined,
        }),
      ),
    );
  }),
);
router.get(
  '/donations/:id/unused-pool-money/targets',
  handle('[moderator/unused]', async (req, res) => {
    const category = unusedCategory(req.query.category);
    res.json(await prisma.$transaction((tx) => unusedTargetsTx(tx, req.params.id!, category)));
  }),
);
router.post(
  '/donations/:id/unused-pool-money',
  handle('[moderator/unused]', async (req, res) => {
    const category = unusedCategory(req.body?.category);
    if (typeof req.body?.target_id !== 'string') throw httpError(400, 'target_id required');
    res.json(
      await withWebhooks((tx, _emit, publisher) =>
        assignUnusedTx(
          tx,
          req.params.id!,
          category,
          req.body.target_id,
          req.body.expected_amount_cents,
          req.donor?.email || 'moderator',
          publisher,
        ),
      ),
    );
  }),
);
router.post(
  '/unused-pool-money/:category/:id/undo',
  handle('[moderator/unused]', async (req, res) => {
    const category = unusedCategory(req.params.category);
    res.json(
      await withWebhooks((tx, _emit, publisher) =>
        undoUnusedTx(tx, category, req.params.id!, req.donor?.email || 'moderator', publisher),
      ),
    );
  }),
);

// Polls CRUD
router.get('/polls', async (req, res) => {
  res.json(
    await prisma.$transaction(async (tx) =>
      Promise.all(
        (
          await tx.poll.findMany({
            include: { options: true, custom_entries: true },
            orderBy: { created_at: 'desc' },
          })
        ).map(async (row) => ({ ...row, ...(await incentiveAllocationTx(tx, 'poll', row.id)) })),
      ),
    ),
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
    event_id,
  } = req.body;
  const poll = await createPoll({
    title,
    description,
    is_active: is_active ?? true,
    ends_at: ends_at ? new Date(ends_at) : null,
    allow_custom_entries: allow_custom_entries ?? false,
    max_entry_chars: max_entry_chars ?? null,
    auto_approve: auto_approve ?? true,
    channel_id: channel_id ?? null,
    event_id,
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
    event_id,
  } = req.body;
  const poll = await updatePoll(req.params.id, {
    title,
    description,
    is_active,
    ends_at: ends_at ? new Date(ends_at) : null,
    allow_custom_entries: allow_custom_entries ?? false,
    max_entry_chars: max_entry_chars ?? null,
    auto_approve: auto_approve ?? true,
    channel_id,
    event_id,
  });
  res.json(poll);
});

router.delete('/polls/:id', async (req, res) => {
  try {
    await removeIncentive('POLL', req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, '[moderator/polls]');
  }
});

router.post('/polls/:id/options', async (req, res) => {
  const option = await createPollOption(req.params.id, req.body.label);
  res.json(option);
});

router.patch('/polls/options/:id', async (req, res) => {
  const { label } = req.body;
  const option = await updatePollOption(req.params.id, label);
  res.json(option);
});

router.delete('/polls/options/:id', async (req, res) => {
  try {
    await removeIncentive('POLL_OPTION', req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, '[moderator/polls/options]');
  }
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

  try {
    const updated = await withWebhooks((tx, _emit, publisher) =>
      moderateCustomEntryTx(tx, req.params.id, status, req.donor?.email || 'moderator', publisher),
    );
    res.json(updated);
  } catch (e) {
    sendError(res, e, '[moderator/custom-entries]');
  }
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
  res.json(
    await prisma.$transaction(async (tx) =>
      Promise.all(
        (await tx.reward.findMany({ orderBy: { created_at: 'desc' } })).map(async (row) => ({
          ...row,
          ...(await incentiveAllocationTx(tx, 'reward', row.id)),
        })),
      ),
    ),
  );
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
    event_id,
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
    channel_id: channel_id ?? null,
    event_id,
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
    event_id,
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
    channel_id,
    event_id,
  });
  res.json(reward);
});

router.delete('/rewards/:id', async (req, res) => {
  try {
    await removeIncentive('REWARD', req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, '[moderator/rewards]');
  }
});

// Claims
// Read-only from the moderator side: fulfillment status is not
// displayed/tracked here (admin retains its own status toggle at
// admin.ts's PATCH /claims/:id, which is unrelated and untouched).
router.get('/claims', async (req, res) => {
  res.json(await prisma.$transaction((tx) => readStaffClaimsTx(tx, true)));
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
      channel: { select: { id: true, name: true, slug: true, event_id: true } },
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
    await prisma.$transaction((tx) =>
      Promise.all(
        donations.map(async (d) => {
          const { pledge, ...rest } = d;
          const { pools: _privateCredits, ...current } = await readStaffDonationTx(tx, d.id);
          void _privateCredits; // Deliberately omit the Pool-credit panel from moderator responses.
          return {
            ...rest,
            ...current,
            pledge_items: (pledge?.items ?? []).map((i) => ({
              kind: i.kind,
              label: labelForItem(i),
              amount_cents: i.amount_cents,
              quantity: i.quantity,
            })),
            top_up_cents: pledge?.top_up_cents ?? null,
          };
        }),
      ),
    ),
  );
});

/**
 * PATCH /moderator/donations/:id — `{ moderated?, hidden_from_overlay? }`, at least one.
 *
 * - `moderated` is the review toggle: native `donation.moderated` only. It does NOT
 *   republish on TILTIFY, because the body would not change and a republish of an
 *   anonymous donation removes it from the overlay (PRD-0002 §T8).
 * - `hidden_from_overlay` hides the donation from the stream overlay: native
 *   `donation.hidden` / `donation.unhidden`, and a TILTIFY republish (as `"Anonymous"`
 *   without `completed_at` when hidden, the full donation when shown; §T5–T6).
 *   Setting the value it already has publishes nothing.
 */
router.patch('/donations/:id', async (req, res) => {
  const { moderated, hidden_from_overlay: hidden } = req.body;
  if (moderated === undefined && hidden === undefined) {
    return res
      .status(400)
      .json({ error: 'Provide moderated and/or hidden_from_overlay (booleans)' });
  }
  if (moderated !== undefined && typeof moderated !== 'boolean') {
    return res.status(400).json({ error: 'moderated must be a boolean' });
  }
  if (hidden !== undefined && typeof hidden !== 'boolean') {
    return res.status(400).json({ error: 'hidden_from_overlay must be a boolean' });
  }
  const moderatorEmail = req.donor?.email || 'moderator';

  const reviewFields = (value: boolean) =>
    value
      ? { moderated: true, moderated_at: new Date(), moderated_by: moderatorEmail }
      : { moderated: false, moderated_at: null, moderated_by: null };

  const donation = await withWebhooks(async (tx, _emit, publisher) => {
    // Snapshot inside the transaction, so two concurrent hides publish once.
    const before = await publisher.snapshot(req.params.id);
    if (!before.get(req.params.id)) return null;
    const updated = await tx.donation.update({
      where: { id: req.params.id },
      data: {
        ...(moderated === undefined ? {} : reviewFields(moderated)),
        ...(hidden === undefined ? {} : { hidden_from_overlay: hidden }),
      },
    });
    await publisher.publish(updated.id, before);
    return updated;
  });

  if (!donation) return res.status(404).json({ error: 'Donation not found' });
  res.json(donation);
});

// Goals CRUD
router.get('/goals', async (req, res) => {
  res.json(
    await prisma.$transaction(async (tx) =>
      Promise.all(
        (await tx.fundGoal.findMany({ orderBy: { created_at: 'desc' } })).map(async (row) => ({
          ...row,
          ...(await incentiveAllocationTx(tx, 'goal', row.id)),
        })),
      ),
    ),
  );
});

router.post('/goals', async (req, res) => {
  const { title, description, target_cents, is_active, channel_id, event_id, is_complete } =
    req.body;
  const goal = await createGoal({
    is_complete,
    title,
    description,
    target_cents,
    is_active: is_active ?? true,
    channel_id: channel_id ?? null,
    event_id,
  });
  res.json(goal);
});

router.put('/goals/:id', async (req, res) => {
  const { title, description, target_cents, is_active, is_complete, channel_id, event_id } =
    req.body;
  const goal = await updateGoal(req.params.id, {
    title,
    description,
    target_cents,
    is_active,
    is_complete,
    channel_id,
    event_id,
  });
  res.json(goal);
});

router.delete('/goals/:id', async (req, res) => {
  try {
    await removeIncentive('GOAL', req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, '[moderator/goals]');
  }
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
    event_id,
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
      event_id: await incentiveEventId(prisma, { channel_id: channel_id || null, event_id }),
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
    event_id,
  } = req.body;
  const existing = await prisma.auction.findUnique({
    where: { id: req.params.id },
    select: { image_url: true, status: true, event_id: true },
  });
  if (!existing) return res.status(404).json({ error: 'Auction not found' });
  await keepEvent(prisma, { channel_id: channel_id || null, event_id }, existing);
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
