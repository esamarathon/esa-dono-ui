import { describe, it, expect } from 'vitest';
import { hasModeratorAccess } from '../src/types';

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
