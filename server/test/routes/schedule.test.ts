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

function channelWithSlug(horaroScheduleSlug: string | null, eventId: string | null = 'event-1') {
  vi.mocked(prisma.channel.findUnique).mockResolvedValue({
    horaro_schedule_slug: horaroScheduleSlug,
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
      select: { horaro_schedule_slug: true, event_id: true },
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
      { id: 'event-1', primary_channel: { horaro_schedule_slug: '2026-winter1' } },
    ] as never);
    const fetchMock = mockFetch(fixture);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.status).toBe(200);
    expect(res.body.live).toEqual({ game: 'Celeste', players: 'TGH' });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { is_active: true },
      select: { id: true, primary_channel: { select: { horaro_schedule_slug: true } } },
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
    vi.restoreAllMocks();
  });

  it("returns the Event's ack-eligible donations of the last minute when the flag is on (D1/D8)", async () => {
    ackFlagOn();
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
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
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
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
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
    stubDonationRows([donationRow({ id: 'd-blank', donor_name: '   ', amount_cents: 1050 })]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.recent_donations).toEqual([
      expect.objectContaining({ id: 'd-blank', display_name: 'Anonymous', amount_cents: 1050 }),
    ]);
  });

  it('never carries the donor comment into the payload (D4)', async () => {
    ackFlagOn();
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
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
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
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
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });

  it('reads the acknowledgements fresh on every request, outside the timetable cache (D8)', async () => {
    ackFlagOn();
    channelWithSlug('2026-winter1');
    const fetchMock = mockFetch(fixture);
    const before = donationRow({ id: 'd-1' });
    const after = donationRow({ id: 'd-2', created_at: new Date(NOW_MS - 5_000) });
    vi.mocked(prisma.donation.findMany)
      .mockResolvedValueOnce([before] as never)
      .mockResolvedValueOnce([before, after] as never);

    const app = createApp();
    const first = await request(app).get('/api/schedule?channel=stream-1');
    const second = await request(app).get('/api/schedule?channel=stream-1');

    // The Horaro timetable is cached; the donation read is not.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.donation.findMany).toHaveBeenCalledTimes(2);
    expect(first.body.recent_donations.map((d: { id: string }) => d.id)).toEqual(['d-1']);
    expect(second.body.recent_donations.map((d: { id: string }) => d.id)).toEqual(['d-1', 'd-2']);
  });

  it('scopes acknowledgements to the Event of the Channel in context (D3)', async () => {
    ackFlagOn();
    channelWithSlug('2026-winter1');
    mockFetch(fixture);
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
      { id: 'event-9', primary_channel: { horaro_schedule_slug: '2026-winter1' } },
    ] as never);
    mockFetch(fixture);
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
    channelWithSlug('2026-winter1');
    mockFetch(horaroPayload([]));
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule?channel=stream-1');

    expect(res.body).toEqual({ live: null, next: null });
    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });

  it('carries no acknowledgements with two active Events (D3/D7)', async () => {
    ackFlagOn();
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { id: 'event-1', primary_channel: { horaro_schedule_slug: '2026-winter1' } },
      { id: 'event-2', primary_channel: { horaro_schedule_slug: '2026-winter2' } },
    ] as never);
    mockFetch(fixture);
    stubDonationRows([donationRow()]);

    const res = await request(createApp()).get('/api/schedule');

    expect(res.body).toEqual({ live: null, next: null });
    expect(res.body.recent_donations).toBeUndefined();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });
});
