import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseClient } from '../../lib/databaseClient.js';
import adminRouter from '../../routes/admin.js';

const prisma = createDatabaseClient();

const ADMIN_KEY = 'Bearer key_admin_test-admin-key';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const HTML = '<!doctype html><html><body>snapshot</body></html>';

const FEEDBACK_DIR = mkdtempSync(join(tmpdir(), 'dono-admin-feedback-test-'));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

let adminDonor: { id: string; email: string; magic_token: string | null };
let modDonor: { id: string; email: string; magic_token: string | null };

async function createReport(overrides: Record<string, unknown> = {}) {
  return prisma.feedback.create({
    data: {
      message: 'Report message',
      page_url: 'http://localhost:3001/donate',
      route: '/donate',
      viewport: '1600x900',
      ...overrides,
    },
  });
}

describe('Admin feedback queue routes', () => {
  beforeAll(async () => {
    process.env.FEEDBACK_DIR = FEEDBACK_DIR;
    adminDonor = await prisma.donor.create({
      data: { email: 'fb-admin@example.com', role: 'ADMIN', magic_token: 'fb-admin-token' },
    });
    modDonor = await prisma.donor.create({
      data: { email: 'fb-mod@example.com', role: 'MODERATOR', magic_token: 'fb-mod-token' },
    });
    writeFileSync(join(FEEDBACK_DIR, 'shot.png'), PNG_BYTES);
    writeFileSync(join(FEEDBACK_DIR, 'snap.html'), HTML);
  });

  afterAll(async () => {
    await prisma.feedback.deleteMany({});
    await prisma.donor.delete({ where: { id: adminDonor.id } });
    await prisma.donor.delete({ where: { id: modDonor.id } });
    delete process.env.FEEDBACK_DIR;
    rmSync(FEEDBACK_DIR, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('refuses unauthenticated requests and moderator donors (403, never the email)', async () => {
    const app = createApp();
    expect((await request(app).get('/api/admin/feedback')).status).toBe(401);
    const res = await request(app)
      .get('/api/admin/feedback')
      .set('Cookie', 'dono_session=fb-mod-token');
    expect(res.status).toBe(403);
  });

  it('lists reports with filters and the open count (admin key)', async () => {
    const open = await createReport({ status: 'NEW' });
    const done = await createReport({ status: 'DONE' });
    const declined = await createReport({ status: 'DECLINED' });
    try {
      const openRes = await request(createApp())
        .get('/api/admin/feedback')
        .set('Authorization', ADMIN_KEY);
      expect(openRes.status).toBe(200);
      expect(openRes.body.open_count).toBeGreaterThan(0);
      const statuses = openRes.body.items.map((i: { id: string }) => i.id);
      expect(statuses).toContain(open.id);
      expect(statuses).not.toContain(done.id);
      expect(openRes.body.items[0].ref).toMatch(/^FB-[0-9a-f]{8}$/);
      expect(openRes.body.items[0].sender).toBeNull();

      const doneRes = await request(createApp())
        .get('/api/admin/feedback?filter=done')
        .set('Authorization', ADMIN_KEY);
      const doneIds = doneRes.body.items.map((i: { id: string }) => i.id);
      expect(doneIds).toContain(done.id);
      expect(doneIds).toContain(declined.id);
      expect(doneIds).not.toContain(open.id);

      const allRes = await request(createApp())
        .get('/api/admin/feedback?filter=all')
        .set('Authorization', ADMIN_KEY);
      expect(allRes.body.items.length).toBeGreaterThanOrEqual(3);
    } finally {
      await prisma.feedback.deleteMany({
        where: { id: { in: [open.id, done.id, declined.id] } },
      });
    }
  });

  it('shows detail, marks NEW reports SEEN, and 404s unknown ids', async () => {
    const report = await createReport({ sender_id: adminDonor.id });
    try {
      const app = createApp();
      const detail = await request(app)
        .get(`/api/admin/feedback/${report.id}`)
        .set('Authorization', ADMIN_KEY);
      expect(detail.status).toBe(200);
      expect(detail.body.route).toBe('/donate');
      expect(detail.body.sender.email).toBe('fb-admin@example.com');

      expect(
        (
          await request(app)
            .post(`/api/admin/feedback/${report.id}/seen`)
            .set('Authorization', ADMIN_KEY)
        ).status,
      ).toBe(200);
      expect((await prisma.feedback.findUnique({ where: { id: report.id } }))!.status).toBe('SEEN');
      // A SEEN report stays SEEN (no reopen side effect).
      await request(app)
        .post(`/api/admin/feedback/${report.id}/seen`)
        .set('Authorization', ADMIN_KEY);
      expect((await prisma.feedback.findUnique({ where: { id: report.id } }))!.status).toBe('SEEN');

      expect(
        (await request(app).get('/api/admin/feedback/no-such-id').set('Authorization', ADMIN_KEY))
          .status,
      ).toBe(404);
    } finally {
      await prisma.feedback.delete({ where: { id: report.id } });
    }
  });

  it('resolves through the shared parse/apply pair, stamping the admin label', async () => {
    const report = await createReport();
    try {
      const app = createApp();

      expect(
        (
          await request(app)
            .patch(`/api/admin/feedback/${report.id}`)
            .set('Authorization', ADMIN_KEY)
            .send({ status: 'WAT' })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .patch(`/api/admin/feedback/${report.id}`)
            .set('Authorization', ADMIN_KEY)
            .send({ status: 'DONE', resolution_pr: 'not a url' })
        ).status,
      ).toBe(400);

      const res = await request(app)
        .patch(`/api/admin/feedback/${report.id}`)
        .set('Authorization', ADMIN_KEY)
        .send({
          status: 'DONE',
          resolution_note: 'Fixed in #200',
          resolution_pr: 'https://github.com/esamarathon/esa-dono-ui/pull/200',
        });
      expect(res.status).toBe(200);
      const row = await prisma.feedback.findUnique({ where: { id: report.id } });
      expect(row!.status).toBe('DONE');
      expect(row!.resolution_note).toBe('Fixed in #200');
      expect(row!.resolved_by).toBe('admin'); // operational key, no donor identity
      expect(row!.resolved_at).toBeTruthy();

      // A donor admin stamping with their session is labelled by email.
      const donorRes = await request(app)
        .patch(`/api/admin/feedback/${report.id}`)
        .set('Cookie', 'dono_session=fb-admin-token')
        .send({ status: 'SEEN' });
      expect(donorRes.status).toBe(200);
      const reopened = await prisma.feedback.findUnique({ where: { id: report.id } });
      expect(reopened!.status).toBe('SEEN');
      expect(reopened!.resolved_by).toBeNull(); // reopening clears the stamp
      expect(reopened!.resolved_at).toBeNull();
    } finally {
      await prisma.feedback.delete({ where: { id: report.id } });
    }
  });

  it('serves the report files only to admins, with a sandboxed snapshot', async () => {
    const report = await createReport({
      screenshot_path: 'shot.png',
      snapshot_path: 'snap.html',
    });
    try {
      const app = createApp();
      const png = await request(app)
        .get(`/api/admin/feedback/${report.id}/screenshot`)
        .set('Authorization', ADMIN_KEY);
      expect(png.status).toBe(200);
      expect(png.headers['content-type']).toContain('image/png');
      expect(png.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(png.body as unknown as Buffer, PNG_BYTES)).toBe(0);

      const snap = await request(app)
        .get(`/api/admin/feedback/${report.id}/snapshot`)
        .set('Authorization', ADMIN_KEY);
      expect(snap.status).toBe(200);
      expect(snap.text).toContain('snapshot');
      expect(snap.headers['content-security-policy']).toContain('sandbox');
      expect(snap.headers['referrer-policy']).toBe('no-referrer');

      // Moderator donors are refused the files too (the queue is admin-only).
      expect(
        (
          await request(app)
            .get(`/api/admin/feedback/${report.id}/snapshot`)
            .set('Cookie', 'dono_session=fb-mod-token')
        ).status,
      ).toBe(403);

      // A report without files, and a file missing on disk, are 404s.
      const bare = await createReport();
      try {
        expect(
          (
            await request(app)
              .get(`/api/admin/feedback/${bare.id}/screenshot`)
              .set('Authorization', ADMIN_KEY)
          ).status,
        ).toBe(404);
        const ghost = await createReport({ screenshot_path: 'does-not-exist.png' });
        try {
          expect(
            (
              await request(app)
                .get(`/api/admin/feedback/${ghost.id}/screenshot`)
                .set('Authorization', ADMIN_KEY)
            ).status,
          ).toBe(404);
        } finally {
          await prisma.feedback.delete({ where: { id: ghost.id } });
        }
      } finally {
        await prisma.feedback.delete({ where: { id: bare.id } });
      }
    } finally {
      await prisma.feedback.delete({ where: { id: report.id } });
    }
  });
});
