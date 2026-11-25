import { httpError } from '../lib/httpError.js';

/**
 * "Live / Up next" schedule for the donor-site strip (#148; source amended by
 * #286). The server is the only schedule consumer: it fetches Crew Corner's
 * PUBLISHED schedule API — `GET {SCHEDULE_SOURCE_BASE_URL}/api/v1/events/{eventSlug}/schedule?source=published&format=horaro`
 * (anonymous, CORS-open, PII-free; `&stream=<id>` for one stream's board) —
 * caches the timetable (~60 s TTL) and computes the current and next slot.
 * `source=live` (the unpublished board) is never read donor-side: an unknown
 * or unpublished event 404s, which lands in the unclear-state path and hides
 * the strip (D6 of #148) — Crew Corner's publication gate holds by
 * construction. Horaro is Crew Corner's downstream mirror and is never read
 * here again (#286 D1). The donation-acknowledgement part of the strip's read
 * (#250) is not served from this cache — see `recentDonationsForEvent` in
 * `routes/schedule.ts`.
 *
 * Wire adaptation (#286 D5): the published `format=horaro` payload is the
 * Horaro IMPORT shape — `schedule.columns` + `items[{length_t, data}]` — with
 * the setup gap in each row's `[[options]]` cell (`{"setup":"15m"}`, the gap
 * the row consumes AFTER itself — the producer's one-row shift). Slot starts
 * derive with Horaro's recompute rule (start_{i+1} = start_i + length_t_i +
 * setup_i) so the derivation reproduces the published start times exactly;
 * `scheduled_t` and `schedule.start`/`start_t` are honoured when present. The
 * current export carries no time anchor at all (no `scheduled_t`, no
 * `schedule.start`), so the service reads the base start — the chosen stream's
 * first published run start — from the same published surface's `format=json`
 * shape (`runs[0].startsAt`) and skips that companion read whenever the
 * payload self-anchors.
 *
 * D8: on a fetch failure the last good timetable may still be served while it
 * has a current or future slot; once its last slot has passed, the computed
 * result is empty and the strip hides (D6). A 404 is not a failure but the
 * publication gate's answer: it drops the cached timetable and hides the
 * strip. Cache age and the upstream `updated` timestamp are never shown.
 */

/** Default Crew Corner instance (#286 D2); staging may point elsewhere. */
const DEFAULT_SOURCE_BASE_URL = 'https://crewcorner.esamarathon.com';
const FETCH_TIMEOUT_MS = 5000;

/** Server-side timetable cache TTL. The client polls faster than this (~15 s,
 *  #250 D8) because the donation acknowledgements ride the same read and need
 *  fresher data; the timetable itself is refetched at most once per TTL. */
export const SCHEDULE_CACHE_TTL_MS = 60_000;

export interface ScheduleSlot {
  game: string;
  players: string;
}

export interface ScheduleResult {
  live: ScheduleSlot | null;
  next: ScheduleSlot | null;
}

interface TimetableItem {
  /** Planned slot start, unix seconds (given by `scheduled_t`, else derived). */
  scheduled_t: number;
  length_t: number;
  data: unknown[];
}

interface Timetable {
  columns: string[];
  items: TimetableItem[];
}

interface CachedTimetable extends Timetable {
  fetchedAt: number;
}

const cache = new Map<string, CachedTimetable>();

/** Test hook: drop the in-memory timetable cache. */
export function clearScheduleCache(): void {
  cache.clear();
}

/** The configured published-schedule base URL (#286 D2). */
function scheduleSourceBaseUrl(): string {
  return process.env.SCHEDULE_SOURCE_BASE_URL?.trim() || DEFAULT_SOURCE_BASE_URL;
}

/**
 * One published-schedule API URL: `source=published` always, `format=horaro`
 * for the timetable or `format=json` for the anchor read, `&stream=<id>` only
 * when the Channel maps to one stream (#286 D3). Anonymous — no auth headers.
 */
function scheduleUrl(
  eventSlug: string,
  streamId: number | null,
  format: 'horaro' | 'json',
): string {
  const params = new URLSearchParams({ source: 'published', format });
  if (streamId !== null) params.set('stream', String(streamId));
  return `${scheduleSourceBaseUrl()}/api/v1/events/${encodeURIComponent(eventSlug)}/schedule?${params}`;
}

type FetchOutcome =
  | { kind: 'ok'; json: unknown }
  /** The publication gate's answer (#286 D1): unknown event, unpublished
   *  event or unknown stream. Never stale-serve past it. */
  | { kind: 'not-found' }
  /** Transport failure or any other status: the D8 stale rule applies. */
  | { kind: 'failed' };

async function fetchPublished(url: string): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 404) return { kind: 'not-found' };
    if (!response.ok) return { kind: 'failed' };
    return { kind: 'ok', json: await response.json() };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Column mapping rule: by column NAME when the timetable declares columns
 * ("Game", "Player(s)", case-insensitive); else by index (0 = game,
 * 1 = players).
 */
function columnIndex(columns: string[], name: string, fallback: number): number {
  const wanted = name.toLowerCase();
  const index = columns.findIndex((column) => column.trim().toLowerCase() === wanted);
  return index >= 0 ? index : fallback;
}

function toSlot(
  item: TimetableItem | null | undefined,
  gameIndex: number,
  playersIndex: number,
): ScheduleSlot | null {
  if (!item) return null;
  const game = item.data[gameIndex];
  const players = item.data[playersIndex];
  return {
    game: typeof game === 'string' ? game.trim() : '',
    players: typeof players === 'string' ? players.trim() : '',
  };
}

/** Horaro's `ReadableTime` duration ("15m", "1h2m30s"): `<number><unit>`
 *  components; seconds when at least one component parses, else null. */
function readableTimeSeconds(value: string): number | null {
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+)\s*(hr|h|min|m|sec|s)/gi)) {
    matched = true;
    const unit = match[2]!.toLowerCase();
    total += Number(match[1]) * (unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1);
  }
  return matched ? total : null;
}

/**
 * The setup gap a row consumes AFTER itself, from its `[[options]]` cell
 * (e.g. `{"setup":"15m"}` — the producer emits it on every row, shifted one
 * row forward). A missing or unparseable cell reads as 0: the payload carries
 * no schedule-level default, and a guessed default would inject phantom gaps
 * and mis-time every later slot.
 */
function setupGapAfter(data: unknown[], columns: string[]): number {
  const index = columns.findIndex((column) => column.trim().toLowerCase() === '[[options]]');
  if (index < 0) return 0;
  const cell = data[index];
  if (typeof cell !== 'string' || cell.trim() === '') return 0;
  let parsed: { setup?: unknown };
  try {
    parsed = JSON.parse(cell) as { setup?: unknown };
  } catch {
    return 0;
  }
  if (typeof parsed.setup !== 'string') return 0;
  return readableTimeSeconds(parsed.setup) ?? 0;
}

/** The base start of `schedule.start`/`start_t` when the payload carries one
 *  (the Horaro read-API shape); undefined for the current Crew Corner export. */
function payloadStartSeconds(schedule: { start?: unknown; start_t?: unknown }): number | undefined {
  const startT = schedule.start_t;
  if (typeof startT === 'number' && Number.isFinite(startT)) return startT;
  const start = schedule.start;
  if (typeof start === 'string') {
    const parsed = Date.parse(start);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return undefined;
}

/**
 * Parse a Crew Corner `?source=published&format=horaro` payload (also the
 * Horaro read-API shape) into a timetable whose `scheduled_t` values are the
 * derived slot starts; null when the payload is unusable or lacks a time
 * anchor for some row. Slot starts follow Horaro's recompute rule (#286 D5):
 * `scheduled_t` wins per row when present, else the cursor advances from the
 * schedule start by `length_t` plus the row's consumed setup gap
 * (`[[options]].setup`, applied AFTER the row). `baseStartSeconds` supplies
 * the schedule start when the payload carries none.
 */
export function parseHoraroPayload(payload: unknown, baseStartSeconds?: number): Timetable | null {
  const schedule = (
    payload as {
      schedule?: {
        columns?: unknown;
        items?: unknown;
        start?: unknown;
        start_t?: unknown;
      };
    }
  )?.schedule;
  if (!schedule || !Array.isArray(schedule.items)) return null;
  const columns = Array.isArray(schedule.columns) ? schedule.columns.map(String) : [];
  const rows = schedule.items.map((raw) => {
    const item = raw as { scheduled_t?: unknown; length_t?: unknown; data?: unknown };
    return {
      scheduled_t:
        typeof item.scheduled_t === 'number' && Number.isFinite(item.scheduled_t)
          ? item.scheduled_t
          : null,
      length_t:
        typeof item.length_t === 'number' && Number.isFinite(item.length_t) && item.length_t >= 0
          ? item.length_t
          : 0,
      data: Array.isArray(item.data) ? item.data : [],
    };
  });
  const base = payloadStartSeconds(schedule) ?? baseStartSeconds;
  let cursor = base;
  const items: TimetableItem[] = [];
  for (const row of rows) {
    const start = row.scheduled_t ?? cursor;
    if (typeof start !== 'number') return null;
    items.push({ scheduled_t: start, length_t: row.length_t, data: row.data });
    cursor = start + row.length_t + setupGapAfter(row.data, columns);
  }
  return { columns, items };
}

/**
 * "Live" = the item whose planned slot contains now
 * (`scheduled_t <= now < scheduled_t + length_t`); "Up next" = the first item
 * starting after now. Planned-time drift is accepted (D4). An empty result
 * means the strip renders nothing (D6).
 */
export function computeSchedule(timetable: Timetable, nowSeconds: number): ScheduleResult {
  const sorted = [...timetable.items].sort((a, b) => a.scheduled_t - b.scheduled_t);
  const liveItem =
    sorted.find(
      (item) => item.scheduled_t <= nowSeconds && nowSeconds < item.scheduled_t + item.length_t,
    ) ?? null;
  const nextItem = sorted.find((item) => item.scheduled_t > nowSeconds) ?? null;
  const gameIndex = columnIndex(timetable.columns, 'Game', 0);
  const playersIndex = columnIndex(timetable.columns, 'Player(s)', 1);
  return {
    live: toSlot(liveItem, gameIndex, playersIndex),
    next: toSlot(nextItem, gameIndex, playersIndex),
  };
}

/** Whether the payload has rows that may need the external anchor read. */
function hasScheduleRows(payload: unknown): boolean {
  const items = (payload as { schedule?: { items?: unknown } })?.schedule?.items;
  return Array.isArray(items) && items.length > 0;
}

/**
 * The base start for the recompute: the chosen stream's first published run
 * start from the same anonymous published surface in `format=json`
 * (`runs[0].startsAt`; the runs are ordered by start). Only read when the
 * horaro payload carries no anchor of its own.
 */
async function fetchScheduleStart(
  eventSlug: string,
  streamId: number | null,
): Promise<{ kind: 'ok'; seconds: number } | { kind: 'not-found' } | { kind: 'failed' }> {
  const outcome = await fetchPublished(scheduleUrl(eventSlug, streamId, 'json'));
  if (outcome.kind !== 'ok') return outcome;
  const runs = (outcome.json as { runs?: unknown })?.runs;
  const first = Array.isArray(runs) ? (runs[0] as { startsAt?: unknown } | undefined) : undefined;
  const parsed = typeof first?.startsAt === 'string' ? Date.parse(first.startsAt) : NaN;
  if (!Number.isFinite(parsed)) return { kind: 'failed' };
  return { kind: 'ok', seconds: parsed / 1000 };
}

/**
 * Fetch and parse the timetable; keep the previous good copy on failure (D8).
 * A 404 drops it instead: the event is unknown or unpublished (#286 D1). An
 * empty timetable is a good copy: the schedule is genuinely empty (D6).
 */
async function loadTimetable(
  eventSlug: string,
  streamId: number | null,
): Promise<Timetable | null> {
  const key = `${eventSlug}#${streamId ?? ''}`;
  const cached = cache.get(key);
  const nowMs = Date.now();
  if (cached && nowMs - cached.fetchedAt < SCHEDULE_CACHE_TTL_MS) {
    return cached;
  }
  const outcome = await fetchPublished(scheduleUrl(eventSlug, streamId, 'horaro'));
  if (outcome.kind === 'not-found') {
    cache.delete(key);
    return null;
  }
  if (outcome.kind === 'failed') return cached ?? null;
  let timetable = parseHoraroPayload(outcome.json);
  if (timetable === null && hasScheduleRows(outcome.json)) {
    const anchor = await fetchScheduleStart(eventSlug, streamId);
    if (anchor.kind === 'not-found') {
      cache.delete(key);
      return null;
    }
    if (anchor.kind === 'failed') return cached ?? null;
    timetable = parseHoraroPayload(outcome.json, anchor.seconds);
  }
  if (timetable === null) return cached ?? null;
  cache.set(key, { fetchedAt: nowMs, ...timetable });
  return timetable;
}

/**
 * The computed live/next slots for one Channel's schedule (Crew Corner event
 * slug plus optional stream id, #286 D3). Returns nulls for an unknown or
 * empty schedule, an unconfigured slug, or a fetch failure without a usable
 * cached timetable (D6/D8).
 */
export async function scheduleForSlug(
  scheduleSlug: string | null | undefined,
  scheduleStreamId: number | null | undefined = null,
  nowSeconds = Date.now() / 1000,
): Promise<ScheduleResult> {
  const empty: ScheduleResult = { live: null, next: null };
  if (!scheduleSlug) return empty;
  const timetable = await loadTimetable(scheduleSlug, scheduleStreamId ?? null);
  if (!timetable || timetable.items.length === 0) return empty;
  return computeSchedule(timetable, nowSeconds);
}

/**
 * Admin input guard for the Channel's Crew Corner event slug (it becomes a URL
 * path segment). Returns undefined when not provided, null when cleared (empty
 * string or null), else the trimmed slug.
 */
export function optionalScheduleSlug(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'schedule_slug must be a string');
  const slug = value.trim();
  if (slug === '') return null;
  if (slug.length > 100 || !/^[A-Za-z0-9._-]+$/.test(slug)) {
    throw httpError(
      400,
      'schedule_slug must be a Crew Corner event slug like "esa2026" (letters, digits, dot, dash, underscore)',
    );
  }
  return slug;
}

/**
 * Admin input guard for the Channel's Crew Corner stream id (#286 D3): a
 * positive 32-bit integer (the crew Stream id of the published source), from a
 * number or a digit string (the admin form sends strings). Returns undefined
 * when not provided, null when cleared (empty string or null), else the id.
 */
export function optionalScheduleStreamId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 2147483647) {
    throw httpError(400, 'schedule_stream_id must be a positive integer Crew Corner stream id');
  }
  return candidate;
}
