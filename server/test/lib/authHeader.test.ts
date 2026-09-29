import { describe, it, expect } from 'vitest';
import { parseCredential, bearerDonorToken, bearerValue } from '../../lib/authHeader.js';

function req(authorization?: string) {
  return { headers: authorization ? { authorization } : {} } as any;
}

describe('authHeader', () => {
  it('returns undefined when no Authorization header is present', () => {
    expect(bearerValue(req())).toBeUndefined();
    expect(parseCredential(req())).toBeNull();
    expect(bearerDonorToken(req())).toBeUndefined();
  });

  it('tolerates a request with no headers object', () => {
    expect(parseCredential({} as any)).toBeNull();
  });

  it('parses a bare Bearer token as a donor credential (backward compatible)', () => {
    expect(parseCredential(req('Bearer abc123'))).toEqual({ kind: 'donor', token: 'abc123' });
    expect(bearerDonorToken(req('Bearer abc123'))).toBe('abc123');
  });

  it('parses an explicit donor_ prefix', () => {
    expect(parseCredential(req('Bearer donor_abc123'))).toEqual({ kind: 'donor', token: 'abc123' });
  });

  it('parses key_admin_ and key_mod_ prefixes', () => {
    expect(parseCredential(req('Bearer key_admin_secret'))).toEqual({
      kind: 'admin-key',
      key: 'secret',
    });
    expect(parseCredential(req('Bearer key_mod_secret'))).toEqual({
      kind: 'moderator-key',
      key: 'secret',
    });
  });

  it('is case-insensitive on the Bearer scheme and trims whitespace', () => {
    expect(bearerValue(req('bearer   abc123'))).toBe('abc123');
  });

  it('bearerDonorToken returns undefined for a key credential', () => {
    expect(bearerDonorToken(req('Bearer key_admin_secret'))).toBeUndefined();
  });
});
