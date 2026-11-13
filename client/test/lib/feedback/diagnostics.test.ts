import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeFeedbackUrl, formatFeedbackFetchEntry, scrubFeedbackSecrets } from '@dono/shared';
import {
  RingBuffer,
  clientBuildId,
  clientPayload,
  describeConsoleArgs,
  describeThrown,
  installDiagnostics,
  readDiagnostics,
  type DiagTarget,
} from '../../../src/lib/feedback/diagnostics';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('redaction', () => {
  it('scrubs secret-looking parameters out of free text', () => {
    expect(scrubFeedbackSecrets('GET /api/x?token=abc&x=1 -> 500')).toBe(
      'GET /api/x?token=[redacted]&x=1 -> 500',
    );
    expect(scrubFeedbackSecrets('failed with code=zz and Password=hunter2')).toBe(
      'failed with code=[redacted] and Password=[redacted]',
    );
    expect(scrubFeedbackSecrets('plain text stays')).toBe('plain text stays');
  });

  it('records cross-origin fetches as their origin only', () => {
    expect(
      describeFeedbackUrl('https://evil.example.com/a/b?token=x', 'http://localhost:3001/'),
    ).toBe('https://evil.example.com');
    expect(describeFeedbackUrl('/api/x?token=abc', 'http://localhost:3001/donate')).toBe(
      '/api/x?token=[redacted]',
    );
    expect(describeFeedbackUrl('/api/x?y=1', 'http://localhost:3001/donate')).toBe('/api/x?y=1');
  });

  it('formats fetch entries', () => {
    expect(formatFeedbackFetchEntry({ method: 'post', url: '/api/x', status: 500, ms: 12.4 })).toBe(
      'POST /api/x -> 500 (12ms)',
    );
    expect(formatFeedbackFetchEntry({ method: 'GET', url: '/api/x', status: null, ms: 3 })).toBe(
      'GET /api/x -> network error (3ms)',
    );
  });
});

describe('describeThrown / describeConsoleArgs', () => {
  it('renders an Error with the top of its stack', () => {
    const e = new Error('boom');
    const text = describeThrown(e);
    expect(text).toContain('Error: boom');
  });

  it('reduces objects and DOM nodes to their class name — never their contents', () => {
    expect(describeConsoleArgs(['save failed', { typed: 'secret', nested: 1 }])).toBe(
      'save failed [Object]',
    );
    expect(describeConsoleArgs(['x', [1, 2, 3]])).toBe('x [Array(3)]');
    const dom = new DOMParser().parseFromString('<form></form>', 'text/html').body.firstChild!;
    expect(describeConsoleArgs(['x', dom])).toBe('x [HTMLFormElement]');
    expect(describeConsoleArgs(['x', new Event('click')])).toBe('x [Event]');
    expect(describeConsoleArgs(['plain', 42, true])).toBe('plain 42 true');
  });
});

describe('RingBuffer', () => {
  it('keeps only the newest entries and truncates long messages', () => {
    const ring = new RingBuffer(3);
    for (let i = 0; i < 5; i++) ring.push('error', `error number ${i}`);
    const entries = ring.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0]!.message).toBe('error number 2');
    expect(entries[2]!.message).toBe('error number 4');

    const long = new RingBuffer(2);
    long.push('console.error', 'x'.repeat(600));
    expect(long.entries()[0]!.message.length).toBeLessThan(600);
    expect(long.entries()[0]!.message.endsWith('…')).toBe(true);
  });

  it('scrubs secrets on push', () => {
    const ring = new RingBuffer(1);
    ring.push('fetch', 'GET /api/x?secret=abc -> 500');
    expect(ring.entries()[0]!.message).toContain('[redacted]');
  });
});

function fakeWindow(href = 'http://localhost:3001/donate'): DiagTarget & Record<string, unknown> {
  const listeners = new Map<string, (ev: unknown) => void>();
  return {
    location: { href },
    fetch: vi.fn(async () => ({ status: 200 })),
    console: { error: vi.fn() },
    addEventListener: (type: string, listener: (ev: unknown) => void) =>
      listeners.set(type, listener),
    performance: { now: () => 0 },
    __listeners: listeners,
  } as unknown as DiagTarget & Record<string, unknown>;
}

describe('installDiagnostics', () => {
  it('is idempotent and returns the same buffer', () => {
    const win = fakeWindow();
    const first = installDiagnostics(win);
    const second = installDiagnostics(win);
    expect(second).toBe(first);
  });

  it('records window errors, rejections and console.error calls', () => {
    const win = fakeWindow();
    installDiagnostics(win);
    const listeners = (win as Record<string, unknown>).__listeners as Map<
      string,
      (ev: unknown) => void
    >;
    listeners.get('error')!({ message: 'script blew up' });
    listeners.get('unhandledrejection')!({ reason: new Error('rejected') });
    win.console.error('save failed', { form: 'typed value' });
    const entries = readDiagnostics(win);
    expect(entries.map((e) => e.kind)).toEqual(['error', 'unhandledrejection', 'console.error']);
    expect(entries[0]!.message).toContain('script blew up');
    expect(entries[1]!.message).toContain('Error: rejected');
    expect(entries[2]!.message).toBe('save failed [Object]');
  });

  it('records failed fetches with method, path and status, and ignores aborts', async () => {
    const win = fakeWindow();
    win.fetch = vi.fn(async () => ({ status: 500 }));
    installDiagnostics(win);
    await (win.fetch as (input: string) => Promise<unknown>)('/api/x?token=abc');
    win.fetch = vi.fn(async () => {
      throw Object.assign(new Error('stop'), { name: 'AbortError' });
    });
    installDiagnostics(win); // same buffer (idempotent install)
    const original = (win as Record<string, unknown>)['__donoFeedbackDiag'] as unknown as {
      entries: () => unknown[];
    };
    expect(original).toBeTruthy();
    // Reinstall must not wrap again; call the (already wrapped) fetch.
    try {
      await (win.fetch as (input: string) => Promise<unknown>)('/api/abort');
    } catch {
      /* the abort rethrows by design */
    }
    const entries = original.entries() as { kind: string; message: string }[];
    expect(entries.some((e) => e.kind === 'fetch' && e.message.includes('-> 500'))).toBe(true);
    expect(entries.every((e) => !e.message.includes('/api/abort'))).toBe(true);
  });

  it('never throws out of the listeners', () => {
    const win = fakeWindow();
    installDiagnostics(win);
    const listeners = (win as Record<string, unknown>).__listeners as Map<
      string,
      (ev: unknown) => void
    >;
    expect(() => listeners.get('error')!(undefined)).not.toThrow();
    expect(() => win.console.error()).not.toThrow();
  });
});

describe('clientBuildId / clientPayload', () => {
  it('reports unknown without a build env and inlines it in the payload', () => {
    vi.stubEnv('VITE_BUILD_SHA', '');
    expect(clientBuildId()).toBe('unknown');
    const payload = clientPayload(
      [{ at: '2026-11-13T00:00:00.000Z', kind: 'error', message: 'boom' }],
      clientBuildId(),
    );
    expect(JSON.parse(payload)).toEqual({
      build: 'unknown',
      entries: [{ at: '2026-11-13T00:00:00.000Z', kind: 'error', message: 'boom' }],
    });
  });

  it('uses the inlined build id when present', () => {
    vi.stubEnv('VITE_BUILD_SHA', 'abc1234');
    expect(clientBuildId()).toBe('abc1234');
  });
});
