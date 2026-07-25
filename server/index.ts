import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import webhookRouter from './routes/webhook.js';
import campaignRouter from './routes/campaign.js';
import donorRouter from './routes/donor.js';
import rewardsRouter from './routes/rewards.js';
import pollsRouter from './routes/polls.js';
import goalsRouter from './routes/goals.js';
import pledgeRouter from './routes/pledge.js';
import adminRouter from './routes/admin.js';
import moderatorRouter from './routes/moderator.js';
import prisma from './lib/prisma.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// MUST mount webhook BEFORE express.json()
app.use('/api/webhooks/tiltify', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await prisma.donor.count();
    res.json({ ok: true, db: true });
  } catch (err) {
    res.status(503).json({ ok: false, db: false, error: (err as Error).message });
  }
});
app.get('/api/donate-url', (_req: Request, res: Response) => {
  res.json({ url: process.env.TILTIFY_DONATE_URL || null });
});
app.use('/api/campaign', campaignRouter);
app.use('/api/donor', donorRouter);
app.use('/api/rewards', rewardsRouter);
app.use('/api/polls', pollsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/pledge', pledgeRouter);
app.use('/api/admin', adminRouter);
app.use('/api/moderator', moderatorRouter);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
