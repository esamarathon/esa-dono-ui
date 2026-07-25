import { Router, type Request, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { donorAuth } from '../middleware/donorAuth.js';
import { spendLimit } from '../middleware/rateLimit.js';
import { checkBlockedWords } from '../services/donation.js';
import { votePollTx } from '../services/spend.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const polls = await prisma.poll.findMany({
    where: { is_active: true },
    include: { options: { orderBy: { votes_cents: 'desc' } } },
    orderBy: { created_at: 'desc' },
  });
  res.json(polls);
});

router.post('/:id/custom-entry', donorAuth, async (req: Request, res: Response) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'label is required' });
    }

    const poll = await prisma.poll.findUnique({ where: { id: req.params.id } });
    if (!poll || !poll.is_active)
      return res.status(404).json({ error: 'Poll not found or inactive' });
    if (!poll.allow_custom_entries)
      return res.status(400).json({ error: 'This poll does not allow custom entries' });
    if (poll.ends_at && new Date() > poll.ends_at)
      return res.status(400).json({ error: 'Poll has ended' });

    const trimmed = label.trim();

    // Check character limit
    if (poll.max_entry_chars && trimmed.length > poll.max_entry_chars) {
      return res
        .status(400)
        .json({ error: `Entry exceeds maximum of ${poll.max_entry_chars} characters` });
    }

    // Check blocked words
    const blockedError = await checkBlockedWords(trimmed);
    if (blockedError) {
      return res.status(400).json({ error: blockedError });
    }

    const entry = await prisma.pollCustomEntry.create({
      data: {
        poll_id: poll.id,
        donor_id: req.donor!.id,
        label: trimmed,
        status: 'PENDING',
      },
    });

    res.json({ success: true, entry: { id: entry.id, label: entry.label, status: entry.status } });
  } catch (err) {
    console.error('Custom entry error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/vote', spendLimit, donorAuth, async (req: Request, res: Response) => {
  try {
    const { poll_option_id, amount_cents } = req.body;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await votePollTx(tx, req.donor!.id, req.params.id!, poll_option_id, Number(amount_cents));
    });
    res.json({ success: true });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

export default router;
