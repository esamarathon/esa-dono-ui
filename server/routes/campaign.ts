import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';

const router = Router();

// GET /api/campaign retired in #148: the donor site shows no public aggregate
// total (the stream overlay owns the public display) and the homepage's static
// name/description live in the client. Only the broadcast banner read remains.

router.get('/broadcast', async (_req: Request, res: Response) => {
  try {
    const broadcast = await prisma.broadcast.findFirst();
    res.json(
      broadcast && broadcast.is_active
        ? { message: broadcast.message, level: broadcast.level }
        : { message: null, level: null },
    );
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(500).json({ error: 'Failed to fetch broadcast' });
  }
});

export default router;
