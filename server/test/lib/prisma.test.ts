import { describe, it, expect } from 'vitest';
import { sqliteDatasourceUrl } from '../../lib/prisma.js';

describe('sqliteDatasourceUrl', () => {
  it('limits a SQLite URL to one connection', () => {
    expect(sqliteDatasourceUrl('file:/data/dono.db')).toBe('file:/data/dono.db?connection_limit=1');
    expect(sqliteDatasourceUrl('file:./dev.db?socket_timeout=10')).toBe(
      'file:./dev.db?socket_timeout=10&connection_limit=1',
    );
  });

  it('respects an explicit connection_limit', () => {
    expect(sqliteDatasourceUrl('file:./dev.db?connection_limit=3')).toBe(
      'file:./dev.db?connection_limit=3',
    );
  });

  it('leaves non-SQLite and missing URLs unchanged', () => {
    expect(sqliteDatasourceUrl('postgresql://u:p@db/dono')).toBe('postgresql://u:p@db/dono');
    expect(sqliteDatasourceUrl(undefined)).toBeUndefined();
  });
});
