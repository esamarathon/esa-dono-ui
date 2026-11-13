import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_OPEN_STATUSES,
  type FeedbackStatus,
  buildFeedbackDiagnostics,
  feedbackRef,
  feedbackResolutionStamp,
  feedbackStoragePath,
  feedbackViewportString,
  firstChars,
  isFeedbackStatus,
  isOpenFeedbackStatus,
  isStaleFeedbackBuild,
  parseFeedbackDiagnostics,
  queueFilterFrom,
  sanitizeFeedbackClientDiagnostics,
  scrubFeedbackSecrets,
  serializeFeedbackDiagnostics,
  truncateFeedbackDiag,
} from './feedback.js';

describe('feedback vocabulary', () => {
  it('classifies statuses', () => {
    expect(FEEDBACK_OPEN_STATUSES).toEqual(['NEW', 'SEEN']);
    expect(isFeedbackStatus('DONE')).toBe(true);
    expect(isFeedbackStatus('done')).toBe(false);
    expect(isOpenFeedbackStatus('NEW')).toBe(true);
    expect(isOpenFeedbackStatus('DECLINED')).toBe(false);
  });

  it('renders the human reference from the uuid', () => {
    expect(feedbackRef('11111111-2222-4333-8444-555555555555')).toBe('FB-11111111');
    expect(feedbackRef('short')).toBe('FB-short');
  });

  it('builds the storage path and viewport strings', () => {
    const at = new Date('2026-11-13T01:02:03.004Z');
    expect(feedbackStoragePath('png', at, '11111111-2')).toBe(
      '2026/11/2026-11-13T01-02-03-004-11111111-2.png',
    );
    expect(feedbackStoragePath('html', at, null)).toBe('2026/11/2026-11-13T01-02-03-004-anon.html');
    expect(feedbackViewportString(1600.2, 900.6)).toBe('1600x901');
  });

  it('stamps answers and clears reopening', () => {
    const now = new Date('2026-11-13T00:00:00.000Z');
    expect(feedbackResolutionStamp('DONE', 'admin', now)).toEqual({
      resolved_by: 'admin',
      resolved_at: now,
    });
    expect(feedbackResolutionStamp('SEEN', 'admin', now)).toEqual({
      resolved_by: null,
      resolved_at: null,
    });
  });

  it('normalizes the queue filter and truncates text', () => {
    expect(queueFilterFrom('done')).toBe('done');
    expect(queueFilterFrom('anything')).toBe('open');
    expect(firstChars('one two  three', 10)).toBe('one two t…');
    expect(truncateFeedbackDiag('abcdefgh', 5)).toBe('abcd…');
  });
});

describe('diagnostics record', () => {
  const client = sanitizeFeedbackClientDiagnostics(
    JSON.stringify({
      build: 'abc123',
      entries: [
        { at: '2026-11-13T00:00:00.000Z', kind: 'fetch', message: 'GET /api/x?token=abc -> 500' },
        { at: 'nope', kind: 'wat', message: 'dropped' },
      ],
    }),
  )!;

  it('validates the client field: known kinds kept, the rest dropped', () => {
    expect(client).toEqual({
      build: 'abc123',
      entries: [
        {
          at: '2026-11-13T00:00:00.000Z',
          kind: 'fetch',
          message: 'GET /api/x?token=[redacted] -> 500',
        },
      ],
    });
    expect(sanitizeFeedbackClientDiagnostics('not json')).toBeNull();
    expect(sanitizeFeedbackClientDiagnostics(null)).toBeNull();
    expect(sanitizeFeedbackClientDiagnostics('x'.repeat(64 * 1024 + 1))).toBeNull();
    expect(
      sanitizeFeedbackClientDiagnostics(JSON.stringify({ build: 'a/../b<>?', entries: [] }))!.build,
    ).toBe('a..b');
  });

  it('stamps the server context and serializes within the byte cap', () => {
    const record = buildFeedbackDiagnostics({
      client,
      context: {
        build_id: 'srv',
        client_build_id: 'abc123',
        instance: 'TEST',
        viewport: '1600x900',
        userAgent: 'TestAgent/1.0',
        sender_role: 'USER',
      },
      capturedAt: new Date('2026-11-13T12:00:00.000Z'),
    });
    expect(record.error_count).toBe(1);
    expect(record.context.instance).toBe('TEST');
    const json = serializeFeedbackDiagnostics(record);
    expect(JSON.parse(json).v).toBe(1);
    expect(parseFeedbackDiagnostics(json)!.context.client_build_id).toBe('abc123');
    expect(parseFeedbackDiagnostics('[]')).toBeNull();
    expect(parseFeedbackDiagnostics(null)).toBeNull();
  });

  it('keeps the newest 20 entries when serializing', () => {
    // Entries come from the sanitizer (≤20 × ≤500 chars), so the byte cap can
    // never trigger through the public path; the entry-count slice is the
    // enforced bound.
    const record = buildFeedbackDiagnostics({
      client: null,
      context: {
        build_id: 'srv',
        client_build_id: 'unknown',
        instance: null,
        viewport: '',
        userAgent: '',
        sender_role: null,
      },
    });
    const json = serializeFeedbackDiagnostics({
      ...record,
      entries: Array.from({ length: 25 }, (_, i) => ({
        at: '2026-11-13T00:00:00.000Z',
        kind: 'error' as const,
        message: `entry-${i}`,
      })),
    });
    const parsed = parseFeedbackDiagnostics(json)!;
    expect(parsed.entries).toHaveLength(20);
    // The five OLDEST were dropped first.
    expect(parsed.entries[0]!.message).toBe('entry-5');
    expect(parsed.entries[19]!.message).toBe('entry-24');
  });

  it('flags a stale tab only when both builds are known and differ', () => {
    expect(isStaleFeedbackBuild({ build_id: 'a', client_build_id: 'b' })).toBe(true);
    expect(isStaleFeedbackBuild({ build_id: 'unknown', client_build_id: 'b' })).toBe(false);
    expect(isStaleFeedbackBuild({ build_id: 'a', client_build_id: 'a' })).toBe(false);
  });

  it('scrubs secrets', () => {
    expect(scrubFeedbackSecrets('?Key=abc')).toBe('?Key=[redacted]');
  });
});

describe('status type narrowing', () => {
  it('narrows with isFeedbackStatus', () => {
    const raw: unknown = 'SEEN';
    if (isFeedbackStatus(raw)) {
      const status: FeedbackStatus = raw;
      expect(status).toBe('SEEN');
    } else {
      expect.fail('SEEN should be a status');
    }
  });
});
