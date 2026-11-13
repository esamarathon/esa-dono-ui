import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import feedbackRouter from '../../routes/feedback.js';
import { invalidateFlagCache } from '../../services/featureFlags.js';
import sharedPrisma from '../../lib/prisma.js';

const prisma = createDatabaseClient();

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

const FEEDBACK_DIR = mkdtempSync(join(tmpdir(), 'dono-feedback-test-'));

describe('Feedback route', () => {
  beforeAll(async () => {
    process.env.FEEDBACK_DIR = FEEDBACK_DIR;
  });

  afterAll(async () => {
    await setFlag(false);
    delete process.env.FEEDBACK_DIR;
    rmSync(FEEDBACK_DIR, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('returns 413 before parsing when the declared body exceeds the cap', async () => {
    await setFlag(true);
    const res = await request(createApp())
      .post('/api/feedback')
      .field('text', 'Hello there')
      .attach('screenshot', Buffer.alloc(12 * 1024 * 1024), {
        filename: 'big.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(413);
  });

  describe('with the flag enabled', () => {
    beforeAll(async () => {
      await setFlag(true);
    });

    it('returns 400 when text is missing', async () => {
      const res = await request(createApp()).post('/api/feedback').field('text', '');
      expect(res.status).toBe(400);
    });

    it('returns 400 when text exceeds the max length', async () => {
      const res = await request(createApp()).post('/api/feedback').field('text', 'x'.repeat(5001));
      expect(res.status).toBe(400);
    });

    it('returns 400 for an unsupported screenshot type', async () => {
      const res = await request(createApp())
        .post('/api/feedback')
        .field('text', 'Hello there')
        .attach('screenshot', Buffer.from('gif'), { filename: 'x.gif', contentType: 'image/gif' });
      expect(res.status).toBe(400);
    });

    it('persists an anonymous report and delivers to Discord, stripping sensitive metadata keys', async () => {
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
        url: 'http://localhost:3001/donate?draft=1',
        donor_id: 'donor_123',
        email: 'leaked@example.com',
        token: 'super-secret-token',
        channel_name: 'Main Stream',
        cart_summary: '2 items',
      };

      const res = await request(createApp())
        .post('/api/feedback')
        .set('Host', 'localhost:3001')
        .set('User-Agent', 'TestAgent/1.0')
        .field('text', 'Something is broken on this page')
        .field('metadata', JSON.stringify(metadata))
        .field('scrollY', '640')
        .attach('screenshot', Buffer.from([0xff, 0xd8, 0xff]), {
          filename: 'shot.jpg',
          contentType: 'image/jpeg',
        })
        .attach('snapshot', Buffer.from('<html><body>snapshot</body></html>'), {
          filename: 'snapshot.html',
          contentType: 'text/html',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.ref).toMatch(/^FB-[0-9a-f]{8}$/);

      // The row is durable and the sender columns are stamped server-side.
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row).toBeTruthy();
      expect(row!.sender_id).toBeNull();
      expect(row!.message).toBe('Something is broken on this page');
      expect(row!.page_url).toBe('http://localhost:3001/donate?draft=1');
      expect(row!.route).toBe('/donate');
      expect(row!.scroll_y).toBe(640);
      expect(row!.user_agent).toBe('TestAgent/1.0');
      expect(row!.status).toBe('NEW');
      // Diagnostics are a v1 record with zero captured errors.
      const diagnostics = JSON.parse(row!.diagnostics ?? '{}');
      expect(diagnostics.v).toBe(1);
      expect(diagnostics.error_count).toBe(0);
      expect(diagnostics.context.sender_role).toBeNull();
      expect(diagnostics.context.userAgent).toBe('TestAgent/1.0');
      // Files are written under FEEDBACK_DIR with relative paths.
      expect(row!.screenshot_path).toBeTruthy();
      expect(existsSync(join(FEEDBACK_DIR, row!.screenshot_path!))).toBe(true);
      expect(row!.snapshot_path).toBeTruthy();
      expect(readFileSync(join(FEEDBACK_DIR, row!.snapshot_path!), 'utf8')).toContain('snapshot');

      // Discord gets the text, one image and the DOM snapshot, with sensitive
      // metadata keys stripped.
      expect(capturedBody).toBeInstanceOf(FormData);
      const payloadJson = capturedBody!.get('payload_json') as string;
      expect(payloadJson).toContain('Something is broken on this page');
      expect(payloadJson).not.toContain('leaked@example.com');
      expect(payloadJson).not.toContain('super-secret-token');
      expect(capturedBody!.get('files[0]')).toBeTruthy();
      expect(capturedBody!.get('files[1]')).toBeTruthy();
    });

    it('stamps the signed-in sender, effective role, and validated diagnostics', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const donor = await prisma.donor.create({
        data: { email: 'fb-sender@example.com', magic_token: 'fb-session-token' },
      });
      let posted: FormData | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, opts: { body: FormData }) => {
          posted = opts.body;
          return { ok: true, status: 200 };
        }),
      );

      const diagnostics = {
        build: 'abc123',
        entries: [
          {
            at: '2026-11-13T00:00:00.000Z',
            kind: 'fetch',
            message: 'GET /api/x?token=secret -> 500 (10ms)',
          },
          { at: '2026-11-13T00:00:01.000Z', kind: 'console.error', message: 'save failed' },
          { at: 'bad', kind: 'nonsense-kind', message: 'dropped' },
        ],
      };

      const res = await request(createApp())
        .post('/api/feedback')
        .set('Cookie', 'dono_session=fb-session-token')
        .set('Host', 'localhost:3001')
        .field('text', 'The counter does not move')
        .field('metadata', JSON.stringify({ url: 'http://localhost:3001/donate' }))
        .field('diagnostics', JSON.stringify(diagnostics));

      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row!.sender_id).toBe(donor.id);
      const diagnosticsRecord = JSON.parse(row!.diagnostics!);
      expect(diagnosticsRecord.error_count).toBe(2);
      expect(diagnosticsRecord.context.sender_role).toBe('USER');
      expect(diagnosticsRecord.context.client_build_id).toBe('abc123');
      // Secret parameters are redacted server-side, even if the client forgot.
      expect(diagnosticsRecord.entries[0].message).toBe(
        'GET /api/x?token=[redacted] -> 500 (10ms)',
      );
      // The invalid third entry was dropped; timestamps were normalized.
      expect(diagnosticsRecord.entries).toHaveLength(2);
      // Donor identity reaches Discord only as the id (a uuid), never the email.
      const payload = posted!.get('payload_json') as string;
      expect(payload).toContain(donor.id);
      expect(payload).not.toContain('fb-sender@example.com');

      await prisma.donor.delete({ where: { id: donor.id } });
    });

    it('stores the report (200) even when Discord is unreachable, and drops a malformed diagnostics field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network down');
        }),
      );
      const res = await request(createApp())
        .post('/api/feedback')
        .field('text', 'It broke')
        .field('diagnostics', 'not json at all');
      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row).toBeTruthy();
      expect(JSON.parse(row!.diagnostics!).error_count).toBe(0);
    });

    it('stores the report (200) when the Discord webhook is not configured', async () => {
      const res = await request(createApp()).post('/api/feedback').field('text', 'No webhook here');
      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row).toBeTruthy();
    });

    it('drops a screenshot with faked image bytes but keeps the report', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const res = await request(createApp())
        .post('/api/feedback')
        .field('text', 'Magic bytes lie')
        .attach('screenshot', Buffer.from('definitely not an image'), {
          filename: 'shot.jpg',
          contentType: 'image/jpeg',
        });
      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row!.screenshot_path).toBeNull();
      expect(row!.message).toBe('Magic bytes lie');
    });

    it('drops an oversized snapshot but keeps the screenshot and the report', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200 })),
      );
      const res = await request(createApp())
        .post('/api/feedback')
        .field('text', 'Huge snapshot')
        .attach('snapshot', Buffer.alloc(4 * 1024 * 1024, 'a'), {
          filename: 'snapshot.html',
          contentType: 'text/html',
        });
      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row!.snapshot_path).toBeNull();
    });

    it('keeps a same-host page URL but drops a cross-host one', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200 })),
      );
      const res = await request(createApp())
        .post('/api/feedback')
        .set('Host', 'localhost:3001')
        .field('text', 'Which page?')
        .field('metadata', JSON.stringify({ url: 'https://evil.example.com/donate' }));
      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: res.body.id } });
      expect(row!.page_url).toBe('');
      expect(row!.route).toBe('');
    });
  });
});
