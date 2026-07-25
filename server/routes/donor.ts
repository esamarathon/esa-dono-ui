import { Router, type Request, type Response } from 'express';
import { donorAuth } from '../middleware/donorAuth.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get('/', donorAuth, async (req: Request, res: Response) => {
  const donor = await prisma.donor.findUnique({
    where: { id: req.donor!.id },
    include: {
      donations: { orderBy: { created_at: 'desc' } },
      reward_claims: {
        include: { reward: true },
        orderBy: { created_at: 'desc' },
      },
    },
  });
  res.json(donor);
});

export default router;
