/**
 * Feedback queue vocabulary (ported from the esa-crew-corner feedback bubble,
 * docs/FEEDBACK.md there): one click, one sentence, evidence travels with the
 * words, nothing is silently swallowed. Pure module — safe to import from the
 * donor widget, the server and tests alike. Nothing here touches the DOM.
 *
 * Statuses are UPPER_SNAKE like every other dono status; the human reference
 * is `FB-<short id>` (the first segment of the row's uuid).
 */

export const FEEDBACK_STATUSES = ['NEW', 'SEEN', 'DONE', 'DECLINED'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** "Open" on the queue page = not yet answered. */
export const FEEDBACK_OPEN_STATUSES: readonly FeedbackStatus[] = ['NEW', 'SEEN'];

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

export function isOpenFeedbackStatus(status: string): boolean {
  return (FEEDBACK_OPEN_STATUSES as readonly string[]).includes(status);
}

export const FEEDBACK_MESSAGE_MAX_CHARS = 5000;
export const FEEDBACK_RESOLUTION_MAX_CHARS = 5000;
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;
/** Body cap the POST endpoint enforces before parsing multipart (413 above it). */
export const FEEDBACK_MAX_BODY_BYTES =
  FEEDBACK_SCREENSHOT_MAX_BYTES + FEEDBACK_SNAPSHOT_MAX_BYTES + 64 * 1024;
/** Painted screenshot height cap (full page, but never absurd). */
export const FEEDBACK_SCREENSHOT_MAX_HEIGHT_PX = 4000;

/** The first uuid segment: short enough for a human, long enough to be unique. */
export function feedbackShortId(id: string): string {
  const short = id.split('-')[0] ?? id;
  return short.length > 8 ? short.slice(0, 8) : short;
}

/** What a human calls a report. */
export function feedbackRef(id: string): string {
  return `FB-${feedbackShortId(id)}`;
}

export function firstChars(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

export type FeedbackQueueFilter = 'open' | 'done' | 'all';

export function queueFilterFrom(raw: string | undefined | null): FeedbackQueueFilter {
  return raw === 'done' || raw === 'all' ? raw : 'open';
}

/** `YYYY/MM/<timestamp>-<sender id>.<ext>`, relative to FEEDBACK_DIR. */
export function feedbackStoragePath(
  kind: 'png' | 'jpg' | 'html',
  at: Date,
  senderId: string | null,
): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${yyyy}/${mm}/${stamp}-${senderId ?? 'anon'}.${kind}`;
}

export function feedbackViewportString(width: number, height: number): string {
  return `${Math.round(width)}x${Math.round(height)}`;
}

/** Reopening clears the resolution stamp; answering sets it. */
export function feedbackResolutionStamp(
  status: FeedbackStatus,
  resolverId: string,
  now: Date,
): { resolved_by: string | null; resolved_at: Date | null } {
  return isOpenFeedbackStatus(status)
    ? { resolved_by: null, resolved_at: null }
    : { resolved_by: resolverId, resolved_at: now };
}

// ---------------------------------------------------------------------------
// Diagnostics
//
// Every report carries a bounded record of what the page had just been doing,
// so "it says error" arrives with the error. Captured in the browser by
// client/src/lib/feedback/diagnostics.ts (ring buffer), re-validated and
// context-stamped by the server, capped in size here.

export const FEEDBACK_DIAG_MAX_ENTRIES = 20;
export const FEEDBACK_DIAG_ENTRY_MAX_CHARS = 500;
/** Whole stored JSON, bytes. */
export const FEEDBACK_DIAG_MAX_BYTES = 16 * 1024;
/** Raw form field the server will even try to parse. */
export const FEEDBACK_DIAG_FIELD_MAX_CHARS = 64 * 1024;

export const FEEDBACK_DIAG_KINDS = [
  'error',
  'unhandledrejection',
  'console.error',
  'fetch',
] as const;
export type FeedbackDiagKind = (typeof FEEDBACK_DIAG_KINDS)[number];

export interface FeedbackDiagEntry {
  /** ISO timestamp. */
  at: string;
  kind: FeedbackDiagKind;
  /** Already redacted and truncated. */
  message: string;
}

export interface FeedbackDiagContext {
  /** Build of the server that took the report; 'unknown' when not stamped. */
  build_id: string;
  /** Build the browser bundle was made from (differs on a stale tab). */
  client_build_id: string;
  instance: string | null;
  viewport: string;
  userAgent: string;
  /** Effective role of the signed-in sender, null when anonymous. */
  sender_role: string | null;
}

export interface FeedbackDiagnostics {
  v: 1;
  captured_at: string;
  error_count: number;
  context: FeedbackDiagContext;
  entries: FeedbackDiagEntry[];
}

/** Query parameter names whose values are never recorded (case-insensitive). */
const SECRET_PARAM = /^(token|code|state|secret|password|key)$/i;
const REDACTED = '[redacted]';

/** Same names inside free text: `token=abc`, `?code=xyz&x=1`. */
const SECRET_IN_TEXT =
  /\b(token|code|state|secret|password|key)=(?!\[redacted\])([^&\s"'<>)\]]+)/gi;

export function truncateFeedbackDiag(text: string, max = FEEDBACK_DIAG_ENTRY_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Scrub `name=value` pairs of secret-looking parameters out of free text. */
export function scrubFeedbackSecrets(text: string): string {
  return text.replace(SECRET_IN_TEXT, (_m, name: string) => `${name}=${REDACTED}`);
}

/**
 * What goes into a fetch entry for `raw`: same-origin → path + query with
 * secret parameter values redacted (the fragment is dropped); cross-origin →
 * the origin only (paths of third parties can carry tokens too).
 */
export function describeFeedbackUrl(raw: string, pageHref: string): string {
  let url: URL;
  try {
    url = new URL(raw, pageHref);
  } catch {
    return '(unparseable url)';
  }
  let page: URL;
  try {
    page = new URL(pageHref);
  } catch {
    return url.origin;
  }
  if (url.origin !== page.origin) return url.origin;
  const params = new URLSearchParams(url.search);
  let any = false;
  const rebuilt = new URLSearchParams();
  for (const [k, v] of params) {
    if (SECRET_PARAM.test(k)) {
      rebuilt.append(k, REDACTED);
      any = true;
    } else {
      rebuilt.append(k, v);
    }
  }
  if (!any) return `${url.pathname}${url.search}`;
  // URLSearchParams would percent-encode the brackets; keep the marker readable.
  const query = rebuilt.toString().replace(/%5Bredacted%5D/gi, REDACTED);
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

export function formatFeedbackFetchEntry(parts: {
  method: string;
  url: string;
  status: number | null;
  ms: number;
}): string {
  const outcome = parts.status === null ? 'network error' : String(parts.status);
  return `${parts.method.toUpperCase()} ${parts.url} -> ${outcome} (${Math.max(0, Math.round(parts.ms))}ms)`;
}

function cleanKind(v: unknown): FeedbackDiagKind | null {
  return typeof v === 'string' && (FEEDBACK_DIAG_KINDS as readonly string[]).includes(v)
    ? (v as FeedbackDiagKind)
    : null;
}

function cleanAt(v: unknown): string {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date(0).toISOString();
}

export interface FeedbackClientDiagnostics {
  build: string;
  entries: FeedbackDiagEntry[];
}

/**
 * Validate the browser's `diagnostics` field (it is sender-controlled).
 * Anything malformed is dropped (null), never an error: a broken diagnostics
 * block must not cost anyone their report.
 */
export function sanitizeFeedbackClientDiagnostics(raw: unknown): FeedbackClientDiagnostics | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > FEEDBACK_DIAG_FIELD_MAX_CHARS) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { build?: unknown; entries?: unknown };
  const entries: FeedbackDiagEntry[] = [];
  if (Array.isArray(obj.entries)) {
    for (const item of obj.entries.slice(-FEEDBACK_DIAG_MAX_ENTRIES)) {
      if (!item || typeof item !== 'object') continue;
      const e = item as { at?: unknown; kind?: unknown; message?: unknown };
      const kind = cleanKind(e.kind);
      if (!kind || typeof e.message !== 'string') continue;
      entries.push({
        at: cleanAt(e.at),
        kind,
        message: truncateFeedbackDiag(scrubFeedbackSecrets(e.message)),
      });
    }
  }
  const build = typeof obj.build === 'string' ? obj.build.replace(/[^\w.-]/g, '').slice(0, 40) : '';
  return { build: build || 'unknown', entries };
}

export function buildFeedbackDiagnostics(input: {
  client: FeedbackClientDiagnostics | null;
  context: FeedbackDiagContext;
  capturedAt?: Date;
}): FeedbackDiagnostics {
  const entries = input.client?.entries ?? [];
  return {
    v: 1,
    captured_at: (input.capturedAt ?? new Date()).toISOString(),
    error_count: entries.length,
    context: {
      ...input.context,
      client_build_id: input.client?.build ?? 'unknown',
    },
    entries,
  };
}

/** JSON for the column; drops the OLDEST entries until it fits the byte cap. */
export function serializeFeedbackDiagnostics(record: FeedbackDiagnostics): string {
  const rec: FeedbackDiagnostics = {
    ...record,
    entries: record.entries.slice(-FEEDBACK_DIAG_MAX_ENTRIES),
  };
  let json = JSON.stringify(rec);
  while (
    new TextEncoder().encode(json).length > FEEDBACK_DIAG_MAX_BYTES &&
    rec.entries.length > 0
  ) {
    rec.entries = rec.entries.slice(1);
    json = JSON.stringify(rec);
  }
  return json;
}

/** Read a stored column back; null for anything that is not a v1 record. */
export function parseFeedbackDiagnostics(
  json: string | null | undefined,
): FeedbackDiagnostics | null {
  if (!json) return null;
  try {
    const rec = JSON.parse(json) as FeedbackDiagnostics;
    if (!rec || rec.v !== 1 || !rec.context || !Array.isArray(rec.entries)) return null;
    return rec;
  } catch {
    return null;
  }
}

/** "Stale tab" only when both builds are known and differ. */
export function isStaleFeedbackBuild(
  c: Pick<FeedbackDiagContext, 'build_id' | 'client_build_id'>,
): boolean {
  return (
    c.build_id !== 'unknown' && c.client_build_id !== 'unknown' && c.build_id !== c.client_build_id
  );
}

// ---------------------------------------------------------------------------
// The metadata blob the widget sends with a report (multipart `metadata`).
// The server re-validates every field it forwards; keys resembling
// email/token are stripped before anything leaves the server.

export interface FeedbackMetadata {
  url?: string | null;
  donor_id?: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  viewport?: string | null;
  cart_summary?: string | null;
}
