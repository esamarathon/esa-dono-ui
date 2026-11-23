import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/prisma.js', () => ({
  default: {
    broadcast: {
      findFirst: vi.fn(),
    },
  },
}));

import prisma from '../../lib/prisma.js';
import campaignRouter from '../../routes/campaign.js';

// GET /api/campaign retired in #148 (the donor site shows no public aggregate
// total). Only the broadcast banner read remains here.
function createApp() {
  const app = express();
  app.use('/api/campaign', campaignRouter);
  return app;
}

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
