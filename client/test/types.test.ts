import { describe, it, expect } from 'vitest';
import { hasModeratorAccess, hasAdminAccess, apiErrorMessage } from '../src/types';

describe('hasModeratorAccess', () => {
  it('is true for MODERATOR and ADMIN', () => {
    expect(hasModeratorAccess('MODERATOR')).toBe(true);
    expect(hasModeratorAccess('ADMIN')).toBe(true);
  });

  it('is false for USER, undefined, or null', () => {
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

describe('apiErrorMessage', () => {
  it('extracts the server error string from an axios error', () => {
    const err = { response: { data: { error: 'Something broke' } } };
    expect(apiErrorMessage(err, 'fallback')).toBe('Something broke');
  });

  it('falls back when there is no server error', () => {
    expect(apiErrorMessage(new Error('nope'), 'fallback')).toBe('fallback');
    expect(apiErrorMessage({}, 'fallback')).toBe('fallback');
    expect(apiErrorMessage({ response: { data: {} } }, 'fallback')).toBe('fallback');
  });
});
