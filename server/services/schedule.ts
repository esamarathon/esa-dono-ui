import { httpError } from '../lib/httpError.js';

/**
 * "Live / Up next" schedule for the donor-site strip (#148). The server is the
 * only Horaro consumer: it fetches `https://horaro.org/esa/{slug}.json`
 * (public, no auth), caches the timetable (~60 s TTL) and computes the current
 * and next slot from `scheduled_t`/`length_t`. The Horaro organisation is
 * fixed to `esa`; a Channel stores only the schedule slug (D5).
 *
 * D8: on a fetch failure the last good timetable may still be served while it
 * has a current or future slot; once its last slot has passed, the computed
 * result is empty and the strip hides (D6). Cache age and Horaro's `updated`
 * timestamp are never shown.
 */

/** One organisation: a source move stays a code change (derived item 3). */
const HORARO_ORG = 'esa';
const HORARO_BASE_URL = `https://horaro.org/${HORARO_ORG}`;
const FETCH_TIMEOUT_MS = 5000;

/** Server-side timetable cache TTL; the client polls on a matching cadence. */
export const SCHEDULE_CACHE_TTL_MS = 60_000;

export interface ScheduleSlot {
  game: string;
  players: string;
}

export interface ScheduleResult {
  live: ScheduleSlot | null;
  next: ScheduleSlot | null;
}

interface HoraroItem {
  scheduled_t: number;
  length_t: number;
  data: unknown[];
}

interface Timetable {
  columns: string[];
  items: HoraroItem[];
}

interface CachedTimetable extends Timetable {
  fetchedAt: number;
}

const cache = new Map<string, CachedTimetable>();

/** Test hook: drop the in-memory timetable cache. */
export function clearScheduleCache(): void {
  cache.clear();
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
  item: HoraroItem | null | undefined,
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

/** Parse the Horaro `/{org}/{slug}.json` payload; null when unusable. */
export function parseHoraroPayload(payload: unknown): Timetable | null {
  const schedule = (payload as { schedule?: { columns?: unknown; items?: unknown } })?.schedule;
  if (!schedule || !Array.isArray(schedule.items)) return null;
  const columns = Array.isArray(schedule.columns) ? schedule.columns.map(String) : [];
  const items = schedule.items.map((raw) => {
    const item = raw as { scheduled_t?: unknown; length_t?: unknown; data?: unknown };
    return {
      scheduled_t: typeof item.scheduled_t === 'number' ? item.scheduled_t : 0,
      length_t: typeof item.length_t === 'number' ? item.length_t : 0,
      data: Array.isArray(item.data) ? item.data : [],
    };
  });
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

/**
 * Fetch and parse the timetable; keep the previous good copy on failure (D8).
 * An empty timetable is a good copy: the schedule is genuinely empty (D6).
 */
async function loadTimetable(slug: string): Promise<Timetable | null> {
  const cached = cache.get(slug);
  const nowMs = Date.now();
  if (cached && nowMs - cached.fetchedAt < SCHEDULE_CACHE_TTL_MS) {
    return cached;
  }
  try {
    const response = await fetch(`${HORARO_BASE_URL}/${encodeURIComponent(slug)}.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return cached ?? null;
    const timetable = parseHoraroPayload(await response.json());
    if (timetable === null) return cached ?? null;
    cache.set(slug, { fetchedAt: nowMs, ...timetable });
    return timetable;
  } catch {
    return cached ?? null;
  }
}

/**
 * The computed live/next slots for one Horaro schedule slug. Returns nulls for
 * an unknown or empty schedule, an unconfigured slug, or a fetch failure
 * without a usable cached timetable (D6/D8).
 */
export async function scheduleForSlug(
  horaroSlug: string | null | undefined,
  nowSeconds = Date.now() / 1000,
): Promise<ScheduleResult> {
  const empty: ScheduleResult = { live: null, next: null };
  if (!horaroSlug) return empty;
  const timetable = await loadTimetable(horaroSlug);
  if (!timetable || timetable.items.length === 0) return empty;
  return computeSchedule(timetable, nowSeconds);
}

/**
 * Admin input guard for the Channel field (the slug becomes a URL path
 * segment). Returns undefined when not provided, null when cleared (empty
 * string or null), else the trimmed slug.
 */
export function optionalHoraroSlug(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'horaro_schedule_slug must be a string');
  const slug = value.trim();
  if (slug === '') return null;
  if (slug.length > 100 || !/^[A-Za-z0-9._-]+$/.test(slug)) {
    throw httpError(
      400,
      'horaro_schedule_slug must be a Horaro schedule name like "2026-winter1" (letters, digits, dot, dash, underscore)',
    );
  }
  return slug;
}
