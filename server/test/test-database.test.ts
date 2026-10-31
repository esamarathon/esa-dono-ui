import path from 'node:path';
import { inject } from 'vitest';
import { databaseProvider } from '../lib/database.js';
import { createDatabaseClient } from '../lib/databaseClient.js';

// Guards globalSetup: workers must never open the ambient DATABASE_URL or a
// supplied PostgreSQL schema. Every run owns only a fresh file/schema.
describe('test database', () => {
  it('uses the isolated URL supplied by globalSetup', () => {
    const url = inject('testDatabaseUrl');
    expect(process.env.DATABASE_URL).toBe(url);
    const target = process.env.TEST_DATABASE_URL;
    if (databaseProvider(target) === 'postgresql') {
      const actual = new URL(url);
      const expected = new URL(target!);
      expect(actual.searchParams.get('schema')).toMatch(/^dono_test_[a-f0-9]{32}$/);
      expect(actual.searchParams.get('schema')).not.toBe(expected.searchParams.get('schema'));
      actual.searchParams.delete('schema');
      expected.searchParams.delete('schema');
      expect(actual.toString()).toBe(expected.toString());
    } else {
      // This remains SQLite even if DATABASE_URL originally pointed at PG.
      expect(databaseProvider(url)).toBe('sqlite');
      expect(path.basename(path.dirname(url))).toMatch(/^dono-test-db-/);
      expect(url).not.toContain(path.join('prisma', 'dev.db'));
      expect(url).not.toBe(target);
    }
  });

  it('opens the selected connector in the isolated database', async () => {
    const url = inject('testDatabaseUrl');
    const prisma = createDatabaseClient(url);
    try {
      if (databaseProvider(url) === 'postgresql') {
        const rows = await prisma.$queryRaw<Array<{ schema: string }>>`
          SELECT current_schema() AS schema
        `;
        expect(rows).toEqual([{ schema: new URL(url).searchParams.get('schema') }]);
      } else {
        const rows =
          await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode');
        expect(rows).toEqual([{ journal_mode: 'wal' }]);
      }
      // Both migration histories must expose the current application models.
      expect(await prisma.donor.count()).toBeGreaterThanOrEqual(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
