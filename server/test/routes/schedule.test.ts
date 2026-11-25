import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    channel: { findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    donation: { findMany: vi.fn() },
    featureFlag: { findMany: vi.fn() },
  },
}));

import prisma from '../../lib/prisma.js';
import scheduleRouter from '../../routes/schedule.js';
import { invalidateFlagCache } from '../../services/featureFlags.js';
import {
  clearScheduleCache,
  parseHoraroPayload,
  SCHEDULE_CACHE_TTL_MS,
} from '../../services/schedule.js';

function createApp() {
  const app = express();
  app.use('/api/schedule', scheduleRouter);
  return app;
}

/** Fixed clock: 2027-01-14T22:40:00Z in seconds / ms. */
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

/** The default published-schedule base (#286 D2). */
const BASE = 'https://crewcorner.esamarathon.com';

function scheduleUrl(format: 'horaro' | 'json', slug: string, streamId: number | null = null) {
  const params = new URLSearchParams({ source: 'published', format });
  if (streamId !== null) params.set('stream', String(streamId));
  return `${BASE}/api/v1/events/${slug}/schedule?${params}`;
}

/** The producer's `[[options]]` setup format (esa-crew-corner
 *  `lib/vote/horaro.ts` `horaroSetup`): abbreviated unit form, seconds
 *  precise, e.g. "0m", "10m", "1h2m30s". */
function horaroSetup(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return '0m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${sec ? `${sec}s` : ''}`;
}

interface FixtureRun {
  game: string;
  players: string;
  /** Published start (the producer's Run.startsAt), unix seconds. */
  start: number;
  /** Published length (endsAt - startsAt), seconds. */
  length: number;
  platform?: string;
  category?: string;
}

/**
 * Crew Corner `?source=published&format=horaro` fixture, built exactly the way
 * the producer builds it (esa-crew-corner `loadPublishedStreamHoraroItems` +
 * `buildHoraroJson`/`emittedWithOpts`, verified against the producer source):
 * one item per published Run row with `length_t` = the row's duration, and the
 * `[[options]]` cell carrying the NEXT row's consumed setup gap (the
 * producer's one-row shift — Horaro applies a row's setup AFTER it; the last
 * row emits `{"setup":"0m"}`). The payload carries NO `scheduled_t` and NO
 * schedule start: the export is the Horaro import shape, and absolute times
 * live only in the `format=json` read (`runs[].startsAt`).
 */
function publishedHoraroPayload(runs: FixtureRun[]) {
  const columns = [
    'Game',
    'Player(s)',
    'Platform',
    'Category',
    'Note',
    '[[options]]',
    'hidden:Layout',
    'hidden:UserIDs',
    'hidden:ID',
  ];
  return {
    schedule: {
      columns,
      items: runs.map((run, i) => {
        const gapAfter =
          i + 1 < runs.length ? Math.max(0, runs[i + 1]!.start - (run.start + run.length)) : 0;
        return {
          length_t: Math.min(604800, Math.max(1, Math.round(run.length))),
          data: [
            run.game,
            run.players,
            run.platform ?? '',
            run.category ?? '',
            '',
            `{"setup":"${horaroSetup(gapAfter)}"}`,
            '',
            '',
            `run-${i + 1}`,
          ],
        };
      }),
    },
  };
}

/** The anchor companion read (`?source=published&format=json`): the public VM
 *  (`loadCrewRuns`) carries the published `startsAt` per row. */
function publishedJsonPayload(runs: FixtureRun[]) {
  return {
    slug: 'esa2026',
    name: 'ESA 2026',
    source: 'published',
    published: true,
    streams: [{ id: 1, name: 'Main' }],
    currentStreamId: 1,
    runs: runs.map((run, i) => ({
      id: i + 1,
      startsAt: new Date(run.start * 1000).toISOString(),
      endsAt: new Date((run.start + run.length) * 1000).toISOString(),
      title: run.category ? `${run.game} — ${run.category}` : run.game,
      runnerNames: run.players ? run.players.split(', ') : [],
    })),
  };
}

/**
 * A schedule payload with full control over items and columns — the Horaro
 * read-API shape when items carry `scheduled_t` or the payload carries
 * `schedule.start` (#286 D5: "use `scheduled_t` when present").
 */
function horaroPayload(
  items: Array<{ length_t: number; data: string[]; scheduled_t?: number }>,
  columns: string[] | null = ['Game', 'Player(s)', 'Platform', 'Category', 'Note'],
  scheduleExtras: Record<string, unknown> = {},
) {
  return {
    schedule: {
      slug: 'esa2026',
      ...(columns ? { columns } : {}),
      items,
      ...scheduleExtras,
    },
  };
}

const fixtureRuns: FixtureRun[] = [
  { game: 'Celeste', players: 'TGH', start: NOW_S - 600, length: 1800 },
  { game: 'Super Metroid', players: 'Zoast', start: NOW_S + 1200, length: 1800 },
  { game: 'Hollow Knight', players: 'fireb0rn', start: NOW_S + 3600, length: 1800 },
];

interface FetchStub {
  horaro?: unknown;
  anchor?: unknown;
  /** HTTP status of the timetable read (default 200). */
  horaroStatus?: number;
  /** HTTP status of the anchor read (default 200). */
  anchorStatus?: number;
  /** Transport-level failure for every read. */
  reject?: boolean;
}

/**
 * Stub the anonymous published reads: `format=horaro` serves `horaro`,
 * `format=json` serves the anchor. Requests carry no auth headers.
 */
function mockFetch(stub: FetchStub) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (stub.reject) return Promise.reject(new Error('schedule source down'));
    const isTimetable = String(url).includes('format=horaro');
    const status = (isTimetable ? stub.horaroStatus : stub.anchorStatus) ?? 200;
    const body = isTimetable ? stub.horaro : (stub.anchor ?? { runs: [] });
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Stub both published reads for `runs`: the timetable and its json anchor. */
function mockSchedule(runs: FixtureRun[]) {
  return mockFetch({ horaro: publishedHoraroPayload(runs), anchor: publishedJsonPayload(runs) });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, format: 'horaro' | 'json') {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(`format=${format}`));
}

function channelWithSlug(
  scheduleSlug: string | null,
  eventId: string | null = 'event-1',
  scheduleStreamId: number | null = null,
) {
  vi.mocked(prisma.channel.findUnique).mockResolvedValue({
    schedule_slug: scheduleSlug,
    schedule_stream_id: scheduleStreamId,
    event_id: eventId,
  } as never);
}

describe('GET /api/schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearScheduleCache();
    invalidateFlagCache();
    // Flag row absent reads as disabled (D11); no donations by default.
    vi.mocked(prisma.featureFlag.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.donation.findMany).mockResolvedValue([] as never);
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('computes live and next from the Crew Corner published timetable (#286)', async () => {
    channelWithSlug('esa2026');
    const fetchMock = mockSchedule(fixtureRuns);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      live: { game: 'Celeste', players: 'TGH' },
      next: { game: 'Super Metroid', players: 'Zoast' },
    });
    // Base URL + event slug + source=published&format=horaro, and nothing
    // else: the published source is anonymous (no auth headers, D1/D2).
    expect(fetchMock).toHaveBeenCalledWith(scheduleUrl('horaro', 'esa2026'), {
      signal: expect.anything(),
    });
  });

  it('resolves the channel slug to its configured Crew Corner event', async () => {
    channelWithSlug('esa-winter-2027');
    const fetchMock = mockSchedule(fixtureRuns);

    await request(createApp()).get('/api/schedule?channel=stream-2');

    expect(prisma.channel.findUnique).toHaveBeenCalledWith({
      where: { slug: 'stream-2' },
      select: { schedule_slug: true, schedule_stream_id: true, event_id: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      scheduleUrl('horaro', 'esa-winter-2027'),
      expect.anything(),
    );
  });

  it('appends the stream id when the Channel maps to one stream (D3)', async () => {
    channelWithSlug('esa2026', 'event-1', 4);
    const fetchMock = mockSchedule(fixtureRuns);

    await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(fetchMock).toHaveBeenCalledWith(scheduleUrl('horaro', 'esa2026', 4), expect.anything());
    // The anchor read honours the same stream.
    expect(fetchMock).toHaveBeenCalledWith(scheduleUrl('json', 'esa2026', 4), expect.anything());
  });

  it('builds the base from SCHEDULE_SOURCE_BASE_URL and sends no auth headers', async () => {
    vi.stubEnv('SCHEDULE_SOURCE_BASE_URL', 'https://crewcorner.lidholt.se');
    channelWithSlug('esa2026');
    const fetchMock = mockSchedule(fixtureRuns);

    await request(createApp()).get('/api/schedule?channel=stream-1');

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://crewcorner.lidholt.se/api/v1/events/esa2026/schedule?source=published&format=horaro',
    );
    // Exact equality: a `headers` or `authorization` key would fail here.
    expect(options).toEqual({ signal: expect.anything() });
  });

  it('maps game and players by column NAME when columns are declared', async () => {
    channelWithSlug('esa2026');
    mockFetch({
      horaro: horaroPayload(
        [
          {
            scheduled_t: NOW_S - 60,
            length_t: 600,
            data: ['PC', 'Celeste', 'TGH', 'Any%', ''],
          },
          {
            scheduled_t: NOW_S + 600,
            length_t: 600,
            data: ['SNES', 'Super Metroid', 'Zoast', '100%', ''],
          },
        ],
        ['Platform', 'Game', 'Player(s)', 'Category', 'Note'],
      ),
    });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(res.body.next).toEqual({ game: 'Super Metroid', players: 'Zoast' });
  });

  it('falls back to index 0/1 when the timetable declares no columns', async () => {
    channelWithSlug('esa2026');
    mockFetch({
      horaro: horaroPayload(
        [
          {
            scheduled_t: NOW_S - 60,
            length_t: 600,
            data: ['Celeste', 'TGH'],
          },
          {
            scheduled_t: NOW_S + 600,
            length_t: 600,
            data: ['Super Metroid', 'Zoast'],
          },
        ],
        null,
      ),
    });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(res.body.next).toEqual({ game: 'Super Metroid', players: 'Zoast' });
  });

  it('returns nulls for an unknown channel slug without calling the schedule source', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValue(null as never);
    const fetchMock = mockSchedule(fixtureRuns);

    const res = await request(createApp()).get('/api/schedule?channel=nope');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nulls for a channel without a configured schedule', async () => {
    channelWithSlug(null);
    const fetchMock = mockSchedule(fixtureRuns);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the single active Event's primary Channel when no channel is named", async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      {
        id: 'event-1',
        primary_channel: { schedule_slug: 'esa2026', schedule_stream_id: null },
      },
    ] as never);
    const fetchMock = mockSchedule(fixtureRuns);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.status).toBe(200);
    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { is_active: true },
      select: {
        id: true,
        primary_channel: { select: { schedule_slug: true, schedule_stream_id: true } },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(scheduleUrl('horaro', 'esa2026'), expect.anything());
  });

  it("maps the single active Event's primary Channel to its stream id (D3)", async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      {
        id: 'event-1',
        primary_channel: { schedule_slug: 'esa2026', schedule_stream_id: 2 },
      },
    ] as never);
    const fetchMock = mockSchedule(fixtureRuns);

    await request(createApp()).get('/api/schedule');

    expect(fetchMock).toHaveBeenCalledWith(scheduleUrl('horaro', 'esa2026', 2), expect.anything());
  });

  it('returns nulls with two active Events (D7) without calling the schedule source', async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { primary_channel: { schedule_slug: 'esa2026', schedule_stream_id: null } },
      { primary_channel: { schedule_slug: 'esa2027', schedule_stream_id: null } },
    ] as never);
    const fetchMock = mockSchedule(fixtureRuns);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nulls with no active Event without calling the schedule source', async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([] as never);
    const fetchMock = mockSchedule(fixtureRuns);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nulls when the single active Event has no primary Channel or no slug', async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([{ primary_channel: null }] as never);
    mockSchedule(fixtureRuns);
    expect((await request(createApp()).get('/api/schedule')).body).toEqual({
      live: null,
      next: null,
    });

    clearScheduleCache();
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { primary_channel: { schedule_slug: null, schedule_stream_id: null } },
    ] as never);
    expect((await request(createApp()).get('/api/schedule')).body).toEqual({
      live: null,
      next: null,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns nulls for an empty schedule', async () => {
    channelWithSlug('esa2026');
    const fetchMock = mockFetch({ horaro: horaroPayload([]) });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
    // An empty timetable needs no anchor read.
    expect(callsTo(fetchMock, 'json')).toHaveLength(0);
  });

  it("returns nulls once the last run's slot has passed", async () => {
    channelWithSlug('esa2026');
    mockSchedule([
      { game: 'Celeste', players: 'TGH', start: NOW_S - 7200, length: 3600 },
      { game: 'Super Metroid', players: 'Zoast', start: NOW_S - 3000, length: 1800 },
    ]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
  });

  it('serves the last good timetable on fetch failure while a slot is current (D8)', async () => {
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    const first = await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(first.body.live).toEqual({ game: 'Celeste', players: 'TGH' });

    // Past the cache TTL but still inside the live slot: fetch now fails.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SCHEDULE_CACHE_TTL_MS + 5000);
    mockFetch({ reject: true });

    const second = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      live: { game: 'Celeste', players: 'TGH' },
      next: { game: 'Super Metroid', players: 'Zoast' },
    });
  });

  it('serves the last good timetable when only the anchor read fails (D8)', async () => {
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    await request(createApp()).get('/api/schedule?channel=stream-1');

    // Past the TTL the un-anchored payload needs the anchor again; it fails.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SCHEDULE_CACHE_TTL_MS + 5000);
    mockFetch({
      horaro: publishedHoraroPayload(fixtureRuns),
      anchorStatus: 500,
    });

    const second = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(second.body).toEqual({
      live: { game: 'Celeste', players: 'TGH' },
      next: { game: 'Super Metroid', players: 'Zoast' },
    });
  });

  it('hides on fetch failure once every cached slot has passed (D8/D6)', async () => {
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    await request(createApp()).get('/api/schedule?channel=stream-1');

    // Way past the last slot: the stale cache has nothing current or future.
    vi.spyOn(Date, 'now').mockReturnValue((NOW_S + 7200) * 1000);
    mockFetch({ reject: true });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
  });

  it('returns nulls on a fetch failure with no cached timetable', async () => {
    channelWithSlug('esa2026');
    mockFetch({ reject: true });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: null, next: null });
  });

  it('hides on upstream 404 and never stale-serves past it (#286 D1)', async () => {
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    const first = await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(first.body.live).toEqual({ game: 'Celeste', players: 'TGH' });

    // Past the TTL the event is unpublished again: the publication gate's 404
    // drops the cached timetable instead of serving it stale.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SCHEDULE_CACHE_TTL_MS + 5000);
    mockFetch({ horaro: null, horaroStatus: 404 });

    const second = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(second.body).toEqual({ live: null, next: null });
  });

  it('hides on an unknown stream id (404 upstream, never a fallback — D3)', async () => {
    channelWithSlug('esa2026', 'event-1', 999999);
    const fetchMock = mockFetch({ horaro: null, horaroStatus: 404 });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).toHaveBeenCalledWith(
      scheduleUrl('horaro', 'esa2026', 999999),
      expect.anything(),
    );
  });

  it('honours scheduled_t when present and reads no anchor (#286 D5)', async () => {
    channelWithSlug('esa2026');
    const fetchMock = mockFetch({
      horaro: horaroPayload([
        {
          scheduled_t: NOW_S - 60,
          length_t: 600,
          data: ['Celeste', 'TGH'],
        },
        {
          scheduled_t: NOW_S + 600,
          length_t: 600,
          data: ['Super Metroid', 'Zoast'],
        },
      ]),
    });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(callsTo(fetchMock, 'json')).toHaveLength(0);
  });

  it('anchors at schedule.start when present and reads no anchor (#286 D5)', async () => {
    channelWithSlug('esa2026');
    const fetchMock = mockFetch({
      horaro: horaroPayload(
        [
          { length_t: 600, data: ['Celeste', 'TGH', 'PC', 'Any%', '', '{"setup":"10m"}'] },
          { length_t: 600, data: ['Super Metroid', 'Zoast', 'SNES', '100%', '', '{"setup":"0m"}'] },
        ],
        ['Game', 'Player(s)', 'Platform', 'Category', 'Note', '[[options]]'],
        { start_t: NOW_S - 60 },
      ),
    });

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(res.body.next).toEqual({ game: 'Super Metroid', players: 'Zoast' });
    expect(callsTo(fetchMock, 'json')).toHaveLength(0);
  });

  it('does not refetch within the cache TTL and refetches after it', async () => {
    channelWithSlug('esa2026');
    let fetchMock = mockSchedule(fixtureRuns);

    await request(createApp()).get('/api/schedule?channel=stream-1');
    await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(callsTo(fetchMock, 'horaro')).toHaveLength(1);

    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SCHEDULE_CACHE_TTL_MS);
    fetchMock = mockSchedule(fixtureRuns);
    await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(callsTo(fetchMock, 'horaro')).toHaveLength(1);
  });

  it('returns 500 when the schedule lookup itself fails', async () => {
    vi.mocked(prisma.channel.findUnique).mockRejectedValue(new Error('DB error'));

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch schedule');
  });
});

describe('parseHoraroPayload (#286 wire adaptation)', () => {
  it('derives slot starts from the base start by length_t + consumed setup gaps', () => {
    const runs: FixtureRun[] = [
      { game: 'Celeste', players: 'TGH', start: NOW_S - 600, length: 1800 },
      { game: 'Super Metroid', players: 'Zoast', start: NOW_S + 1200, length: 1800 },
      { game: 'Hollow Knight', players: 'fireb0rn', start: NOW_S + 3600, length: 1800 },
    ];
    const timetable = parseHoraroPayload(publishedHoraroPayload(runs), runs[0]!.start);

    expect(timetable).not.toBeNull();
    // start + Σ(length_t + consumed setup gap) reproduces the published starts.
    expect(timetable!.items.map((item) => item.scheduled_t)).toEqual(runs.map((run) => run.start));
    expect(timetable!.items.map((item) => item.length_t)).toEqual([1800, 1800, 1800]);
  });

  it('derives the same starts when the rows carry no setup gaps at all', () => {
    const runs: FixtureRun[] = [
      { game: 'Celeste', players: 'TGH', start: NOW_S, length: 600 },
      { game: 'Super Metroid', players: 'Zoast', start: NOW_S + 600, length: 600 },
    ];
    const timetable = parseHoraroPayload(publishedHoraroPayload(runs), runs[0]!.start);

    expect(timetable!.items.map((item) => item.scheduled_t)).toEqual(runs.map((run) => run.start));
  });

  it('honours scheduled_t per row when present (D5)', () => {
    const timetable = parseHoraroPayload(
      horaroPayload([
        { scheduled_t: 100, length_t: 60, data: ['Celeste', 'TGH'] },
        { length_t: 60, data: ['Super Metroid', 'Zoast'] },
      ]),
    );

    // Row 2 derives from row 1's end when the base is missing but a preceding
    // row anchors the cursor.
    expect(timetable!.items.map((item) => item.scheduled_t)).toEqual([100, 160]);
  });

  it('reads the schedule start from schedule.start / start_t', () => {
    const items = [
      { length_t: 60, data: ['Celeste', 'TGH', '', '', '', '{"setup":"1m30s"}'] },
      { length_t: 60, data: ['Super Metroid', 'Zoast', '', '', '', '{"setup":"0m"}'] },
    ];
    const columns = ['Game', 'Player(s)', 'Platform', 'Category', 'Note', '[[options]]'];

    const fromTs = parseHoraroPayload(horaroPayload(items, columns, { start_t: 1000 }));
    const fromIso = parseHoraroPayload(
      horaroPayload(items, columns, { start: '1970-01-01T00:16:40Z' }),
    );

    const expected = [1000, 1150]; // 1000 + 60 + the 1m30s gap the row consumed after itself
    expect(fromTs!.items.map((item) => item.scheduled_t)).toEqual(expected);
    expect(fromIso!.items.map((item) => item.scheduled_t)).toEqual(expected);
  });

  it('returns null when no time anchor exists at all', () => {
    expect(parseHoraroPayload(publishedHoraroPayload(fixtureRuns))).toBeNull();
    expect(
      parseHoraroPayload(horaroPayload([{ length_t: 60, data: ['Celeste', 'TGH'] }])),
    ).toBeNull();
  });

  it('returns null for an unusable payload', () => {
    expect(parseHoraroPayload(null)).toBeNull();
    expect(parseHoraroPayload({})).toBeNull();
    expect(parseHoraroPayload({ schedule: { columns: ['Game'] } })).toBeNull();
  });

  it('treats a missing or unparseable [[options]] cell as no gap', () => {
    const columns = ['Game', 'Player(s)', '[[options]]'];
    const timetable = parseHoraroPayload(
      horaroPayload(
        [
          { length_t: 60, data: ['Celeste', 'TGH', 'not json'] },
          { length_t: 60, data: ['Super Metroid', 'Zoast', ''] },
          { length_t: 60, data: ['Hollow Knight', 'fireb0rn'] },
        ],
        columns,
      ),
      1000,
    );

    expect(timetable!.items.map((item) => item.scheduled_t)).toEqual([1000, 1060, 1120]);
  });
});

/**
 * Minimal Prisma `where` interpreter for the donation stub: plain equality,
 * `{ in }` and `{ gte }`. The stub filters REAL rows by the query the route
 * sends, so the eligibility tests fail if the query's meaning changes.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key];
    if (condition instanceof Date) {
      if ((value as Date)?.getTime() !== condition.getTime()) return false;
    } else if (condition !== null && typeof condition === 'object') {
      const c = condition as { in?: unknown[]; gte?: Date };
      if (c.in && !c.in.includes(value)) return false;
      if (c.gte && !((value as Date) >= c.gte)) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

interface StubDonation {
  id: string;
  donor_name: string | null;
  hidden_from_overlay: boolean;
  amount_cents: number;
  status: string;
  event_id: string | null;
  comment: string | null;
  created_at: Date;
}

function donationRow(over: Partial<StubDonation> = {}): StubDonation {
  return {
    id: 'donation-1',
    donor_name: 'Sam',
    hidden_from_overlay: false,
    amount_cents: 2500,
    status: 'COMPLETED',
    event_id: 'event-1',
    comment: null,
    created_at: new Date(NOW_MS - 30_000),
    ...over,
  };
}

function stubDonationRows(rows: StubDonation[]) {
  vi.mocked(prisma.donation.findMany).mockImplementation(((args: {
    where?: Record<string, unknown>;
  }) =>
    Promise.resolve(rows.filter((row) => matchesWhere(row as never, args.where ?? {})))) as never);
}

function ackFlagOn() {
  vi.mocked(prisma.featureFlag.findMany).mockResolvedValue([
    { name: 'donation-acknowledgements', is_enabled: true },
  ] as never);
}

describe('GET /api/schedule donation acknowledgements (#250)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearScheduleCache();
    invalidateFlagCache();
    vi.mocked(prisma.featureFlag.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.donation.findMany).mockResolvedValue([] as never);
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the Event's ack-eligible donations of the last minute when the flag is on (D1/D8)", async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([
      donationRow({ id: 'd-old', created_at: new Date(NOW_MS - 120_000) }),
      donationRow({ id: 'd-pending', status: 'PENDING' }),
      donationRow({ id: 'd-chargeback', status: 'CHARGEBACK' }),
      donationRow({ id: 'd-1', created_at: new Date(NOW_MS - 30_000) }),
      donationRow({
        id: 'd-2',
        donor_name: 'Riley',
        amount_cents: 550,
        status: 'REFUNDED',
        created_at: new Date(NOW_MS - 20_000),
      }),
    ]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(200);
    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(res.body.recent_donations).toEqual([
      {
        id: 'd-1',
        display_name: 'Sam',
        amount_cents: 2500,
        created_at: new Date(NOW_MS - 30_000).toISOString(),
      },
      {
        id: 'd-2',
        display_name: 'Riley',
        amount_cents: 550,
        created_at: new Date(NOW_MS - 20_000).toISOString(),
      },
    ]);
    expect(prisma.donation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          event_id: 'event-1',
          created_at: { gte: new Date(NOW_MS - 60_000) },
          status: { in: ['COMPLETED', 'REFUNDED'] },
        }),
      }),
    );
  });

  it('maps hidden donations to Anonymous and keeps the amount (D2)', async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([
      donationRow({
        id: 'd-hidden',
        donor_name: 'Secret Sam',
        hidden_from_overlay: true,
        amount_cents: 1000,
      }),
    ]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.recent_donations).toEqual([
      {
        id: 'd-hidden',
        display_name: 'Anonymous',
        amount_cents: 1000,
        created_at: new Date(NOW_MS - 30_000).toISOString(),
      },
    ]);
  });

  it('maps a blank display name to Anonymous (D5)', async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([donationRow({ id: 'd-blank', donor_name: '   ', amount_cents: 1050 })]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.recent_donations).toEqual([
      expect.objectContaining({ id: 'd-blank', display_name: 'Anonymous', amount_cents: 1050 }),
    ]);
  });

  it('never carries the donor comment into the payload (D4)', async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([
      donationRow({ id: 'd-1', comment: 'A very long donor comment that must never show' }),
    ]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(JSON.stringify(res.body)).not.toContain('A very long donor comment');
    expect(Object.keys(res.body.recent_donations[0]).sort()).toEqual([
      'amount_cents',
      'created_at',
      'display_name',
      'id',
    ]);
  });

  it('omits recent_donations and skips the read while the flag is off (D11)', async () => {
    vi.mocked(prisma.featureFlag.findMany).mockResolvedValue([
      { name: 'donation-acknowledgements', is_enabled: false },
    ] as never);
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    // The schedule strip itself stays ungated (D11).
    expect(res.body).toEqual({
      live: { game: 'Celeste', players: 'TGH' },
      next: { game: 'Super Metroid', players: 'Zoast' },
    });
    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });

  it('omits recent_donations when the flag row is absent (D11)', async () => {
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });

  it('reads the acknowledgements fresh on every request, outside the timetable cache (D8)', async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    const fetchMock = mockSchedule(fixtureRuns);
    const before = donationRow({ id: 'd-1' });
    const after = donationRow({ id: 'd-2', created_at: new Date(NOW_MS - 5_000) });
    vi.mocked(prisma.donation.findMany)
      .mockResolvedValueOnce([before] as never)
      .mockResolvedValueOnce([before, after] as never);

    const app = createApp();
    const first = await request(app).get('/api/schedule?channel=stream-1');
    const second = await request(app).get('/api/schedule?channel=stream-1');

    // The schedule timetable is cached (one fill: timetable + anchor read);
    // the donation read is not.
    expect(callsTo(fetchMock, 'horaro')).toHaveLength(1);
    expect(prisma.donation.findMany).toHaveBeenCalledTimes(2);
    expect(first.body.recent_donations.map((d: { id: string }) => d.id)).toEqual(['d-1']);
    expect(second.body.recent_donations.map((d: { id: string }) => d.id)).toEqual(['d-1', 'd-2']);
  });

  it('scopes acknowledgements to the Event of the Channel in context (D3)', async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    mockSchedule(fixtureRuns);
    stubDonationRows([
      donationRow({ id: 'd-own' }),
      donationRow({ id: 'd-other-event', event_id: 'event-2' }),
      donationRow({ id: 'd-no-event', event_id: null }),
    ]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.recent_donations.map((d: { id: string }) => d.id)).toEqual(['d-own']);
    expect(prisma.donation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ event_id: 'event-1' }) }),
    );
  });

  it("acknowledges the single active Event's donations when no channel is named (D3)", async () => {
    ackFlagOn();
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      {
        id: 'event-9',
        primary_channel: { schedule_slug: 'esa2026', schedule_stream_id: null },
      },
    ] as never);
    mockSchedule(fixtureRuns);
    stubDonationRows([
      donationRow({ id: 'd-own', event_id: 'event-9' }),
      donationRow({ id: 'd-other-event', event_id: 'event-1' }),
    ]);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body.recent_donations.map((d: { id: string }) => d.id)).toEqual(['d-own']);
    expect(prisma.donation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ event_id: 'event-9' }) }),
    );
  });

  it('carries no acknowledgements when the schedule renders nothing (D3/D6)', async () => {
    ackFlagOn();
    channelWithSlug('esa2026');
    mockFetch({ horaro: horaroPayload([]) });
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });

  it('carries no acknowledgements with two active Events (D3/D7)', async () => {
    ackFlagOn();
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { id: 'event-1', primary_channel: { schedule_slug: 'esa2026', schedule_stream_id: null } },
      { id: 'event-2', primary_channel: { schedule_slug: 'esa2027', schedule_stream_id: null } },
    ] as never);
    mockSchedule(fixtureRuns);
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body).toEqual({ live: null, next: null });
    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });
});
