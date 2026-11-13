import { describe, it, expect, afterAll } from 'vitest';
import {
  FEEDBACK_CLI_USAGE,
  FeedbackCliUsageError,
  findFeedbackResolver,
  parseFeedbackCliArgs,
  resolveFeedbackId,
  runFeedbackCli,
} from '../../services/feedbackCli.js';
import { createDatabaseClient } from '../../lib/databaseClient.js';

const prisma = createDatabaseClient();

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    outText: () => out.join('\n'),
    errText: () => err.join('\n'),
  };
}

const ADMIN_EMAIL = 'fb-cli-admin@example.com';
const USER_EMAIL = 'fb-cli-user@example.com';
let adminDonorId = '';
let userDonorId = '';

const REPORT_IDS: string[] = [];

async function seedReport(data: Record<string, unknown> = {}) {
  const row = await prisma.feedback.create({ data: { message: 'Report message', ...data } });
  REPORT_IDS.push(row.id);
  return row;
}

afterAll(async () => {
  if (REPORT_IDS.length > 0) {
    await prisma.feedback.deleteMany({ where: { id: { in: REPORT_IDS } } });
  }
  if (adminDonorId) await prisma.donor.delete({ where: { id: adminDonorId } }).catch(() => {});
  if (userDonorId) await prisma.donor.delete({ where: { id: userDonorId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('feedbackCli', () => {
  describe('parseFeedbackCliArgs', () => {
    it('splits value flags, boolean flags and positionals', () => {
      const parsed = parseFeedbackCliArgs(['show', 'FB-1a2b3c4d', '--json']);
      expect(parsed.positional).toEqual(['show', 'FB-1a2b3c4d']);
      expect(parsed.flags.get('json')).toBe(true);
      expect(parseFeedbackCliArgs(['list', '--status=all']).flags.get('status')).toBe('all');
      expect(parseFeedbackCliArgs(['list', '--limit', '5']).flags.get('limit')).toBe('5');
    });

    it('rejects unknown options, duplicate value flags and missing values', () => {
      expect(() => parseFeedbackCliArgs(['list', '--wat'])).toThrow(FeedbackCliUsageError);
      expect(() => parseFeedbackCliArgs(['list', '--status', 'a', '--status', 'b'])).toThrow(
        /given twice/,
      );
      expect(() => parseFeedbackCliArgs(['resolve', 'x', '--status'])).toThrow(/needs a value/);
      expect(() => parseFeedbackCliArgs(['list', '--json=1'])).toThrow(/takes no value/);
    });
  });

  describe('resolveFeedbackId', () => {
    it('accepts a full uuid or a unique FB-<short id>', async () => {
      const row = await seedReport();
      expect(await resolveFeedbackId(row.id)).toBe(row.id);
      const short = row.id.split('-')[0];
      expect(await resolveFeedbackId(`FB-${short}`)).toBe(row.id);
      expect(await resolveFeedbackId(short)).toBe(row.id);
      await expect(resolveFeedbackId('zzzzzzzz')).rejects.toThrow(/bad report id/);
      await expect(resolveFeedbackId('deadc0de')).rejects.toThrow(/no report matches/);
    });

    it('refuses garbage and ambiguous prefixes', async () => {
      await expect(resolveFeedbackId(undefined)).rejects.toThrow(/expected a report id/);
      await expect(resolveFeedbackId('xyz!')).rejects.toThrow(/bad report id/);
      // Two rows sharing the first 7 hex characters: create a second report whose
      // short id extends the first one's (uuid v4 first segment varies; use a
      // crafted id to force the ambiguity deterministically).
      const crafted = await prisma.$executeRawUnsafe(
        `INSERT INTO "Feedback" ("id", "message") VALUES ('deadbeef-aaaa-4bbb-8ccc-000000000001', 'A'), ('deadbeef-aaaa-4bbb-8ccc-000000000002', 'B')`,
      );
      expect(crafted).toBe(2);
      REPORT_IDS.push(
        'deadbeef-aaaa-4bbb-8ccc-000000000001',
        'deadbeef-aaaa-4bbb-8ccc-000000000002',
      );
      await expect(resolveFeedbackId('deadbeef')).rejects.toThrow(/matches several reports/);
      expect(await resolveFeedbackId('deadbeef-aaaa-4bbb-8ccc-000000000001')).toBe(
        'deadbeef-aaaa-4bbb-8ccc-000000000001',
      );
    });
  });

  describe('findFeedbackResolver', () => {
    it('requires an effective ADMIN and matches email case-insensitively', async () => {
      const admin = await prisma.donor.create({
        data: { email: ADMIN_EMAIL, role: 'ADMIN', magic_token: 'fb-cli-admin-token' },
      });
      adminDonorId = admin.id;
      const user = await prisma.donor.create({
        data: { email: USER_EMAIL, role: 'USER', magic_token: 'fb-cli-user-token' },
      });
      userDonorId = user.id;

      expect((await findFeedbackResolver(ADMIN_EMAIL)).id).toBe(adminDonorId);
      expect((await findFeedbackResolver(ADMIN_EMAIL.toUpperCase())).id).toBe(adminDonorId);
      expect((await findFeedbackResolver(adminDonorId)).id).toBe(adminDonorId);
      await expect(findFeedbackResolver(USER_EMAIL)).rejects.toThrow(/is not an admin/);
      await expect(findFeedbackResolver('ghost@example.com')).rejects.toThrow(/no such donor/);
    });
  });

  describe('runFeedbackCli', () => {
    it('prints usage for no command or help and exits non-zero without one', async () => {
      const noArgs = sink();
      expect(await runFeedbackCli([], noArgs)).toBe(2);
      expect(noArgs.outText()).toContain('Usage:');
      const help = sink();
      expect(await runFeedbackCli(['help'], help)).toBe(0);
      expect(help.outText()).toBe(FEEDBACK_CLI_USAGE);
      const unknown = sink();
      expect(await runFeedbackCli(['frobnicate'], unknown)).toBe(2);
      expect(unknown.errText()).toContain('unknown command');
    });

    it('lists open reports by default, newest first, with flags', async () => {
      const open = await seedReport({ message: 'The counter is stuck on zero' });
      const answered = await seedReport({
        message: 'Already answered',
        status: 'DONE',
        screenshot_path: '2026/11/shot.png',
        snapshot_path: '2026/11/snap.html',
      });
      const io = sink();
      const code = await runFeedbackCli(['list', '--limit', '10'], io);
      expect(code).toBe(0);
      const text = io.outText();
      expect(text).toContain(open.id.slice(0, 8));
      expect(text).not.toContain(answered.id.slice(0, 8));
      expect(text).toContain('(flags:');

      const all = sink();
      await runFeedbackCli(['list', '--status', 'all', '--limit', '10'], all);
      expect(all.outText()).toContain(answered.id.slice(0, 8));
      // The answered report carries both files: Screenshot + DOM snapshot flags.
      expect(all.outText()).toContain('SD');

      const json = sink();
      await runFeedbackCli(['list', '--json', '--limit', '10'], json);
      const items = JSON.parse(json.outText());
      expect(items[0]).toHaveProperty('ref');
      expect(items[0].created_at).toBeTruthy();

      expect(await runFeedbackCli(['list', '--status', 'WAT'], sink())).toBe(2);
      expect(await runFeedbackCli(['list', '--limit', '999'], sink())).toBe(2);
    });

    it('shows a report (text and json) with diagnostics and file paths', async () => {
      const diagnostics = JSON.stringify({
        v: 1,
        captured_at: '2026-11-13T00:00:00.000Z',
        error_count: 1,
        context: {
          build_id: 'b1',
          client_build_id: 'b2',
          instance: null,
          viewport: '1600x900',
          userAgent: 'Test',
          sender_role: 'USER',
        },
        entries: [{ at: '2026-11-13T00:00:00.000Z', kind: 'error', message: 'boom' }],
      });
      const report = await seedReport({
        diagnostics,
        page_url: 'http://localhost:3001/donate',
        route: '/donate',
        viewport: '1600x900',
        user_agent: 'TestAgent/1.0',
        resolution_note: 'Fixed in #200',
        resolved_by: ADMIN_EMAIL,
        resolved_at: new Date('2026-11-13T12:00:00.000Z'),
        status: 'DONE',
      });
      const io = sink();
      expect(await runFeedbackCli(['show', report.id], io)).toBe(0);
      const text = io.outText();
      expect(text).toContain(`FB-${report.id.slice(0, 8)}`);
      expect(text).toContain('/donate');
      expect(text).toContain('TestAgent/1.0');
      expect(text).toContain('Diagnostics: 1 error(s)');
      expect(text).toContain('error: boom');
      expect(text).toContain('Fixed in #200');
      expect(text).toContain(ADMIN_EMAIL);

      const json = sink();
      expect(await runFeedbackCli(['show', report.id, '--json'], json)).toBe(0);
      const data = JSON.parse(json.outText());
      expect(data.diagnostics.entries[0].message).toBe('boom');
      expect(data.files.screenshot).toBeNull();

      const missing = sink();
      // An unresolvable id is a usage error (exit 2), not a missing row (exit 1).
      expect(await runFeedbackCli(['show', 'FB-deadc0de'], missing)).toBe(2);
      expect(missing.errText()).toContain('no report matches');

      expect(await runFeedbackCli(['show'], sink())).toBe(2);
      expect(await runFeedbackCli(['show', 'a', 'b'], sink())).toBe(2);
    });

    it('resolves through the shared parse/apply pair and keeps the current note on a bare status change', async () => {
      const admin = await prisma.donor.findUnique({ where: { email: ADMIN_EMAIL } });
      if (!admin) {
        const created = await prisma.donor.create({
          data: { email: ADMIN_EMAIL, role: 'ADMIN', magic_token: 'fb-cli-admin-token' },
        });
        adminDonorId = created.id;
      }
      const report = await seedReport();
      const io = sink();
      expect(
        await runFeedbackCli(
          [
            'resolve',
            report.id,
            '--status',
            'DONE',
            '--note',
            'Fixed in #201',
            '--as',
            ADMIN_EMAIL,
          ],
          io,
        ),
      ).toBe(0);
      expect(io.outText()).toContain(`-> DONE by ${ADMIN_EMAIL}`);
      let row = await prisma.feedback.findUnique({ where: { id: report.id } });
      expect(row!.resolution_note).toBe('Fixed in #201');
      expect(row!.resolved_by).toBe(ADMIN_EMAIL);

      // Bare status change keeps the note; --pr '' clears it.
      expect(
        await runFeedbackCli(
          ['resolve', report.id, '--status', 'DECLINED', '--as', ADMIN_EMAIL],
          sink(),
        ),
      ).toBe(0);
      row = await prisma.feedback.findUnique({ where: { id: report.id } });
      expect(row!.status).toBe('DECLINED');
      expect(row!.resolution_note).toBe('Fixed in #201');

      // Validation failures are usage errors with the shared error text.
      expect(
        await runFeedbackCli(
          ['resolve', report.id, '--status', 'NEW', '--as', ADMIN_EMAIL],
          sink(),
        ),
      ).toBe(2);
      expect(await runFeedbackCli(['resolve', report.id, '--as', ADMIN_EMAIL], sink())).toBe(2);
      expect(await runFeedbackCli(['resolve', report.id, '--status', 'DONE'], sink())).toBe(2);
      const bad = sink();
      expect(
        await runFeedbackCli(
          ['resolve', report.id, '--status', 'DONE', '--pr', 'notaurl', '--as', ADMIN_EMAIL],
          bad,
        ),
      ).toBe(2);
      expect(bad.errText()).toContain('http(s) URL');
    });
  });
});
