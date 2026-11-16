import { describe, it, expect, afterAll } from 'vitest';
import {
  applyFeedbackUpdate,
  loadFeedbackItem,
  loadFeedbackQueue,
  markFeedbackSeen,
  parseFeedbackUpdate,
} from '../../services/feedbackQueue.js';
import { createDatabaseClient } from '../../lib/databaseClient.js';

const prisma = createDatabaseClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('feedbackQueue', () => {
  describe('parseFeedbackUpdate', () => {
    const base = {
      id: '11111111-2222-4333-8444-555555555555',
      status: 'DONE',
      resolution_note: '',
      resolution_pr: '',
    };

    it('accepts a valid update', () => {
      expect(
        parseFeedbackUpdate({
          ...base,
          resolution_note: 'Fixed in #200',
          resolution_pr: 'https://github.com/x/y/pull/1',
        }),
      ).toEqual({
        id: base.id,
        status: 'DONE',
        resolution_note: 'Fixed in #200',
        resolution_pr: 'https://github.com/x/y/pull/1',
      });
    });

    it('refuses an unknown id, an invalid status, an over-long note and a non-http PR', () => {
      expect(parseFeedbackUpdate({ ...base, id: '' })).toHaveProperty('error', 'bad-id');
      expect(parseFeedbackUpdate({ ...base, status: 'WAT' })).toHaveProperty('error', 'bad-status');
      expect(parseFeedbackUpdate({ ...base, resolution_note: 'x'.repeat(5001) })).toHaveProperty(
        'error',
        'note-long',
      );
      expect(parseFeedbackUpdate({ ...base, resolution_pr: 'javascript:alert(1)' })).toHaveProperty(
        'error',
        'bad-pr',
      );
    });
  });

  describe('applyFeedbackUpdate', () => {
    it('throws for an unknown report', async () => {
      await expect(
        applyFeedbackUpdate(
          { id: 'nope', status: 'DONE', resolution_note: '', resolution_pr: '' },
          'admin@example.com',
        ),
      ).rejects.toThrow('Unknown report.');
    });

    it('stamps who/when on an answer and clears the stamp on reopening', async () => {
      const report = await prisma.feedback.create({ data: { message: 'Stamp me' } });
      try {
        const at = new Date('2026-11-13T12:00:00.000Z');
        await applyFeedbackUpdate(
          { id: report.id, status: 'DONE', resolution_note: 'Answered', resolution_pr: '' },
          'admin@example.com',
          at,
        );
        let row = await prisma.feedback.findUnique({ where: { id: report.id } });
        expect(row!.status).toBe('DONE');
        expect(row!.resolution_note).toBe('Answered');
        expect(row!.resolved_by).toBe('admin@example.com');
        expect(row!.resolved_at?.toISOString()).toBe(at.toISOString());

        await applyFeedbackUpdate(
          { id: report.id, status: 'SEEN', resolution_note: 'Answered', resolution_pr: '' },
          'admin@example.com',
          at,
        );
        row = await prisma.feedback.findUnique({ where: { id: report.id } });
        expect(row!.status).toBe('SEEN');
        expect(row!.resolved_by).toBeNull();
        expect(row!.resolved_at).toBeNull();
      } finally {
        await prisma.feedback.delete({ where: { id: report.id } });
      }
    });
  });

  describe('markFeedbackSeen', () => {
    it('moves only NEW reports to SEEN', async () => {
      const fresh = await prisma.feedback.create({ data: { message: 'Fresh' } });
      const done = await prisma.feedback.create({ data: { message: 'Done', status: 'DONE' } });
      try {
        await markFeedbackSeen(fresh.id);
        await markFeedbackSeen(done.id);
        expect((await prisma.feedback.findUnique({ where: { id: fresh.id } }))!.status).toBe(
          'SEEN',
        );
        expect((await prisma.feedback.findUnique({ where: { id: done.id } }))!.status).toBe('DONE');
      } finally {
        await prisma.feedback.delete({ where: { id: fresh.id } });
        await prisma.feedback.delete({ where: { id: done.id } });
      }
    });
  });

  describe('loadFeedbackQueue / loadFeedbackItem', () => {
    it('splits open and answered reports and exposes the diagnostics error count', async () => {
      const diagnostics = JSON.stringify({
        v: 1,
        captured_at: '2026-11-13T00:00:00.000Z',
        error_count: 3,
        context: {
          build_id: 'unknown',
          client_build_id: 'unknown',
          instance: null,
          viewport: '1600x900',
          userAgent: 'Test',
          sender_role: null,
        },
        entries: [],
      });
      const open = await prisma.feedback.create({ data: { message: 'Open', diagnostics } });
      const answered = await prisma.feedback.create({
        data: { message: 'Answered', status: 'DECLINED' },
      });
      try {
        const queue = await loadFeedbackQueue('open');
        expect(queue.map((i) => i.id)).toContain(open.id);
        expect(queue.map((i) => i.id)).not.toContain(answered.id);
        const mine = queue.find((i) => i.id === open.id)!;
        expect(mine.diagnostics_error_count).toBe(3);
        expect(mine.has_screenshot).toBe(false);

        const done = await loadFeedbackQueue('done');
        expect(done.map((i) => i.id)).toContain(answered.id);
        expect(done.map((i) => i.id)).not.toContain(open.id);

        const item = await loadFeedbackItem(open.id);
        expect(item!.diagnostics?.error_count).toBe(3);
        expect(await loadFeedbackItem('missing')).toBeNull();
      } finally {
        await prisma.feedback.delete({ where: { id: open.id } });
        await prisma.feedback.delete({ where: { id: answered.id } });
      }
    });
  });
});
