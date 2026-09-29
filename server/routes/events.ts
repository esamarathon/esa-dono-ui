import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';

const router = Router();

/** Public view of an Event and its active Channels (no internal fields). */
const publicEvent = {
  id: true,
  name: true,
  slug: true,
  primary_channel_id: true,
  channels: {
    where: { is_active: true },
    orderBy: { created_at: 'asc' as const },
    select: { id: true, name: true, slug: true, event_id: true, is_active: true },
  },
};

/**
 * GET /api/events
 * Public list of active Events with their active Channels (PRD-0002 §E1).
 */
router.get('/', async (_req: Request, res: Response) => {
  res.json(
    await prisma.event.findMany({
      where: { is_active: true },
      orderBy: { created_at: 'asc' },
      select: publicEvent,
    }),
  );
});

/**
 * GET /api/events/:slug
 * One active Event by slug, for /donate/<event-slug>[/<channel-slug>] (§E3).
 */
router.get('/:slug', async (req: Request, res: Response) => {
  const event = await prisma.event.findFirst({
    where: { slug: req.params.slug, is_active: true },
    select: publicEvent,
  });
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

export default router;
