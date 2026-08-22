import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import webhookRouter from './routes/webhook.js';
import campaignRouter from './routes/campaign.js';
import donorRouter from './routes/donor.js';
import rewardsRouter from './routes/rewards.js';
import pollsRouter from './routes/polls.js';
import goalsRouter from './routes/goals.js';
import channelsRouter from './routes/channels.js';
import pledgeRouter from './routes/pledge.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import moderatorRouter from './routes/moderator.js';
import { startEventDispatcher } from './services/eventDispatcher.js';
import prisma from './lib/prisma.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import { metricsAuth } from './middleware/metricsAuth.js';
import { metricsLimit } from './middleware/rateLimit.js';
import { register } from './lib/metrics.js';
import { startMetricsRefresh } from './services/metrics.js';
import { UPLOADS_DIR, ensureUploadsDir } from './lib/uploads.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Behind the nginx frontend proxy in production: trust the first hop so
// req.ip (rate limiting) and secure-cookie detection reflect the real client.
app.set('trust proxy', 1);

app.use(cors());

// MUST mount webhook BEFORE express.json()
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());
app.use(httpMetrics);

// Serve uploaded reward images — immutable cache headers (random uuid filenames
// make long-caching safe).  Mounted before API routes so a CDN can later front
// /api/uploads/ without any code change.
await ensureUploadsDir();
app.use(
  '/api/uploads',
  express.static(UPLOADS_DIR, {
    immutable: true,
    maxAge: '1y',
    index: false,
  }),
);

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await prisma.donor.count();
    res.json({ ok: true, db: true });
  } catch (err) {
    res.status(503).json({ ok: false, db: false, error: (err as Error).message });
  }
});

app.get('/api/metrics', metricsLimit, metricsAuth, async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.get('/api/openapi.yaml', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/x-yaml');
  res.sendFile(resolve(dirname(fileURLToPath(import.meta.url)), 'openapi.yaml'));
});

app.get('/api/docs', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(resolve(dirname(fileURLToPath(import.meta.url)), 'swagger.html'));
});

app.use('/api/campaign', campaignRouter);
app.use('/api/donor', donorRouter);
app.use('/api/rewards', rewardsRouter);
app.use('/api/polls', pollsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/pledge', pledgeRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/moderator', moderatorRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startEventDispatcher();
});
startMetricsRefresh();
