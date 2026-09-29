import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

vi.mock('../../services/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/oauth.js')>();
  return { ...actual, exchangeCodeForUser: vi.fn() };
});

import authRouter from '../../routes/auth.js';
import { exchangeCodeForUser } from '../../services/oauth.js';

const prisma = new PrismaClient();

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

function clearOAuthEnv() {
  for (const k of [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
  ]) {
    delete process.env[k];
  }
}

function setGoogleEnv() {
  process.env.GOOGLE_CLIENT_ID = 'gid';
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
}

describe('OAuth auth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    clearOAuthEnv();
    await prisma.$disconnect();
  });

  describe('GET /api/auth/providers', () => {
    it('returns an empty list when no providers are configured', async () => {
      clearOAuthEnv();
      const res = await request(createApp()).get('/api/auth/providers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ providers: [] });
    });

    it('lists a configured provider', async () => {
      setGoogleEnv();
      const res = await request(createApp()).get('/api/auth/providers');
      expect(res.status).toBe(200);
      expect(res.body.providers).toContain('google');
    });
  });

  describe('GET /api/auth/:provider', () => {
    it('redirects to the provider and sets a state cookie', async () => {
      setGoogleEnv();
      const res = await request(createApp()).get('/api/auth/google');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('accounts.google.com');
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie![0]).toContain('oauth_state=');
    });

    it('returns 503 for an unconfigured provider', async () => {
      clearOAuthEnv();
      const res = await request(createApp()).get('/api/auth/discord');
      expect(res.status).toBe(503);
    });

    it('returns 404 for an unknown provider', async () => {
      const res = await request(createApp()).get('/api/auth/facebook');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/auth/:provider/callback', () => {
    it('upserts a verified donor and sets a session cookie, redirecting to the wallet', async () => {
      setGoogleEnv();
      const email = `sso-${Date.now()}-${Math.random()}@example.com`;
      vi.mocked(exchangeCodeForUser).mockResolvedValue({ email, emailVerified: true });

      const res = await request(createApp())
        .get('/api/auth/google/callback')
        .query({ code: 'code-1', state: 'st-1' })
        .set('Cookie', 'oauth_state=st-1');

      expect(res.status).toBe(302);
      // Token is set as an httpOnly session cookie, not exposed in the URL.
      expect(new URL(res.headers.location!, 'http://x').searchParams.get('token')).toBeNull();
      const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      const sessionCookie = setCookie.find((c) => c.startsWith('dono_session='));
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie).toContain('HttpOnly');
      const token = /dono_session=([^;]+)/.exec(sessionCookie!)?.[1] ?? '';

      const donor = await prisma.donor.findUnique({ where: { email } });
      expect(donor).toBeTruthy();
      expect(donor!.email_verified).toBe(true);
      expect(donor!.magic_token).toBe(decodeURIComponent(token));

      await prisma.donor.delete({ where: { id: donor!.id } });
    });

    it('marks a Twitch sign-in unverified', async () => {
      process.env.TWITCH_CLIENT_ID = 'tid';
      process.env.TWITCH_CLIENT_SECRET = 'tsecret';
      const email = `twitch-${Date.now()}-${Math.random()}@example.com`;
      vi.mocked(exchangeCodeForUser).mockResolvedValue({ email, emailVerified: false });

      const res = await request(createApp())
        .get('/api/auth/twitch/callback')
        .query({ code: 'code-2', state: 'st-2' })
        .set('Cookie', 'oauth_state=st-2');

      expect(res.status).toBe(302);
      const donor = await prisma.donor.findUnique({ where: { email } });
      expect(donor!.email_verified).toBe(false);

      await prisma.donor.delete({ where: { id: donor!.id } });
    });

    it('redirects with an error on state mismatch', async () => {
      setGoogleEnv();
      const res = await request(createApp())
        .get('/api/auth/google/callback')
        .query({ code: 'code-3', state: 'wrong' })
        .set('Cookie', 'oauth_state=right');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
    });

    it('redirects with an error when the code is missing', async () => {
      setGoogleEnv();
      const res = await request(createApp())
        .get('/api/auth/google/callback')
        .query({ state: 'st-4' })
        .set('Cookie', 'oauth_state=st-4');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
    });

    it('redirects with an error for a frozen donor', async () => {
      setGoogleEnv();
      const email = `frozen-sso-${Date.now()}-${Math.random()}@example.com`;
      const donor = await prisma.donor.create({
        data: { email, is_frozen: true },
      });
      vi.mocked(exchangeCodeForUser).mockResolvedValue({ email, emailVerified: true });

      const res = await request(createApp())
        .get('/api/auth/google/callback')
        .query({ code: 'code-5', state: 'st-5' })
        .set('Cookie', 'oauth_state=st-5');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');

      await prisma.donor.delete({ where: { id: donor.id } });
    });
  });
});
