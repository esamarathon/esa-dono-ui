import { describe, expect, it } from 'vitest';
import { databaseProvider } from '../../lib/database.js';

describe('databaseProvider', () => {
  it('defaults to SQLite and accepts file URLs', () => {
    expect(databaseProvider(undefined)).toBe('sqlite');
    expect(databaseProvider('file:/data/dono.db')).toBe('sqlite');
  });

  it('accepts both PostgreSQL URL schemes', () => {
    expect(databaseProvider('postgresql://localhost/dono')).toBe('postgresql');
    expect(databaseProvider('postgres://localhost/dono')).toBe('postgresql');
  });

  it('rejects unsupported providers without echoing connection credentials', () => {
    expect(() => databaseProvider('mysql://user:secret@localhost/dono')).toThrow(
      'DATABASE_URL must use file:, postgresql: or postgres:',
    );
  });
});
