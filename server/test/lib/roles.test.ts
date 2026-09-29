import { describe, it, expect, afterEach } from 'vitest';
import { hasModeratorAccess, hasAdminAccess, resolveEffectiveRole, ROLE } from '../../lib/roles.js';

describe('roles', () => {
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
    delete process.env.MODERATOR_EMAILS;
  });

  describe('hasModeratorAccess', () => {
    it('is true for MODERATOR and ADMIN', () => {
      expect(hasModeratorAccess('MODERATOR')).toBe(true);
      expect(hasModeratorAccess('ADMIN')).toBe(true);
    });
    it('is false for USER or missing role', () => {
      expect(hasModeratorAccess('USER')).toBe(false);
      expect(hasModeratorAccess(undefined)).toBe(false);
      expect(hasModeratorAccess(null)).toBe(false);
    });
  });

  describe('hasAdminAccess', () => {
    it('is true only for ADMIN', () => {
      expect(hasAdminAccess('ADMIN')).toBe(true);
      expect(hasAdminAccess('MODERATOR')).toBe(false);
      expect(hasAdminAccess('USER')).toBe(false);
    });
  });

  describe('resolveEffectiveRole', () => {
    it('defaults to USER with no allowlists and no stored role', () => {
      expect(resolveEffectiveRole('nobody@example.com', 'USER', true)).toBe(ROLE.USER);
    });

    it('grants ADMIN via ADMIN_EMAILS for a verified email', () => {
      process.env.ADMIN_EMAILS = 'boss@example.com';
      expect(resolveEffectiveRole('boss@example.com', 'USER', true)).toBe(ROLE.ADMIN);
    });

    it('does NOT grant ADMIN via ADMIN_EMAILS for an unverified email', () => {
      process.env.ADMIN_EMAILS = 'boss@example.com';
      expect(resolveEffectiveRole('boss@example.com', 'USER', false)).toBe(ROLE.USER);
    });

    it('grants MODERATOR via MODERATOR_EMAILS for a verified email', () => {
      process.env.MODERATOR_EMAILS = 'mod@example.com';
      expect(resolveEffectiveRole('mod@example.com', 'USER', true)).toBe(ROLE.MODERATOR);
    });

    it('does NOT grant MODERATOR via MODERATOR_EMAILS for an unverified email', () => {
      process.env.MODERATOR_EMAILS = 'mod@example.com';
      expect(resolveEffectiveRole('mod@example.com', 'USER', false)).toBe(ROLE.USER);
    });

    it('ADMIN_EMAILS takes precedence over MODERATOR_EMAILS', () => {
      process.env.ADMIN_EMAILS = 'both@example.com';
      process.env.MODERATOR_EMAILS = 'both@example.com';
      expect(resolveEffectiveRole('both@example.com', 'USER', true)).toBe(ROLE.ADMIN);
    });

    it('never downgrades a persisted role below what env allowlists grant', () => {
      // Persisted ADMIN, no longer on any allowlist -> stays ADMIN.
      expect(resolveEffectiveRole('ex-admin@example.com', 'ADMIN', false)).toBe(ROLE.ADMIN);
    });

    it('is case-insensitive and trims whitespace on email matching', () => {
      process.env.ADMIN_EMAILS = ' Boss@Example.com , other@example.com';
      expect(resolveEffectiveRole('  boss@example.com  ', 'USER', true)).toBe(ROLE.ADMIN);
    });

    it('does not grant any role from donating alone (no allowlist match)', () => {
      expect(resolveEffectiveRole('random-donor@example.com', 'USER', true)).toBe(ROLE.USER);
    });
  });
});
