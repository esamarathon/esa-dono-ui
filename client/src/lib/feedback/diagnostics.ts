// Feedback diagnostics — the browser half (the pure validation/serialization
// lives in @dono/shared). Ported from the esa-crew-corner feedback bubble.
//
// installDiagnostics(window) starts a small ring buffer when the widget module
// loads, so errors from BEFORE the button was pressed are in the report: last
// 20 entries, each at most 500 chars. What is NEVER captured: form values,
// typed text, request/response bodies, headers, cookies, tokens. A fetch is
// recorded as method + same-origin path+query (secret parameter values
// redacted) + status + duration; a cross-origin fetch is recorded as its
// origin only. console.error arguments that are objects are reduced to their
// class name, so `console.error("save failed", formState)` cannot leak what
// was typed; only strings, numbers and Errors are kept.

import {
  FEEDBACK_DIAG_ENTRY_MAX_CHARS,
  type FeedbackDiagEntry,
  type FeedbackDiagKind,
  describeFeedbackUrl,
  formatFeedbackFetchEntry,
  scrubFeedbackSecrets,
} from '@dono/shared';

export class RingBuffer {
  private items: FeedbackDiagEntry[] = [];
  constructor(private readonly max: number = 20) {}

  push(kind: FeedbackDiagKind, message: string, now: Date = new Date()): void {
    this.items.push({
      at: now.toISOString(),
      kind,
      message: scrubFeedbackSecrets(
        message.length <= FEEDBACK_DIAG_ENTRY_MAX_CHARS
          ? message
          : `${message.slice(0, FEEDBACK_DIAG_ENTRY_MAX_CHARS - 1)}…`,
      ),
    });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  entries(): FeedbackDiagEntry[] {
    return this.items.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.items.length;
  }
}

type Listener = (ev: never) => void;

/** The slice of `window` the installer touches, so tests can pass a fake. */
export type DiagTarget = {
  location: { href: string };
  fetch?: (input: unknown, init?: unknown) => Promise<{ status: number }>;
  console: { error: (...args: unknown[]) => void };
  addEventListener: (type: string, listener: Listener) => void;
  performance?: { now(): number };
  [flag: string]: unknown;
};

export const DIAG_WINDOW_FLAG = '__donoFeedbackDiag';

/** An Error becomes "Name: message" plus the top of its stack; never an object dump. */
export function describeThrown(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) {
    const e = value as { name?: unknown; message?: unknown; stack?: unknown };
    const head = `${typeof e.name === 'string' ? e.name : 'Error'}: ${typeof e.message === 'string' ? e.message : ''}`;
    const stack =
      typeof e.stack === 'string'
        ? e.stack.split('\n').slice(1, 4).join(' | ').replace(/\s+/g, ' ')
        : '';
    return stack ? `${head} @ ${stack}` : head;
  }
  return describeArg(value);
}

function describeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
    return String(arg);
  }
  if (typeof arg === 'function') return '[function]';
  if (typeof arg === 'object') {
    // Elements and events can reference form controls: name the class, dump nothing.
    const ctor = (arg as { constructor?: { name?: string } }).constructor?.name;
    if (typeof Node !== 'undefined' && arg instanceof Node) return `[${ctor ?? 'Node'}]`;
    if (typeof Event !== 'undefined' && arg instanceof Event) return `[${ctor ?? 'Event'}]`;
    if ('message' in arg) return describeThrown(arg);
    // Plain objects and arrays are NOT serialised: `console.error("save failed", formState)`
    // must never leak what was typed. Class name only.
    return Array.isArray(arg) ? `[Array(${arg.length})]` : `[${ctor ?? 'object'}]`;
  }
  return String(arg);
}

export function describeConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => (a && typeof a === 'object' && 'message' in a ? describeThrown(a) : describeArg(a)))
    .join(' ');
}

function requestMethod(input: unknown, init: unknown): string {
  const fromInit = (init as { method?: unknown } | undefined)?.method;
  if (typeof fromInit === 'string' && fromInit) return fromInit;
  const fromReq = (input as { method?: unknown } | null)?.method;
  if (typeof fromReq === 'string' && fromReq) return fromReq;
  return 'GET';
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const u =
      (input as { url?: unknown; href?: unknown }).url ?? (input as { href?: unknown }).href;
    if (typeof u === 'string') return u;
  }
  return String(input);
}

/**
 * Start recording. Idempotent: the module can be evaluated twice (HMR, test
 * re-imports), and wrapping fetch twice would double-count, so the buffer
 * lives on the window and a second call returns it.
 */
export function installDiagnostics(win: DiagTarget): RingBuffer {
  const existing = win[DIAG_WINDOW_FLAG] as RingBuffer | undefined;
  if (existing) return existing;
  const buffer = new RingBuffer();
  win[DIAG_WINDOW_FLAG] = buffer;
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* diagnostics must never break the page */
    }
  };

  win.addEventListener('error', ((ev: {
    message?: string;
    filename?: string;
    lineno?: number;
    error?: unknown;
  }) =>
    safely(() => {
      const where = ev.filename
        ? ` (${describeFeedbackUrl(ev.filename, win.location.href)}:${ev.lineno ?? 0})`
        : '';
      const text = ev.error ? describeThrown(ev.error) : (ev.message ?? 'error');
      buffer.push('error', `${text}${where}`);
    })) as Listener);

  win.addEventListener('unhandledrejection', ((ev: { reason?: unknown }) =>
    safely(() => buffer.push('unhandledrejection', describeThrown(ev.reason)))) as Listener);

  const originalError = win.console.error;
  win.console.error = (...args: unknown[]) => {
    safely(() => buffer.push('console.error', describeConsoleArgs(args)));
    return originalError.apply(win.console, args);
  };

  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    const clock = () => win.performance?.now() ?? Date.now();
    win.fetch = async function wrappedFetch(this: unknown, input: unknown, init?: unknown) {
      const started = clock();
      let method = 'GET';
      let url = '';
      safely(() => {
        method = requestMethod(input, init);
        url = describeFeedbackUrl(requestUrl(input), win.location.href);
      });
      try {
        const res = await originalFetch.call(win, input, init);
        if (res.status >= 400) {
          safely(() =>
            buffer.push(
              'fetch',
              formatFeedbackFetchEntry({ method, url, status: res.status, ms: clock() - started }),
            ),
          );
        }
        return res;
      } catch (err) {
        // A navigation or an explicit abort is not a failure worth reporting.
        const name = (err as { name?: unknown } | null)?.name;
        if (name !== 'AbortError') {
          safely(() =>
            buffer.push(
              'fetch',
              formatFeedbackFetchEntry({ method, url, status: null, ms: clock() - started }),
            ),
          );
        }
        throw err;
      }
    };
  }
  return buffer;
}

export function readDiagnostics(win: { [flag: string]: unknown }): FeedbackDiagEntry[] {
  const buffer = win[DIAG_WINDOW_FLAG] as RingBuffer | undefined;
  return buffer ? buffer.entries() : [];
}

/**
 * The build the BROWSER bundle was made from (inlined by Vite when
 * VITE_BUILD_SHA is set at build time; 'unknown' otherwise, and a report never
 * claims a "stale tab" while either side is unknown).
 */
export function clientBuildId(): string {
  const raw = import.meta.env?.VITE_BUILD_SHA;
  return (typeof raw === 'string' && raw.trim()) || 'unknown';
}

/** What the browser puts in the `diagnostics` form field. */
export function clientPayload(entries: FeedbackDiagEntry[], build: string): string {
  return JSON.stringify({ build, entries });
}
