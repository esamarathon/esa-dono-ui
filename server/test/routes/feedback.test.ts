import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import feedbackRouter from '../../routes/feedback.js';
import { invalidateFlagCache } from '../../services/featureFlags.js';
import sharedPrisma from '../../lib/prisma.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', feedbackRouter);
  return app;
}

async function setFlag(enabled: boolean) {
  await prisma.featureFlag.upsert({
    where: { name: 'feedback' },
    create: { name: 'feedback', is_enabled: enabled },
    update: { is_enabled: enabled },
  });
  invalidateFlagCache();
}

describe('Feedback route', () => {
  afterAll(async () => {
    await setFlag(false);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  });

  it('returns 404 when the feedback flag is disabled', async () => {
    await setFlag(false);
    const res = await request(createApp()).post('/api/feedback').field('text', 'Hello there');
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 400) for an invalid upload when the flag is disabled', async () => {
    await setFlag(false);
    const res = await request(createApp())
      .post('/api/feedback')
      .field('text', 'Hello there')
      .attach('screenshot', Buffer.from('gif'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(404);
  });

  it('returns 500 (without crashing) when the flag lookup fails', async () => {
    const app = createApp();
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ error: 'Internal error' });
      },
    );
    invalidateFlagCache();
    const spy = vi
      .spyOn(sharedPrisma.featureFlag, 'findMany')
      .mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/api/feedback').field('text', 'Hello there');
    expect(res.status).toBe(500);
    spy.mockRestore();
  });

  describe('with the flag enabled', () => {
    beforeAll(async () => {
      await setFlag(true);
    });

    it('returns 400 when text is missing', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const res = await request(createApp()).post('/api/feedback').field('text', '');
      expect(res.status).toBe(400);
    });

    it('returns 400 when text exceeds the max length', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const res = await request(createApp()).post('/api/feedback').field('text', 'x'.repeat(2001));
      expect(res.status).toBe(400);
    });

    it('returns 400 for an unsupported screenshot type', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const res = await request(createApp())
        .post('/api/feedback')
        .field('text', 'Hello there')
        .attach('screenshot', Buffer.from('gif'), { filename: 'x.gif', contentType: 'image/gif' });
      expect(res.status).toBe(400);
    });

    it('returns 503 when the webhook env var is unset', async () => {
      const res = await request(createApp()).post('/api/feedback').field('text', 'It broke');
      expect(res.status).toBe(503);
    });

    it('returns 502 when the Discord fetch throws', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network down');
        }),
      );
      const res = await request(createApp()).post('/api/feedback').field('text', 'It broke');
      expect(res.status).toBe(502);
    });

    it('returns 502 when Discord responds with a non-2xx status', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 400 })),
      );
      const res = await request(createApp()).post('/api/feedback').field('text', 'It broke');
      expect(res.status).toBe(502);
    });

    it('posts to Discord with the text and screenshot, stripping sensitive metadata keys', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      let capturedBody: FormData | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, opts: { body: FormData }) => {
          capturedBody = opts.body;
          return { ok: true, status: 200 };
        }),
      );

      const metadata = {
        url: '/donate',
        donorId: 'donor_123',
        email: 'leaked@example.com',
        token: 'super-secret-token',
        cartSummary: '2 items',
      };

      const res = await request(createApp())
        .post('/api/feedback')
        .field('text', 'Something is broken on this page')
        .field('metadata', JSON.stringify(metadata))
        .attach('screenshot', Buffer.from([0xff, 0xd8, 0xff]), {
          filename: 'shot.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      expect(capturedBody).toBeInstanceOf(FormData);
      const payloadJson = capturedBody!.get('payload_json') as string;
      expect(payloadJson).toContain('Something is broken on this page');
      expect(payloadJson).not.toContain('leaked@example.com');
      expect(payloadJson).not.toContain('super-secret-token');
      const file = capturedBody!.get('files[0]');
      expect(file).toBeTruthy();
    });
  });
});
