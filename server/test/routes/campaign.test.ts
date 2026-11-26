import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    broadcast: {
      findFirst: vi.fn(),
    },
    donation: {
      aggregate: vi.fn(),
    },
    event: {
      findUnique: vi.fn(),
    },
    channel: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from '../../lib/prisma.js';
import campaignRouter from '../../routes/campaign.js';

// The donor site shows no public aggregate total (#148), but the total stays in
// the API for external tools (#148 amendment). Only the broadcast banner read
// remains alongside it.
function createApp() {
  const app = express();
  app.use('/api/campaign', campaignRouter);
  return app;
}

describe('GET /api/campaign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the money total of counted donations only', async () => {
    vi.mocked(prisma.donation.aggregate).mockResolvedValue({
      _sum: { amount_cents: 12345 },
    } as any);

    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_raised_cents: 12345 });
    // COMPLETED and REFUNDED count; CHARGEBACK and PENDING do not; hidden donations count.
    expect(prisma.donation.aggregate).toHaveBeenCalledWith({
      where: { status: { in: ['COMPLETED', 'REFUNDED'] } },
      _sum: { amount_cents: true },
    });
  });

  it('returns 0 when no donations count', async () => {
    vi.mocked(prisma.donation.aggregate).mockResolvedValue({
      _sum: { amount_cents: null },
    } as any);

    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_raised_cents: 0 });
  });

  it('returns 500 when the aggregate fails', async () => {
    vi.mocked(prisma.donation.aggregate).mockRejectedValue(new Error('DB error'));

    const res = await request(createApp()).get('/api/campaign');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch campaign');
  });

  it("returns an Event's total for ?event=<slug>, inactive Events included", async () => {
    vi.mocked(prisma.event.findUnique).mockResolvedValue({
      id: 'event-1',
      slug: '2026-winter1',
      is_active: false,
    } as any);
    vi.mocked(prisma.donation.aggregate).mockResolvedValue({
      _sum: { amount_cents: 700 },
    } as any);

    const res = await request(createApp()).get('/api/campaign?event=2026-winter1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_raised_cents: 700 });
    // The Event's assigned donations only (unassigned ones count overall).
    expect(prisma.event.findUnique).toHaveBeenCalledWith({ where: { slug: '2026-winter1' } });
    expect(prisma.donation.aggregate).toHaveBeenCalledWith({
      where: { event_id: 'event-1', status: { in: ['COMPLETED', 'REFUNDED'] } },
      _sum: { amount_cents: true },
    });
  });

  it("returns a Channel's total for ?channel=<slug>", async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({
      id: 'channel-1',
      slug: 'stream-1',
      is_active: true,
    } as any);
    vi.mocked(prisma.donation.aggregate).mockResolvedValue({
      _sum: { amount_cents: 12345 },
    } as any);

    const res = await request(createApp()).get('/api/campaign?channel=stream-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_raised_cents: 12345 });
    expect(prisma.donation.aggregate).toHaveBeenCalledWith({
      where: { channel_id: 'channel-1', status: { in: ['COMPLETED', 'REFUNDED'] } },
      _sum: { amount_cents: true },
    });
  });

  it('returns 400 when both event and channel are given', async () => {
    const res = await request(createApp()).get('/api/campaign?event=a&channel=b');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Use either event or channel, not both');
  });

  it('returns 404 for an unknown event slug', async () => {
    vi.mocked(prisma.event.findUnique).mockResolvedValue(null as any);

    const res = await request(createApp()).get('/api/campaign?event=nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  it('returns 404 for an unknown channel slug', async () => {
    vi.mocked(prisma.channel.findUnique).mockResolvedValue(null as any);

    const res = await request(createApp()).get('/api/campaign?channel=nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Channel not found');
  });
});

describe('GET /api/campaign/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null message and level when no broadcast row exists', async () => {
    vi.mocked(prisma.broadcast.findFirst).mockResolvedValue(null as any);

    const res = await request(createApp()).get('/api/campaign/broadcast');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: null, level: null });
  });

  it('returns null message and level when the broadcast is inactive', async () => {
    vi.mocked(prisma.broadcast.findFirst).mockResolvedValue({
      id: '1',
      message: 'hidden',
      level: 'CRITICAL',
      is_active: false,
    } as any);

    const res = await request(createApp()).get('/api/campaign/broadcast');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: null, level: null });
  });

  it('returns the message with a null level for backward-compatible broadcasts', async () => {
    vi.mocked(prisma.broadcast.findFirst).mockResolvedValue({
      id: '1',
      message: 'hello',
      level: null,
      is_active: true,
    } as any);

    const res = await request(createApp()).get('/api/campaign/broadcast');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hello', level: null });
  });

  it('returns the message and level for an active broadcast with a severity', async () => {
    vi.mocked(prisma.broadcast.findFirst).mockResolvedValue({
      id: '1',
      message: 'server maintenance soon',
      level: 'WARNING',
      is_active: true,
    } as any);

    const res = await request(createApp()).get('/api/campaign/broadcast');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'server maintenance soon', level: 'WARNING' });
  });

  it('returns 500 when the lookup fails', async () => {
    vi.mocked(prisma.broadcast.findFirst).mockRejectedValue(new Error('DB error'));

    const res = await request(createApp()).get('/api/campaign/broadcast');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch broadcast');
  });
});
