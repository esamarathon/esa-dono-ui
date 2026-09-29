import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

vi.mock('../../services/email.js', () => ({
  sendMagicLink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/rateLimit.js', () => ({
  authLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import authRouter from '../../routes/auth.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('POST /api/auth/request-token', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rotates the magic token and returns uniform success for an existing donor', async () => {
    const email = `rotate-${Date.now()}-${Math.random()}@example.com`;
    const oldToken = crypto.randomBytes(16).toString('hex');
    const donor = await prisma.donor.create({
      data: {
        email,
        magic_token: oldToken,
        token_expires_at: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(createApp()).post('/api/auth/request-token').send({ email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const updated = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(updated!.magic_token).toBeTruthy();
    expect(updated!.magic_token).not.toBe(oldToken);
    expect(updated!.token_expires_at!.getTime()).toBeGreaterThan(Date.now());

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('returns uniform success (and does nothing) for an unknown email', async () => {
    const email = `nobody-${Date.now()}-${Math.random()}@example.com`;

    const res = await request(createApp()).post('/api/auth/request-token').send({ email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(await prisma.donor.count({ where: { email } })).toBe(0);
  });

  it('does not rotate the token for a frozen donor', async () => {
    const email = `frozen-${Date.now()}-${Math.random()}@example.com`;
    const oldToken = crypto.randomBytes(16).toString('hex');
    const donor = await prisma.donor.create({
      data: {
        email,
        magic_token: oldToken,
        token_expires_at: new Date(Date.now() + 60_000),
        is_frozen: true,
      },
    });

    const res = await request(createApp()).post('/api/auth/request-token').send({ email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const updated = await prisma.donor.findUnique({ where: { id: donor.id } });
    expect(updated!.magic_token).toBe(oldToken);

    await prisma.donor.delete({ where: { id: donor.id } });
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(createApp()).post('/api/auth/request-token').send({ email: 'nope' });
    expect(res.status).toBe(400);
  });
});
