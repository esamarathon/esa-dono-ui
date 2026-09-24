import { Router, type Request, type Response } from 'express';
import { getAllFeatureFlags } from '../services/featureFlags.js';

const router = Router();

// Get all feature flags (public endpoint for client to check what features are enabled)
router.get('/', async (req: Request, res: Response) => {
  const flags = await getAllFeatureFlags();
  res.json(flags);
});

export default router;
