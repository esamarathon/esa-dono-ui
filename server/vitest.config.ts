import { configDefaults, defineConfig } from 'vitest/config';
import { databaseProvider } from './lib/database.js';

const postgresql = databaseProvider(process.env.TEST_DATABASE_URL) === 'postgresql';

export default defineConfig({
  // vite-node (the vitest runner) does not honor `resolve.extensionAlias`, so
  // map relative `.js` specifiers that point at migrated TypeScript sources
  // (lib/services/routes/middleware) to their `.ts` files. NodeNext ESM keeps
  // the `.js` extension in imports even though the source is now TypeScript.
  resolve: {
    alias: [
      {
        find: /^((?:\.{1,2}\/)+(?:lib|services|routes|middleware)\/.*)\.js$/,
        replacement: '$1.ts',
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // Creates a migrated temp SQLite file or unique PostgreSQL test schema.
    // Only TEST_DATABASE_URL opts into PostgreSQL; DATABASE_URL is ignored.
    // Do not set DATABASE_URL in `test.env`: it would override that value.
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      // These replay historical SQLite databases, not the current schema.
      ...(postgresql
        ? [
            'test/scripts/pooled-migration.test.ts',
            'test/scripts/payment-refund-migration.test.ts',
            'test/scripts/shared-incentive-migration.test.ts',
            'test/scripts/transition.test.ts',
          ]
        : []),
    ],
    // Both providers share fixtures across files. Serialize them to avoid
    // cross-file cleanup races (and SQLite's single-writer lock contention).
    fileParallelism: false,
    // Integration tests share one database and run under v8 coverage in the
    // pre-commit hook (alongside lint-staged). On small CI/dev hosts the 5s
    // default was hit intermittently by unrelated DB-backed route tests, so
    // allow more headroom. This only bounds how long a hung test may take.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'middleware/**/*.ts', 'routes/**/*.ts', 'services/**/*.ts'],
      // `include` makes untested files appear at 0% (rather than dropping out
      // of the metric). Entry points (index.ts) and config are left out as
      // glue, not behavior.
      // Thresholds updated to match current coverage levels (~79% statements).
      thresholds: {
        statements: 77,
        branches: 65,
        functions: 87,
        lines: 79,
      },
    },
  },
});
