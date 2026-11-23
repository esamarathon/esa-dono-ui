import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    channel: { findUnique: vi.fn() },
    event: { findMany: vi.fn() },
  },
}));

import prisma from '../../lib/prisma.js';
import scheduleRouter from '../../routes/schedule.js';
import { clearScheduleCache, SCHEDULE_CACHE_TTL_MS } from '../../services/schedule.js';

function createApp() {
  const app = express();
  app.use('/api/schedule', scheduleRouter);
  return app;
}

/** Fixed clock: 2027-01-14T22:40:00Z in seconds / ms. */
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

/**
 * Horaro `/{org}/{slug}.json` shape, modeled on the live ESA schedule
 * (https://horaro.org/esa/2026-winter1.json): top-level `schedule` with
 * `columns` and `items` of `scheduled_t` (unix seconds), `length_t` (seconds)
 * and `data` (one value per column).
 */
function horaroPayload(
  items: Array<{ scheduled_t: number; length_t: number; data: string[] }>,
  columns: string[] | null = ['Game', 'Player(s)', 'Platform', 'Category', 'Note'],
) {
  return {
    schedule: {
      slug: '2026-winter1',
      name: 'ESA Winter 2026',
      url: 'https://horaro.org/esa/2026-winter1',
      ...(columns ? { columns } : {}),
      items: items.map((item) => ({ ...item, options: {} })),
    },
  };
}

const fixture = horaroPayload([
  {
    scheduled_t: NOW_S - 600,
    length_t: 1800,
    data: ['Celeste', 'TGH', 'PC', 'Any%', ''],
  },
  {
    scheduled_t: NOW_S + 1200,
    length_t: 1800,
    data: ['Super Metroid', 'Zoast', 'SNES', '100%', ''],
  },
  {
    scheduled_t: NOW_S + 3600,
    length_t: 1800,
    data: ['Hollow Knight', 'fireb0rn', 'PC', 'All Bosses', ''],
  },
]);

function mockFetch(payload: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function channelWithSlug(horaroScheduleSlug: string | null) {
  vi.mocked(prisma.channel.findUnique).mockResolvedValue({
    horaro_schedule_slug: horaroScheduleSlug,
  } as never);
}

describe('GET /api/schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearScheduleCache();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('computes live and next from the stubbed Horaro timetable', async () => {
    channelWithSlug('2026-winter1');
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      live: { game: 'Celeste', players: 'TGH' },
      next: { game: 'Super Metroid', players: 'Zoast' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://horaro.org/esa/2026-winter1.json',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('resolves the channel slug to its configured Horaro schedule', async () => {
    channelWithSlug('2026-winter2');
    const fetchMock = mockFetch(fixture);

    await request(createApp()).get('/api/schedule?channel=stream-2');

    expect(prisma.channel.findUnique).toHaveBeenCalledWith({
      where: { slug: 'stream-2' },
      select: { horaro_schedule_slug: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://horaro.org/esa/2026-winter2.json',
      expect.anything(),
    );
  });

  it('maps game and players by column NAME when columns are declared', async () => {
    channelWithSlug('2026-winter1');
    mockFetch(
      horaroPayload(
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
    );

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(res.body.next).toEqual({ game: 'Super Metroid', players: 'Zoast' });
  });

  it('falls back to index 0/1 when the timetable declares no columns', async () => {
    channelWithSlug('2026-winter1');
    mockFetch(
      horaroPayload(
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
    );

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(res.body.next).toEqual({ game: 'Super Metroid', players: 'Zoast' });
  });

  it('returns nulls for an unknown channel slug without calling Horaro', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValue(null as never);
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule?channel=nope');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nulls for a channel without a configured slug', async () => {
    channelWithSlug(null);
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the single active Event's primary Channel when no channel is named", async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { primary_channel: { horaro_schedule_slug: '2026-winter1' } },
    ] as never);
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.status).toBe(200);
    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { is_active: true },
      select: { primary_channel: { select: { horaro_schedule_slug: true } } },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://horaro.org/esa/2026-winter1.json',
      expect.anything(),
    );
  });

  it('returns nulls with two active Events (D7) without calling Horaro', async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { primary_channel: { horaro_schedule_slug: '2026-winter1' } },
      { primary_channel: { horaro_schedule_slug: '2026-winter2' } },
    ] as never);
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nulls with no active Event without calling Horaro', async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([] as never);
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body).toEqual({ live: null, next: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nulls when the single active Event has no primary Channel or no slug', async () => {
    vi.mocked(prisma.event.findMany).mockResolvedValue([{ primary_channel: null }] as never);
    mockFetch(fixture);
    expect((await request(createApp()).get('/api/schedule')).body).toEqual({
      live: null,
      next: null,
    });

    clearScheduleCache();
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { primary_channel: { horaro_schedule_slug: null } },
    ] as never);
    expect((await request(createApp()).get('/api/schedule')).body).toEqual({
      live: null,
      next: null,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns nulls for an empty schedule', async () => {
    channelWithSlug('2026-winter1');
    mockFetch(horaroPayload([]));

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
  });

  it("returns nulls once the last run's slot has passed", async () => {
    channelWithSlug('2026-winter1');
    mockFetch(
      horaroPayload([
        {
          scheduled_t: NOW_S - 7200,
          length_t: 3600,
          data: ['Celeste', 'TGH', 'PC', 'Any%', ''],
        },
        {
          scheduled_t: NOW_S - 3000,
          length_t: 1800,
          data: ['Super Metroid', 'Zoast', 'SNES', '100%', ''],
        },
      ]),
    );

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
  });

  it('serves the last good timetable on fetch failure while a slot is current (D8)', async () => {
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
    const first = await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(first.body.live).toEqual({ game: 'Celeste', players: 'TGH' });

    // Past the cache TTL but still inside the live slot: fetch now fails.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SCHEDULE_CACHE_TTL_MS + 5000);
    vi.mocked(fetch).mockRejectedValue(new Error('horaro down'));

    const second = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      live: { game: 'Celeste', players: 'TGH' },
      next: { game: 'Super Metroid', players: 'Zoast' },
    });
  });

  it('hides on fetch failure once every cached slot has passed (D8/D6)', async () => {
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
    await request(createApp()).get('/api/schedule?channel=stream-1');

    // Way past the last slot: the stale cache has nothing current or future.
    vi.spyOn(Date, 'now').mockReturnValue((NOW_S + 7200) * 1000);
    vi.mocked(fetch).mockRejectedValue(new Error('horaro down'));

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
  });

  it('returns nulls on a fetch failure with no cached timetable', async () => {
    channelWithSlug('2026-winter1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('horaro down')));

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: null, next: null });
  });

  it('does not refetch within the cache TTL and refetches after it', async () => {
    channelWithSlug('2026-winter1');
    const fetchMock = mockFetch(fixture);

    await request(createApp()).get('/api/schedule?channel=stream-1');
    await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SCHEDULE_CACHE_TTL_MS);
    mockFetch(fixture);
    await request(createApp()).get('/api/schedule?channel=stream-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the schedule lookup itself fails', async () => {
    vi.mocked(prisma.channel.findUnique).mockRejectedValue(new Error('DB error'));

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch schedule');
  });
});
