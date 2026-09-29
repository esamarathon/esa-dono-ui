import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  isOAuthProvider,
  enabledProviders,
  buildAuthorizeUrl,
  exchangeCodeForUser,
} from '../../services/oauth.js';

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

describe('oauth service', () => {
  afterEach(() => {
    clearOAuthEnv();
    vi.unstubAllGlobals();
  });

  describe('isOAuthProvider', () => {
    it('accepts the three supported providers only', () => {
      expect(isOAuthProvider('google')).toBe(true);
      expect(isOAuthProvider('discord')).toBe(true);
      expect(isOAuthProvider('twitch')).toBe(true);
      expect(isOAuthProvider('facebook')).toBe(false);
    });
  });

  describe('enabledProviders', () => {
    it('returns an empty list when nothing is configured', () => {
      expect(enabledProviders()).toEqual([]);
    });

    it('lists only fully configured providers', () => {
      process.env.GOOGLE_CLIENT_ID = 'gid';
      process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
      process.env.DISCORD_CLIENT_ID = 'did'; // missing secret -> disabled
      expect(enabledProviders()).toEqual(['google']);
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('throws a 503 when the provider is not configured', () => {
      expect(() => buildAuthorizeUrl('google', 'state')).toThrowError(
        expect.objectContaining({ status: 503 }),
      );
    });

    it('builds a Google authorize URL with the redirect and state', () => {
      process.env.GOOGLE_CLIENT_ID = 'gid';
      process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
      const url = buildAuthorizeUrl('google', 'state-123');
      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=gid');
      expect(url).toContain('state=state-123');
      expect(url).toContain(encodeURIComponent('http://localhost:5173/api/auth/google/callback'));
    });
  });

  describe('exchangeCodeForUser', () => {
    it('returns a verified email for Google', async () => {
      process.env.GOOGLE_CLIENT_ID = 'gid';
      process.env.GOOGLE_CLIENT_SECRET = 'gsecret';

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('oauth2.googleapis.com/token')) {
            return { ok: true, json: async () => ({ access_token: 'at-1' }) };
          }
          return {
            ok: true,
            json: async () => ({ email: 'g@example.com', email_verified: true }),
          };
        }),
      );

      const user = await exchangeCodeForUser('google', 'code');
      expect(user).toEqual({ email: 'g@example.com', emailVerified: true });
    });

    it('returns an unverified email for Twitch (no verification flag)', async () => {
      process.env.TWITCH_CLIENT_ID = 'tid';
      process.env.TWITCH_CLIENT_SECRET = 'tsecret';

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('id.twitch.tv/oauth2/token')) {
            return { ok: true, json: async () => ({ access_token: 'at-2' }) };
          }
          return { ok: true, json: async () => ({ data: [{ email: 't@example.com' }] }) };
        }),
      );

      const user = await exchangeCodeForUser('twitch', 'code');
      expect(user).toEqual({ email: 't@example.com', emailVerified: false });
    });
  });
});
