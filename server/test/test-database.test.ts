import path from 'node:path';
import { inject } from 'vitest';

// Guards test/global-setup.ts: workers must open the per-run temp DB, never
// the local dev server's prisma/dev.db.
describe('test database', () => {
  it('uses the per-run temp DB created by globalSetup', () => {
    const url = inject('testDatabaseUrl');
    expect(process.env.DATABASE_URL).toBe(url);
    expect(path.basename(path.dirname(url))).toMatch(/^dono-test-db-/);
    expect(url).not.toContain(path.join('prisma', 'dev.db'));
  });
});
